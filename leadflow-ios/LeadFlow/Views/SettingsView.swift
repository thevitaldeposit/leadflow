import SwiftUI

struct SettingsView: View {
    @State private var backendURL = LocalStorageService.shared.backendURL
    @State private var userName = LocalStorageService.shared.userName
    @State private var businessName = LocalStorageService.shared.businessName
    @State private var recordingEnabled = LocalStorageService.shared.recordingEnabled
    @State private var notificationsEnabled = LocalStorageService.shared.notificationsEnabled
    @State private var healthStatus: String?
    @State private var isCheckingHealth = false
    @State private var pendingCount = 0

    private let storage = LocalStorageService.shared
    private let vertical = LocalStorageService.shared.selectedVertical

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Business Type", value: vertical.displayName)
                    HStack {
                        Text("Name")
                        Spacer()
                        TextField("Full Name", text: $userName)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Business")
                        Spacer()
                        TextField("Business Name", text: $businessName)
                            .multilineTextAlignment(.trailing)
                    }
                }

                Section("Recording") {
                    Toggle("Enable Automatic Recording", isOn: $recordingEnabled)
                    Toggle("Push Notifications", isOn: $notificationsEnabled)
                    if pendingCount > 0 {
                        HStack {
                            Image(systemName: "clock.badge.exclamationmark")
                                .foregroundColor(.orange)
                            Text("\(pendingCount) upload(s) pending retry")
                                .font(.callout)
                            Spacer()
                            Button("Retry Now") {
                                RecordingManager.shared.retryPendingUploads()
                                pendingCount = storage.pendingUploads.count
                            }
                            .font(.callout)
                        }
                    }
                }

                Section("Server") {
                    HStack {
                        Text("Backend URL")
                        Spacer()
                        TextField("https://…", text: $backendURL)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    Button(action: testConnection) {
                        HStack {
                            if isCheckingHealth {
                                ProgressView().progressViewStyle(CircularProgressViewStyle())
                                Text("Checking…")
                            } else {
                                Image(systemName: "network")
                                Text("Test Connection")
                            }
                            Spacer()
                            if let status = healthStatus {
                                Text(status)
                                    .font(.callout)
                                    .foregroundColor(status == "Connected" ? .green : .red)
                            }
                        }
                    }
                    .disabled(isCheckingHealth)
                }

                Section("About") {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                    LabeledContent("Build", value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                    Link("Privacy & Recording Disclosure", destination: URL(string: "https://leadflow-production-9c02.up.railway.app")!)
                }

                Section {
                    Button("Save Settings", action: saveSettings)
                        .frame(maxWidth: .infinity)
                        .foregroundColor(.blue)
                }
            }
            .navigationTitle("Settings")
            .onAppear { pendingCount = storage.pendingUploads.count }
        }
    }

    private func saveSettings() {
        storage.backendURL = backendURL
        storage.userName = userName
        storage.businessName = businessName
        storage.recordingEnabled = recordingEnabled
        storage.notificationsEnabled = notificationsEnabled
    }

    private func testConnection() {
        isCheckingHealth = true
        healthStatus = nil
        saveSettings()
        Task {
            let ok = (try? await APIService.shared.checkHealth()) ?? false
            await MainActor.run {
                healthStatus = ok ? "Connected" : "Failed"
                isCheckingHealth = false
            }
        }
    }
}
