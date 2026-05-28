import SwiftUI

struct VerticalSelectView: View {
    @Binding var selectedVertical: VerticalType?
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Text("LeadFlow")
                    .font(.system(size: 32, weight: .bold))
                    .foregroundColor(.primary)
                Text("What type of business are you?")
                    .font(.title2)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 60)
            .padding(.horizontal, 24)

            Spacer()

            VStack(spacing: 16) {
                ForEach(VerticalType.allCases) { vertical in
                    VerticalCard(
                        vertical: vertical,
                        isSelected: selectedVertical == vertical,
                        onTap: { selectedVertical = vertical }
                    )
                }
            }
            .padding(.horizontal, 24)

            Spacer()

            Button(action: onContinue) {
                Text("Continue")
                    .font(.headline)
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(selectedVertical != nil ? Color.blue : Color.gray)
                    .cornerRadius(14)
            }
            .disabled(selectedVertical == nil)
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
        }
        .background(Color(.systemBackground))
    }
}

// MARK: - Vertical Card

private struct VerticalCard: View {
    let vertical: VerticalType
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 16) {
                Image(systemName: vertical.icon)
                    .font(.system(size: 28))
                    .foregroundColor(isSelected ? .white : .blue)
                    .frame(width: 48, height: 48)
                    .background(isSelected ? Color.blue : Color.blue.opacity(0.1))
                    .cornerRadius(12)

                VStack(alignment: .leading, spacing: 4) {
                    Text(vertical.displayName)
                        .font(.headline)
                        .foregroundColor(isSelected ? .white : .primary)
                    Text(vertical.description)
                        .font(.caption)
                        .foregroundColor(isSelected ? .white.opacity(0.85) : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.white)
                }
            }
            .padding(16)
            .background(isSelected ? Color.blue : Color(.secondarySystemBackground))
            .cornerRadius(16)
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(isSelected ? Color.blue : Color.clear, lineWidth: 2)
            )
        }
        .buttonStyle(PlainButtonStyle())
        .animation(.easeInOut(duration: 0.2), value: isSelected)
    }
}
