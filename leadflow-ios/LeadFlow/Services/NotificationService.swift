import Foundation
import UserNotifications

// MARK: - Notification Service

final class NotificationService: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()
    @Published var pendingLeadID: Int?

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func requestPermission() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .sound, .badge]
            )
            return granted
        } catch {
            return false
        }
    }

    func checkPermissionStatus() async -> UNAuthorizationStatus {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus
    }

    // Called when app is in foreground and notification arrives
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    // Called when user taps the notification
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if let leadIdRaw = userInfo["leadId"] {
            if let leadId = leadIdRaw as? Int {
                pendingLeadID = leadId
            } else if let leadIdStr = leadIdRaw as? String, let leadId = Int(leadIdStr) {
                pendingLeadID = leadId
            }
        }
        completionHandler()
    }

    func clearBadge() {
        UNUserNotificationCenter.current().setBadgeCount(0, withCompletionHandler: nil)
    }
}
