import SwiftUI

// MARK: - Lead Card View (display only)

struct LeadCardView: View {
    let lead: Lead
    var config: VerticalConfig {
        let type = lead.verticalType ?? LocalStorageService.shared.selectedVertical
        return VerticalConfig.config(for: type)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            headerSection
            confidenceBar
            fieldsSection
            if let summary = lead.callSummary, !summary.isEmpty {
                summarySection(summary)
            }
        }
        .padding(20)
    }

    private var headerSection: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(lead.displayName)
                    .font(.title2)
                    .fontWeight(.bold)
                HStack(spacing: 8) {
                    if let phone = lead.phone {
                        Label(phone, systemImage: "phone.fill")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    if let dir = lead.callDirection {
                        Image(systemName: dir == "inbound" ? "phone.arrow.down.left" : "phone.arrow.up.right")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                ConfidenceBadge(confidence: lead.confidence ?? 0)
                StatusBadge(status: lead.status ?? "new")
            }
        }
    }

    private var confidenceBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Extraction Confidence")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Text("\(lead.confidence ?? 0)%")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(lead.confidenceTier.color)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4).fill(Color(.systemGray5)).frame(height: 6)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(lead.confidenceTier.color)
                        .frame(width: geo.size.width * CGFloat(lead.confidence ?? 0) / 100, height: 6)
                }
            }
            .frame(height: 6)
        }
    }

    private var fieldsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(config.fields) { field in
                let value = fieldValue(for: field)
                if let value, !value.isEmpty {
                    FieldRow(label: field.label, value: value, type: field.type)
                }
            }
        }
    }

    private func summarySection(_ summary: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Call Summary")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
                .textCase(.uppercase)
            Text(summary)
                .font(.body)
                .foregroundColor(.primary)
                .padding(12)
                .background(Color(.secondarySystemBackground))
                .cornerRadius(10)
        }
    }

    private func fieldValue(for field: FieldDefinition) -> String? {
        // Check vertical data first
        if let v = lead.verticalData[field.key]?.stringValue { return v }
        // Fall back to common fields
        switch field.key {
        case "customerName": return lead.displayName == (lead.phone ?? "Unknown Caller") ? nil : lead.displayName
        case "customerPhone": return lead.phone
        case "customerEmail": return lead.email
        default: return nil
        }
    }
}

// MARK: - Field Row

struct FieldRow: View {
    let label: String
    let value: String
    let type: FieldDefinition.FieldType

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
                .textCase(.uppercase)
            Text(value)
                .font(.body)
                .foregroundColor(.primary)
        }
        Divider()
    }
}

// MARK: - Confidence Badge

struct ConfidenceBadge: View {
    let confidence: Int
    private var tier: ConfidenceTier {
        if confidence >= 75 { return .high }
        if confidence >= 45 { return .medium }
        return .low
    }
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(tier.color).frame(width: 7, height: 7)
            Text(tier.label)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(tier.color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tier.color.opacity(0.12))
        .cornerRadius(8)
    }
}
