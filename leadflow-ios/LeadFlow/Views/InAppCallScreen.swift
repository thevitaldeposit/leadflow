// InAppCallScreen.swift
// LeadFlow
//
// Foreground in-app call UI (modeled on Google Voice). iOS only presents its
// native full-screen call UI for a third-party VoIP call when the app is
// backgrounded or locked; while Stream is foreground (outbound calls, answering
// while open, redial) the system shows only the green status-bar pill and the
// user lands back on the dashboard. This screen fills that gap: the root view
// presents it over the app whenever VoiceCallManager reports an active call
// (inbound-answered OR outbound) and dismisses it when the call ends.
//
// It is PURE UI. It READS VoiceCallManager's published state and calls the
// manager's EXISTING control methods (toggleMute / toggleSpeaker / endActiveCall).
// It does not touch CallKit, Twilio, the audio session, or recording — and the
// native CallKit screen still owns the backgrounded/locked experience unchanged.

import SwiftUI

struct InAppCallScreen: View {
    @ObservedObject var voice: VoiceCallManager

    // CRM customer name resolved by normalized phone, used only when the call
    // wasn't placed from a known lead (which already supplies activeCallName).
    @State private var crmName: String? = nil

    private enum Theme {
        static let bg = Color(red: 0.039, green: 0.055, blue: 0.106)        // deep navy
        static let card = Color(red: 0.106, green: 0.129, blue: 0.196)      // elevated navy
        static let primaryText = Color.white
        static let secondaryText = Color(red: 0.58, green: 0.62, blue: 0.71)
        static let mutedText = Color(red: 0.42, green: 0.46, blue: 0.55)
        static let accent = Color(red: 0.18, green: 0.83, blue: 0.71)       // brand teal
        static let danger = Color(red: 0.93, green: 0.30, blue: 0.33)       // end-call red
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer().frame(height: 72)
                identity
                Spacer()
                controls.padding(.bottom, 32)
                endButton.padding(.bottom, 48)
            }
            .padding(.horizontal, 32)
        }
        .preferredColorScheme(.dark)
        // Resolve the customer name once the remote number is known. Re-runs if the
        // handle changes; skips the lookup when we already have a name from the lead.
        .task(id: voice.activeCallHandle) {
            crmName = nil
            if voice.activeCallName == nil { await lookupCustomer() }
        }
    }

    // MARK: - Identity (avatar + name + number + status/timer)

    private var identity: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().fill(Theme.card).frame(width: 118, height: 118)
                if let initials = avatarInitials {
                    Text(initials)
                        .font(.system(size: 42, weight: .semibold, design: .rounded))
                        .foregroundColor(Theme.accent)
                } else {
                    Image(systemName: "person.fill")
                        .font(.system(size: 50))
                        .foregroundColor(Theme.accent)
                }
            }

            VStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundColor(Theme.primaryText)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)

                if showsNumberSubtitle {
                    Text(formattedNumber)
                        .font(.system(size: 16, weight: .regular))
                        .foregroundColor(Theme.mutedText)
                }
            }

            statusLine.padding(.top, 2)
        }
    }

    // Ticking call timer once connected; "Calling…" beforehand (outbound dialing).
    private var statusLine: some View {
        Group {
            if let connectedAt = voice.callConnectedAt {
                TimelineView(.periodic(from: connectedAt, by: 1)) { context in
                    Text(Self.timeString(context.date.timeIntervalSince(connectedAt)))
                        .monospacedDigit()
                        .foregroundColor(Theme.accent)
                }
            } else {
                Text("Calling…").foregroundColor(Theme.secondaryText)
            }
        }
        .font(.system(size: 17, weight: .medium))
    }

    // MARK: - Controls (mute / speaker) — wired to existing VoiceCallManager methods

    private var controls: some View {
        HStack(spacing: 44) {
            CallControlButton(
                systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill",
                label: "Mute",
                isActive: voice.isMuted
            ) { voice.toggleMute() }

            CallControlButton(
                systemName: voice.isSpeakerOn ? "speaker.wave.3.fill" : "speaker.wave.2.fill",
                label: "Speaker",
                isActive: voice.isSpeakerOn
            ) { voice.toggleSpeaker() }
        }
    }

    private var endButton: some View {
        Button(action: { voice.endActiveCall() }) {
            ZStack {
                Circle().fill(Theme.danger).frame(width: 74, height: 74)
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundColor(.white)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("End call")
    }

    // MARK: - Derived display

    // Prefer a name supplied at dial time (outbound from a lead), then the CRM
    // lookup, then the formatted phone number.
    private var title: String {
        if let name = voice.activeCallName, !name.isEmpty { return name }
        if let crm = crmName, !crm.isEmpty { return crm }
        return formattedNumber
    }

    // Show the raw number under the name only when the title is actually a name.
    private var showsNumberSubtitle: Bool {
        guard let handle = voice.activeCallHandle, !handle.isEmpty else { return false }
        return title != formattedNumber
    }

    private var avatarInitials: String? {
        let t = title
        guard t != formattedNumber else { return nil }   // it's a number, not a name
        let letters = t.split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined()
        return letters.isEmpty ? nil : letters.uppercased()
    }

    private var formattedNumber: String {
        guard let raw = voice.activeCallHandle, !raw.isEmpty else { return "Unknown" }
        let digits = raw.filter(\.isNumber)
        let core = digits.count > 10 ? String(digits.suffix(10)) : digits
        guard core.count == 10 else { return raw }       // not a US 10-digit number; show as-is
        let a = core.prefix(3), b = core.dropFirst(3).prefix(3), c = core.suffix(4)
        return "(\(a)) \(b)-\(c)"
    }

    // MARK: - Customer lookup

    private func lookupCustomer() async {
        guard let handle = voice.activeCallHandle else { return }
        let target = Self.normalize(handle)
        guard target.count >= 7 else { return }
        guard let leads = try? await APIService.shared.fetchLeads() else { return }
        let match = leads.first { lead in
            let p = Self.normalize(lead.phone ?? lead.callerNumber ?? "")
            return !p.isEmpty && p == target
        }
        guard let m = match else { return }
        let name = [m.customerFirstName, m.customerLastName]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !name.isEmpty { crmName = name }
    }

    // Last 10 digits — a stable key for matching US numbers regardless of +1 / formatting.
    private static func normalize(_ s: String) -> String {
        String(s.filter(\.isNumber).suffix(10))
    }

    private static func timeString(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s)
                     : String(format: "%02d:%02d", m, s)
    }
}

// MARK: - Round call-control button (mute / speaker)

private struct CallControlButton: View {
    let systemName: String
    let label: String
    let isActive: Bool
    let action: () -> Void

    private static let bg = Color(red: 0.039, green: 0.055, blue: 0.106)
    private static let accent = Color(red: 0.18, green: 0.83, blue: 0.71)
    private static let secondaryText = Color(red: 0.58, green: 0.62, blue: 0.71)

    var body: some View {
        Button(action: action) {
            VStack(spacing: 9) {
                ZStack {
                    Circle()
                        .fill(isActive ? Self.accent : Color.white.opacity(0.10))
                        .frame(width: 66, height: 66)
                    Image(systemName: systemName)
                        .font(.system(size: 25, weight: .medium))
                        .foregroundColor(isActive ? Self.bg : .white)
                }
                Text(label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Self.secondaryText)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(isActive ? "On" : "Off")
    }
}
