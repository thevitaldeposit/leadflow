import Foundation

// MARK: - Vertical Type

enum VerticalType: String, Codable, CaseIterable, Identifiable {
    case autoDealer = "auto_dealer"
    case insuranceAgent = "insurance_agent"
    case homeServices = "home_services"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .autoDealer: return "Auto Dealership"
        case .insuranceAgent: return "Insurance Agency"
        case .homeServices: return "Home Services"
        }
    }

    var description: String {
        switch self {
        case .autoDealer: return "Captures vehicle interest, trade-ins, financing, and buyer timeframe"
        case .insuranceAgent: return "Captures coverage type, current provider, premiums, and quote requests"
        case .homeServices: return "Captures service needed, urgency, scheduling, and property details"
        }
    }

    var icon: String {
        switch self {
        case .autoDealer: return "car.fill"
        case .insuranceAgent: return "shield.fill"
        case .homeServices: return "house.fill"
        }
    }
}

// MARK: - Field Definition

struct FieldDefinition: Identifiable {
    let id: String
    let key: String
    let label: String
    let type: FieldType
    let placeholder: String

    enum FieldType {
        case text
        case multilineText
        case bool
        case phone
        case email
    }

    init(key: String, label: String, type: FieldType = .text, placeholder: String = "") {
        self.id = key
        self.key = key
        self.label = label
        self.type = type
        self.placeholder = placeholder.isEmpty ? label : placeholder
    }
}

// MARK: - Vertical Config

struct VerticalConfig {
    let identifier: VerticalType
    let displayName: String
    let fields: [FieldDefinition]
    let primaryField: String

    static func config(for vertical: VerticalType) -> VerticalConfig {
        switch vertical {
        case .autoDealer: return autoDealer
        case .insuranceAgent: return insuranceAgent
        case .homeServices: return homeServices
        }
    }

    // MARK: Auto Dealer

    static let autoDealer = VerticalConfig(
        identifier: .autoDealer,
        displayName: "Auto Dealership",
        fields: [
            FieldDefinition(key: "customerName", label: "Customer Name"),
            FieldDefinition(key: "customerPhone", label: "Phone", type: .phone),
            FieldDefinition(key: "customerEmail", label: "Email", type: .email),
            FieldDefinition(key: "vehicleInterest", label: "Vehicle Interest", placeholder: "Year, make, model"),
            FieldDefinition(key: "tradeIn", label: "Trade-In", placeholder: "Trade-in vehicle if any"),
            FieldDefinition(key: "budget", label: "Budget"),
            FieldDefinition(key: "financingInterested", label: "Interested in Financing", type: .bool),
            FieldDefinition(key: "timeframe", label: "Timeframe", placeholder: "How soon they want to buy"),
            FieldDefinition(key: "notes", label: "Notes", type: .multilineText),
        ],
        primaryField: "vehicleInterest"
    )

    // MARK: Insurance Agent

    static let insuranceAgent = VerticalConfig(
        identifier: .insuranceAgent,
        displayName: "Insurance Agency",
        fields: [
            FieldDefinition(key: "customerName", label: "Customer Name"),
            FieldDefinition(key: "customerPhone", label: "Phone", type: .phone),
            FieldDefinition(key: "customerEmail", label: "Email", type: .email),
            FieldDefinition(key: "coverageType", label: "Coverage Type", placeholder: "Auto, home, life, commercial..."),
            FieldDefinition(key: "currentProvider", label: "Current Provider"),
            FieldDefinition(key: "currentPremium", label: "Current Premium", placeholder: "What they currently pay"),
            FieldDefinition(key: "policyExpiration", label: "Policy Expiration"),
            FieldDefinition(key: "quoteRequested", label: "Quote Requested", type: .bool),
            FieldDefinition(key: "bundleInterest", label: "Interested in Bundling", type: .bool),
            FieldDefinition(key: "driversInHousehold", label: "Drivers in Household"),
            FieldDefinition(key: "propertyAddress", label: "Property Address"),
            FieldDefinition(key: "notes", label: "Notes", type: .multilineText),
        ],
        primaryField: "coverageType"
    )

    // MARK: Home Services

    static let homeServices = VerticalConfig(
        identifier: .homeServices,
        displayName: "Home Services",
        fields: [
            FieldDefinition(key: "customerName", label: "Customer Name"),
            FieldDefinition(key: "customerPhone", label: "Phone", type: .phone),
            FieldDefinition(key: "customerEmail", label: "Email", type: .email),
            FieldDefinition(key: "serviceNeeded", label: "Service Needed", placeholder: "HVAC, plumbing, electrical..."),
            FieldDefinition(key: "propertyAddress", label: "Property Address"),
            FieldDefinition(key: "issueDescription", label: "Issue Description", type: .multilineText),
            FieldDefinition(key: "urgency", label: "Urgency", placeholder: "Emergency, this week, flexible"),
            FieldDefinition(key: "quoteRequested", label: "Quote Requested", type: .bool),
            FieldDefinition(key: "preferredSchedule", label: "Preferred Schedule"),
            FieldDefinition(key: "propertyType", label: "Property Type", placeholder: "Residential or commercial"),
            FieldDefinition(key: "notes", label: "Notes", type: .multilineText),
        ],
        primaryField: "serviceNeeded"
    )
}
