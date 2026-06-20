import Foundation

// MARK: - User Settings Keys

enum SettingsKey {
    static let hasCompletedOnboarding = "hasCompletedOnboarding"
    static let selectedVertical = "selectedVertical"
    static let userName = "userName"
    static let businessName = "businessName"
    static let userPhone = "userPhone"
    static let backendURL = "backendURL"
    static let recordingEnabled = "recordingEnabled"
    static let notificationsEnabled = "notificationsEnabled"
    static let deviceToken = "deviceToken"
    static let voipToken = "voipToken"
    static let voiceIdentity = "voiceIdentity"
}

// MARK: - Pending Upload

struct PendingUpload: Codable {
    let id: String
    let audioPath: String
    let callerNumber: String?
    let callDirection: String
    let callDuration: Int
    let timestamp: String
    let vertical: String
    var retryCount: Int
    let capturedBy: String?
}

// MARK: - Local Storage Service

final class LocalStorageService {
    static let shared = LocalStorageService()
    private let defaults = UserDefaults.standard
    private let pendingKey = "pendingUploads"

    private init() {}

    // MARK: Settings

    var hasCompletedOnboarding: Bool {
        get { defaults.bool(forKey: SettingsKey.hasCompletedOnboarding) }
        set { defaults.set(newValue, forKey: SettingsKey.hasCompletedOnboarding) }
    }

    var selectedVertical: VerticalType {
        get {
            guard let raw = defaults.string(forKey: SettingsKey.selectedVertical),
                  let v = VerticalType(rawValue: raw) else { return .autoDealer }
            return v
        }
        set { defaults.set(newValue.rawValue, forKey: SettingsKey.selectedVertical) }
    }

    var userName: String {
        get { defaults.string(forKey: SettingsKey.userName) ?? "" }
        set { defaults.set(newValue, forKey: SettingsKey.userName) }
    }

    var businessName: String {
        get { defaults.string(forKey: SettingsKey.businessName) ?? "" }
        set { defaults.set(newValue, forKey: SettingsKey.businessName) }
    }

    var userPhone: String {
        get { defaults.string(forKey: SettingsKey.userPhone) ?? "" }
        set { defaults.set(newValue, forKey: SettingsKey.userPhone) }
    }

    var backendURL: String {
        get { defaults.string(forKey: SettingsKey.backendURL) ?? "https://leadflow-production-9c02.up.railway.app" }
        set { defaults.set(newValue, forKey: SettingsKey.backendURL) }
    }

    var recordingEnabled: Bool {
        get { defaults.object(forKey: SettingsKey.recordingEnabled) as? Bool ?? true }
        set { defaults.set(newValue, forKey: SettingsKey.recordingEnabled) }
    }

    var notificationsEnabled: Bool {
        get { defaults.object(forKey: SettingsKey.notificationsEnabled) as? Bool ?? true }
        set { defaults.set(newValue, forKey: SettingsKey.notificationsEnabled) }
    }

    var deviceToken: String? {
        get { defaults.string(forKey: SettingsKey.deviceToken) }
        set { defaults.set(newValue, forKey: SettingsKey.deviceToken) }
    }

    // Twilio Voice: the PushKit VoIP push token (hex) and the client identity the
    // device registered under. Stored so device registration can include them.
    var voipToken: String? {
        get { defaults.string(forKey: SettingsKey.voipToken) }
        set { defaults.set(newValue, forKey: SettingsKey.voipToken) }
    }

    var voiceIdentity: String? {
        get { defaults.string(forKey: SettingsKey.voiceIdentity) }
        set { defaults.set(newValue, forKey: SettingsKey.voiceIdentity) }
    }

    // MARK: Pending Upload Queue

    var pendingUploads: [PendingUpload] {
        get {
            guard let data = defaults.data(forKey: pendingKey),
                  let uploads = try? JSONDecoder().decode([PendingUpload].self, from: data)
            else { return [] }
            return uploads
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) {
                defaults.set(data, forKey: pendingKey)
            }
        }
    }

    func addPendingUpload(_ upload: PendingUpload) {
        var uploads = pendingUploads
        uploads.append(upload)
        pendingUploads = uploads
    }

    func removePendingUpload(id: String) {
        pendingUploads = pendingUploads.filter { $0.id != id }
    }

    func incrementRetry(id: String) {
        pendingUploads = pendingUploads.map { upload in
            var u = upload
            if u.id == id { u.retryCount += 1 }
            return u
        }
    }

    // MARK: Temporary Audio File Management

    func temporaryAudioURL() -> URL {
        let dir = FileManager.default.temporaryDirectory
        let filename = "recording-\(UUID().uuidString).m4a"
        return dir.appendingPathComponent(filename)
    }

    func deleteFile(at url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}
