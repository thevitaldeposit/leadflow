import SwiftUI

struct UserInfoView: View {
    @Binding var userName: String
    @Binding var businessName: String
    @Binding var userPhone: String
    let onContinue: () -> Void

    var isValid: Bool {
        !userName.trimmingCharacters(in: .whitespaces).isEmpty &&
        !businessName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Text("Your Info")
                    .font(.system(size: 32, weight: .bold))
                Text("This appears on your captured leads.")
                    .font(.body)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 60)
            .padding(.horizontal, 24)

            Spacer()

            VStack(spacing: 20) {
                LabeledField(label: "Full Name", placeholder: "Jane Smith", text: $userName)
                LabeledField(label: "Business Name", placeholder: "Acme Auto Group", text: $businessName)
                LabeledField(label: "Your Phone (optional)", placeholder: "555-000-0000", text: $userPhone, keyboardType: .phonePad)
            }
            .padding(.horizontal, 24)

            Spacer()

            Button(action: onContinue) {
                Text("Continue")
                    .font(.headline)
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(isValid ? Color.blue : Color.gray)
                    .cornerRadius(14)
            }
            .disabled(!isValid)
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
        }
        .background(Color(.systemBackground))
    }
}

// MARK: - Labeled Field

struct LabeledField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var keyboardType: UIKeyboardType = .default

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
                .textCase(.uppercase)
            TextField(placeholder, text: $text)
                .keyboardType(keyboardType)
                .padding(14)
                .background(Color(.secondarySystemBackground))
                .cornerRadius(10)
        }
    }
}
