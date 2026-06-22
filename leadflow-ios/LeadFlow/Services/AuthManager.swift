import Foundation
import Combine

// MARK: - Auth models
//
// These mirror the backend's auth responses exactly (see server/routes/auth.js):
//   POST /api/auth/login  -> { token, user, business }
//   GET  /api/auth/me     -> { user, business }
// `user` is the publicUser() shape; `business` is the row's public columns. We
// decode network payloads with `.convertFromSnakeCase`, so the backend's
// snake_case columns (subscription_status, …) map to these camelCase fields,
// while already-camelCase keys (businessId) pass through unchanged.

/// The signed-in user. `role` underpins the upcoming owner/driver split — the
/// backend already stamps every user with a role ('owner' for accounts created
/// via signup; business_id 1 is the Stream admin). We surface it now so later
/// role-gated screens can branch without re-plumbing the session.
struct AuthUser: Codable, Equatable {
    let id: Int
    let email: String
    let role: String?
    let businessId: Int?

    /// Parsed role with a sensible default. Unknown/missing roles fall back to
    /// `.owner` so the current single-role app behaves exactly as before.
    var parsedRole: UserRole { UserRole(rawValue: (role ?? "").lowercased()) ?? .owner }
}

/// The tenant the user belongs to. Fields are optional so a column the backend
/// stops returning never breaks decoding.
struct AuthBusiness: Codable, Equatable {
    let id: Int
    let name: String?
    let slug: String?
    let subscriptionStatus: String?
    let industryType: String?
    let ownerFirstName: String?
}

/// Known account roles. `driver` is reserved for the next feature (an owner adds
/// drivers who get a limited view) — it's defined here so the session model is
/// already role-aware; no driver UI exists yet.
enum UserRole: String, Equatable {
    case owner
    case admin
    case driver
    case user

    var isPrivileged: Bool { self == .owner || self == .admin }
}

/// Login + /me response envelope.
struct AuthResponse: Codable {
    let token: String?
    let user: AuthUser
    let business: AuthBusiness
}

/// What we cache locally (NOT the token — that's in the Keychain) so a relaunch
/// can show the right identity/role immediately, before the /me refresh lands.
private struct SessionCache: Codable {
    let user: AuthUser
    let business: AuthBusiness
}

// MARK: - Auth Manager

/// Single source of truth for the app's authentication state. Owns the session,
/// drives the login gate in `RootView`, and reacts to 401s from anywhere in the
/// app by signing out. `@MainActor` because it publishes UI state.
@MainActor
final class AuthManager: ObservableObject {
    static let shared = AuthManager()

    enum State {
        case loading          // deciding at launch whether a stored token is good
        case authenticated
        case unauthenticated
    }

    @Published private(set) var state: State = .loading
    @Published private(set) var user: AuthUser?
    @Published private(set) var business: AuthBusiness?

    /// Convenience for role-gated UI. Defaults to `.owner` until a user loads.
    var role: UserRole { user?.parsedRole ?? .owner }
    var isAuthenticated: Bool { state == .authenticated }

    private let storage = LocalStorageService.shared
    private let keychain = KeychainService.shared

    private init() {
        // Any API call that returns 401 posts .authUnauthorized; treat that as a
        // session expiry and sign out (clears the token + returns to login).
        NotificationCenter.default.addObserver(
            forName: .authUnauthorized, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.handleUnauthorized() }
        }
    }

    // MARK: Launch

    /// Decide the initial state. With no token → login. With a token → optimistically
    /// authenticate using the cached identity (so role/email are known instantly
    /// and the app works offline), then refresh from /api/auth/me. A 401 during the
    /// refresh flows through the notification path and signs out; other failures
    /// (e.g. offline) leave the cached session in place.
    func bootstrap() async {
        guard keychain.hasToken else {
            applySignedOut()
            return
        }
        restoreCachedSession()
        state = .authenticated

        do {
            let me = try await APIService.shared.fetchMe()
            apply(user: me.user, business: me.business)
        } catch {
            // Non-401 errors (network, server hiccup): keep the optimistic session.
            // 401 is handled by handleUnauthorized() via .authUnauthorized.
            NSLog("[auth] bootstrap refresh failed (keeping cached session): \(error.localizedDescription)")
        }
    }

    // MARK: Login / logout

    /// Authenticate against the backend, persist the JWT, and flip to the app.
    /// Throws on bad credentials / network failure so the login screen can show a
    /// message. Mirrors the web's contract: POST /api/auth/login { email, password }.
    func login(email: String, password: String) async throws {
        let resp = try await APIService.shared.login(email: email, password: password)
        guard let token = resp.token, !token.isEmpty else {
            throw APIError.invalidResponse
        }
        keychain.token = token
        apply(user: resp.user, business: resp.business)
        state = .authenticated

        // Now that requests carry the user's JWT, (re)register this device for
        // incoming calls under the authenticated Voice identity, and refresh the
        // server device row to the signed-in business. Best-effort — never blocks
        // login, and never touches the call stack itself.
        VoiceCallManager.shared.register()
        Task { try? await APIService.shared.syncDeviceRegistration() }
    }

    /// Explicit sign-out from Settings. Drops the server device binding and the
    /// Twilio VoIP registration first (while the token is still valid), then clears
    /// local session and returns to the login screen.
    func logout() async {
        await APIService.shared.unregisterDevice()
        VoiceCallManager.shared.unregister()
        applySignedOut()
    }

    /// Reaction to a 401 from any API call: the stored token is invalid/expired, so
    /// tear down the Twilio binding and sign out. Idempotent.
    func handleUnauthorized() {
        guard state != .unauthenticated else { return }
        NSLog("[auth] 401 received — clearing session and returning to login")
        VoiceCallManager.shared.unregister()
        applySignedOut()
    }

    // MARK: Session plumbing

    private func apply(user: AuthUser, business: AuthBusiness) {
        self.user = user
        self.business = business
        cacheSession(user: user, business: business)
    }

    private func applySignedOut() {
        keychain.token = nil
        clearCachedSession()
        user = nil
        business = nil
        state = .unauthenticated
    }

    private func cacheSession(user: AuthUser, business: AuthBusiness) {
        let cache = SessionCache(user: user, business: business)
        storage.authSessionData = try? JSONEncoder().encode(cache)
    }

    private func restoreCachedSession() {
        guard let data = storage.authSessionData,
              let cache = try? JSONDecoder().decode(SessionCache.self, from: data)
        else { return }
        user = cache.user
        business = cache.business
    }

    private func clearCachedSession() {
        storage.authSessionData = nil
    }
}

// MARK: - Notifications

extension Notification.Name {
    /// Posted by APIService when a request comes back 401. AuthManager observes it
    /// to sign the user out from anywhere in the app.
    static let authUnauthorized = Notification.Name("app.joinstream.leadflow.authUnauthorized")
}
