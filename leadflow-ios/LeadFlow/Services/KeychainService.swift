import Foundation
import Security

// MARK: - Keychain Service
//
// Secure storage for the auth JWT. Tokens are credentials, so they live in the
// iOS Keychain rather than UserDefaults (which is plain, file-backed, and not
// meant for secrets).
//
// Accessibility is kSecAttrAccessibleAfterFirstUnlock so the token is readable
// while the device is locked *after* the first post-boot unlock. That matters
// here: the app makes authenticated requests from the background (VoIP-push
// device registration, pending-recording uploads), which would fail if the
// token were only readable while the screen is unlocked.

final class KeychainService {
    static let shared = KeychainService()
    private init() {}

    // A single generic-password item identifies the stored JWT.
    private let service = "app.joinstream.leadflow.auth"
    private let account = "jwt"

    /// The stored JWT, or nil when signed out. Setting nil deletes the item.
    var token: String? {
        get { read() }
        set {
            if let newValue, !newValue.isEmpty {
                save(newValue)
            } else {
                delete()
            }
        }
    }

    var hasToken: Bool { read() != nil }

    // MARK: - Private

    @discardableResult
    private func save(_ value: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }

        // SecItemAdd fails with errSecDuplicateItem if a row already exists, so
        // clear any prior value first, then insert fresh.
        delete()

        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status != errSecSuccess {
            NSLog("[keychain] save failed (OSStatus \(status))")
        }
        return status == errSecSuccess
    }

    private func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else { return nil }
        return token
    }

    @discardableResult
    private func delete() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
