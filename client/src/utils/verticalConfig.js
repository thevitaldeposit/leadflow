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

// Phase 2: full job lifecycle
export const JOB_STATUSES = [
  { value: 'inquiry', label: 'Inquiry' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'booked', label: 'Booked' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'active_rental', label: 'Active Rental' },
  { value: 'picked_up', label: 'Picked Up' },
  { value: 'completed', label: 'Completed' },
  // Non-job terminal states
  { value: 'lost', label: 'Lost' },
  { value: 'spam', label: 'Spam' },
];

export const JOB_STATUS_STYLES = {
  inquiry: 'bg-blue-100 text-blue-700 border-blue-200',
  opportunity: 'bg-amber-100 text-amber-700 border-amber-200',
  booked: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  scheduled: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  delivered: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  active_rental: 'bg-violet-100 text-violet-700 border-violet-200',
  picked_up: 'bg-teal-100 text-teal-700 border-teal-200',
  completed: 'bg-gray-100 text-gray-700 border-gray-200',
  lost: 'bg-red-100 text-red-500 border-red-200',
  spam: 'bg-gray-100 text-gray-400 border-gray-200',
};

export const HOME_SERVICES_STATUS_STYLES = {
  new: 'bg-blue-100 text-blue-700 border-blue-200',
  needs_follow_up: 'bg-amber-100 text-amber-700 border-amber-200',
  waiting_on_customer: 'bg-purple-100 text-purple-700 border-purple-200',
  booked: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  lost: 'bg-gray-100 text-gray-500 border-gray-200',
  spam: 'bg-gray-100 text-gray-400 border-gray-200',
  // Legacy values still in DB
  contacted: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  quote_sent: 'bg-purple-100 text-purple-700 border-purple-200',
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
  { value: 'not_serviceable', label: 'Not Serviceable' },
];

export const URGENCY_VALUES = ['ASAP', 'This Week', 'Next Week', 'Flexible'];

export const URGENCY_STYLES = {
  'ASAP': 'bg-red-100 text-red-700 border-red-200',
  'This Week': 'bg-orange-100 text-orange-700 border-orange-200',
  'Next Week': 'bg-yellow-100 text-yellow-700 border-yellow-200',
  'Flexible': 'bg-green-100 text-green-700 border-green-200',
};

// Replaces the numerical confidence score. High/Warm/Cold are derived in the AI
// extraction and override-able from the detail page.
export const INTENT_VALUES = ['high', 'warm', 'cold'];
export const INTENT_LABELS = { high: 'High Intent', warm: 'Warm', cold: 'Cold' };
export const INTENT_STYLES = {
  high: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  warm: 'bg-amber-100 text-amber-700 border-amber-200',
  cold: 'bg-gray-100 text-gray-500 border-gray-200',
};

// Sub-verticals that share the home_services dashboard.
export const HOME_SERVICES_SUB_VERTICALS = [
  { id: 'dumpster_rental', label: 'Dumpster Rental' },
  { id: 'hvac', label: 'HVAC' },
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

// Job statuses where the job is confirmed — no longer a sales lead
export const OPERATIONAL_JOB_STATUSES = new Set(['booked', 'scheduled', 'delivered', 'active_rental', 'picked_up', 'completed']);
// Non-actionable terminal states
export const TERMINAL_JOB_STATUSES = new Set(['completed', 'lost', 'spam']);

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
  const jobStatus = lead?.job_status || vd.job_status || null;
  const status = lead?.status || 'new';
  // isActive: not terminal — show in dashboard priority buckets
  const isActive = jobStatus
    ? !TERMINAL_JOB_STATUSES.has(jobStatus)
    : !new Set(['booked', 'lost', 'spam']).has(status);
  // isOpportunity: pre-booked, in the sales funnel (not yet confirmed as a job)
  const isOpportunity = jobStatus
    ? !OPERATIONAL_JOB_STATUSES.has(jobStatus) && !TERMINAL_JOB_STATUSES.has(jobStatus)
    : isActive;

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
  const neverContacted = (jobStatus === 'inquiry' || jobStatus === null) && status === 'new';
  const stale = isActive && neverContacted && ageMs >= STALE_THRESHOLD_MS;

  // ASAP leads in pre-booked states must surface immediately regardless of follow-up date.
  const isAsapActive = !!(isOpportunity && isActive && vd.urgency === 'ASAP');
  // High intent with no action taken after 2 hours — don't let these sit in All Opportunities.
  const highIntentUncontacted = !!(isOpportunity && isActive && intent === 'high' && ageMs > 2 * MS_HOUR && neverContacted);
  // High-intent lead with no confirmed delivery date — needs a follow-up call to lock in the date.
  const noConfirmedDelivery = !!(
    isOpportunity && isActive && intent === 'high' && !lead?.delivery_date &&
    (jobStatus === 'inquiry' || jobStatus === 'opportunity' || jobStatus === null)
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
    else if (status === 'waiting_on_customer') recommendation = 'Check back with the customer.';
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
  const isMissedCall = lead?.call_type === 'missed_call';
  if (isMissedCall) {
    const mcName = vd.customerName
      || [lead?.customer_first_name, lead?.customer_last_name].filter(Boolean).join(' ')
      || lead?.phone || lead?.caller_number || 'this caller';
    recommendation = `Call back ${mcName} — missed call, no voicemail`;
  }

  // Buckets used by Today's Priorities — ordered by priority floor below.
  // asap sits above follow_up_due so ASAP customers are never buried.
  let bucket = 'other';
  if (isAsapActive) bucket = 'asap';
  else if (followUpDueToday) bucket = 'follow_up_due';
  else if (voicemailCallback) bucket = 'voicemail';
  else if (highIntentUncontacted) bucket = 'high_intent_new';
  else if (noConfirmedDelivery) bucket = 'no_delivery_date';
  else if (stale) bucket = 'stale';
  else if (status === 'waiting_on_customer') bucket = 'waiting';

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

  const isOperational = jobStatus ? OPERATIONAL_JOB_STATUSES.has(jobStatus) : false;

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
