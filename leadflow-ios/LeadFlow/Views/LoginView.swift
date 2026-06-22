import SwiftUI
import UIKit

// Login gate. First screen for a signed-out user. Mirrors the web sign-in:
// POST /api/auth/login { email, password } via AuthManager.login. Styled to the
// app's dark-navy theme (same palette as HomeDashboardView).

struct LoginView: View {
    @EnvironmentObject private var auth: AuthManager

    @State private var email = ""
    @State private var password = ""
    @State private var errorMessage: String?
    @State private var isSubmitting = false
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
            && !isSubmitting
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 28) {
                    Spacer(minLength: 48)

                    VStack(spacing: 14) {
                        Image("StreamLogo")
                            .resizable()
                            .scaledToFit()
                            .frame(height: 56)
                            .accessibilityLabel("Stream")

                        Text("Sign in to your account")
                            .font(.subheadline)
                            .foregroundColor(Theme.secondaryText)
                    }

                    VStack(spacing: 14) {
                        field(
                            title: "Email",
                            text: $email,
                            placeholder: "you@business.com",
                            isSecure: false,
                            field: .email,
                            submitLabel: .next,
                            keyboard: .emailAddress
                        )

                        field(
                            title: "Password",
                            text: $password,
                            placeholder: "••••••••",
                            isSecure: true,
                            field: .password,
                            submitLabel: .go,
                            keyboard: .default
                        )

                        if let errorMessage {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                Text(errorMessage)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .font(.footnote)
                            .foregroundColor(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .transition(.opacity)
                        }

                        Button(action: submit) {
                            HStack {
                                if isSubmitting {
                                    ProgressView()
                                        .progressViewStyle(.circular)
                                        .tint(Theme.bg)
                                }
                                Text(isSubmitting ? "Signing in…" : "Sign In")
                                    .fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 15)
                            .background(canSubmit ? Theme.accent : Theme.accent.opacity(0.35))
                            .foregroundColor(Theme.bg)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .disabled(!canSubmit)
                        .padding(.top, 4)
                    }
                    .padding(20)
                    .background(Theme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Theme.border, lineWidth: 1)
                    )

                    Text("Use the same email and password as the Stream dashboard.")
                        .font(.caption)
                        .foregroundColor(Theme.mutedText)
                        .multilineTextAlignment(.center)

                    Spacer(minLength: 24)
                }
                .padding(.horizontal, 22)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - Field builder

    @ViewBuilder
    private func field(
        title: String,
        text: Binding<String>,
        placeholder: String,
        isSecure: Bool,
        field: Field,
        submitLabel: SubmitLabel,
        keyboard: UIKeyboardType
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundColor(Theme.mutedText)

            Group {
                if isSecure {
                    SecureField("", text: text, prompt: prompt(placeholder))
                        .textContentType(.password)
                } else {
                    TextField("", text: text, prompt: prompt(placeholder))
                        .textContentType(.username)
                        .keyboardType(keyboard)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .foregroundColor(Theme.primaryText)
            .focused($focusedField, equals: field)
            .submitLabel(submitLabel)
            .onSubmit(advance)
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(Theme.cardElevated)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(focusedField == field ? Theme.accent.opacity(0.6) : Theme.border, lineWidth: 1)
            )
        }
    }

    private func prompt(_ text: String) -> Text {
        Text(text).foregroundColor(Theme.mutedText)
    }

    // MARK: - Actions

    private func advance() {
        switch focusedField {
        case .email: focusedField = .password
        case .password: submit()
        case .none: break
        }
    }

    private func submit() {
        guard canSubmit else { return }
        focusedField = nil
        errorMessage = nil
        isSubmitting = true
        let creds = (email.trimmingCharacters(in: .whitespaces), password)
        Task {
            do {
                try await auth.login(email: creds.0, password: creds.1)
                // On success AuthManager flips state → RootView swaps to the app.
            } catch {
                await MainActor.run {
                    errorMessage = Self.message(for: error)
                    isSubmitting = false
                }
            }
        }
    }

    /// Turn API/network errors into a friendly, non-leaky message.
    private static func message(for error: Error) -> String {
        if let apiError = error as? APIError {
            switch apiError {
            case .serverError(let code, let msg):
                if code == 401 { return "Invalid email or password." }
                return msg
            case .invalidResponse:
                return "Unexpected response from the server. Please try again."
            case .invalidURL:
                return "Invalid server URL. Check Settings."
            }
        }
        if (error as NSError).domain == NSURLErrorDomain {
            return "Can't reach the server. Check your connection and try again."
        }
        return "Something went wrong. Please try again."
    }
}

// MARK: - Theme (matches HomeDashboardView's dark navy palette)

private enum Theme {
    static let bg = Color(red: 0.039, green: 0.055, blue: 0.106)
    static let card = Color(red: 0.078, green: 0.098, blue: 0.157)
    static let cardElevated = Color(red: 0.106, green: 0.129, blue: 0.196)
    static let border = Color.white.opacity(0.07)
    static let primaryText = Color.white
    static let secondaryText = Color(red: 0.58, green: 0.62, blue: 0.71)
    static let mutedText = Color(red: 0.42, green: 0.46, blue: 0.55)
    static let accent = Color(red: 0.18, green: 0.83, blue: 0.71)
    static let danger = Color(red: 0.97, green: 0.45, blue: 0.45)
}
