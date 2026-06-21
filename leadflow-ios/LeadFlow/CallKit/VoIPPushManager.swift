// VoIPPushManager.swift
// LeadFlow
//
// Owns the PKPushRegistry for VoIP pushes. Must be initialized at app launch —
// delaying it can cause iOS to drop VoIP pushes and terminate the app for not
// reporting them to CallKit. Forwards all events to VoiceCallManager.

import Foundation
import UIKit
import PushKit

final class VoIPPushManager: NSObject, PKPushRegistryDelegate {

    static let shared = VoIPPushManager()

    private var voipRegistry: PKPushRegistry?

    private override init() {}

    /// Call once, early in didFinishLaunchingWithOptions.
    func initialize() {
        guard voipRegistry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
        NSLog("[voip-push] PushKit initialized (desiredPushTypes=[voIP]); awaiting VoIP token from APNs…")
    }

    // MARK: PKPushRegistryDelegate

    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        // First proof that the entitlement/provisioning is wired up: if this never
        // fires, the app has no VoIP token and nothing downstream can ring.
        let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
        NSLog("[voip-push] didUpdate VoIP token: \(VoIPPushManager.short(hex)) (len \(credentials.token.count) bytes)")
        VoiceCallManager.shared.updateVoipToken(credentials.token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        NSLog("[voip-push] didInvalidatePushToken — VoIP token revoked; will need to re-register")
        VoiceCallManager.shared.invalidateVoipToken()
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType,
                      completion: @escaping () -> Void) {
        // THE key diagnostic line: if a real inbound call NEVER produces this log,
        // the VoIP push was not delivered to the device at all (APNs dropped it) —
        // which almost always means the Twilio Voice Push Credential's APNs
        // environment (sandbox vs production) doesn't match this build's
        // aps-environment, or the VoIP cert/bundle id is wrong. If this DOES log
        // but no CallKit screen appears, the break is in handling (below), not
        // delivery.
        NSLog("[voip-push] ⬇︎ didReceiveIncomingPush (type=\(type.rawValue)) payloadKeys=\(Array(payload.dictionaryPayload.keys))")
        guard type == .voIP else { completion(); return }
        // Hand off to VoiceCallManager, which reports the incoming call to CallKit
        // synchronously before `completion()` is invoked (iOS 13+ requirement).
        VoiceCallManager.shared.handleIncomingPush(payload: payload, completion: completion)
    }

    /// Short, log-safe prefix of a hex token (avoids dumping the full token).
    static func short(_ hex: String) -> String {
        hex.count > 10 ? "\(hex.prefix(10))…" : hex
    }
}
