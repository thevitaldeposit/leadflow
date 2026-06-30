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
// It is PURE UI plus one in-call control. It READS VoiceCallManager's published
// state and calls the manager's EXISTING control methods (toggleMute /
// toggleSpeaker / endActiveCall / sendDigits). It does NOT touch CallKit, the
// Twilio connect/accept path, the audio session, or recording — the native
// CallKit screen still owns the backgrounded/locked experience unchanged.
//
// Identity resolves like a real phone: a saved customer/lead (matched by
// normalized phone, both inbound and outbound) shows their name + real initials
// and a compact CRM context card; an unknown number shows the formatted number
// and the standard silhouette — initials are NEVER derived from a phone number.
// The keypad sends DTMF through VoiceCallManager.sendDigits (Twilio Call.sendDigits).

import SwiftUI

struct InAppCallScreen: View {
    @ObservedObject var voice: VoiceCallManager

    // The CRM record (lead) for the remote number, matched by normalized phone.
    // Drives the resolved name when the call wasn't dialed from a known name, and
    // the context card. Reset + re-resolved whenever the active handle changes.
    @State private var matchedLead: Lead? = nil

    // The person-layer customer NAME for the remote number (the web app's customers
    // source), matched by normalized phone. This name PERSISTS across later nameless
    // calls, so it's the name fallback when the matched lead has none of its own — a
    // known customer shows their name, not just a number, on inbound and outbound.
    // nil ⇒ no saved customer name for this number (or signed out, where the
    // auth-only customers endpoint is unavailable). Resolved alongside matchedLead.
    @State private var matchedCustomerName: String? = nil

    // The person-layer customer's primary ADDRESS (the same customers.address the
    // web profile shows as the customer's location, e.g. a town like "Ottawa").
    // Used as the LAST fallback for the context card's location row when the matched
    // call has no clean delivery/property/service address of its own. Raw here;
    // cleaned (placeholder/uncertainty stripped) at the point of use. Resolved by
    // normalized phone alongside matchedCustomerName. nil ⇒ none on file / signed out.
    @State private var matchedCustomerAddress: String? = nil

    // Keypad (DTMF) overlay state. `dtmfEntered` mirrors what's been keyed this
    // keypad session, shown above the dialpad like a standard call screen.
    @State private var showKeypad = false
    @State private var dtmfEntered = ""

    private enum Theme {
        static let bg = Color(red: 0.039, green: 0.055, blue: 0.106)        // deep navy
        static let card = Color(red: 0.106, green: 0.129, blue: 0.196)      // elevated navy
        static let primaryText = Color.white
        static let secondaryText = Color(red: 0.58, green: 0.62, blue: 0.71)
        static let mutedText = Color(red: 0.42, green: 0.46, blue: 0.55)
        static let accent = Color(red: 0.18, green: 0.83, blue: 0.71)       // brand teal
        static let amber = Color(red: 0.98, green: 0.75, blue: 0.22)        // active-inquiry
        static let danger = Color(red: 0.93, green: 0.30, blue: 0.33)       // end-call red
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer().frame(height: showKeypad ? 36 : 72)
                identity
                Spacer(minLength: 20)

                if showKeypad {
                    keypadPanel
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    middleContext
                    Spacer(minLength: 20)
                    controls
                        .transition(.opacity)
                }

                Spacer(minLength: 20)
                endButton.padding(.bottom, 44)
            }
            .padding(.horizontal, 32)
        }
        .preferredColorScheme(.dark)
        // Resolve the CRM record once the remote number is known. Re-runs (and
        // resets the keypad) whenever the active handle changes. Runs for inbound
        // AND outbound so a saved caller's name + context show in both directions.
        .task(id: voice.activeCallHandle) {
            matchedLead = nil
            matchedCustomerName = nil
            matchedCustomerAddress = nil
            showKeypad = false
            dtmfEntered = ""
            await lookupCustomer()
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
                    // Unknown caller → standard person silhouette (never number chars).
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

                // The number appears under the name only when line 1 is a name; when
                // line 1 is already the number we don't repeat it.
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

    // MARK: - Middle: CRM context card (known) / subtle hint (unknown)

    @ViewBuilder private var middleContext: some View {
        if let ctx = crmContext {
            contextCard(ctx)
        } else if resolvedName == nil && voice.activeCallHandle != nil {
            // Unknown number: keep the space minimal — just a subtle hint, no card.
            Text("Unknown caller")
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(Theme.mutedText)
        }
    }

    private func contextCard(_ ctx: CRMContext) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            if let address = ctx.address {
                contextRow(icon: "mappin.and.ellipse", text: address, tint: Theme.secondaryText)
            }
            if let engagement = ctx.engagementText {
                contextRow(icon: ctx.engagementIcon, text: engagement, tint: ctx.engagementTint, emphasize: true)
            }
            if let detail = ctx.jobDetail {
                contextRow(icon: "calendar", text: detail, tint: Theme.secondaryText)
            }
            if let last = ctx.lastContact {
                contextRow(icon: "clock.arrow.circlepath", text: last, tint: Theme.mutedText)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.white.opacity(0.06), lineWidth: 1))
    }

    private func contextRow(icon: String, text: String, tint: Color, emphasize: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(tint)
                .frame(width: 18)
                .padding(.top, 1)
            Text(text)
                .font(.system(size: 15, weight: emphasize ? .semibold : .regular))
                .foregroundColor(emphasize ? Theme.primaryText : Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    // MARK: - Controls (mute / keypad / speaker) — existing VoiceCallManager methods

    private var controls: some View {
        HStack(spacing: 28) {
            CallControlButton(
                systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill",
                label: "Mute",
                isActive: voice.isMuted
            ) { voice.toggleMute() }

            CallControlButton(
                systemName: "circle.grid.3x3.fill",
                label: "Keypad",
                isActive: showKeypad
            ) {
                withAnimation(.easeInOut(duration: 0.22)) {
                    dtmfEntered = ""
                    showKeypad = true
                }
            }

            CallControlButton(
                systemName: voice.isSpeakerOn ? "speaker.wave.3.fill" : "speaker.wave.2.fill",
                label: "Speaker",
                isActive: voice.isSpeakerOn
            ) { voice.toggleSpeaker() }
        }
    }

    // MARK: - Keypad (DTMF) — sends via VoiceCallManager.sendDigits (Twilio Call.sendDigits)

    private var keypadPanel: some View {
        VStack(spacing: 16) {
            Text(dtmfEntered.isEmpty ? " " : dtmfEntered)
                .font(.system(size: 28, weight: .medium, design: .rounded))
                .monospacedDigit()
                .foregroundColor(Theme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(height: 34)

            VStack(spacing: 12) {
                ForEach(0..<Self.dialpad.count, id: \.self) { r in
                    HStack(spacing: 24) {
                        ForEach(0..<Self.dialpad[r].count, id: \.self) { c in
                            let key = Self.dialpad[r][c]
                            DialpadKey(digit: key.0, letters: key.1) { press($0) }
                        }
                    }
                }
            }

            Button {
                withAnimation(.easeInOut(duration: 0.22)) { showKeypad = false }
            } label: {
                Text("Hide")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(Theme.accent)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 20)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Hide keypad")
            .padding(.top, 2)
        }
    }

    // Append for the on-screen readout and send the tone on the active call.
    private func press(_ digit: String) {
        dtmfEntered.append(digit)
        voice.sendDigits(digit)
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

    // The customer/lead name when known. Resolves with the SAME fallback chain the
    // web app uses, so a known customer with a nameless recent lead shows their name
    // (not just a number) on both inbound and outbound. nil ⇒ unknown caller (show
    // the formatted number + silhouette).
    private var resolvedName: String? {
        // 1. A name supplied at dial time (outbound from a known contact) — but only
        //    when it's a real name, not a phone number some callers pass.
        if let dialed = voice.activeCallName, Self.isNameLike(dialed) {
            return dialed.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // 2. The matched lead's own name — flat columns, then vertical_data.customerName
        //    (the same fields the web app's leadIdentity reads off a lead).
        if let lead = matchedLead {
            let flat = [lead.customerFirstName, lead.customerLastName]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            if let name = Self.nonEmpty(flat) { return name }
            if let vdName = Self.nonEmpty(lead.verticalData["customerName"]?.stringValue),
               Self.isNameLike(vdName) {
                return vdName
            }
        }
        // 3. The CUSTOMERS person-layer saved name (display_name / first+last) for
        //    this number — exactly what the web app shows. It persists across later
        //    nameless calls, so a known customer's name appears even when their most
        //    recent lead has none. Resolved by normalized phone, so it works inbound.
        if let custName = matchedCustomerName { return custName }
        // 4. Nothing ⇒ unknown caller: fall through to the formatted number + silhouette.
        return nil
    }

    private var title: String { resolvedName ?? formattedNumber }

    private var showsNumberSubtitle: Bool {
        resolvedName != nil && formattedNumber != "Unknown"
    }

    private var avatarInitials: String? {
        guard let name = resolvedName else { return nil }   // unknown ⇒ silhouette
        let letters = name.split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined()
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

    // MARK: - CRM context model

    private struct CRMContext {
        var address: String?
        var engagementText: String?
        var engagementTint: Color
        var engagementIcon: String
        var jobDetail: String?      // "20yd · Delivers Jun 23"
        var lastContact: String?    // "Last contact 3d ago"

        var hasContent: Bool {
            address != nil || engagementText != nil || jobDetail != nil || lastContact != nil
        }
    }

    // Build the context card from the matched lead, gracefully omitting missing
    // fields. Reuses the same vertical_data keys the dashboard reads
    // (deliveryAddress, dumpsterSize, deliveryDate, job_status). nil ⇒ no card.
    private var crmContext: CRMContext? {
        guard let lead = matchedLead else { return nil }
        let vd = lead.verticalData

        // Only a clean, real address is shown; empty or AI-uncertain values
        // ("… (unclear)") are dropped so the row is hidden rather than showing junk.
        // Fallback chain: this call's extracted delivery/property/service address,
        // then the customer's profile address (their town, e.g. "Ottawa" — the same
        // customers.address the web profile shows) so a known customer with no
        // address on this call still gets a location instead of a blank row. Each
        // candidate is cleaned, so a garbage profile address is skipped too.
        let address = Self.cleanAddress(vd["deliveryAddress"]?.stringValue)
            ?? Self.cleanAddress(vd["propertyAddress"]?.stringValue)
            ?? Self.cleanAddress(vd["serviceAddress"]?.stringValue)
            ?? Self.cleanAddress(matchedCustomerAddress)

        let jobStatus = Self.nonEmpty(lead.jobStatus) ?? Self.nonEmpty(vd["job_status"]?.stringValue)

        // Current open engagement: an operational job ("Open Job") vs a pre-booking
        // inquiry ("Active Inquiry"). Terminal jobs have no open engagement — the
        // last-contact row carries the history instead.
        let operational: Set<String> = ["booked", "scheduled", "delivered", "active_rental", "picked_up"]
        let terminal: Set<String> = ["completed", "lost", "spam"]
        var engagementText: String?
        var engagementTint = Theme.accent
        var engagementIcon = "shippingbox.fill"
        if let js = jobStatus, operational.contains(js) {
            engagementText = "Open Job · \(Self.prettyStatus(js))"
            engagementTint = Theme.accent
            engagementIcon = "shippingbox.fill"
        } else if let js = jobStatus, terminal.contains(js) {
            if js == "completed" {
                engagementText = "Completed job"
                engagementTint = Theme.secondaryText
                engagementIcon = "checkmark.seal.fill"
            }
        } else {
            engagementText = "Active Inquiry"
            engagementTint = Theme.amber
            engagementIcon = "bubble.left.and.text.bubble.right.fill"
        }

        // Size + delivery date for the engagement (each optional).
        let size = Self.formatSize(vd["dumpsterSize"]?.stringValue)
        let deliveryLabel = Self.shortDate(
            Self.nonEmpty(lead.deliveryDate)
            ?? vd["deliveryDateISO"]?.stringValue
            ?? vd["deliveryDate"]?.stringValue
        )
        var detailParts: [String] = []
        if let size = size { detailParts.append(size) }
        if let d = deliveryLabel { detailParts.append("Delivers \(d)") }
        let jobDetail = detailParts.isEmpty ? nil : detailParts.joined(separator: " · ")

        // Last interaction — most recent touch on the record.
        let lastContact = Self.elapsed(Self.nonEmpty(lead.updatedAt) ?? lead.createdAt)
            .map { "Last contact \($0)" }

        let ctx = CRMContext(
            address: address, engagementText: engagementText, engagementTint: engagementTint,
            engagementIcon: engagementIcon, jobDetail: jobDetail, lastContact: lastContact
        )
        return ctx.hasContent ? ctx : nil
    }

    // MARK: - Customer lookup

    private func lookupCustomer() async {
        guard let handle = voice.activeCallHandle else { return }
        let target = Self.normalize(handle)
        guard target.count >= 7 else { return }

        // Resolve the per-call lead (for the context card) and the person-layer
        // customer (for the name fallback) concurrently. Both are best-effort: a
        // failure — e.g. signed out, where /api/customers is auth-only — just leaves
        // that source nil and name resolution falls back to the next option.
        async let leadsResult = APIService.shared.fetchLeads()
        async let customersResult = APIService.shared.fetchCustomers()

        if let leads = try? await leadsResult {
            let matches = leads.filter { lead in
                let p = Self.normalize(lead.phone ?? lead.callerNumber ?? "")
                return !p.isEmpty && p == target
            }
            // Freshest record wins so name + context reflect the latest engagement.
            matchedLead = matches.max { ($0.updatedAt ?? $0.createdAt) < ($1.updatedAt ?? $1.createdAt) }
        }

        if let customers = try? await customersResult {
            let match = customers.first { c in
                let p = Self.normalize(c.phone ?? "")
                return !p.isEmpty && p == target
            }
            matchedCustomerName = match.flatMap { Self.customerSavedName($0) }
            // The customer's primary address (e.g. their town) — the location-row
            // fallback when the matched call has no clean address of its own. Stored
            // raw; cleanAddress is applied where it's used in crmContext.
            matchedCustomerAddress = match?.address
        }
    }

    // MARK: - String / date helpers

    // A real name contains letters; a phone number is digits + dialing punctuation.
    // This is what keeps initials/identity from ever using a number-as-name.
    private static func isNameLike(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return false }
        let lower = t.lowercased()
        guard lower != "unknown", lower != "unknown caller" else { return false }
        return t.contains { $0.isLetter }
    }

    // The customer's real saved name, for use as a name fallback. Built from
    // first+last, then the server's display_name. The latter rolls up to the phone
    // or "Unknown" when no name exists, which must NOT masquerade as a name (it
    // would put a number or filler in the title + avatar), so the candidate is
    // gated through isNameLike. nil ⇒ no real saved name for this customer.
    private static func customerSavedName(_ c: CustomerSummary) -> String? {
        let composed = [c.firstName, c.lastName]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard let candidate = nonEmpty(composed) ?? nonEmpty(c.displayName),
              isNameLike(candidate) else { return nil }
        return candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s = s, !s.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return s
    }

    // Show an address only when it's clean and real. AI extraction / transcription
    // can emit the model's own uncertainty inline (e.g. "Goalspeed (unclear)") or a
    // bare placeholder; better to show nothing than a garbage address. Returns nil
    // for empty, a placeholder, any uncertainty marker, or a value with no letters.
    private static func cleanAddress(_ s: String?) -> String? {
        guard let v = nonEmpty(s) else { return nil }
        let lower = v.lowercased()
        // Whole-value placeholders the model uses to mean "no address".
        let placeholders: Set<String> = ["n/a", "na", "tbd", "none", "unknown", "null", "-", "—"]
        if placeholders.contains(lower) { return nil }
        // Inline uncertainty appended to an uncertain value, e.g. "… (unclear)".
        let markers = ["(unclear)", "unclear", "inaudible", "not provided",
                       "not given", "unspecified", "didn't catch", "couldn't hear"]
        if markers.contains(where: { lower.contains($0) }) { return nil }
        // A usable address has letters (street/city); pure digits/punctuation isn't one.
        guard v.contains(where: { $0.isLetter }) else { return nil }
        return v
    }

    // "20 yard" / "20yd" → "20yd" (mirrors the dashboard's formatSize).
    private static func formatSize(_ raw: String?) -> String? {
        guard let raw = raw, !raw.isEmpty else { return nil }
        if let r = raw.range(of: "\\d+", options: .regularExpression) { return "\(raw[r])yd" }
        return raw
    }

    private static func prettyStatus(_ s: String) -> String {
        switch s {
        case "booked": return "Booked"
        case "scheduled": return "Scheduled"
        case "delivered": return "Delivered"
        case "active_rental": return "Active Rental"
        case "picked_up": return "Picked Up"
        case "completed": return "Completed"
        case "inquiry": return "Inquiry"
        case "opportunity": return "Opportunity"
        case "quoted": return "Quoted"
        case "lost": return "Lost"
        case "spam": return "Spam"
        default: return s.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    // Leading YYYY-MM-DD → "Jun 23"; nil for anything that isn't a date.
    private static func shortDate(_ s: String?) -> String? {
        guard let raw = s, raw.count >= 10 else { return nil }
        guard let d = dayInputFormatter.date(from: String(raw.prefix(10))) else { return nil }
        return shortOutputFormatter.string(from: d)
    }

    // Relative age of a stored timestamp ("just now" / "5h ago" / "3d ago").
    private static func elapsed(_ s: String?) -> String? {
        guard let d = parseTimestamp(s) else { return nil }
        let diff = Date().timeIntervalSince(d)
        guard diff >= 0 else { return nil }
        if diff < 60 { return "just now" }
        let m = Int(diff / 60); if m < 60 { return "\(m)m ago" }
        let h = m / 60; if h < 24 { return "\(h)h ago" }
        return "\(h / 24)d ago"
    }

    // Tolerant parse of the API's timestamp shapes: ISO-8601, naive SQLite
    // "YYYY-MM-DD HH:MM:SS" (local), or a bare date.
    private static func parseTimestamp(_ s: String?) -> Date? {
        guard let raw = s?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        if raw.contains("T"), let d = isoFormatter.date(from: raw) { return d }
        if let d = naiveLocalFormatter.date(from: raw) { return d }
        if raw.count >= 10, let d = dayInputFormatter.date(from: String(raw.prefix(10))) { return d }
        return nil
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

    // MARK: - Static config

    // Standard dialpad: (digit, letters). Letters are cosmetic; the digit is sent.
    private static let dialpad: [[(String, String)]] = [
        [("1", ""),     ("2", "ABC"), ("3", "DEF")],
        [("4", "GHI"),  ("5", "JKL"), ("6", "MNO")],
        [("7", "PQRS"), ("8", "TUV"), ("9", "WXYZ")],
        [("*", ""),     ("0", "+"),   ("#", "")],
    ]

    private static let dayInputFormatter: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f
    }()
    private static let shortOutputFormatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f
    }()
    private static let naiveLocalFormatter: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; return f
    }()
    private static let isoFormatter = ISO8601DateFormatter()
}

// MARK: - Round call-control button (mute / keypad / speaker)

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

// MARK: - Dialpad key (digit + cosmetic letters)

private struct DialpadKey: View {
    let digit: String
    let letters: String
    let action: (String) -> Void

    var body: some View {
        Button { action(digit) } label: {
            VStack(spacing: 1) {
                Text(digit)
                    .font(.system(size: 32, weight: .regular, design: .rounded))
                    .foregroundColor(.white)
                Text(letters.isEmpty ? " " : letters)
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.5)
                    .foregroundColor(.white.opacity(0.55))
            }
            .frame(width: 68, height: 68)
            .background(Circle().fill(Color.white.opacity(0.09)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dial \(digit)")
    }
}
