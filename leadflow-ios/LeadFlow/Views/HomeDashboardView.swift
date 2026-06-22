import SwiftUI

// Mobile home dashboard. Mirrors the web Home Services dashboard's three
// data-backed sections — Action Queue, Today's Schedule, Availability Tracker —
// in the same order, pulling the same live data from the same API endpoint
// (GET /api/leads?vertical=home_services&includeMissed=true). The Action Queue
// and Today's Schedule are derived entirely client-side, porting the exact
// membership/ranking/date-filter logic from client/src/utils/verticalConfig.js
// and client/src/components/home_services/HomeServicesDashboard.jsx so the mobile
// queue matches the web's. The Availability section pulls live per-size inventory
// from GET /api/dumpsters (requireAuth), scoped to the signed-in business by the
// JWT the app now sends — mirroring the web InventoryPage overview.

// MARK: - Theme (dark navy, per the mockup)

fileprivate enum Theme {
    static let bg = Color(red: 0.039, green: 0.055, blue: 0.106)        // deep navy
    static let card = Color(red: 0.078, green: 0.098, blue: 0.157)      // card navy
    static let cardElevated = Color(red: 0.106, green: 0.129, blue: 0.196)
    static let border = Color.white.opacity(0.07)
    static let primaryText = Color.white
    static let secondaryText = Color(red: 0.58, green: 0.62, blue: 0.71)
    static let mutedText = Color(red: 0.42, green: 0.46, blue: 0.55)
    static let accent = Color(red: 0.18, green: 0.83, blue: 0.71)       // green/teal
    static let high = Color(red: 0.20, green: 0.83, blue: 0.60)         // emerald
    static let warm = Color(red: 0.98, green: 0.75, blue: 0.22)         // amber
    static let cold = Color(red: 0.60, green: 0.64, blue: 0.71)         // gray
    static let danger = Color(red: 0.97, green: 0.45, blue: 0.45)       // red
    static let drop = Color(red: 0.20, green: 0.83, blue: 0.60)         // emerald (delivery)
    static let pick = Color(red: 0.40, green: 0.66, blue: 0.99)         // blue (pickup)
}

// MARK: - Date / string helpers (ports of the web helpers)

fileprivate enum DateHelp {
    static func regexGroups(_ s: String, _ pattern: String) -> [String?]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        guard let m = re.firstMatch(in: s, options: [], range: range) else { return nil }
        var groups: [String?] = []
        for i in 0..<m.numberOfRanges {
            if let r = Range(m.range(at: i), in: s) { groups.append(String(s[r])) } else { groups.append(nil) }
        }
        return groups
    }

    static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    // Pull (year, month, day) from a leading YYYY-MM-DD, validating the format.
    static func ymd(_ value: String?) -> (Int, Int, Int)? {
        guard let raw = value, raw.count >= 10 else { return nil }
        let s = String(raw.prefix(10))
        guard matches(s, "^\\d{4}-\\d{2}-\\d{2}$") else { return nil }
        let parts = s.split(separator: "-")
        guard parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        return (y, m, d)
    }

    // Normalize any stored date/datetime value to its YYYY-MM-DD calendar day.
    static func dayKey(_ value: String?) -> String? {
        guard let raw = value, raw.count >= 10 else { return nil }
        let s = String(raw.prefix(10))
        return matches(s, "^\\d{4}-\\d{2}-\\d{2}$") ? s : nil
    }

    // Parse a YYYY-MM-DD string as a local-calendar date (midnight local), avoiding
    // the UTC-midnight shift `new Date("YYYY-MM-DD")` causes in negative offsets.
    static func parseLocalDate(_ value: String?) -> Date? {
        guard let (y, m, d) = ymd(value) else { return nil }
        var c = DateComponents(); c.year = y; c.month = m; c.day = d
        return Calendar.current.date(from: c)
    }

    // Port of parseFollowUpDate: date-only → local end-of-day; naive SQLite datetime
    // → UTC; full ISO → as-is.
    static func parseFollowUp(_ value: String?) -> Date? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        if matches(raw, "^\\d{4}-\\d{2}-\\d{2}$"), let (y, m, d) = ymd(raw) {
            var c = DateComponents(); c.year = y; c.month = m; c.day = d
            c.hour = 23; c.minute = 59; c.second = 59
            return Calendar.current.date(from: c)
        }
        if matches(raw, "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$") {
            return naiveUTC.date(from: raw)
        }
        return parseInstant(raw)
    }

    // Port of `new Date(str)` for the API's formats: ISO (absolute) or naive SQLite
    // "YYYY-MM-DD HH:MM:SS" (interpreted as local, matching V8 — so relative ages
    // line up with the web exactly).
    static func parseInstant(_ value: String?) -> Date? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        if raw.contains("T") {
            if let d = isoFrac.date(from: raw) { return d }
            if let d = isoPlain.date(from: raw) { return d }
        }
        if matches(raw, "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}") {
            return naiveLocal.date(from: raw)
        }
        if matches(raw, "^\\d{4}-\\d{2}-\\d{2}$") {
            return dateOnlyLocal.date(from: raw)
        }
        return isoFrac.date(from: raw) ?? isoPlain.date(from: raw)
    }

    static func localDayString(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func endOfLocalDay(_ d: Date) -> Date {
        let cal = Calendar.current
        let start = cal.startOfDay(for: d)
        return cal.date(byAdding: DateComponents(hour: 23, minute: 59, second: 59), to: start) ?? d
    }

    // True when a date falls on today or tomorrow (local).
    static func isNearTerm(_ d: Date?, now: Date) -> Bool {
        guard let d = d else { return false }
        let cal = Calendar.current
        let today = cal.startOfDay(for: now)
        guard let tomorrow = cal.date(byAdding: .day, value: 1, to: today) else { return false }
        let day = cal.startOfDay(for: d)
        return day == today || day == tomorrow
    }

    // Best-effort parse of a schedule time ("8:00 AM", "14:30", "9am") to minutes
    // past midnight, for sorting. nil when unparseable (sorts last).
    static func timeToMinutes(_ t: String?) -> Int? {
        guard let s = t?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        if let g = regexGroups(s, "^(\\d{1,2}):(\\d{2})\\s*(am|pm)?$"),
           let hs = g[safe: 1] ?? nil, var h = Int(hs),
           let ms = g[safe: 2] ?? nil, let min = Int(ms) {
            let ap = (g[safe: 3] ?? nil)?.lowercased()
            if ap == "pm" && h < 12 { h += 12 }
            if ap == "am" && h == 12 { h = 0 }
            return h * 60 + min
        }
        if let g = regexGroups(s, "^(\\d{1,2})\\s*(am|pm)$"),
           let hs = g[safe: 1] ?? nil, var h = Int(hs) {
            let ap = (g[safe: 2] ?? nil)?.lowercased()
            if ap == "pm" && h < 12 { h += 12 }
            if ap == "am" && h == 12 { h = 0 }
            return h * 60
        }
        return nil
    }

    // Format an "HH:MM" 24-hour string as 12-hour "8:00 AM".
    static func formatTime12(_ hhmm: String?) -> String? {
        guard let s = hhmm?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        guard let g = regexGroups(s, "^(\\d{1,2}):(\\d{2})"),
              let hs = g[safe: 1] ?? nil, var h = Int(hs),
              let mStr = g[safe: 2] ?? nil else { return s }
        let ap = h >= 12 ? "PM" : "AM"
        h = h % 12; if h == 0 { h = 12 }
        return "\(h):\(mStr) \(ap)"
    }

    static func extractNumbers(_ s: String) -> [Double] {
        guard let re = try? NSRegularExpression(pattern: "\\d+(?:\\.\\d+)?") else { return [] }
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return re.matches(in: s, range: range).compactMap { match in
            Range(match.range, in: s).flatMap { Double(s[$0]) }
        }
    }

    private static let naiveLocal: DateFormatter = formatter("yyyy-MM-dd HH:mm:ss", TimeZone.current)
    private static let naiveUTC: DateFormatter = formatter("yyyy-MM-dd HH:mm:ss", TimeZone(identifier: "UTC"))
    private static let dateOnlyLocal: DateFormatter = formatter("yyyy-MM-dd", TimeZone.current)
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()

    private static func formatter(_ format: String, _ tz: TimeZone?) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = format
        if let tz = tz { f.timeZone = tz }
        return f
    }
}

fileprivate extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

fileprivate func nonEmpty(_ s: String?) -> String? {
    guard let s = s, !s.isEmpty else { return nil }
    return s
}

fileprivate func isBlank(_ s: String?) -> Bool { (s ?? "").isEmpty }

// MARK: - Action prioritization (port of verticalConfig.js + dashboard helpers)

fileprivate let OPERATIONAL_JOB_STATUSES: Set<String> = ["booked", "scheduled", "delivered", "active_rental", "picked_up", "completed"]
fileprivate let TERMINAL_JOB_STATUSES: Set<String> = ["completed", "lost", "spam"]
fileprivate let HOUR: TimeInterval = 3600
fileprivate let STALE_THRESHOLD: TimeInterval = 48 * 3600

// Grace windows that decide when items age out of the Action Queue. The web pulls
// per-business overrides from GET /api/settings (requireAuth); the app uses the
// same defaults the web falls back to, keeping this section tokenless.
fileprivate struct QueueConfig {
    var asapExpiryH: Double = 24
    var followupExpiryH: Double = 48
    var voicemailExpiryH: Double = 24
    var missedCallExpiryH: Double = 24
}

fileprivate struct LeadActionState {
    var intent: String
    var followUpDate: Date?
    var followUpDueToday: Bool
    var followUpOverdue: Bool
    var stale: Bool
    var isActive: Bool
    var isOpportunity: Bool
    var isOperational: Bool
    var isDead: Bool
    var jobStatus: String?
    var recommendation: String
    var estimatedRevenue: Double?
}

// Dead-end detection — AI flagged the call as needing no follow-up.
fileprivate func isDeadLead(_ lead: Lead, _ vd: [String: AnyCodable]) -> Bool {
    if vd["requiresFollowUp"]?.boolValue == false { return true }
    let followUp = nonEmpty(vd["followUpDate"]?.stringValue) ?? nonEmpty(lead.followUpDate)
    let rec = (vd["aiRecommendation"]?.stringValue ?? "").lowercased()
    let deadLanguage = DateHelp.matches(rec, "no follow.?up|not interested|customer declined|\\bdeclined\\b|went with another|going elsewhere|no further action|won'?t proceed")
    if followUp == nil && deadLanguage { return true }
    let outcome = (nonEmpty(lead.outcome) ?? vd["outcome"]?.stringValue ?? "").lowercased()
    let declinedOutcome = DateHelp.matches(outcome, "not[_ ]?interested|declined|cancell?ed")
    if vd["intentLevel"]?.stringValue == "cold" && declinedOutcome { return true }
    return false
}

fileprivate func isCriticalLead(_ lead: Lead, _ vd: [String: AnyCodable]) -> Bool {
    let aiRec = vd["aiRecommendation"]?.stringValue ?? ""
    let notes = lead.internalNotes ?? ""
    return vd["inventoryConflict"]?.boolValue == true
        || aiRec.range(of: "INVENTORY CONFLICT", options: .caseInsensitive) != nil
        || notes.range(of: "AUTO-BOOK BLOCKED", options: .caseInsensitive) != nil
}

fileprivate func isExpiredFlagged(_ lead: Lead) -> Bool {
    (lead.internalNotes ?? "").range(of: "Expired — no action taken", options: .caseInsensitive) != nil
}

fileprivate func isDismissedFlagged(_ lead: Lead) -> Bool {
    (lead.internalNotes ?? "").range(of: "Dismissed from Action Queue", options: .caseInsensitive) != nil
}

// A booked/scheduled job delivering today/tomorrow still missing the delivery
// address or payment — operational risk that jumps to the top tier.
fileprivate func bookedAttentionReason(_ lead: Lead, _ vd: [String: AnyCodable], now: Date) -> String? {
    guard lead.jobStatus == "booked" || lead.jobStatus == "scheduled" else { return nil }
    guard let d = DateHelp.parseLocalDate(nonEmpty(lead.deliveryDate) ?? vd["deliveryDateISO"]?.stringValue ?? vd["deliveryDate"]?.stringValue) else { return nil }
    let cal = Calendar.current
    let today = cal.startOfDay(for: now)
    guard let tomorrow = cal.date(byAdding: .day, value: 1, to: today) else { return nil }
    let day = cal.startOfDay(for: d)
    guard day == today || day == tomorrow else { return nil }
    var missing: [String] = []
    if isBlank(vd["deliveryAddress"]?.stringValue) { missing.append("delivery address") }
    if isBlank(lead.paidAt) { missing.append("payment") }
    guard !missing.isEmpty else { return nil }
    let when = day == today ? "today" : "tomorrow"
    return "Delivering \(when) — missing \(missing.joined(separator: " & "))"
}

fileprivate func computeActionState(_ lead: Lead, _ vd: [String: AnyCodable], now: Date) -> LeadActionState {
    let dead = isDeadLead(lead, vd)
    let jobStatus = nonEmpty(lead.jobStatus) ?? vd["job_status"]?.stringValue
    let status = nonEmpty(lead.status) ?? "new"
    let isMissedCall = lead.callType == "missed_call"

    let isActive: Bool
    if isMissedCall {
        isActive = false
    } else if let js = jobStatus {
        isActive = !TERMINAL_JOB_STATUSES.contains(js)
    } else {
        isActive = !["booked", "lost", "spam"].contains(status)
    }

    let isOpportunity: Bool
    if isMissedCall {
        isOpportunity = false
    } else if let js = jobStatus {
        isOpportunity = !OPERATIONAL_JOB_STATUSES.contains(js) && !TERMINAL_JOB_STATUSES.contains(js)
    } else {
        isOpportunity = isActive
    }

    // Intent: prefer AI's call, fall back to urgency/emergency cues.
    var intent: String? = ["high", "warm", "cold"].contains(vd["intentLevel"]?.stringValue ?? "") ? vd["intentLevel"]?.stringValue : nil
    if intent == nil {
        let urgency = vd["urgency"]?.stringValue
        if urgency == "ASAP" || vd["emergencyStatus"]?.boolValue == true { intent = "high" }
        else if urgency == "This Week" { intent = "warm" }
        else { intent = "warm" }
    }
    let intentVal = intent ?? "warm"

    let followUpDate = DateHelp.parseFollowUp(vd["followUpDate"]?.stringValue)
    let createdAt = DateHelp.parseInstant(lead.createdAt)
    let ageSec = createdAt != nil ? now.timeIntervalSince(createdAt!) : 0

    let cal = Calendar.current
    let followUpDueToday = followUpDate != nil && isActive && followUpDate! <= DateHelp.endOfLocalDay(now)
    let followUpOverdue = followUpDate != nil && isActive && followUpDate! < cal.startOfDay(for: now)
    let neverContacted = (jobStatus == "inquiry" || jobStatus == nil) && status == "new"
    let stale = isActive && neverContacted && ageSec >= STALE_THRESHOLD

    // Recommendation: AI sentence wins; otherwise a sensible default.
    let isVoicemail = lead.callType == "voicemail"
    var recommendation = (vd["aiRecommendation"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if recommendation.isEmpty {
        let isAsapActive = isOpportunity && isActive && vd["urgency"]?.stringValue == "ASAP"
        let noConfirmedDelivery = isOpportunity && isActive && intentVal == "high" && isBlank(lead.deliveryDate)
            && (jobStatus == "inquiry" || jobStatus == "opportunity" || jobStatus == nil)
        if isAsapActive { recommendation = "Customer needs service ASAP — call back immediately." }
        else if followUpDueToday { recommendation = "Follow up today — scheduled callback is due." }
        else if noConfirmedDelivery { recommendation = "Confirm delivery date — customer agreed to price and size but no date was set." }
        else if stale { recommendation = "Lead is going cold — reach out to re-engage." }
        else if intentVal == "high" { recommendation = "Call today — high-intent lead with no follow-up yet." }
        else if status == "waiting_on_customer" { recommendation = "Check back with the customer." }
        else { recommendation = "Review and decide on next step." }
    }
    if isVoicemail {
        recommendation = "Call back \(displayLeadName(lead, vd, fallback: "this caller")) — came in via voicemail"
    }
    if isMissedCall {
        let name = nonEmpty(vd["customerName"]?.stringValue) ?? nonEmpty(joinedName(lead)) ?? nonEmpty(lead.phone) ?? nonEmpty(lead.callerNumber) ?? "this caller"
        recommendation = "Call back \(name) — missed call, no voicemail"
    }

    var estimatedRevenue: Double? = nil
    if let n = vd["estimatedRevenue"]?.doubleValue { estimatedRevenue = n }
    else if let q = vd["quotedPrice"]?.stringValue {
        let nums = DateHelp.extractNumbers(q)
        if nums.count == 1 { estimatedRevenue = nums[0] }
        else if nums.count >= 2 { estimatedRevenue = (nums[0] + nums[1]) / 2 }
    }

    let isOperational = isMissedCall ? false : (jobStatus != nil ? OPERATIONAL_JOB_STATUSES.contains(jobStatus!) : false)

    return LeadActionState(
        intent: intentVal, followUpDate: followUpDate, followUpDueToday: followUpDueToday,
        followUpOverdue: followUpOverdue, stale: stale, isActive: isActive, isOpportunity: isOpportunity,
        isOperational: isOperational, isDead: dead, jobStatus: jobStatus, recommendation: recommendation,
        estimatedRevenue: estimatedRevenue
    )
}

fileprivate struct QueueClassification {
    let inQueue: Bool
    let expired: Bool
    let reason: String?
}

fileprivate func classifyForQueue(_ lead: Lead, _ state: LeadActionState, _ vd: [String: AnyCodable], now: Date, cfg: QueueConfig) -> QueueClassification {
    let status = nonEmpty(lead.status) ?? "new"
    let neverContacted = (state.jobStatus == "inquiry" || state.jobStatus == nil) && status == "new"

    if lead.callType == "missed_call" {
        if !neverContacted { return QueueClassification(inQueue: false, expired: false, reason: nil) }
        guard let created = DateHelp.parseInstant(lead.createdAt) else {
            return QueueClassification(inQueue: true, expired: false, reason: nil)
        }
        let active = now.timeIntervalSince1970 <= created.timeIntervalSince1970 + cfg.missedCallExpiryH * HOUR
        return QueueClassification(inQueue: active, expired: !active, reason: nil)
    }

    if state.isOperational {
        let reason = bookedAttentionReason(lead, vd, now: now)
        return QueueClassification(inQueue: reason != nil, expired: false, reason: reason)
    }

    if state.isDead { return QueueClassification(inQueue: false, expired: false, reason: nil) }
    if !state.isOpportunity || !state.isActive { return QueueClassification(inQueue: false, expired: false, reason: nil) }

    let critical = isCriticalLead(lead, vd)
    let isVoicemail = lead.callType == "voicemail"

    var reasons: [Bool] = []   // each entry = "still within its window"
    if critical { reasons.append(true) }

    if let fu = state.followUpDate, fu <= now {
        let expireAt = fu.timeIntervalSince1970 + cfg.followupExpiryH * HOUR
        reasons.append(now.timeIntervalSince1970 <= expireAt)
    }

    let deliveryDate = DateHelp.parseLocalDate(nonEmpty(lead.deliveryDate) ?? vd["deliveryDateISO"]?.stringValue ?? vd["deliveryDate"]?.stringValue)

    if (vd["urgency"]?.stringValue ?? "").lowercased() == "asap" {
        let active: Bool
        if let dd = deliveryDate {
            active = now.timeIntervalSince1970 <= DateHelp.endOfLocalDay(dd).timeIntervalSince1970 + cfg.asapExpiryH * HOUR
        } else { active = true }
        reasons.append(active)
    }

    if DateHelp.isNearTerm(deliveryDate, now: now), let dd = deliveryDate {
        let active = now.timeIntervalSince1970 <= DateHelp.endOfLocalDay(dd).timeIntervalSince1970 + cfg.asapExpiryH * HOUR
        reasons.append(active)
    }

    if isVoicemail && neverContacted {
        if let created = DateHelp.parseInstant(lead.createdAt) {
            reasons.append(now.timeIntervalSince1970 <= created.timeIntervalSince1970 + cfg.voicemailExpiryH * HOUR)
        } else {
            reasons.append(true)
        }
    }

    if reasons.isEmpty { return QueueClassification(inQueue: false, expired: false, reason: nil) }
    let anyActive = reasons.contains(true)
    return QueueClassification(inQueue: anyActive, expired: !anyActive, reason: nil)
}

// Priority tier (1 = most urgent). Fractional tiers slot missed calls between the
// integer tiers as they age. Matches getAttentionTier in the web dashboard.
fileprivate func attentionTier(_ lead: Lead, _ state: LeadActionState, _ vd: [String: AnyCodable], bookedReason: String?, now: Date) -> Double {
    if isCriticalLead(lead, vd) || bookedReason != nil { return 1 }

    let status = nonEmpty(lead.status) ?? "new"
    let neverContacted = (state.jobStatus == "inquiry" || state.jobStatus == nil) && status == "new"
    let isVoicemail = lead.callType == "voicemail"

    if isVoicemail && neverContacted { return 2 }

    if lead.callType == "missed_call" && neverContacted {
        let ageH = DateHelp.parseInstant(lead.createdAt).map { now.timeIntervalSince($0) / HOUR } ?? 0
        if ageH < 1 { return 2.5 }
        if ageH < 2 { return 4.5 }
        if ageH < 4 { return 5.5 }
        return 6.5
    }

    let deliveryDate = DateHelp.parseLocalDate(nonEmpty(lead.deliveryDate) ?? vd["deliveryDateISO"]?.stringValue ?? vd["deliveryDate"]?.stringValue)
    if (vd["urgency"]?.stringValue ?? "").lowercased() == "asap" || DateHelp.isNearTerm(deliveryDate, now: now) { return 3 }
    if state.followUpOverdue && (state.intent == "high" || state.intent == "warm") { return 4 }
    if state.followUpDueToday && !state.followUpOverdue { return 5 }
    return 6
}

// MARK: - Name + label helpers

fileprivate func joinedName(_ lead: Lead) -> String? {
    let parts = [lead.customerFirstName, lead.customerLastName].compactMap { $0 }.filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: " ")
}

fileprivate func displayLeadName(_ lead: Lead, _ vd: [String: AnyCodable], fallback: String = "Unknown") -> String {
    nonEmpty(vd["customerName"]?.stringValue) ?? joinedName(lead) ?? fallback
}

fileprivate func followUpLabel(_ followUpDate: Date?, now: Date) -> String? {
    guard let f = followUpDate else { return nil }
    let diff = f.timeIntervalSince(now)
    if diff < 0 { return "Overdue" }
    let totalMinutes = Int((diff / 60).rounded())
    if totalMinutes < 60 { return "Due now" }
    let hrs = Int((Double(totalMinutes) / 60).rounded())
    if hrs < 24 { return "Due in \(hrs)h" }
    let days = Int((Double(totalMinutes) / 1440).rounded())
    return "Due in \(days)d"
}

fileprivate func elapsedLabel(_ date: Date?, now: Date) -> String? {
    guard let d = date else { return nil }
    let diff = now.timeIntervalSince(d)
    if diff < 0 { return nil }
    let minutes = Int(diff / 60)
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m ago" }
    let hrs = minutes / 60
    if hrs < 24 { return "\(hrs)h ago" }
    let days = hrs / 24
    return "\(days)d ago"
}

fileprivate func formatSize(_ raw: String?) -> String? {
    guard let raw = raw, !raw.isEmpty else { return nil }
    if let g = DateHelp.regexGroups(raw, "(\\d+)"), let n = g[safe: 1] ?? nil { return "\(n)yd" }
    return raw
}

fileprivate func scheduleBadges(subVertical: String?) -> (start: String, end: String) {
    switch subVertical {
    case "hvac": return ("JOB", "DONE")
    default: return ("DROP", "PICK")   // dumpster_rental + fallback
    }
}

// MARK: - Derived view models

fileprivate enum BadgeKind { case critical, intent(String) }
fileprivate enum ScheduleType { case drop, pick; var order: Int { self == .drop ? 0 : 1 } }

fileprivate struct ActionItem: Identifiable {
    let id: Int
    let badge: BadgeKind
    let name: String
    let phone: String?          // shown only when it differs from the name
    let isVoicemail: Bool
    let isMissedCall: Bool
    let reason: String?
    let reasonIsCritical: Bool
    let followUpLabel: String?
    let elapsedLabel: String?
    let tier: Double
}

fileprivate struct ScheduleItem: Identifiable {
    let id = UUID()
    let leadID: Int
    let type: ScheduleType
    let badge: String
    let time: String?           // formatted, e.g. "8:00 AM"
    let sortMinutes: Int?
    let name: String
    let size: String?
    let phone: String?
    let address: String?
}

// MARK: - View Model

@MainActor
fileprivate final class HomeDashboardViewModel: ObservableObject {
    @Published var actionItems: [ActionItem] = []
    @Published var schedule: [ScheduleItem] = []
    @Published var inventory: [InventoryPool] = []
    @Published var isLoading = false
    @Published var hasLoaded = false
    @Published var inventoryLoaded = false
    @Published var errorMessage: String?
    @Published var inventoryError: String?

    func refresh() async {
        isLoading = true
        // Leads (Action Queue + Today's Schedule) and inventory (Availability) come
        // from independent endpoints — load them concurrently and let each fail on
        // its own so one outage doesn't blank the other.
        async let leadsLoad: Void = loadLeads()
        async let inventoryLoad: Void = loadInventory()
        _ = await (leadsLoad, inventoryLoad)
        isLoading = false
        hasLoaded = true
    }

    private func loadLeads() async {
        do {
            let leads = try await APIService.shared.fetchHomeServicesLeads()
            compute(leads)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadInventory() async {
        do {
            inventory = try await APIService.shared.fetchInventory()
            inventoryError = nil
        } catch {
            inventoryError = error.localizedDescription
        }
        inventoryLoaded = true
    }

    private func compute(_ leads: [Lead]) {
        let now = Date()
        let cfg = QueueConfig()
        let enriched: [(lead: Lead, vd: [String: AnyCodable], state: LeadActionState)] = leads.map {
            let vd = $0.verticalData
            return ($0, vd, computeActionState($0, vd, now: now))
        }

        // ── Action Queue: classify membership, rank by tier, drop expired/dismissed ──
        var items: [(item: ActionItem, state: LeadActionState, lead: Lead)] = []
        for e in enriched {
            let q = classifyForQueue(e.lead, e.state, e.vd, now: now, cfg: cfg)
            guard q.inQueue, !isExpiredFlagged(e.lead), !isDismissedFlagged(e.lead) else { continue }
            let tier = attentionTier(e.lead, e.state, e.vd, bookedReason: q.reason, now: now)
            let isMissedCall = e.lead.callType == "missed_call"
            var name = displayLeadName(e.lead, e.vd)
            if isMissedCall && name == "Unknown" {
                name = nonEmpty(e.lead.phone) ?? nonEmpty(e.lead.callerNumber) ?? "Unknown caller"
            }
            let showPhone = nonEmpty(e.lead.phone) != nil && e.lead.phone != name
            let fuLabel = followUpLabel(e.state.followUpDate, now: now)
            let elapsed = (isMissedCall && fuLabel == nil) ? elapsedLabel(DateHelp.parseInstant(e.lead.createdAt), now: now) : nil
            let reasonText = nonEmpty(q.reason) ?? e.state.recommendation
            let badge: BadgeKind = tier == 1 ? .critical : .intent(e.state.intent)
            let item = ActionItem(
                id: e.lead.id, badge: badge, name: name, phone: showPhone ? e.lead.phone : nil,
                isVoicemail: e.lead.callType == "voicemail", isMissedCall: isMissedCall,
                reason: nonEmpty(reasonText), reasonIsCritical: q.reason != nil || tier == 1,
                followUpLabel: fuLabel, elapsedLabel: elapsed, tier: tier
            )
            items.append((item, e.state, e.lead))
        }
        items.sort { a, b in
            if a.item.tier != b.item.tier { return a.item.tier < b.item.tier }
            let fa = a.state.followUpDate?.timeIntervalSince1970 ?? .greatestFiniteMagnitude
            let fb = b.state.followUpDate?.timeIntervalSince1970 ?? .greatestFiniteMagnitude
            if fa != fb { return fa < fb }
            let ra = a.lead.estimatedRevenue ?? a.state.estimatedRevenue ?? 0
            let rb = b.lead.estimatedRevenue ?? b.state.estimatedRevenue ?? 0
            return ra > rb
        }
        actionItems = items.map { $0.item }

        // ── Today's Schedule: operational jobs with a drop or pickup landing today ──
        let todayStr = DateHelp.localDayString(now)
        var sched: [ScheduleItem] = []
        for e in enriched {
            guard let js = nonEmpty(e.lead.jobStatus), OPERATIONAL_JOB_STATUSES.contains(js) else { continue }
            let badges = scheduleBadges(subVertical: e.lead.subVertical)
            let deliveryStr = DateHelp.dayKey(nonEmpty(e.lead.deliveryDate) ?? e.vd["deliveryDateISO"]?.stringValue ?? e.vd["deliveryDate"]?.stringValue)
            let pickupStr = DateHelp.dayKey(nonEmpty(e.lead.pickupDate) ?? e.vd["pickupDate"]?.stringValue)
            let name = displayLeadName(e.lead, e.vd)
            let size = formatSize(e.vd["dumpsterSize"]?.stringValue)
            let address = nonEmpty(e.vd["deliveryAddress"]?.stringValue)
            if deliveryStr == todayStr {
                sched.append(ScheduleItem(leadID: e.lead.id, type: .drop, badge: badges.start,
                                          time: DateHelp.formatTime12(e.lead.scheduledTime), sortMinutes: DateHelp.timeToMinutes(e.lead.scheduledTime),
                                          name: name, size: size, phone: nonEmpty(e.lead.phone), address: address))
            }
            if pickupStr == todayStr {
                sched.append(ScheduleItem(leadID: e.lead.id, type: .pick, badge: badges.end,
                                          time: DateHelp.formatTime12(e.lead.scheduledTime), sortMinutes: DateHelp.timeToMinutes(e.lead.scheduledTime),
                                          name: name, size: size, phone: nonEmpty(e.lead.phone), address: address))
            }
        }
        sched.sort { a, b in
            if let ta = a.sortMinutes, let tb = b.sortMinutes, ta != tb { return ta < tb }
            if a.sortMinutes != nil && b.sortMinutes == nil { return true }
            if a.sortMinutes == nil && b.sortMinutes != nil { return false }
            return a.type.order < b.type.order
        }
        schedule = sched
    }
}

// MARK: - Main View

struct HomeDashboardView: View {
    @StateObject private var vm = HomeDashboardViewModel()
    @State private var selectedLeadID: Int?
    @State private var showLeadReview = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 16) {
                        header
                        ActionQueueCard(items: vm.actionItems, loading: vm.isLoading && !vm.hasLoaded, error: vm.errorMessage, onTap: openLead)
                        TodaysScheduleCard(items: vm.schedule, loading: vm.isLoading && !vm.hasLoaded, onTap: openLead)
                        AvailabilityCard(pools: vm.inventory,
                                         loading: vm.isLoading && !vm.inventoryLoaded,
                                         error: vm.inventoryError)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 28)
                }
            }
            .navigationBarHidden(true)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await vm.refresh() }
            .task { if !vm.hasLoaded { await vm.refresh() } }
            .sheet(isPresented: $showLeadReview) {
                if let id = selectedLeadID {
                    LeadReviewView(leadID: id, onDismiss: {
                        showLeadReview = false
                        Task { await vm.refresh() }
                    })
                }
            }
        }
    }

    private func openLead(_ id: Int) {
        selectedLeadID = id
        showLeadReview = true
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        if hour < 12 { return "Good morning" }
        if hour < 17 { return "Good afternoon" }
        return "Good evening"
    }

    private var ownerName: String {
        let business = LocalStorageService.shared.businessName.trimmingCharacters(in: .whitespaces)
        let user = LocalStorageService.shared.userName.trimmingCharacters(in: .whitespaces)
        return nonEmpty(business) ?? nonEmpty(user) ?? ""
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image("StreamLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 30)
                    .accessibilityLabel("Stream")
                Spacer()
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(ownerName.isEmpty ? "\(greeting) 👋" : "\(greeting), \(ownerName) 👋")
                    .font(.title2).fontWeight(.bold)
                    .foregroundColor(Theme.primaryText)
                Text("Here's what's happening with your business today.")
                    .font(.subheadline)
                    .foregroundColor(Theme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }
}

// MARK: - Section cards

fileprivate struct ActionQueueCard: View {
    let items: [ActionItem]
    let loading: Bool
    let error: String?
    let onTap: (Int) -> Void

    var body: some View {
        DashCard {
            CardHeaderRow(icon: "exclamationmark.triangle.fill", iconColor: Theme.danger, title: "Action Queue") {
                if !items.isEmpty {
                    CountBadge(count: items.count, color: Theme.danger)
                }
            }
            if loading {
                LoadingRow()
            } else if let error = error, items.isEmpty {
                EmptyMessage(text: "Couldn't load — pull to refresh.\n\(error)", systemImage: "wifi.exclamationmark")
            } else if items.isEmpty {
                EmptyMessage(text: "Inbox clear — great work! 🎉", systemImage: "checkmark.circle")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { RowDivider() }
                        ActionRow(item: item).onTapGesture { onTap(item.id) }
                    }
                }
            }
        }
    }
}

fileprivate struct ActionRow: View {
    let item: ActionItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            tierAccent
            badgeView
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.name)
                        .font(.subheadline).fontWeight(.semibold)
                        .foregroundColor(Theme.primaryText)
                        .lineLimit(1)
                    if let phone = item.phone {
                        Text(phone).font(.caption2).foregroundColor(Theme.mutedText).lineLimit(1)
                    }
                    if item.isVoicemail { MiniTag(text: "VM", color: Theme.pick) }
                    if item.isMissedCall { MiniTag(text: "MISSED", color: Theme.warm) }
                }
                if let reason = item.reason {
                    Text(reason)
                        .font(.caption).fontWeight(.medium)
                        .foregroundColor(item.reasonIsCritical ? Theme.danger : Theme.accent)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            trailingLabel
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    private var tierAccent: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(accentColor)
            .frame(width: 3)
            .frame(maxHeight: .infinity)
    }

    private var accentColor: Color {
        if item.tier == 1 { return .clear }       // critical badge already signals urgency
        if item.tier <= 3 { return Theme.warm.opacity(0.8) }
        if item.tier <= 5 { return Theme.warm.opacity(0.45) }
        return Theme.border
    }

    @ViewBuilder private var badgeView: some View {
        switch item.badge {
        case .critical:
            TagPill(text: "CRITICAL", color: Theme.danger)
        case .intent(let intent):
            TagPill(text: intentLabel(intent), color: intentColor(intent))
        }
    }

    @ViewBuilder private var trailingLabel: some View {
        if let label = item.followUpLabel {
            let urgent = label == "Overdue" || label == "Due now"
            PillLabel(text: label, color: urgent ? Theme.danger : Theme.warm)
        } else if let elapsed = item.elapsedLabel {
            PillLabel(text: elapsed, color: Theme.warm)
        }
    }
}

fileprivate struct TodaysScheduleCard: View {
    let items: [ScheduleItem]
    let loading: Bool
    let onTap: (Int) -> Void

    private var todayLabel: String {
        let f = DateFormatter(); f.dateFormat = "MMM d"
        return f.string(from: Date())
    }

    var body: some View {
        DashCard {
            CardHeaderRow(icon: "calendar", iconColor: Theme.accent, title: "Today's Schedule") {
                Text(todayLabel).font(.caption).foregroundColor(Theme.mutedText)
            }
            if loading {
                LoadingRow()
            } else if items.isEmpty {
                EmptyMessage(text: "Nothing scheduled for today.", systemImage: "calendar")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { RowDivider() }
                        ScheduleRow(item: item).onTapGesture { onTap(item.leadID) }
                    }
                }
            }
        }
    }
}

fileprivate struct ScheduleRow: View {
    let item: ScheduleItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(item.time ?? "Flexible")
                .font(.caption).fontWeight(.semibold)
                .foregroundColor(item.time != nil ? Theme.secondaryText : Theme.mutedText)
                .frame(width: 66, alignment: .leading)
            TagPill(text: item.badge, color: item.type == .drop ? Theme.drop : Theme.pick)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.name)
                        .font(.subheadline).fontWeight(.semibold)
                        .foregroundColor(Theme.primaryText)
                        .lineLimit(1)
                    if let size = item.size {
                        Text(size).font(.caption2).foregroundColor(Theme.secondaryText)
                    }
                }
                if item.phone != nil || item.address != nil {
                    Text([item.phone, item.address].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption2).foregroundColor(Theme.mutedText)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

// Availability — third section. Live per-size inventory from GET /api/dumpsters
// (requireAuth, scoped to the signed-in business by the JWT). Mirrors the web
// InventoryPage overview: each size shows units available (owned − in service)
// against the owned total, with a tag for any units pulled for service.
fileprivate struct AvailabilityCard: View {
    let pools: [InventoryPool]
    let loading: Bool
    let error: String?

    private var totalOwned: Int { pools.reduce(0) { $0 + $1.quantity } }
    private var totalAvailable: Int { pools.reduce(0) { $0 + $1.available } }

    var body: some View {
        DashCard {
            CardHeaderRow(icon: "shippingbox.fill", iconColor: Theme.accent, title: "Availability") {
                if !pools.isEmpty {
                    Text("\(totalAvailable) of \(totalOwned) ready")
                        .font(.caption).foregroundColor(Theme.mutedText)
                }
            }
            if loading {
                LoadingRow()
            } else if let error = error, pools.isEmpty {
                EmptyMessage(text: "Couldn't load availability — pull to refresh.\n\(error)", systemImage: "wifi.exclamationmark")
            } else if pools.isEmpty {
                EmptyMessage(text: "No inventory yet. Add dumpster sizes on the web dashboard to track availability here.", systemImage: "shippingbox")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(pools.enumerated()), id: \.element.id) { index, pool in
                        if index > 0 { RowDivider() }
                        AvailabilityRow(pool: pool)
                    }
                }
            }
        }
    }
}

fileprivate struct AvailabilityRow: View {
    let pool: InventoryPool

    // Green when there's comfortable stock, amber at the last unit, red when none
    // are free — a quick at-a-glance read of each size's health.
    private var availColor: Color {
        if pool.available <= 0 { return Theme.danger }
        if pool.available == 1 { return Theme.warm }
        return Theme.high
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            TagPill(text: formatSize(pool.size) ?? pool.size, color: Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text("\(pool.available)")
                        .font(.subheadline).fontWeight(.bold)
                        .foregroundColor(availColor)
                    Text("of \(pool.quantity) available")
                        .font(.subheadline)
                        .foregroundColor(Theme.secondaryText)
                }
                if let notes = nonEmpty(pool.notes) {
                    Text(notes)
                        .font(.caption2).foregroundColor(Theme.mutedText)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if pool.unitsInService > 0 {
                MiniTag(text: "\(pool.unitsInService) IN SERVICE", color: Theme.warm)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

// MARK: - Reusable building blocks

fileprivate struct DashCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Theme.border, lineWidth: 1)
            )
    }
}

fileprivate struct CardHeaderRow<Trailing: View>: View {
    let icon: String
    let iconColor: Color
    let title: String
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 14, weight: .semibold)).foregroundColor(iconColor)
                Text(title).font(.subheadline).fontWeight(.bold).foregroundColor(Theme.primaryText)
                Spacer()
                trailing
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            RowDivider()
        }
    }
}

fileprivate struct RowDivider: View {
    var body: some View { Rectangle().fill(Theme.border).frame(height: 1) }
}

fileprivate struct CountBadge: View {
    let count: Int
    let color: Color
    var body: some View {
        Text("\(count)")
            .font(.caption2).fontWeight(.bold)
            .foregroundColor(color)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.18)))
    }
}

fileprivate struct TagPill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundColor(color)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 4).fill(color.opacity(0.16)))
    }
}

fileprivate struct MiniTag: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 8, weight: .bold))
            .foregroundColor(color)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 3).fill(color.opacity(0.16)))
    }
}

fileprivate struct PillLabel: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.caption2).fontWeight(.semibold)
            .foregroundColor(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.16)))
            .fixedSize()
    }
}

fileprivate struct LoadingRow: View {
    var body: some View {
        HStack {
            Spacer()
            ProgressView().tint(Theme.secondaryText)
            Spacer()
        }
        .padding(.vertical, 32)
    }
}

fileprivate struct EmptyMessage: View {
    let text: String
    let systemImage: String
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage).font(.system(size: 20)).foregroundColor(Theme.mutedText)
            Text(text)
                .font(.footnote)
                .foregroundColor(Theme.mutedText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 30)
    }
}

// MARK: - Intent badge styling (mirrors INTENT_LABELS / INTENT_STYLES)

fileprivate func intentLabel(_ intent: String) -> String {
    switch intent {
    case "high": return "HIGH"
    case "warm": return "WARM"
    case "cold": return "COLD"
    default: return intent.uppercased()
    }
}

fileprivate func intentColor(_ intent: String) -> Color {
    switch intent {
    case "high": return Theme.high
    case "warm": return Theme.warm
    case "cold": return Theme.cold
    default: return Theme.cold
    }
}
