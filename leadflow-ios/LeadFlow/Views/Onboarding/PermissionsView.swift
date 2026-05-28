import SwiftUI
import AVFoundation
import UserNotifications
import UIKit

struct PermissionsView: View {
    let onComplete: () -> Void
    @State private var micGranted = false
    @State private var notificationsGranted = false
    @State private var recordingEnabled = true
    @State private var isRequesting = false

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Text("Enable LeadFlow")
                    .font(.system(size: 32, weight: .bold))
                Text("Two permissions required for automatic lead capture.")
                    .font(.body)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 60)
            .padding(.horizontal, 24)

            Spacer()

            VStack(spacing: 20) {
                PermissionRow(
                    icon: "mic.fill",
                    color: .orange,
                    title: "Microphone",
                    description: "Required to record calls. LeadFlow records your voice to transcribe lead data automatically.",
                    isGranted: micGranted
                )

                PermissionRow(
                    icon: "bell.fill",
                    color: .blue,
                    title: "Notifications",
                    description: "Required to alert you when a new lead is captured. Tap the notification to review your lead.",
                    isGranted: notificationsGranted
                )

                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Enable automatic recording")
                            .font(.body)
                            .fontWeight(.medium)
                        Text("Records every call automatically. You can disable this anytime in Settings.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    Toggle("", isOn: $recordingEnabled)
                        .labelsHidden()
                }
                .padding(16)
                .background(Color(.secondarySystemBackground))
                .cornerRadius(12)
            }
            .padding(.horizontal, 24)

            Spacer()

            Button(action: requestPermissions) {
                Group {
                    if isRequesting {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    } else {
                        Text(micGranted && notificationsGranted ? "Get Started" : "Enable Permissions")
                            .font(.headline)
                            .foregroundColor(.white)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Color.blue)
                .cornerRadius(14)
            }
            .disabled(isRequesting)
            .padding(.horizontal, 24)
            .padding(.bottom, 16)

            if micGranted && notificationsGranted {
                Button("Continue without changes", action: finish)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.bottom, 32)
            } else {
                Text("You can grant these in iOS Settings if you decline now.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 32)
            }
        }
        .background(Color(.systemBackground))
        .task { await checkCurrentStatus() }
    }

    private func checkCurrentStatus() async {
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        micGranted = micStatus == .authorized

        let notifSettings = await UNUserNotificationCenter.current().notificationSettings()
        notificationsGranted = notifSettings.authorizationStatus == .authorized
    }

    private func requestPermissions() {
        isRequesting = true
        Task {
            if !micGranted {
                micGranted = await AVCaptureDevice.requestAccess(for: .audio)
            }
            if !notificationsGranted {
                notificationsGranted = (try? await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                if notificationsGranted {
                    await MainActor.run {
                        UIApplication.shared.registerForRemoteNotifications()
                    }
                }
            }
            await MainActor.run {
                isRequesting = false
                if micGranted && notificationsGranted { finish() }
            }
        }
    }

    private func finish() {
        LocalStorageService.shared.recordingEnabled = recordingEnabled
        onComplete()
    }
}

// MARK: - Permission Row

private struct PermissionRow: View {
    let icon: String
    let color: Color
    let title: String
    let description: String
    let isGranted: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 22))
                .foregroundColor(.white)
                .frame(width: 44, height: 44)
                .background(color)
                .cornerRadius(10)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body)
                    .fontWeight(.semibold)
                Text(description)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            Image(systemName: isGranted ? "checkmark.circle.fill" : "circle")
                .foregroundColor(isGranted ? .green : .secondary)
        }
        .padding(14)
        .background(Color(.secondarySystemBackground))
        .cornerRadius(12)
    }
}
