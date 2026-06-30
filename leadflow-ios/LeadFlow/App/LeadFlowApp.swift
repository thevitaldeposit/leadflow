import SwiftUI
import UIKit
import UserNotifications
import Intents

@main
struct LeadFlowApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var notificationService = NotificationService.shared
    @StateObject private var auth = AuthManager.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(notificationService)
                .environmentObject(auth)
                .task { await auth.bootstrap() }
                // Redial from the iOS call log / Siri: tapping a Stream number hands
                // the app an INStartCallIntent (or legacy audio variant) which we
                // route into the same outbound flow as the in-app Call button. This
                // is the reliable hook under the SwiftUI scene lifecycle (cold + warm).
                .onContinueUserActivity("INStartCallIntent") { activity in
                    OutboundCallRouter.handle(activity)
                }
                .onContinueUserActivity("INStartAudioCallIntent") { activity in
                    OutboundCallRouter.handle(activity)
                }
        }
    }
}

// MARK: - Outbound call routing (call-log redial / Siri)

// Routes a system "call" hand-off into the in-app outbound flow. iOS hands the app
// an INStartCallIntent (or the legacy INStartAudioCallIntent) when the user taps a
// Stream number in the call history; we pull the destination number out and place
// the call exactly like the in-app Call button — fixing the prior behavior where a
// call-log tap merely opened the app and did nothing.
enum OutboundCallRouter {
    @discardableResult
    static func handle(_ userActivity: NSUserActivity) -> Bool {
        guard let target = destination(from: userActivity) else {
            NSLog("[voice] continue userActivity '\(userActivity.activityType)' carried no callable handle")
            return false
        }
        NSLog("[voice] redial from call log → \(target.number)")
        VoiceCallManager.shared.startOutgoingCall(to: target.number, displayName: target.name) { message in
            NSLog("[voice] redial failed: \(message)")
        }
        return true
    }

    private static func destination(from userActivity: NSUserActivity) -> (number: String, name: String?)? {
        let intent = userActivity.interaction?.intent
        if let startCall = intent as? INStartCallIntent,
           let contact = startCall.contacts?.first,
           let value = contact.personHandle?.value, !value.isEmpty {
            return (value, contact.displayName)
        }
        if let startAudio = intent as? INStartAudioCallIntent,
           let contact = startAudio.contacts?.first,
           let value = contact.personHandle?.value, !value.isEmpty {
            return (value, contact.displayName)
        }
        return nil
    }
}

// MARK: - Root View (Auth gate)

// Outermost gate: validate a stored token at launch, then route to the login
// screen or the authenticated app. Onboarding/permissions live behind auth in
// AuthedRootView, so a signed-out user always sees login first.
struct RootView: View {
    @EnvironmentObject private var auth: AuthManager
    @EnvironmentObject private var notificationService: NotificationService

    var body: some View {
        switch auth.state {
        case .loading:
            LaunchView()
        case .unauthenticated:
            LoginView()
        case .authenticated:
            AuthedRootView()
                .environmentObject(notificationService)
        }
    }
}

// MARK: - Launch splash (brief, while a stored token is validated)

struct LaunchView: View {
    var body: some View {
        ZStack {
            Color(red: 0.039, green: 0.055, blue: 0.106).ignoresSafeArea()
            VStack(spacing: 18) {
                Image("StreamLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 48)
                ProgressView()
                    .tint(.white.opacity(0.6))
            }
        }
        .preferredColorScheme(.dark)
    }
}

// MARK: - Authenticated Root (Onboarding vs. Main)

struct AuthedRootView: View {
    @EnvironmentObject private var notificationService: NotificationService
    @State private var hasCompletedOnboarding = LocalStorageService.shared.hasCompletedOnboarding
    @State private var onboardingStep = 0
    @State private var selectedVertical: VerticalType? = nil
    @State private var userName = ""
    @State private var businessName = ""
    @State private var userPhone = ""

    var body: some View {
        if hasCompletedOnboarding {
            MainTabView()
                .environmentObject(notificationService)
        } else {
            onboardingFlow
        }
    }

    @ViewBuilder
    private var onboardingFlow: some View {
        switch onboardingStep {
        case 0:
            VerticalSelectView(selectedVertical: $selectedVertical) {
                if let v = selectedVertical {
                    LocalStorageService.shared.selectedVertical = v
                    onboardingStep = 1
                }
            }
        case 1:
            UserInfoView(userName: $userName, businessName: $businessName, userPhone: $userPhone) {
                let storage = LocalStorageService.shared
                storage.userName = userName
                storage.businessName = businessName
                storage.userPhone = userPhone
                onboardingStep = 2
            }
        default:
            PermissionsView {
                LocalStorageService.shared.hasCompletedOnboarding = true
                hasCompletedOnboarding = true
                _ = CallObserver.shared
            }
        }
    }
}

// MARK: - Main Tab View

struct MainTabView: View {
    @EnvironmentObject private var notificationService: NotificationService
    // Observe the call manager so an active call presents the in-app call screen
    // over the whole tab UI (the foreground gap the native CallKit screen leaves).
    @ObservedObject private var voice = VoiceCallManager.shared

    var body: some View {
        TabView {
            HomeDashboardView()
                .tabItem { Label("Home", systemImage: "house.fill") }
            DashboardView()
                .tabItem { Label("Leads", systemImage: "list.bullet.rectangle.portrait") }
                .environmentObject(notificationService)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        // Present the foreground call screen for BOTH inbound-answered and outbound
        // calls. Dismissal is driven by the call ending (hasActiveCall → false), so
        // the setter is a no-op — there's no user-interactive dismiss of a call.
        .fullScreenCover(isPresented: Binding(
            get: { voice.hasActiveCall },
            set: { _ in }
        )) {
            InAppCallScreen(voice: voice)
        }
    }
}

// MARK: - App Delegate

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // VoIP/CallKit incoming-call stack. PushKit MUST be initialized at launch
        // so iOS delivers VoIP pushes and doesn't terminate the app for failing to
        // report a call. register() mints a Voice token and registers once a VoIP
        // token is available; it no-ops gracefully when Voice isn't configured yet.
        VoIPPushManager.shared.initialize()
        VoiceCallManager.shared.register()

        _ = CallObserver.shared
        RecordingManager.shared.retryPendingUploads()
        NotificationService.shared.clearBadge()
        // Re-register for APNs if already authorized
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized {
                await MainActor.run { application.registerForRemoteNotifications() }
            }
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let tokenString = deviceToken.map { String(format: "%02x", $0) }.joined()
        LocalStorageService.shared.deviceToken = tokenString
        Task {
            try? await APIService.shared.registerDevice(token: tokenString)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[APNs] Failed to register: \(error.localizedDescription)")
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        NotificationService.shared.clearBadge()
        RecordingManager.shared.retryPendingUploads()
        // Refresh the Voice registration on foreground (throttled internally).
        VoiceCallManager.shared.register()
    }

    // Fallback hand-off hook (alongside SwiftUI's .onContinueUserActivity) so a
    // call-log redial routes into the outbound flow regardless of how the system
    // delivers the activity.
    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        return OutboundCallRouter.handle(userActivity)
    }
}
