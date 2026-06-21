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

    // VoIP push token (raw Data from PushKit) + the last access token we minted,
    // needed for register/unregister with Twilio.
    private var voipToken: Data? = nil
    private var cachedAccessToken: String? = nil
    private var lastRegisteredAt: Date? = nil

    // Set true right before we disconnect a call on the user's behalf so the
    // disconnect callback doesn't redundantly re-report the end to CallKit.
    private var userInitiatedDisconnect = false
    private var answerCompletion: ((Bool) -> Void)? = nil

    private override init() {
        super.init()
        TwilioVoiceSDK.audioDevice = audioDevice
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
        identity = nil
        lastRegisteredAt = nil
        LocalStorageService.shared.voipToken = nil
        LocalStorageService.shared.voiceIdentity = nil
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
        let acceptOptions = AcceptOptions(callInvite: invite) { builder in
            builder.uuid = invite.uuid
        }
        answerCompletion = completion
        let call = invite.accept(options: acceptOptions, delegate: self)
        let key = call.uuid?.uuidString ?? uuid.uuidString
        activeCalls[key] = call
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
    }

    // MARK: - Audio session (invoked by CallKitProvider)

    func audioSessionActivated() { audioDevice.isEnabled = true }
    func audioSessionDeactivated() { audioDevice.isEnabled = false }

    func providerReset() {
        audioDevice.isEnabled = false
        activeCalls.removeAll()
        activeCallInvites.removeAll()
        incomingCallerNumber = nil
        incomingCallUUID = nil
        hasActiveCall = false
    }

    private func cleanup(call: Call) {
        if let id = call.uuid?.uuidString { activeCalls.removeValue(forKey: id) }
        userInitiatedDisconnect = false
        if activeCalls.isEmpty {
            hasActiveCall = false
            incomingCallerNumber = nil
            incomingCallUUID = nil
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
