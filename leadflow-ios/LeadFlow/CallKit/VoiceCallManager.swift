// VoiceCallManager.swift
// LeadFlow
//
// Owns the Twilio Voice glue for RECEIVING calls: registers this device's VoIP
// push token with Twilio (using a short-lived access token minted by our
// backend), parses incoming VoIP pushes into CallInvites, reports them to
// CallKit, and accepts/rejects on the user's CallKit action. It deliberately
// implements only the incoming path — outgoing dialing is out of scope.
//
// Threading: PushKit delivers on .main, TwilioVoice delegate callbacks use
// delegateQueue: nil (main), and CXProvider uses queue: nil (main), so all
// delegate callbacks below run on the main thread and @Published mutations are
// safe without an explicit @MainActor annotation.

import Foundation
import UIKit
import CallKit
import PushKit
import AVFoundation
import TwilioVoice

final class VoiceCallManager: NSObject, ObservableObject {

    static let shared = VoiceCallManager()

    // Lightweight published state for any in-app UI that wants to reflect calls.
    // The primary call UI is the system CallKit screen; these are supplementary.
    @Published private(set) var incomingCallerNumber: String? = nil
    @Published private(set) var hasActiveCall: Bool = false

    // Supplementary published state powering the in-app FOREGROUND call screen
    // (the native CallKit screen still owns backgrounded/locked calls). These are
    // pure UI mirrors set alongside the existing call lifecycle — they do not
    // alter any CallKit / Twilio / audio behavior.
    @Published private(set) var activeCallHandle: String? = nil  // remote phone number / identity
    @Published private(set) var activeCallName: String? = nil    // display name known at dial time (outbound from a lead)
    @Published private(set) var callConnectedAt: Date? = nil     // when the call actually connected (drives the timer)
    @Published private(set) var isMuted: Bool = false
    @Published private(set) var isSpeakerOn: Bool = false

    // UUID CallKit knows the in-progress call by — used to mute/end the active call.
    private var currentCallUUID: UUID? = nil

    /// The Twilio Voice client identity this device last registered under
    /// (e.g. "business_1"). Surfaced for debugging / Settings.
    private(set) var identity: String? = nil

    // Twilio's audio engine. Must be assigned to TwilioVoiceSDK.audioDevice
    // before any call connects; CallKit toggles its `isEnabled` on
    // activate/deactivate of the audio session.
    private let audioDevice = DefaultAudioDevice()

    // Active state keyed by the CallKit call UUID string.
    private var activeCallInvites: [String: CallInvite] = [:]
    private var activeCalls: [String: Call] = [:]
    private var incomingCallUUID: UUID? = nil

    // Outgoing-call state. `pendingOutgoing` holds the destination + minted access
    // token for a call that's been reported to CallKit but not yet connected via
    // TwilioVoiceSDK (the connect happens when the system performs the
    // CXStartCallAction). `outgoingCallUUIDs` marks which active calls are outbound
    // so the shared CallDelegate can report `connectedAt` to CallKit for them.
    private struct PendingOutgoing {
        let to: String
        let displayName: String?
        let accessToken: String
        let iceServers: [APIService.VoiceTokenResponse.ICEServer]?
    }
    private var pendingOutgoing: [String: PendingOutgoing] = [:]
    private var outgoingCallUUIDs: Set<String> = []

    // VoIP push token (raw Data from PushKit) + the last access token we minted,
    // needed for register/unregister with Twilio.
    private var voipToken: Data? = nil
    private var cachedAccessToken: String? = nil
    private var lastRegisteredAt: Date? = nil

    // TURN/STUN relay servers from the last minted access token (Twilio NTS, via our
    // backend). Kept as the FALLBACK for an inbound accept: performAnswer mints a fresh
    // token (fresh relay creds) at accept time and only falls back to this
    // registration-time copy if that fetch fails. Nil when Voice/NTS isn't configured
    // (or before the first successful registration); the call then proceeds without a
    // pre-provided relay, as before.
    private var cachedIceServers: [APIService.VoiceTokenResponse.ICEServer]? = nil

    // Set true right before we disconnect a call on the user's behalf so the
    // disconnect callback doesn't redundantly re-report the end to CallKit.
    private var userInitiatedDisconnect = false
    private var answerCompletion: ((Bool) -> Void)? = nil

    private override init() {
        super.init()
        TwilioVoiceSDK.audioDevice = audioDevice
        // Pin the media edge to a nearby Twilio region so the audio anchor is close
        // and the SDK doesn't burn the first seconds of a cellular call discovering
        // one. Global and set once here — the SDK requires the edge be set before any
        // handleNotification / register / connect. Ashburn = US East, closest to the
        // Illinois service area.
        TwilioVoiceSDK.edge = "ashburn"
    }

    // MARK: - Registration lifecycle

    /// Register (or refresh) this device for incoming VoIP calls. Safe to call on
    /// every launch / foreground — throttled so we don't re-mint a token each time.
    func register() {
        Task { await refreshRegistration(force: false) }
    }

    /// PushKit handed us a (new) VoIP token. Always (re)register on a real change.
    func updateVoipToken(_ token: Data) {
        let changed = token != voipToken
        voipToken = token
        LocalStorageService.shared.voipToken = token.map { String(format: "%02x", $0) }.joined()
        NSLog("[voice] updateVoipToken (changed=\(changed)) → triggering registration")
        Task { await refreshRegistration(force: changed) }
    }

    func invalidateVoipToken() {
        voipToken = nil
        LocalStorageService.shared.voipToken = nil
    }

    private func refreshRegistration(force: Bool) async {
        guard let token = voipToken else {
            // No VoIP token yet; updateVoipToken(_:) will drive registration once
            // PushKit issues one. On a fresh launch this is expected — the token
            // arrives moments later via PKPushRegistry.didUpdate.
            NSLog("[voice] refreshRegistration skipped — no VoIP token yet (waiting on PushKit didUpdate)")
            return
        }
        if !force, let last = lastRegisteredAt, Date().timeIntervalSince(last) < 600 {
            NSLog("[voice] refreshRegistration skipped — registered \(Int(Date().timeIntervalSince(last)))s ago (throttled, <600s)")
            return // registered recently; nothing to do
        }

        let tokenHex = token.map { String(format: "%02x", $0) }.joined()
        NSLog("[voice] refreshRegistration (force=\(force)) — minting access token; voipToken=\(VoIPPushManager.short(tokenHex)) (len \(token.count) bytes)")

        // Mint a fresh Twilio access token from our backend. If Voice isn't
        // configured yet the endpoint returns 503 and this throws — we log and
        // bail so the app keeps working normally (incoming calls just aren't
        // wired up until the Twilio Voice SIDs exist).
        let voice: APIService.VoiceTokenResponse
        do {
            voice = try await APIService.shared.fetchVoiceToken()
        } catch {
            NSLog("[voice] ✗ Access-token fetch failed (Voice may not be configured — backend returns 503 until the 4 Twilio Voice SIDs are set): \(error.localizedDescription)")
            return
        }

        cachedAccessToken = voice.token
        cachedIceServers = voice.iceServers
        identity = voice.identity
        LocalStorageService.shared.voiceIdentity = voice.identity
        NSLog("[voice] access token minted — identity=\(voice.identity) ttl=\(voice.ttl ?? -1)s; calling TwilioVoiceSDK.register…")

        // Tell Twilio to route incoming VoIP pushes for this identity to this token.
        do {
            try await TwilioVoiceSDK.register(accessToken: voice.token, deviceToken: token)
            // NOTE: success here only means Twilio ACCEPTED the registration. It does
            // NOT prove a push can be delivered — that additionally requires the
            // Push Credential's APNs environment (sandbox/production) to match this
            // build. Watch for the "[voip-push] ⬇︎ didReceiveIncomingPush" line on a
            // real test call to confirm end-to-end delivery.
            NSLog("[voice] ✓ Registered for VoIP push as \(voice.identity).")
            // Only arm the 10-min throttle on SUCCESS, so a failed registration is
            // retried on the next launch/foreground instead of being suppressed.
            lastRegisteredAt = Date()
        } catch {
            NSLog("[voice] ✗ Twilio VoIP registration error: \(error.localizedDescription)")
        }

        // Mirror the registration to our backend so the device row carries the
        // VoIP token + identity (used later by inbound TwiML to dial this client).
        try? await APIService.shared.syncDeviceRegistration()
    }

    /// De-register on logout: remove the Twilio binding and clear local state so
    /// a signed-out device stops receiving calls.
    func unregister() {
        if let token = voipToken, let access = cachedAccessToken {
            TwilioVoiceSDK.unregister(accessToken: access, deviceToken: token) { error in
                if let error = error {
                    NSLog("[voice] Twilio unregister error: \(error.localizedDescription)")
                } else {
                    NSLog("[voice] Unregistered from VoIP push.")
                }
            }
        }
        voipToken = nil
        cachedAccessToken = nil
        cachedIceServers = nil
        identity = nil
        lastRegisteredAt = nil
        LocalStorageService.shared.voipToken = nil
        LocalStorageService.shared.voiceIdentity = nil
    }

    // MARK: - ICE (relay) options

    /// Build Twilio `IceOptions` from the relay servers our backend fetched from NTS,
    /// or nil when none were provided (Voice/NTS not configured) — in which case the
    /// call is built without `iceOptions`, exactly as before.
    ///
    /// `transportPolicy` is `.relay`: the call gathers ONLY relay (TURN) candidates so
    /// one is nominated immediately, instead of the SDK first probing the direct / STUN
    /// path and waiting ~5-7s for it to time out on cellular before falling back. This
    /// is safe precisely because this method only runs when the server list is
    /// non-empty — it can never force `.relay` with no relay available (a nil return
    /// leaves the call on the SDK's default `.all` behavior). The cost is a few ms of
    /// extra latency routing through the pinned Ashburn TURN, negligible for voice.
    private func makeIceOptions(from servers: [APIService.VoiceTokenResponse.ICEServer]?) -> IceOptions? {
        guard let servers, !servers.isEmpty else { return nil }
        let iceServers: [IceServer] = servers.compactMap { server in
            guard let urlString = server.urls ?? server.url, !urlString.isEmpty else { return nil }
            return IceServer(urlString: urlString, username: server.username, password: server.credential)
        }
        guard !iceServers.isEmpty else { return nil }
        return IceOptions { builder in
            builder.servers = iceServers
            builder.transportPolicy = .relay
        }
    }

    // MARK: - Incoming push

    /// Entry point from the PushKit incoming-push handler. iOS 13+ terminates an
    /// app that receives a VoIP push without reporting a call to CallKit, so for
    /// EVERY push we must end up calling reportNewIncomingCall before returning.
    /// `handleNotification` (delegateQueue: nil) invokes `callInviteReceived`
    /// synchronously on this (main) thread, which reports the call. If the
    /// payload isn't a valid Twilio Voice push we still report a throwaway call
    /// and immediately end it to honor the OS contract.
    func handleIncomingPush(payload: PKPushPayload, completion: @escaping () -> Void) {
        let handled = TwilioVoiceSDK.handleNotification(payload.dictionaryPayload, delegate: self, delegateQueue: nil)
        NSLog("[voice] handleIncomingPush → TwilioVoiceSDK.handleNotification handled=\(handled)")
        if !handled {
            NSLog("[voice] Received a non-Twilio VoIP push; reporting and ending a placeholder call.")
            let uuid = UUID()
            CallKitProvider.shared.reportIncomingCall(uuid: uuid, handle: "Unknown") { _ in
                CallKitProvider.shared.reportCallEnded(uuid: uuid, reason: .failed)
            }
        }
        completion()
    }

    // MARK: - CallKit action handlers (invoked by CallKitProvider)

    func performAnswer(uuid: UUID, completion: @escaping (Bool) -> Void) {
        guard let invite = activeCallInvites[uuid.uuidString] else {
            completion(false)
            return
        }
        // Answer with FRESH relay creds. `cachedIceServers` was captured at
        // registration and can be nil on a cold launch from a push, or stale if we
        // registered over an hour ago — either way the answer drops onto the slow
        // direct/STUN path. Mint a fresh Voice token (it carries current NTS relay
        // servers) right before building AcceptOptions, and fall back to the cached
        // servers — or none — on any failure so this never fails the call. The Twilio
        // accept is deferred by one token fetch; the CallKit action is fulfilled by the
        // provider right after this returns, so the ring UI is never held up.
        Task { @MainActor in
            var servers = self.cachedIceServers
            do {
                let voice = try await APIService.shared.fetchVoiceToken()
                if let fresh = voice.iceServers, !fresh.isEmpty {
                    servers = fresh
                    self.cachedIceServers = fresh   // refresh the cache for later reuse
                }
            } catch {
                NSLog("[voice] inbound ICE refresh failed; using cached relay servers: \(error.localizedDescription)")
            }
            // The caller may have hung up (or the user declined) while the token was in
            // flight — only accept if this invite is still the pending one.
            guard self.activeCallInvites[uuid.uuidString] != nil else {
                NSLog("[voice] inbound answer aborted — invite no longer pending (cancelled/declined during ICE fetch)")
                completion(false)
                return
            }
            self.acceptInvite(invite, reportedUUID: uuid, iceServers: servers, completion: completion)
        }
    }

    /// Accept a pending CallInvite with the given relay servers and mirror the answered
    /// call into the in-app call-screen state. Split out of `performAnswer` so the
    /// answer can first fetch fresh relay creds; the logic below is unchanged from the
    /// prior inline accept. Runs on the main thread (via performAnswer's @MainActor Task).
    private func acceptInvite(_ invite: CallInvite,
                              reportedUUID uuid: UUID,
                              iceServers: [APIService.VoiceTokenResponse.ICEServer]?,
                              completion: @escaping (Bool) -> Void) {
        let acceptOptions = AcceptOptions(callInvite: invite) { builder in
            builder.uuid = invite.uuid
            // Hand the answered call the relay servers so cellular audio comes up
            // straight on the TURN relay path (skipped if none are available).
            if let iceOptions = self.makeIceOptions(from: iceServers) {
                builder.iceOptions = iceOptions
            }
        }
        answerCompletion = completion
        let call = invite.accept(options: acceptOptions, delegate: self)
        let key = call.uuid?.uuidString ?? uuid.uuidString
        activeCalls[key] = call
        // Mirror the answered call into the in-app call-screen state.
        currentCallUUID = call.uuid ?? uuid
        activeCallHandle = (invite.from ?? incomingCallerNumber)?.replacingOccurrences(of: "client:", with: "")
        activeCallName = nil
        isMuted = false
        isSpeakerOn = false
        activeCallInvites.removeValue(forKey: uuid.uuidString)
        incomingCallerNumber = nil
        incomingCallUUID = nil
        hasActiveCall = true
    }

    func performEnd(uuid: UUID) {
        if let invite = activeCallInvites[uuid.uuidString] {
            // Decline before answering → Twilio falls through to the server's
            // voicemail greeting (handled entirely server-side; not touched here).
            invite.reject()
            activeCallInvites.removeValue(forKey: uuid.uuidString)
        } else if let call = activeCalls[uuid.uuidString] {
            userInitiatedDisconnect = true
            call.disconnect()
        }
        if incomingCallUUID == uuid {
            incomingCallerNumber = nil
            incomingCallUUID = nil
        }
        // An outbound call ended/declined before connecting: drop its pending state.
        pendingOutgoing.removeValue(forKey: uuid.uuidString)
        outgoingCallUUIDs.remove(uuid.uuidString)
    }

    // MARK: - Outgoing calls

    /// Public entry point for placing a call — used by the in-app "Call" button and
    /// by the call-log redial intent. Mints a fresh Voice access token, then asks
    /// CallKit to start the outgoing call so the NATIVE system call screen appears;
    /// the actual Twilio connect happens in `performStartCall` when the system
    /// performs the CXStartCallAction. `onError` (main thread) fires if Voice isn't
    /// configured / the token can't be minted, so the UI shows a message instead of
    /// a dead call screen. Outbound calls are NOT recorded.
    func startOutgoingCall(to rawNumber: String, displayName: String?, onError: ((String) -> Void)? = nil) {
        let to = rawNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !to.isEmpty else {
            onError?("There's no phone number to call.")
            return
        }

        Task { @MainActor in
            let voice: APIService.VoiceTokenResponse
            do {
                voice = try await APIService.shared.fetchVoiceToken()
            } catch {
                NSLog("[voice] ✗ outbound token mint failed (Voice may not be configured): \(error.localizedDescription)")
                onError?("Calling isn’t available right now. Please try again later.")
                return
            }

            let uuid = UUID()
            pendingOutgoing[uuid.uuidString] = PendingOutgoing(to: to, displayName: displayName, accessToken: voice.token, iceServers: voice.iceServers)
            identity = voice.identity
            NSLog("[voice] startOutgoingCall → \(to) as \(voice.identity) (uuid \(uuid.uuidString))")
            CallKitProvider.shared.startOutgoingCall(uuid: uuid, handle: to, displayName: displayName)
        }
    }

    /// Invoked by CallKitProvider when the system performs the CXStartCallAction.
    /// Connects the Twilio call using the destination + token stashed by
    /// `startOutgoingCall`. Returns whether the connect was kicked off so the
    /// provider can fulfill/fail the action. Reuses the SAME DefaultAudioDevice the
    /// inbound path uses — CallKit's didActivate enables it; no AVAudioSession
    /// reconfiguration here.
    func performStartCall(uuid: UUID) -> Bool {
        guard let pending = pendingOutgoing[uuid.uuidString] else {
            NSLog("[voice] performStartCall — no pending outgoing for \(uuid.uuidString)")
            return false
        }
        let connectOptions = ConnectOptions(accessToken: pending.accessToken) { builder in
            // `To` is read by the backend's /api/voice/outbound TwiML endpoint, which
            // <Dial>s it presenting the business's verified caller ID.
            builder.params = ["To": pending.to]
            builder.uuid = uuid
            // Hand the call the relay servers fetched with this token so cellular
            // audio comes up straight on the TURN relay path (skipped if none provided).
            if let iceOptions = self.makeIceOptions(from: pending.iceServers) {
                builder.iceOptions = iceOptions
            }
        }
        let call = TwilioVoiceSDK.connect(options: connectOptions, delegate: self)
        activeCalls[uuid.uuidString] = call
        outgoingCallUUIDs.insert(uuid.uuidString)
        hasActiveCall = true
        // Mirror the outbound call into the in-app call-screen state ("Calling…"
        // until callDidConnect stamps callConnectedAt and starts the timer).
        currentCallUUID = uuid
        activeCallHandle = pending.to
        activeCallName = pending.displayName
        isMuted = false
        isSpeakerOn = false
        NSLog("[voice] ▶︎ outbound connect started → \(pending.to) (uuid \(uuid.uuidString))")
        return true
    }

    /// Called by CallKitProvider when the CXStartCallAction transaction request
    /// itself fails (e.g. another call is already active), before the call ever
    /// reaches the provider. Tears down the pending outbound state.
    func outgoingTransactionFailed(uuid: UUID) {
        pendingOutgoing.removeValue(forKey: uuid.uuidString)
        outgoingCallUUIDs.remove(uuid.uuidString)
        if let call = activeCalls.removeValue(forKey: uuid.uuidString) {
            call.disconnect()
        }
        if activeCalls.isEmpty {
            hasActiveCall = false
            clearActiveCallUIState()
        }
    }

    // MARK: - In-call controls (invoked by the in-app call screen)

    /// Toggle mute on the active call by flipping the Twilio Call's `isMuted`.
    /// Touches only the existing call object — no audio-session work.
    func toggleMute() {
        guard let id = currentCallUUID?.uuidString, let call = activeCalls[id] else { return }
        call.isMuted.toggle()
        isMuted = call.isMuted
    }

    /// Route call audio to the speaker (or back to the receiver) via the shared
    /// AVAudioSession output-port override — the standard speaker toggle. It does
    /// NOT change the session category/mode, touch the DefaultAudioDevice, or
    /// re-activate the session.
    func setSpeaker(_ on: Bool) {
        do {
            try AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
            isSpeakerOn = on
        } catch {
            NSLog("[voice] speaker override failed: \(error.localizedDescription)")
        }
    }

    func toggleSpeaker() { setSpeaker(!isSpeakerOn) }

    /// Send DTMF tone(s) on the active call — used by the in-app keypad. Forwards to
    /// the EXISTING Twilio `Call.sendDigits(_:)` on the in-progress call, exactly as
    /// `toggleMute` flips the call's `isMuted`. It does not touch the audio session,
    /// CallKit, call setup, or recording. No-op when there's no active call. The SDK
    /// accepts 0-9, `*`, `#`, and `w` (a half-second pause); other characters are ignored.
    func sendDigits(_ digits: String) {
        guard let id = currentCallUUID?.uuidString, let call = activeCalls[id] else { return }
        call.sendDigits(digits)
    }

    /// End the active call through CallKit (CXEndCallAction) — the same path the
    /// native red End button uses (CallKitProvider → performEnd → disconnect).
    func endActiveCall() {
        guard let uuid = currentCallUUID else { return }
        CallKitProvider.shared.endCall(uuid: uuid)
    }

    // MARK: - Audio session (invoked by CallKitProvider)

    func audioSessionActivated() { audioDevice.isEnabled = true }
    func audioSessionDeactivated() { audioDevice.isEnabled = false }

    func providerReset() {
        audioDevice.isEnabled = false
        activeCalls.removeAll()
        activeCallInvites.removeAll()
        pendingOutgoing.removeAll()
        outgoingCallUUIDs.removeAll()
        incomingCallerNumber = nil
        incomingCallUUID = nil
        hasActiveCall = false
        clearActiveCallUIState()
    }

    /// Reset the in-app call-screen's published state once no call remains.
    private func clearActiveCallUIState() {
        currentCallUUID = nil
        activeCallHandle = nil
        activeCallName = nil
        callConnectedAt = nil
        isMuted = false
        isSpeakerOn = false
    }

    private func cleanup(call: Call) {
        if let id = call.uuid?.uuidString {
            activeCalls.removeValue(forKey: id)
            pendingOutgoing.removeValue(forKey: id)
            outgoingCallUUIDs.remove(id)
        }
        userInitiatedDisconnect = false
        if activeCalls.isEmpty {
            hasActiveCall = false
            incomingCallerNumber = nil
            incomingCallUUID = nil
            clearActiveCallUIState()
        }
    }
}

// MARK: - NotificationDelegate (incoming invites)

extension VoiceCallManager: NotificationDelegate {

    func callInviteReceived(callInvite: CallInvite) {
        // Surface the caller's real phone number (server-side caller-ID
        // passthrough already populates `from`); strip any "client:" prefix.
        let from = (callInvite.from ?? "Unknown").replacingOccurrences(of: "client:", with: "")
        NSLog("[voice] ✓ callInviteReceived from=\(from) callSid=\(callInvite.callSid) — reporting to CallKit")
        incomingCallerNumber = from
        incomingCallUUID = callInvite.uuid
        activeCallInvites[callInvite.uuid.uuidString] = callInvite

        // Report to CallKit immediately (we're still inside the push handler).
        CallKitProvider.shared.reportIncomingCall(uuid: callInvite.uuid, handle: from)
    }

    func cancelledCallInviteReceived(cancelledCallInvite: CancelledCallInvite, error: Error) {
        // Caller hung up (or it timed out) before the user answered. Tear down
        // the CallKit UI for the matching invite.
        guard let invite = activeCallInvites.values.first(where: { $0.callSid == cancelledCallInvite.callSid }) else { return }
        CallKitProvider.shared.reportCallEnded(uuid: invite.uuid, reason: .remoteEnded)
        activeCallInvites.removeValue(forKey: invite.uuid.uuidString)
        if incomingCallUUID == invite.uuid {
            incomingCallerNumber = nil
            incomingCallUUID = nil
        }
    }
}

// MARK: - CallDelegate (in-call lifecycle)

extension VoiceCallManager: CallDelegate {

    func callDidConnect(call: Call) {
        NSLog("[voice] callDidConnect")
        answerCompletion?(true)
        answerCompletion = nil
        // For outbound calls, tell CallKit the call connected so the native screen
        // switches from "Calling…" to the running call timer. Inbound answers are
        // already reported as connected by CallKit when the user accepts.
        if let id = call.uuid?.uuidString, outgoingCallUUIDs.contains(id) {
            CallKitProvider.shared.reportOutgoingConnected(uuid: call.uuid)
        }
        // Stamp the connect moment so the in-app call screen's timer counts from here.
        callConnectedAt = Date()
        hasActiveCall = true
    }

    func callDidFailToConnect(call: Call, error: Error) {
        NSLog("[voice] callDidFailToConnect: \(error.localizedDescription)")
        answerCompletion?(false)
        answerCompletion = nil
        CallKitProvider.shared.reportCallEnded(uuid: call.uuid, reason: .failed)
        cleanup(call: call)
    }

    func callDidDisconnect(call: Call, error: Error?) {
        NSLog("[voice] callDidDisconnect: \(error?.localizedDescription ?? "clean")")
        // If the user ended the call via CallKit we already initiated the end, so
        // CallKit knows; only report system-side for remote/error disconnects.
        if !userInitiatedDisconnect {
            CallKitProvider.shared.reportCallEnded(uuid: call.uuid, reason: error != nil ? .failed : .remoteEnded)
        }
        cleanup(call: call)
    }
}
