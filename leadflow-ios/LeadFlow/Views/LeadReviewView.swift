import SwiftUI

struct LeadReviewView: View {
    let leadID: Int
    let onDismiss: () -> Void

    @State private var lead: Lead?
    @State private var editedFields: [String: String] = [:]
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var showDiscardConfirm = false

    private var config: VerticalConfig {
        let type = lead?.verticalType ?? LocalStorageService.shared.selectedVertical
        return VerticalConfig.config(for: type)
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading lead…")
                } else if let lead {
                    reviewContent(lead: lead)
                } else {
                    Text("Lead not found").foregroundColor(.secondary)
                }
            }
            .navigationTitle("Review Lead")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDismiss)
                }
            }
            .task { await loadLead() }
            .alert("Error", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
            .confirmationDialog("Discard this lead?", isPresented: $showDiscardConfirm, titleVisibility: .visible) {
                Button("Discard Lead", role: .destructive, action: discardLead)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The lead will be kept but marked as discarded.")
            }
        }
    }

    @ViewBuilder
    private func reviewContent(lead: Lead) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Header
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Review & Confirm")
                            .font(.headline)
                        Text("Edit any fields before confirming.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    ConfidenceBadge(confidence: lead.confidence ?? 0)
                }

                // Call the customer in-app (outbound VoIP; presents the verified
                // business caller ID). Hidden when the lead has no callable number.
                if let number = callableNumber(lead) {
                    Button {
                        placeCall(to: number, displayName: lead.displayName)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "phone.fill")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(.white)
                                .frame(width: 38, height: 38)
                                .background(Color.green)
                                .clipShape(Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Call \(lead.displayName)")
                                    .font(.subheadline)
                                    .fontWeight(.semibold)
                                    .foregroundColor(.primary)
                                Text(number)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        .padding(12)
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(12)
                    }
                    .accessibilityLabel("Call \(lead.displayName) at \(number)")
                }

                if let summary = lead.callSummary, !summary.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("AI Summary", systemImage: "sparkles")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.secondary)
                        Text(summary)
                            .font(.callout)
                            .padding(12)
                            .background(Color(.secondarySystemBackground))
                            .cornerRadius(10)
                    }
                }

                // Editable fields
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(config.fields) { field in
                        EditableFieldRow(
                            field: field,
                            value: binding(for: field, lead: lead)
                        )
                    }
                }

                // Action buttons
                VStack(spacing: 12) {
                    Button(action: confirmLead) {
                        HStack {
                            if isSaving {
                                ProgressView().progressViewStyle(CircularProgressViewStyle(tint: .white))
                            } else {
                                Image(systemName: "checkmark")
                                Text("Confirm Lead")
                            }
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.blue)
                        .cornerRadius(14)
                    }
                    .disabled(isSaving)

                    Button(role: .destructive) {
                        showDiscardConfirm = true
                    } label: {
                        Text("Discard")
                            .font(.body)
                            .foregroundColor(.red)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.red.opacity(0.08))
                            .cornerRadius(14)
                    }
                    .disabled(isSaving)
                }
            }
            .padding(20)
        }
    }

    // MARK: - Bindings

    private func binding(for field: FieldDefinition, lead: Lead) -> Binding<String> {
        Binding(
            get: {
                if let edited = editedFields[field.key] { return edited }
                if let v = lead.verticalData[field.key]?.stringValue { return v }
                switch field.key {
                case "customerName": return lead.displayName
                case "customerPhone": return lead.phone ?? ""
                case "customerEmail": return lead.email ?? ""
                default: return ""
                }
            },
            set: { editedFields[field.key] = $0 }
        )
    }

    // MARK: - Actions

    private func loadLead() async {
        do {
            lead = try await APIService.shared.fetchLead(id: leadID)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func confirmLead() {
        guard let lead else { return }
        isSaving = true

        Task {
            do {
                // Build updated vertical data
                var newVerticalData: [String: Any] = lead.verticalData.compactMapValues { $0.value }
                for (key, value) in editedFields {
                    newVerticalData[key] = value
                }

                // Extract common fields from edited values
                var commonFields: [String: Any] = [:]
                if let name = editedFields["customerName"] ?? lead.verticalData["customerName"]?.stringValue {
                    let parts = name.split(separator: " ")
                    commonFields["customer_first_name"] = parts.first.map(String.init) ?? name
                    commonFields["customer_last_name"] = parts.dropFirst().joined(separator: " ")
                }
                if let phone = editedFields["customerPhone"] ?? lead.phone {
                    commonFields["phone"] = phone
                }
                if let email = editedFields["customerEmail"] ?? lead.email {
                    commonFields["email"] = email
                }

                _ = try await APIService.shared.confirmLead(
                    id: lead.id,
                    verticalData: newVerticalData,
                    commonFields: commonFields
                )
                onDismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }

    private func discardLead() {
        guard let lead else { return }
        isSaving = true
        Task {
            do {
                _ = try await APIService.shared.discardLead(id: lead.id)
                onDismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }

    // MARK: - Calling

    /// The best number to dial for this lead: a phone the user just edited, else the
    /// extracted customer phone, else the inbound caller's number. Nil when none is
    /// usable, which hides the Call button.
    private func callableNumber(_ lead: Lead) -> String? {
        let candidates = [editedFields["customerPhone"], lead.phone, lead.callerNumber]
        return candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }

    /// Place an outbound VoIP call to the customer via VoiceCallManager. Surfaces a
    /// message through the existing error alert if Voice isn't configured.
    private func placeCall(to number: String, displayName: String?) {
        VoiceCallManager.shared.startOutgoingCall(to: number, displayName: displayName) { message in
            errorMessage = message
        }
    }
}

// MARK: - Editable Field Row

private struct EditableFieldRow: View {
    let field: FieldDefinition
    @Binding var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(field.label)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
                .textCase(.uppercase)

            switch field.type {
            case .bool:
                Toggle(field.label, isOn: Binding(
                    get: { value.lowercased() == "yes" || value.lowercased() == "true" },
                    set: { value = $0 ? "Yes" : "No" }
                ))
                .labelsHidden()
            case .multilineText:
                TextEditor(text: $value)
                    .frame(minHeight: 72)
                    .padding(10)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(10)
            case .phone:
                TextField(field.placeholder, text: $value)
                    .keyboardType(.phonePad)
                    .padding(12)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(10)
            case .email:
                TextField(field.placeholder, text: $value)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .padding(12)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(10)
            default:
                TextField(field.placeholder, text: $value)
                    .padding(12)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(10)
            }
        }
    }
}
