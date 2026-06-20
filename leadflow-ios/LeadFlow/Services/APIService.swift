import Foundation

// MARK: - API Service

final class APIService: ObservableObject {
    static let shared = APIService()
    private var baseURL: String { LocalStorageService.shared.backendURL }

    private init() {}

    private func url(_ path: String) throws -> URL {
        guard let url = URL(string: baseURL + path) else {
            throw APIError.invalidURL
        }
        return url
    }

    // MARK: Upload Recording

    func uploadRecording(
        audioURL: URL,
        callerNumber: String?,
        callDirection: String,
        callDuration: Int,
        timestamp: String,
        vertical: String,
        capturedBy: String?
    ) async throws -> Lead {
        let endpoint = try url("/api/upload/recording")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 120

        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()

        func appendField(_ name: String, value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }

        appendField("callDirection", value: callDirection)
        appendField("callDuration", value: "\(callDuration)")
        appendField("timestamp", value: timestamp)
        appendField("vertical", value: vertical)
        if let callerNumber { appendField("callerNumber", value: callerNumber) }
        if let capturedBy { appendField("capturedBy", value: capturedBy) }
        if let token = LocalStorageService.shared.deviceToken {
            appendField("deviceToken", value: token)
        }

        // Append audio file
        let audioData = try Data(contentsOf: audioURL)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"recording.m4a\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/mp4\r\n\r\n".data(using: .utf8)!)
        body.append(audioData)
        body.append("\r\n".data(using: .utf8)!)
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response, data: data)
        return try JSONDecoder().decode(Lead.self, from: data)
    }

    // MARK: Leads

    func fetchLeads(includeDiscarded: Bool = false) async throws -> [Lead] {
        var components = URLComponents(string: baseURL + "/api/leads")!
        if includeDiscarded {
            components.queryItems = [URLQueryItem(name: "discarded", value: "include")]
        }
        guard let url = components.url else { throw APIError.invalidURL }
        let (data, response) = try await URLSession.shared.data(from: url)
        try validateResponse(response, data: data)
        return try JSONDecoder().decode([Lead].self, from: data)
    }

    func fetchLead(id: Int) async throws -> Lead {
        let endpoint = try url("/api/leads/\(id)")
        let (data, response) = try await URLSession.shared.data(from: endpoint)
        try validateResponse(response, data: data)
        return try JSONDecoder().decode(Lead.self, from: data)
    }

    func updateLead(id: Int, fields: [String: Any]) async throws -> Lead {
        let endpoint = try url("/api/leads/\(id)")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: fields)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response, data: data)
        return try JSONDecoder().decode(Lead.self, from: data)
    }

    func discardLead(id: Int) async throws -> Lead {
        return try await updateLead(id: id, fields: ["discarded": 1])
    }

    func confirmLead(id: Int, verticalData: [String: Any], commonFields: [String: Any]) async throws -> Lead {
        var fields = commonFields
        fields["status"] = "confirmed"
        fields["vertical_data"] = try String(data: JSONSerialization.data(withJSONObject: verticalData), encoding: .utf8)
        return try await updateLead(id: id, fields: fields)
    }

    // MARK: Device Registration

    /// Registers this device's APNs token (called from the APNs callback). Routes
    /// through syncDeviceRegistration so any Voice fields already on hand are sent
    /// in the same device row.
    func registerDevice(token: String) async throws {
        LocalStorageService.shared.deviceToken = token
        try await syncDeviceRegistration()
    }

    /// Posts the consolidated device registration (APNs token plus, when present,
    /// the VoIP push token + Voice identity) from local storage. Keyed on the
    /// APNs token, which the backend requires; if it isn't available yet this is a
    /// no-op and the next APNs registration carries the voice fields.
    func syncDeviceRegistration() async throws {
        let storage = LocalStorageService.shared
        guard let apns = storage.deviceToken, !apns.isEmpty else { return }
        let endpoint = try url("/api/devices/register")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "deviceToken": apns,
            "userName": storage.userName,
            "businessName": storage.businessName,
            "vertical": storage.selectedVertical.rawValue,
        ]
        if let voip = storage.voipToken, !voip.isEmpty { body["voipToken"] = voip }
        if let identity = storage.voiceIdentity, !identity.isEmpty { body["identity"] = identity }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response, data: data)
    }

    /// Best-effort de-registration of this device (used on logout).
    func unregisterDevice() async {
        guard let apns = LocalStorageService.shared.deviceToken, !apns.isEmpty else { return }
        guard let endpoint = try? url("/api/devices/unregister") else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceToken": apns])
        _ = try? await URLSession.shared.data(for: request)
    }

    // MARK: Voice (Twilio access token)

    struct VoiceTokenResponse: Decodable {
        let token: String
        let identity: String
        let ttl: Int?
    }

    /// Mints a short-lived Twilio Voice access token for this user from the
    /// backend. Throws on 503 when Voice isn't configured yet — VoiceCallManager
    /// treats that as "skip" so the app keeps working.
    func fetchVoiceToken() async throws -> VoiceTokenResponse {
        let endpoint = try url("/api/voice/token")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // When per-user JWT auth lands on iOS, attach the Authorization header
        // here so the token is scoped to the signed-in user, not the default
        // business.
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response, data: data)
        return try JSONDecoder().decode(VoiceTokenResponse.self, from: data)
    }

    // MARK: Health Check

    func checkHealth() async throws -> Bool {
        let endpoint = try url("/api/health")
        let (data, response) = try await URLSession.shared.data(from: endpoint)
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else { return false }
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let status = json["status"] as? String {
            return status == "ok"
        }
        return false
    }

    // MARK: Private

    private func validateResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard 200..<300 ~= http.statusCode else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.serverError(http.statusCode, message ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
    }
}

// MARK: - Errors

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case serverError(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid server URL. Check Settings."
        case .invalidResponse: return "Invalid response from server."
        case .serverError(let code, let msg): return "Server error \(code): \(msg)"
        }
    }
}
