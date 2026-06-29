// CallKitProvider.swift
// LeadFlow
//
// Thin wrapper around CXProvider / CXCallController for the native incoming-call
// UI. Reports incoming calls to CallKit and routes the user's answer/end actions
// back to VoiceCallManager. Holds no Twilio types — it only speaks CallKit.

import Foundation
import CallKit
import AVFoundation

final class CallKitProvider: NSObject {

    static let shared = CallKitProvider()

    let provider: CXProvider
    let callController = CXCallController()

    private override init() {
        let configuration = CXProviderConfiguration()
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportsVideo = false
        configuration.supportedHandleTypes = [.phoneNumber, .generic]
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil) // nil → callbacks on the main queue
    }

    // MARK: Incoming

    /// Present the native incoming-call screen. `handle` is the caller's real
    /// phone number when available (shown as the caller ID).
    func reportIncomingCall(uuid: UUID, handle: String, completion: ((Error?) -> Void)? = nil) {
        let update = CXCallUpdate()
        update.remoteHandle = makeHandle(handle)
        update.hasVideo = false
        update.supportsDTMF = true
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false

        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            if let error = error {
                NSLog("[callkit] reportNewIncomingCall failed: \(error.localizedDescription)")
            }
            completion?(error)
        }
    }

    /// End a call from our side (e.g. caller cancelled) via a CallKit transaction.
    func endCall(uuid: UUID) {
        let transaction = CXTransaction(action: CXEndCallAction(call: uuid))
        callController.request(transaction) { error in
            if let error = error {
                NSLog("[callkit] endCall request failed: \(error.localizedDescription)")
            }
        }
    }

    /// Report (system-side) that a call has ended — used for remote/failed
    /// disconnects and for the invalid-push safety net.
    func reportCallEnded(uuid: UUID?, reason: CXCallEndedReason) {
        guard let uuid = uuid else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
    }

    // MARK: Outgoing

    /// Ask CallKit to place an outgoing call. This presents the NATIVE system call
    /// screen (Calling… → in-call with mute / speaker / keypad, plus the green
    /// status-bar tap-to-return-to-call). The actual Twilio connect happens when
    /// the system performs the resulting CXStartCallAction (see the delegate
    /// below). `handle` is the destination phone number; `displayName` (optional)
    /// is shown as the callee's name on the call screen.
    func startOutgoingCall(uuid: UUID, handle: String, displayName: String?) {
        let action = CXStartCallAction(call: uuid, handle: makeHandle(handle))
        action.isVideo = false
        if let displayName = displayName, !displayName.isEmpty {
            action.contactIdentifier = displayName
        }
        let transaction = CXTransaction(action: action)
        callController.request(transaction) { error in
            if let error = error {
                NSLog("[callkit] startOutgoingCall request failed: \(error.localizedDescription)")
                // The action never reached the provider; tear down pending state.
                VoiceCallManager.shared.outgoingTransactionFailed(uuid: uuid)
            }
        }
    }

    /// Report that an outgoing call has begun connecting (native UI shows "Calling…").
    func reportOutgoingStartedConnecting(uuid: UUID) {
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
    }

    /// Report that an outgoing call has connected (native UI starts the call timer).
    func reportOutgoingConnected(uuid: UUID?) {
        guard let uuid = uuid else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    // Use a .phoneNumber handle for real numbers (lets CallKit match contacts /
    // show a recognizable caller ID); fall back to .generic otherwise.
    private func makeHandle(_ value: String) -> CXHandle {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return CXHandle(type: .generic, value: "Unknown") }
        let looksNumeric = trimmed.first == "+" || trimmed.allSatisfy { $0.isNumber || $0 == "+" }
        return looksNumeric ? CXHandle(type: .phoneNumber, value: trimmed)
                            : CXHandle(type: .generic, value: trimmed)
    }
}

// MARK: - CXProviderDelegate

extension CallKitProvider: CXProviderDelegate {

    func providerDidReset(_ provider: CXProvider) {
        NSLog("[callkit] providerDidReset")
        VoiceCallManager.shared.providerReset()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        VoiceCallManager.shared.audioSessionActivated()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        VoiceCallManager.shared.audioSessionDeactivated()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        VoiceCallManager.shared.performAnswer(uuid: action.callUUID) { _ in }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        // Surface the destination (and name, if any) on the native call screen.
        let update = CXCallUpdate()
        update.remoteHandle = action.handle
        if let name = action.contactIdentifier, !name.isEmpty {
            update.localizedCallerName = name
        }
        update.hasVideo = false
        update.supportsDTMF = true
        update.supportsHolding = false
        provider.reportCall(with: action.callUUID, updated: update)

        // Move the UI into "Calling…", then kick off the Twilio connect. The system
        // activates the audio session after we fulfill, driving the shared
        // DefaultAudioDevice via provider(_:didActivate:) — same path as inbound.
        reportOutgoingStartedConnecting(uuid: action.callUUID)
        if VoiceCallManager.shared.performStartCall(uuid: action.callUUID) {
            action.fulfill()
        } else {
            action.fail()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        VoiceCallManager.shared.performEnd(uuid: action.callUUID)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        NSLog("[callkit] timed out performing action")
    }
}
