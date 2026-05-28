import SwiftUI

struct DashboardView: View {
    @StateObject private var vm = DashboardViewModel()
    @EnvironmentObject private var notificationService: NotificationService
    @State private var showLeadReview = false
    @State private var selectedLeadID: Int?
    @State private var showDiscarded = false

    private var vertical: VerticalType { LocalStorageService.shared.selectedVertical }
    private var config: VerticalConfig { VerticalConfig.config(for: vertical) }

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.leads.isEmpty {
                    ProgressView("Loading leads…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.filteredLeads(showDiscarded: showDiscarded).isEmpty {
                    EmptyStateView(vertical: vertical)
                } else {
                    leadList
                }
            }
            .navigationTitle("LeadFlow")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showDiscarded.toggle()
                    } label: {
                        Image(systemName: showDiscarded ? "eye.fill" : "eye.slash.fill")
                    }
                }
            }
            .refreshable { await vm.refresh() }
            .task { await vm.refresh() }
            .sheet(isPresented: $showLeadReview) {
                if let id = selectedLeadID {
                    LeadReviewView(leadID: id, onDismiss: {
                        showLeadReview = false
                        Task { await vm.refresh() }
                    })
                }
            }
            .onChange(of: notificationService.pendingLeadID) { id in
                guard let id else { return }
                selectedLeadID = id
                showLeadReview = true
                notificationService.pendingLeadID = nil
            }
        }
    }

    private var leadList: some View {
        List {
            ForEach(vm.filteredLeads(showDiscarded: showDiscarded)) { lead in
                LeadRowView(lead: lead, config: config)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        selectedLeadID = lead.id
                        showLeadReview = true
                    }
                    .listRowBackground(lead.isDiscarded ? Color(.systemGray6) : Color(.systemBackground))
            }
        }
        .listStyle(.plain)
    }
}

// MARK: - Lead Row

private struct LeadRowView: View {
    let lead: Lead
    let config: VerticalConfig

    var body: some View {
        HStack(spacing: 12) {
            ConfidenceDot(tier: lead.confidenceTier)

            VStack(alignment: .leading, spacing: 3) {
                Text(lead.displayName)
                    .font(.headline)
                    .opacity(lead.isDiscarded ? 0.5 : 1)
                if let primary = lead.primaryFieldValue {
                    Text(primary)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                HStack(spacing: 6) {
                    if let phone = lead.phone {
                        Text(phone)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    if lead.isDiscarded {
                        Text("DISCARDED")
                            .font(.caption2)
                            .fontWeight(.bold)
                            .foregroundColor(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(.systemGray4))
                            .cornerRadius(4)
                    }
                }
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 3) {
                Text(lead.formattedDate)
                    .font(.caption)
                    .foregroundColor(.secondary)
                StatusBadge(status: lead.status ?? "new")
            }
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Supporting Views

struct ConfidenceDot: View {
    let tier: ConfidenceTier
    var body: some View {
        Circle()
            .fill(tier.color)
            .frame(width: 10, height: 10)
    }
}

struct StatusBadge: View {
    let status: String
    var body: some View {
        Text(status.capitalized)
            .font(.caption2)
            .fontWeight(.semibold)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(statusColor.opacity(0.15))
            .foregroundColor(statusColor)
            .cornerRadius(6)
    }
    private var statusColor: Color {
        switch status {
        case "confirmed": return .green
        case "new": return .blue
        case "discarded": return .secondary
        default: return .secondary
        }
    }
}

private struct EmptyStateView: View {
    let vertical: VerticalType
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: vertical.icon)
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("No leads yet")
                .font(.title3)
                .fontWeight(.semibold)
            Text("Leads will appear here automatically after calls are processed.")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Extensions

extension ConfidenceTier {
    var color: Color {
        switch self {
        case .high: return .green
        case .medium: return .orange
        case .low: return .red
        }
    }
}

extension Lead {
    var formattedDate: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: createdAt) ?? Date()
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .short
        return rel.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - View Model

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var leads: [Lead] = []
    @Published var isLoading = false
    @Published var error: String?

    func refresh() async {
        isLoading = true
        do {
            leads = try await APIService.shared.fetchLeads(includeDiscarded: true)
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func filteredLeads(showDiscarded: Bool) -> [Lead] {
        if showDiscarded { return leads }
        return leads.filter { !$0.isDiscarded }
    }
}
