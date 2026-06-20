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
    }

    // MARK: PKPushRegistryDelegate

    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        VoiceCallManager.shared.updateVoipToken(credentials.token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        VoiceCallManager.shared.invalidateVoipToken()
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType,
                      completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        // Hand off to VoiceCallManager, which reports the incoming call to CallKit
        // synchronously before `completion()` is invoked (iOS 13+ requirement).
        VoiceCallManager.shared.handleIncomingPush(payload: payload, completion: completion)
    }
}
