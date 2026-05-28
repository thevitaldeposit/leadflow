import Foundation

// MARK: - Lead Model

struct Lead: Codable, Identifiable {
    let id: Int
    var status: String?
    var discarded: Int?
    var vertical: String?
    var source: String?
    var callerNumber: String?
    var callDirection: String?
    var callDuration: Int?
    var capturedBy: String?
    var verticalDataRaw: String?
    var confidence: Int?
    var callSummary: String?
    var createdAt: String
    var updatedAt: String?
    var customerFirstName: String?
    var customerLastName: String?
    var phone: String?
    var email: String?
    var rawTranscript: String?
    var extractionType: String?

    enum CodingKeys: String, CodingKey {
        case id
        case status
        case discarded
        case vertical
        case source
        case callerNumber = "caller_number"
        case callDirection = "call_direction"
        case callDuration = "call_duration"
        case capturedBy = "captured_by"
        case verticalDataRaw = "vertical_data"
        case confidence
        case callSummary = "call_summary"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case customerFirstName = "customer_first_name"
        case customerLastName = "customer_last_name"
        case phone
        case email
        case rawTranscript = "raw_transcript"
        case extractionType = "extraction_type"
    }

    var verticalData: [String: AnyCodable] {
        guard let raw = verticalDataRaw,
              let data = raw.data(using: .utf8),
              let dict = try? JSONDecoder().decode([String: AnyCodable].self, from: data)
        else { return [:] }
        return dict
    }

    var displayName: String {
        let parts = [customerFirstName, customerLastName].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? (phone ?? "Unknown Caller") : parts.joined(separator: " ")
    }

    var verticalType: VerticalType? {
        guard let v = vertical else { return nil }
        return VerticalType(rawValue: v)
    }

    var primaryFieldValue: String? {
        guard let type = verticalType else { return nil }
        let config = VerticalConfig.config(for: type)
        return verticalData[config.primaryField]?.stringValue
    }

    var confidenceTier: ConfidenceTier {
        let c = confidence ?? 0
        if c >= 75 { return .high }
        if c >= 45 { return .medium }
        return .low
    }

    var isDiscarded: Bool { discarded == 1 }
}

enum ConfidenceTier {
    case high, medium, low

    var label: String {
        switch self {
        case .high: return "High"
        case .medium: return "Medium"
        case .low: return "Low"
        }
    }
}

// MARK: - Type-erased Codable value

struct AnyCodable: Codable {
    let value: Any?

    var stringValue: String? {
        switch value {
        case let s as String: return s.isEmpty ? nil : s
        case let b as Bool: return b ? "Yes" : "No"
        case let n as Int: return "\(n)"
        case let n as Double: return String(format: "%.0f", n)
        default: return nil
        }
    }

    var boolValue: Bool? {
        switch value {
        case let b as Bool: return b
        case let s as String: return s.lowercased() == "true"
        case let n as Int: return n != 0
        default: return nil
        }
    }

    init(_ value: Any?) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = nil }
        else if let b = try? container.decode(Bool.self) { value = b }
        else if let i = try? container.decode(Int.self) { value = i }
        else if let d = try? container.decode(Double.self) { value = d }
        else if let s = try? container.decode(String.self) { value = s }
        else { value = nil }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case nil: try container.encodeNil()
        case let b as Bool: try container.encode(b)
        case let i as Int: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let s as String: try container.encode(s)
        default: try container.encodeNil()
        }
    }
}
