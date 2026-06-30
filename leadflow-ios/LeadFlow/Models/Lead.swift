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

    // Home Services flat columns (returned by GET /api/leads via SELECT *). All
    // optional & additive, so absent columns simply decode to nil. These power the
    // dashboard's Action Queue + Today's Schedule (mirrors the web dashboard).
    var jobStatus: String?
    var subVertical: String?
    var callType: String?
    var outcome: String?
    var deliveryDate: String?
    var pickupDate: String?
    var scheduledTime: String?
    var followUpDate: String?
    var paidAt: String?
    var internalNotes: String?
    var estimatedRevenue: Double?

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
        case jobStatus = "job_status"
        case subVertical = "sub_vertical"
        case callType = "call_type"
        case outcome
        case deliveryDate = "delivery_date"
        case pickupDate = "pickup_date"
        case scheduledTime = "scheduled_time"
        case followUpDate = "follow_up_date"
        case paidAt = "paid_at"
        case internalNotes = "internal_notes"
        case estimatedRevenue = "estimated_revenue"
    }

    // Convenience accessors for vertical_data fields (parsed lazily from the JSON
    // blob). Kept here so the dashboard logic reads like the web's parseVerticalData.
    func vdString(_ key: String) -> String? { verticalData[key]?.stringValue }
    func vdBool(_ key: String) -> Bool? { verticalData[key]?.boolValue }
    func vdDouble(_ key: String) -> Double? { verticalData[key]?.doubleValue }

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

// MARK: - Customer Model (person-layer)

// A row from GET /api/customers — the person-layer the web dashboard reads. One
// record per real person (keyed by normalized phone) carrying the saved name that
// PERSISTS across later nameless calls. The call screen uses it as the name
// fallback when a matched lead has no name of its own, so a known customer shows
// their name (not just a number) on both inbound and outbound calls. Intentionally
// lightweight: only the fields needed to resolve a name by phone. (display_name is
// the server's best-name rollup, which can fall back to the phone/"Unknown" — the
// call screen guards against that before treating it as a real name.)
struct CustomerSummary: Codable, Identifiable {
    let id: Int
    let displayName: String?
    let firstName: String?
    let lastName: String?
    let phone: String?

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case firstName = "first_name"
        case lastName = "last_name"
        case phone
    }
}

// MARK: - Inventory Pool Model

// One per-size inventory pool, as returned by GET /api/dumpsters (requireAuth,
// scoped to the business by the JWT). Mirrors the web InventoryPage: each row is
// a size with an owned quantity and a count of units pulled for service.
// quantity/units_in_service are stored as optionals so a null column decodes to
// 0 rather than throwing (the backend reads them as `value || 0` too).
struct InventoryPool: Codable, Identifiable {
    let id: Int
    let size: String
    let notes: String?
    private let quantityRaw: Int?
    private let unitsInServiceRaw: Int?

    enum CodingKeys: String, CodingKey {
        case id, size, notes
        case quantityRaw = "quantity"
        case unitsInServiceRaw = "units_in_service"
    }

    var quantity: Int { quantityRaw ?? 0 }
    var unitsInService: Int { unitsInServiceRaw ?? 0 }

    /// Units ready to rent, excluding those pulled for service — exactly the
    /// "Available" column the web inventory overview shows (owned − in service).
    var available: Int { max(0, quantity - unitsInService) }
}

// Forward-looking availability for a delivery window, returned by
// GET /api/schedule/availability — the endpoint the web dashboard's "Quick
// Availability Check" calls. The backend already emits camelCase keys
// (deliveryDate, bySizes, availableCount, …), so a plain JSONDecoder maps them.
struct AvailabilityResponse: Decodable {
    let deliveryDate: String
    let pickupDate: String
    let rentalDuration: Int
    let bySizes: [SizeAvailability]
}

struct SizeAvailability: Decodable, Identifiable {
    let size: String
    let ownedCount: Int
    let unitsInService: Int
    let bookedCount: Int
    let availableCount: Int

    var id: String { size }

    enum CodingKeys: String, CodingKey {
        case size, ownedCount, unitsInService, bookedCount, availableCount
    }

    // Defensive against a null/missing count (mirrors InventoryPool's tolerance):
    // size is required, the counts default to 0.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        size = try c.decode(String.self, forKey: .size)
        ownedCount = (try? c.decodeIfPresent(Int.self, forKey: .ownedCount)) ?? 0
        unitsInService = (try? c.decodeIfPresent(Int.self, forKey: .unitsInService)) ?? 0
        bookedCount = (try? c.decodeIfPresent(Int.self, forKey: .bookedCount)) ?? 0
        availableCount = (try? c.decodeIfPresent(Int.self, forKey: .availableCount)) ?? 0
    }
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

    var doubleValue: Double? {
        switch value {
        case let d as Double: return d
        case let i as Int: return Double(i)
        case let s as String: return Double(s)
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
