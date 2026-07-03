export const VERTICALS = [
  { id: 'auto_dealer', label: 'Auto Dealer' },
  { id: 'home_services', label: 'Home Services' },
];

// Legacy pipeline state — kept for backward compatibility; job_status drives Phase 2 UI.
export const HOME_SERVICES_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'needs_follow_up', label: 'Needs Follow Up' },
  { value: 'waiting_on_customer', label: 'Waiting On Customer' },
  { value: 'booked', label: 'Booked' },
  { value: 'lost', label: 'Lost' },
  { value: 'spam', label: 'Spam' },
];

// Phase 2: full job lifecycle. The active chain is
//   inquiry → pending_payment → booked → active_rental → awaiting_final_payment → completed.
// scheduled / delivered / picked_up are RETIRED mid-states — kept for back-compat
// labels only (nothing transitions into them; legacy rows map at read time).
export const JOB_STATUSES = [
  { value: 'inquiry', label: 'Inquiry' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'pending_payment', label: 'Pending Payment' },
  { value: 'booked', label: 'Booked' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'active_rental', label: 'Active Rental' },
  { value: 'picked_up', label: 'Picked Up' },
  { value: 'awaiting_final_payment', label: 'Awaiting Final Payment' },
  { value: 'completed', label: 'Completed' },
  // Non-job terminal states
  { value: 'lost', label: 'Lost' },
  { value: 'spam', label: 'Spam' },
];

// ── Canonical status source of truth (CLIENT) ─────────────────────────────────
// The one place the web app defines job-status VALUES and the named status GROUPS
// it tests membership against. Mirrored on the server in server/config/jobStatus.js
// (that CommonJS module can't import this ES module) — keep the two IDENTICAL in
// membership. Any change here must be mirrored there and vice-versa.
//
// The rationalized lifecycle:
//   inquiry → pending_payment → booked → active_rental → awaiting_final_payment → completed
//   plus terminal side-states lost, spam. scheduled/delivered/picked_up are RETIRED
//   mid-states (labels only; legacy rows map at read time via mapLegacyJobStatus).
// The two historical inconsistencies are RESOLVED (identically on the server):
//   1. OPERATIONAL/active EXCLUDES 'completed' — a completed job is terminal and must
//      not appear in active-job lists, inventory, or the schedule.
//   2. TERMINAL = {completed, lost, spam} everywhere; the legacy "booked = deal closed"
//      meaning is dropped (booked now means a confirmed, in-flight job).

// The job_status values as named constants (same strings as JOB_STATUSES above).
export const JOB_STATUS = Object.freeze({
  INQUIRY: 'inquiry',
  OPPORTUNITY: 'opportunity',
  PENDING_PAYMENT: 'pending_payment',
  BOOKED: 'booked',
  SCHEDULED: 'scheduled',
  DELIVERED: 'delivered',
  ACTIVE_RENTAL: 'active_rental',
  PICKED_UP: 'picked_up',
  AWAITING_FINAL_PAYMENT: 'awaiting_final_payment',
  COMPLETED: 'completed',
  LOST: 'lost',
  SPAM: 'spam',
});

// The separate PAYMENT axis (leads.payment_status) — shown as a second indicator
// alongside job_status so "work done, still owed" is visible.
export const PAYMENT_STATUS = Object.freeze({
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
});

// RESERVES a unit + occupies the calendar/inventory. Booked is PAID + reserved.
// EXCLUDES pending_payment (nothing reserved pre-payment), awaiting_final_payment /
// picked_up (unit already back), and completed. Legacy scheduled/delivered kept so
// pre-lifecycle rows still occupy correctly.
export const ACTIVE_JOB_STATUSES = Object.freeze([
  JOB_STATUS.BOOKED, JOB_STATUS.SCHEDULED, JOB_STATUS.DELIVERED, JOB_STATUS.ACTIVE_RENTAL,
]);
export const ACTIVE_JOB_STATUS_SET = new Set(ACTIVE_JOB_STATUSES);

// A real, committed JOB (deal closed/paid, in fulfillment), EXCLUDING completed and
// the unpaid pending_payment stage. Includes the post-return billing stage and
// legacy picked_up so those still read as jobs.
export const CONFIRMED_JOB_STATUSES = Object.freeze([
  JOB_STATUS.BOOKED, JOB_STATUS.SCHEDULED, JOB_STATUS.DELIVERED,
  JOB_STATUS.ACTIVE_RENTAL, JOB_STATUS.PICKED_UP, JOB_STATUS.AWAITING_FINAL_PAYMENT,
]);
export const CONFIRMED_JOB_STATUS_SET = new Set(CONFIRMED_JOB_STATUSES);

// Operational = committed + in flight, from booking initiation (pending_payment)
// through the final-payment stage, EXCLUDING completed. Used by getLeadActionState
// (isOperational / isOpportunity).
export const OPERATIONAL_JOB_STATUSES = new Set([JOB_STATUS.PENDING_PAYMENT, ...CONFIRMED_JOB_STATUSES]);

// Confirmed + PAID but not yet delivered — the delivering-soon / upcoming-pipeline pair.
export const UPCOMING_JOB_STATUSES = Object.freeze([JOB_STATUS.BOOKED, JOB_STATUS.SCHEDULED]);
export const UPCOMING_JOB_STATUS_SET = new Set(UPCOMING_JOB_STATUSES);

// Non-actionable terminal states — used by getLeadActionState (isActive).
export const TERMINAL_JOB_STATUSES = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.LOST, JOB_STATUS.SPAM]);

// Closed-lost / dead job_status values, EXCLUDING completed.
export const CLOSED_LOST_STATUSES = new Set([JOB_STATUS.LOST, JOB_STATUS.SPAM]);

// Map a RETIRED mid-state to its nearest active-chain equivalent for read-time
// display + logic (non-destructive). scheduled→booked, delivered→active_rental,
// picked_up→awaiting_final_payment; active-chain/terminal values pass through.
const LEGACY_STATE_MAP = Object.freeze({
  [JOB_STATUS.SCHEDULED]: JOB_STATUS.BOOKED,
  [JOB_STATUS.DELIVERED]: JOB_STATUS.ACTIVE_RENTAL,
  [JOB_STATUS.PICKED_UP]: JOB_STATUS.AWAITING_FINAL_PAYMENT,
});
export function mapLegacyJobStatus(jobStatus) {
  return LEGACY_STATE_MAP[jobStatus] || jobStatus || null;
}

// Legacy leads.status vocabulary (parallel column, being phased out; read only as a
// fallback when job_status is null). job_status drives the Phase-2 UI.
export const LEGACY_STATUS = Object.freeze({
  NEW: 'new',
  NEEDS_FOLLOW_UP: 'needs_follow_up',
  WAITING_ON_CUSTOMER: 'waiting_on_customer',
  BOOKED: 'booked',
  LOST: 'lost',
  SPAM: 'spam',
  CONTACTED: 'contacted',
  QUOTE_SENT: 'quote_sent',
});
// Legacy status values meaning "not an active lead" — fallback terminal set for a
// lead that has no job_status yet.
export const LEGACY_TERMINAL_STATUSES = new Set([LEGACY_STATUS.BOOKED, LEGACY_STATUS.LOST, LEGACY_STATUS.SPAM]);

// Engagement status — the reduced inquiry → booked → completed (/ lost) lifecycle a
// single engagement can be in (derived server-side in customerService; consumed by
// the customer profile).
export const ENGAGEMENT_STATUS = Object.freeze({
  INQUIRY: 'inquiry',
  BOOKED: 'booked',
  COMPLETED: 'completed',
  LOST: 'lost',
});

export const JOB_STATUS_STYLES = {
  inquiry: 'bg-brand/10 text-brand border-brand/30',
  opportunity: 'bg-warning/10 text-warning border-warning/30',
  // Booking initiated, awaiting payment (nothing reserved yet) → amber.
  pending_payment: 'bg-warning/10 text-warning border-warning/30',
  booked: 'bg-success/10 text-success border-success/30',
  scheduled: 'bg-info/10 text-info border-info/30',
  // Job is live or done → green (success), per the product's status color language.
  delivered: 'bg-success/10 text-success border-success/30',
  active_rental: 'bg-success/10 text-success border-success/30',
  picked_up: 'bg-success/10 text-success border-success/30',
  // Work done, balance owed → amber (not yet complete).
  awaiting_final_payment: 'bg-warning/10 text-warning border-warning/30',
  completed: 'bg-success/10 text-success border-success/30',
  lost: 'bg-danger/10 text-danger border-danger/30',
  spam: 'bg-surface-2 text-muted border-divider',
};

// The PAYMENT axis, rendered as a second indicator next to job_status.
export const PAYMENT_STATUS_LABELS = { unpaid: 'Unpaid', partial: 'Partially Paid', paid: 'Paid' };
export const PAYMENT_STATUS_STYLES = {
  unpaid: 'bg-danger/10 text-danger border-danger/30',
  partial: 'bg-warning/10 text-warning border-warning/30',
  paid: 'bg-success/10 text-success border-success/30',
};
export function getPaymentStatusLabel(value) {
  return PAYMENT_STATUS_LABELS[value] || 'Unpaid';
}

export const HOME_SERVICES_STATUS_STYLES = {
  new: 'bg-brand/10 text-brand border-brand/30',
  needs_follow_up: 'bg-warning/10 text-warning border-warning/30',
  waiting_on_customer: 'bg-brand/10 text-brand border-brand/30',
  booked: 'bg-success/10 text-success border-success/30',
  lost: 'bg-surface-2 text-muted border-divider',
  spam: 'bg-surface-2 text-muted border-divider',
  // Legacy values still in DB
  contacted: 'bg-warning/10 text-warning border-warning/30',
  quote_sent: 'bg-brand/10 text-brand border-brand/30',
};

// Returns the display label for a job_status value
export function getJobStatusLabel(jobStatus) {
  return JOB_STATUSES.find(s => s.value === jobStatus)?.label || jobStatus || 'Inquiry';
}

// Funnel outcome — answers "what stage of the sale is this?"
export const HOME_SERVICES_OUTCOMES = [
  { value: 'quote_requested', label: 'Quote Requested' },
  { value: 'quote_sent', label: 'Quote Sent' },
  { value: 'appointment_scheduled', label: 'Appointment Scheduled' },
  { value: 'booked', label: 'Booked' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'not_serviceable', label: 'Not Serviceable' },
];

export const URGENCY_VALUES = ['ASAP', 'This Week', 'Next Week', 'Flexible'];

export const URGENCY_STYLES = {
  'ASAP': 'bg-danger/10 text-danger border-danger/30',
  'This Week': 'bg-warning/10 text-warning border-warning/30',
  'Next Week': 'bg-warning/10 text-warning border-warning/30',
  'Flexible': 'bg-success/10 text-success border-success/30',
};

// Replaces the numerical confidence score. High/Warm/Cold are derived in the AI
// extraction and override-able from the detail page.
export const INTENT_VALUES = ['high', 'warm', 'cold'];
export const INTENT_LABELS = { high: 'High Intent', warm: 'Warm', cold: 'Cold' };
export const INTENT_STYLES = {
  high: 'bg-success/10 text-success border-success/30',
  warm: 'bg-warning/10 text-warning border-warning/30',
  cold: 'bg-surface-2 text-muted border-divider',
};

// Sub-verticals that share the home_services dashboard.
export const HOME_SERVICES_SUB_VERTICALS = [
  { id: 'dumpster_rental', label: 'Dumpster Rental' },
  { id: 'hvac', label: 'HVAC' },
];

// ── Customer lifecycle ────────────────────────────────────────────────────────
// A customer is one person (deduped by phone on the server). Their status is the
// most valuable stage across all of their jobs — derived server-side, but
// override-able. The ladder runs coldest → most valuable; 'inactive' is the
// no-live-work terminal state.
export const CUSTOMER_STATUSES = [
  { value: 'lead', label: 'Lead' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'booked', label: 'Booked' },
  { value: 'customer', label: 'Customer' },
  { value: 'repeat', label: 'Repeat' },
  { value: 'inactive', label: 'Inactive' },
];

export const CUSTOMER_STATUS_STYLES = {
  lead: 'bg-brand/10 text-brand border-brand/30',
  opportunity: 'bg-warning/10 text-warning border-warning/30',
  booked: 'bg-success/10 text-success border-success/30',
  customer: 'bg-brand/10 text-brand border-brand/30',
  repeat: 'bg-success/10 text-success border-success/30',
  inactive: 'bg-surface-2 text-muted border-divider',
};

export function getCustomerStatusLabel(value) {
  return CUSTOMER_STATUSES.find(s => s.value === value)?.label || value || 'Lead';
}

// ── Invoice lifecycle ─────────────────────────────────────────────────────────
// draft → sent → signed → paid. 'paid' is reachable today only via the owner's
// manual record action; online payment collection is a separate, later task.
export const INVOICE_STATUSES = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'signed', label: 'Signed' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

export const INVOICE_STATUS_STYLES = {
  draft: 'bg-surface-2 text-muted border-divider',
  sent: 'bg-brand/10 text-brand border-brand/30',
  signed: 'bg-brand/10 text-brand border-brand/30',
  paid: 'bg-success/10 text-success border-success/30',
  void: 'bg-surface-2 text-muted border-divider',
};

export function getInvoiceStatusLabel(value) {
  return INVOICE_STATUSES.find(s => s.value === value)?.label || value || 'Draft';
}

// Generic line-item types for the invoice editor. Free-form on the server (any
// string is accepted) — these are just the presets the dropdown offers, so the
// model generalizes past dumpster rental (base service, add-ons, overages, fees).
export const INVOICE_LINE_TYPES = [
  { value: 'service', label: 'Service' },
  { value: 'rental', label: 'Rental' },
  { value: 'addon', label: 'Add-on' },
  { value: 'overage', label: 'Overage' },
  { value: 'fee', label: 'Fee' },
  { value: 'discount', label: 'Discount' },
];

// Field packs render the "Industry Details" section of the lead detail view.
// Field types:
//   - text       single-line editable string
//   - multiline  textarea editable string
//   - bool       Yes / No / unset toggle
//   - enum       dropdown driven by `options`
// `span` controls grid layout (1 = half row, 2 = full row).
export const HOME_SERVICES_FIELD_PACKS = {
  dumpster_rental: {
    label: 'Dumpster Rental',
    // Card subtitle: which vertical_data field summarizes the job at a glance.
    summaryKey: 'dumpsterSize',
    industryFields: [
      { key: 'dumpsterSize', label: 'Dumpster Size', type: 'text' },
      { key: 'debrisType', label: 'Debris Type', type: 'text' },
      { key: 'deliveryDate', label: 'Delivery Date', type: 'date', rawKey: 'rawDeliveryDate' },
      // Specific time of day for the drop-off. Stored on the flat scheduled_time
      // column (HH:MM 24-hour), not in vertical_data — flatKey points the field
      // renderer at the lead column instead of vd.
      { key: 'scheduledTime', label: 'Delivery Time', type: 'time', flatKey: 'scheduled_time' },
      { key: 'pickupDate', label: 'Pickup Date', type: 'date', showTBDWhenEmpty: true },
      { key: 'rentalDuration', label: 'Rental Duration', type: 'text' },
      // permitNeeded is still captured by extraction + stored in vertical_data,
      // but intentionally not surfaced here — low signal, clutters the UI.
      { key: 'deliveryAddress', label: 'Delivery Address', type: 'text', span: 2 },
      { key: 'accessNotes', label: 'Access Notes', type: 'multiline', span: 2 },
    ],
    quoteFields: [
      { key: 'quotedPrice', label: 'Quoted Price', type: 'text' },
      { key: 'paymentStatus', label: 'Payment Status', type: 'text' },
    ],
  },
  hvac: {
    label: 'HVAC',
    summaryKey: 'serviceType',
    industryFields: [
      {
        key: 'serviceType',
        label: 'Service Type',
        type: 'enum',
        options: ['repair', 'maintenance', 'install', 'replacement', 'estimate', 'unknown'],
      },
      {
        key: 'equipmentType',
        label: 'Equipment',
        type: 'enum',
        options: ['furnace', 'ac', 'heat_pump', 'boiler', 'ductwork', 'other', 'unknown'],
      },
      { key: 'systemAge', label: 'System Age', type: 'text' },
      { key: 'brandOrModel', label: 'Brand / Model', type: 'text' },
      { key: 'emergencyStatus', label: 'Emergency', type: 'bool' },
      { key: 'appointmentRequested', label: 'Appointment Requested', type: 'bool' },
      { key: 'propertyAddress', label: 'Property Address', type: 'text', span: 2 },
      { key: 'issueDescription', label: 'Issue Description', type: 'multiline', span: 2 },
    ],
    quoteFields: [
      { key: 'quotedPrice', label: 'Quoted Price', type: 'text' },
      { key: 'followUpNeeded', label: 'Follow-Up Needed', type: 'bool' },
    ],
  },
};

// Per-vertical wording so shared UI (e.g. the manual lead form) labels date and
// job fields in the language each trade uses, without hardcoding "Delivery Date"
// everywhere. Keyed by sub_vertical; falls back to dumpster_rental.
const TERMINOLOGY = {
  dumpster_rental: {
    startDate: 'Delivery Date',
    endDate: 'Pickup Date',
    startTime: 'Delivery Time',
    startAction: 'Delivery',
    endAction: 'Pickup',
    startBadge: 'DROP',
    endBadge: 'PICK',
    jobUnit: 'Dumpster',
    serviceType: 'Dumpster rental', // service TYPE label (e.g. Jobs-table Service column)
    jobUnitSize: true, // show size (10yd, 20yd etc)
    durationLabel: 'Rental Duration',
    // Extended labels for the manual lead form's dumpster-specific fields.
    sizeLabel: 'Dumpster Size',
    addressLabel: 'Delivery Address',
    accessLabel: 'Access / Delivery Notes',
  },
  hvac: {
    startDate: 'Job Date',
    endDate: 'Completion Date',
    startTime: 'Appointment Time',
    startAction: 'Job Start',
    endAction: 'Job Complete',
    startBadge: 'JOB',
    endBadge: 'DONE',
    jobUnit: 'Job',
    serviceType: 'HVAC service', // service TYPE label (e.g. Jobs-table Service column)
    jobUnitSize: false,
    durationLabel: 'Job Duration',
    // Extended labels for the manual lead form.
    sizeLabel: 'Equipment',
    addressLabel: 'Property Address',
    accessLabel: 'Access Notes',
  },
};

// Returns the terminology object for a vertical/sub-vertical, falling back to
// dumpster_rental defaults. The `vertical` arg is accepted for forward-compat
// with future top-level verticals; today the sub_vertical drives the wording.
export function getTerminology(vertical, subVertical) {
  return TERMINOLOGY[subVertical] || TERMINOLOGY[vertical] || TERMINOLOGY.dumpster_rental;
}

// Format an "HH:MM" 24-hour time string as 12-hour "8:00 AM". Returns null for
// empty/missing values; passes through anything that isn't HH:MM unchanged.
export function formatTime12(hhmm) {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm).trim());
  if (!m) return String(hhmm);
  let h = Number(m[1]);
  const min = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ap}`;
}

export function getSubVertical(lead) {
  const sv = lead?.sub_vertical;
  if (sv && HOME_SERVICES_FIELD_PACKS[sv]) return sv;
  // Legacy/back-compat: any home_services lead without a sub_vertical is dumpster_rental.
  return 'dumpster_rental';
}

export function getFieldPack(lead) {
  return HOME_SERVICES_FIELD_PACKS[getSubVertical(lead)];
}

const STORAGE_KEY = 'leadflow:activeVertical';

export function getActiveVertical() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VERTICALS.find(x => x.id === v)?.id || 'auto_dealer';
  } catch {
    return 'auto_dealer';
  }
}

export function setActiveVertical(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
}

export function parseVerticalData(lead) {
  if (!lead?.vertical_data) return {};
  try { return JSON.parse(lead.vertical_data); } catch { return {}; }
}

// ── Action prioritization ─────────────────────────────────────────────────
// Every screen in Home Services answers "what do I do next?" — these helpers
// produce the action category, priority score, and human label that the
// dashboard and lead card both use so the ranking is consistent everywhere.

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
const STALE_THRESHOLD_MS = 48 * MS_HOUR;

// OPERATIONAL_JOB_STATUSES and TERMINAL_JOB_STATUSES are defined once in the
// canonical status block near the top of this file.

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// Parse a stored follow-up date into an absolute Date. It can arrive in three
// formats, two of which `new Date()` misreads — which is what made a future
// follow-up show as "Overdue":
//   • Full ISO ("…Z" / with offset)         → already absolute; use as-is.
//   • Naive SQLite "YYYY-MM-DD HH:MM:SS"     → no zone, so new Date() reads it as
//     local time. It's UTC — append "Z" (same as formatActivityTime does).
//   • Date-only "YYYY-MM-DD"                 → new Date() reads it as UTC midnight,
//     which lands on the previous evening in negative-offset zones (US), making a
//     follow-up due today look overdue. Anchor to local end-of-day so it only goes
//     overdue once that calendar day has actually passed.
export function parseFollowUpDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    const d = new Date(`${str.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Dead-end detection: the AI flagged the call as needing no follow-up — the
// customer declined, isn't interested, or is going elsewhere. Such leads stay
// in All Leads for the record but must never enter the Action Queue. Mirrors the
// three signals the spec calls out so it also catches pre-existing leads that
// predate the requiresFollowUp flag.
export function isDeadLead(lead, vd = parseVerticalData(lead)) {
  // 1. Explicit AI signal (new extractions + migrated leads).
  if (vd.requiresFollowUp === false) return true;

  const followUp = vd.followUpDate || lead?.follow_up_date || null;
  const rec = String(vd.aiRecommendation || '').toLowerCase();
  const deadLanguage = /no follow.?up|not interested|customer declined|\bdeclined\b|went with another|going elsewhere|no further action|won'?t proceed/.test(rec);

  // 2. No follow-up date + a recommendation that says no follow-up is needed.
  if (!followUp && deadLanguage) return true;

  // 3. Cold intent paired with a declining outcome.
  const outcome = String(lead?.outcome || vd.outcome || '').toLowerCase();
  const declinedOutcome = /not[_ ]?interested|declined|cancell?ed/.test(outcome);
  if (vd.intentLevel === 'cold' && declinedOutcome) return true;

  return false;
}

// Returns an enrichment object for a lead that powers card + dashboard.
// {
//   intent: 'high' | 'warm' | 'cold',
//   followUpDate: Date | null,
//   followUpDueToday: bool,
//   followUpOverdue: bool,
//   stale: bool,
//   priority: number,    // higher = handle sooner
//   bucket: 'follow_up_due' | 'high_intent_new' | 'stale' | 'waiting' | 'other',
//   recommendation: string,
//   summaryDetail: string,
//   estimatedRevenue: number | null,
//   isActive: bool,      // not terminal — show in dashboard buckets
// }
export function getLeadActionState(lead, now = new Date()) {
  const vd = parseVerticalData(lead);
  // Dead-end leads (customer declined / not interested) stay in All Leads but
  // are kept out of the Action Queue — see classifyForQueue.
  const isDead = isDeadLead(lead, vd);
  const jobStatus = lead?.job_status || vd.job_status || null;
  const status = lead?.status || LEGACY_STATUS.NEW;
  // Missed calls are NOT leads — they live only in the dashboard Action Queue
  // (which classifies them on its own). They must never read as an opportunity,
  // an active lead, or operational work, or they'd leak into All Opportunities,
  // Booked Jobs, estimate counts, and every other list/metric derived from here.
  const isMissedCall = lead?.call_type === 'missed_call';
  // isActive: not terminal — show in dashboard priority buckets
  const isActive = isMissedCall ? false : (jobStatus
    ? !TERMINAL_JOB_STATUSES.has(jobStatus)
    : !LEGACY_TERMINAL_STATUSES.has(status));
  // isOpportunity: pre-booked, in the sales funnel (not yet confirmed as a job)
  const isOpportunity = isMissedCall ? false : (jobStatus
    ? !OPERATIONAL_JOB_STATUSES.has(jobStatus) && !TERMINAL_JOB_STATUSES.has(jobStatus)
    : isActive);

  // Intent: prefer AI's call, fall back to urgency/emergency cues.
  let intent = INTENT_VALUES.includes(vd.intentLevel) ? vd.intentLevel : null;
  if (!intent) {
    if (vd.urgency === 'ASAP' || vd.emergencyStatus === true) intent = 'high';
    else if (vd.urgency === 'This Week') intent = 'warm';
    else intent = 'warm';
  }

  // Follow-up date parsing — handles full ISO, naive SQLite UTC, and date-only
  // strings without the timezone shift that made future follow-ups read as past.
  const followUpDate = parseFollowUpDate(vd.followUpDate);

  const createdAt = lead?.created_at ? new Date(lead.created_at) : null;
  const ageMs = createdAt ? (now - createdAt) : 0;

  const followUpDueToday = !!(followUpDate && isActive && followUpDate <= endOfDay(now));
  const followUpOverdue = !!(followUpDate && isActive && followUpDate < startOfDay(now));
  // Cold-going leads: 48h old, no follow-up resolution, still active, never contacted.
  const neverContacted = (jobStatus === JOB_STATUS.INQUIRY || jobStatus === null) && status === LEGACY_STATUS.NEW;
  const stale = isActive && neverContacted && ageMs >= STALE_THRESHOLD_MS;

  // ASAP leads in pre-booked states must surface immediately regardless of follow-up date.
  const isAsapActive = !!(isOpportunity && isActive && vd.urgency === 'ASAP');
  // High intent with no action taken after 2 hours — don't let these sit in All Opportunities.
  const highIntentUncontacted = !!(isOpportunity && isActive && intent === 'high' && ageMs > 2 * MS_HOUR && neverContacted);
  // High-intent lead with no confirmed delivery date — needs a follow-up call to lock in the date.
  const noConfirmedDelivery = !!(
    isOpportunity && isActive && intent === 'high' && !lead?.delivery_date &&
    (jobStatus === JOB_STATUS.INQUIRY || jobStatus === JOB_STATUS.OPPORTUNITY || jobStatus === null)
  );
  // Voicemail leads: the customer is waiting for a callback, so surface them in
  // Needs Attention until the owner takes a first action.
  const isVoicemail = lead?.call_type === 'voicemail';
  const voicemailCallback = !!(isOpportunity && isActive && isVoicemail && neverContacted);

  // Recommendation: AI-provided sentence wins; otherwise derive a sensible default.
  let recommendation = vd.aiRecommendation && String(vd.aiRecommendation).trim();
  if (!recommendation) {
    if (isAsapActive) recommendation = 'Customer needs service ASAP — call back immediately.';
    else if (followUpDueToday) recommendation = 'Follow up today — scheduled callback is due.';
    else if (noConfirmedDelivery) recommendation = 'Confirm delivery date — customer agreed to price and size but no date was set.';
    else if (stale) recommendation = 'Lead is going cold — reach out to re-engage.';
    else if (intent === 'high') recommendation = 'Call today — high-intent lead with no follow-up yet.';
    else if (status === LEGACY_STATUS.WAITING_ON_CUSTOMER) recommendation = 'Check back with the customer.';
    else recommendation = 'Review and decide on next step.';
  }
  // Voicemail leads always read as a callback prompt, naming the caller.
  if (isVoicemail) {
    const vmName = vd.customerName
      || [lead?.customer_first_name, lead?.customer_last_name].filter(Boolean).join(' ')
      || 'this caller';
    recommendation = `Call back ${vmName} — came in via voicemail`;
  }
  // Missed calls (unanswered, no voicemail) read as a callback prompt naming the
  // caller — falling back to the phone number when no name is known yet.
  if (isMissedCall) {
    const mcName = vd.customerName
      || [lead?.customer_first_name, lead?.customer_last_name].filter(Boolean).join(' ')
      || lead?.phone || lead?.caller_number || 'this caller';
    recommendation = `Call back ${mcName} — missed call, no voicemail`;
  }

  // A booked job with a pending CALL-DRIVEN reschedule request: the proposed
  // schedule change was held (not written) and is waiting on the owner to approve
  // or reject. Surfaced as a Tier-1 Action Queue item (see bookedAttentionReason).
  const rescheduleRequested = !!vd.rescheduleRequest;
  if (rescheduleRequested) {
    recommendation = 'Customer requested reschedule — approve?';
  }

  // A detected cancellation cue held for the owner to confirm or disregard (mirrors
  // the reschedule-approval pattern — never auto-cancels).
  const cancelRequested = !!vd.cancelRequest && !vd.cancelDismissedAt;
  if (cancelRequested) {
    recommendation = 'Customer expressed intent to cancel — confirm or disregard';
  }

  // PAYMENT axis + the two new lifecycle stages, surfaced for the two-indicator UI
  // and the pending-payment / balance-chaser nudges.
  const paymentStatus = lead?.payment_status || 'unpaid';
  const pendingPayment = jobStatus === JOB_STATUS.PENDING_PAYMENT;
  const awaitingFinalPayment = jobStatus === JOB_STATUS.AWAITING_FINAL_PAYMENT;

  // Buckets used by Today's Priorities — ordered by priority floor below.
  // asap sits above follow_up_due so ASAP customers are never buried.
  let bucket = 'other';
  if (isAsapActive) bucket = 'asap';
  else if (followUpDueToday) bucket = 'follow_up_due';
  else if (voicemailCallback) bucket = 'voicemail';
  else if (highIntentUncontacted) bucket = 'high_intent_new';
  else if (noConfirmedDelivery) bucket = 'no_delivery_date';
  else if (stale) bucket = 'stale';
  else if (status === LEGACY_STATUS.WAITING_ON_CUSTOMER) bucket = 'waiting';

  // Priority floor by bucket gives stable ranking; intra-bucket tiebreaker is
  // overdueness (older follow-up date first) then lead age.
  const BUCKET_FLOOR = {
    asap: 5000,
    follow_up_due: 4000,
    voicemail: 3500,
    high_intent_new: 3000,
    no_delivery_date: 2500,
    stale: 2000,
    waiting: 1000,
    other: 0,
  };
  let priority = BUCKET_FLOOR[bucket];
  if (followUpDate) {
    const hoursOverdue = Math.max(0, (now - followUpDate) / MS_HOUR);
    priority += Math.min(500, hoursOverdue * 5);
  }
  if (intent === 'high') priority += 200;
  else if (intent === 'warm') priority += 50;
  if (vd.urgency === 'ASAP') priority += 150;
  // Slight bump for older leads in the same bucket.
  priority += Math.min(100, ageMs / MS_HOUR);

  // Summary detail used by the card subtitle alongside service type.
  const subVertical = getSubVertical(lead);
  const pack = HOME_SERVICES_FIELD_PACKS[subVertical];
  const primary = pack ? (vd[pack.summaryKey] || vd.serviceType) : (vd.serviceType || null);
  const dateHint = vd.deliveryDate || vd.appointmentDate || null;
  const term = getTerminology(lead?.vertical, subVertical);
  const summaryDetail = [primary, dateHint && `${term.startAction} ${dateHint}`].filter(Boolean).join(' — ');

  let estimatedRevenue = null;
  if (typeof vd.estimatedRevenue === 'number' && !Number.isNaN(vd.estimatedRevenue)) {
    estimatedRevenue = vd.estimatedRevenue;
  } else if (vd.quotedPrice) {
    // Parse "$300", "300", "$300-$400" → midpoint.
    const nums = String(vd.quotedPrice).match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length === 1) estimatedRevenue = Number(nums[0]);
    else if (nums && nums.length >= 2) estimatedRevenue = (Number(nums[0]) + Number(nums[1])) / 2;
  }

  const isOperational = isMissedCall ? false : (jobStatus ? OPERATIONAL_JOB_STATUSES.has(jobStatus) : false);

  return {
    intent,
    followUpDate,
    followUpDueToday,
    followUpOverdue,
    stale,
    isAsapActive,
    highIntentUncontacted,
    noConfirmedDelivery,
    voicemailCallback,
    priority,
    bucket,
    recommendation,
    summaryDetail,
    estimatedRevenue,
    isActive,
    isOpportunity,
    isOperational,
    isDead,
    rescheduleRequested,
    cancelRequested,
    paymentStatus,
    pendingPayment,
    awaitingFinalPayment,
    jobStatus,
  };
}

function startOfDay(d) {
  const c = new Date(d); c.setHours(0, 0, 0, 0); return c;
}
function endOfDay(d) {
  const c = new Date(d); c.setHours(23, 59, 59, 999); return c;
}
export { startOfDay, endOfDay, isSameLocalDay };
