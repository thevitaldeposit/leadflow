import SwiftUI
import UIKit
import UserNotifications

@main
struct LeadFlowApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var notificationService = NotificationService.shared
    private let storage = LocalStorageService.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(notificationService)
        }
    }
}

// MARK: - Root View (Onboarding vs. Main)

struct RootView: View {
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

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Leads", systemImage: "list.bullet.rectangle.portrait") }
                .environmentObject(notificationService)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
    }
}

// MARK: - App Delegate

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
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
    }
}
