export const VERTICALS = [
  { id: 'auto_dealer', label: 'Auto Dealer' },
  { id: 'home_services', label: 'Home Services' },
];

// Pipeline state — answers "where does this lead sit in my day?"
export const HOME_SERVICES_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'needs_follow_up', label: 'Needs Follow Up' },
  { value: 'waiting_on_customer', label: 'Waiting On Customer' },
  { value: 'booked', label: 'Booked' },
  { value: 'lost', label: 'Lost' },
  { value: 'spam', label: 'Spam' },
];

export const HOME_SERVICES_STATUS_STYLES = {
  new: 'bg-blue-100 text-blue-700 border-blue-200',
  needs_follow_up: 'bg-amber-100 text-amber-700 border-amber-200',
  waiting_on_customer: 'bg-purple-100 text-purple-700 border-purple-200',
  booked: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  lost: 'bg-gray-100 text-gray-500 border-gray-200',
  spam: 'bg-gray-100 text-gray-400 border-gray-200',
  // Legacy values still in DB — keep visible during transition.
  contacted: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  quote_sent: 'bg-purple-100 text-purple-700 border-purple-200',
};

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
      { key: 'deliveryDate', label: 'Delivery Date', type: 'text' },
      { key: 'pickupDate', label: 'Pickup Date', type: 'text' },
      { key: 'rentalDuration', label: 'Rental Duration', type: 'text' },
      { key: 'permitNeeded', label: 'Permit Needed', type: 'bool' },
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
// Going-cold threshold: 48 hours with no contact, per spec.
const STALE_THRESHOLD_MS = 48 * MS_HOUR;
// Non-actionable terminal states.
const TERMINAL_STATUSES = new Set(['booked', 'lost', 'spam']);

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
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
  const status = lead?.status || 'new';
  const isActive = !TERMINAL_STATUSES.has(status);

  // Intent: prefer AI's call, fall back to urgency/emergency cues.
  let intent = INTENT_VALUES.includes(vd.intentLevel) ? vd.intentLevel : null;
  if (!intent) {
    if (vd.urgency === 'ASAP' || vd.emergencyStatus === true) intent = 'high';
    else if (vd.urgency === 'This Week') intent = 'warm';
    else intent = 'warm';
  }

  // Follow-up date parsing — supports ISO timestamp or YYYY-MM-DD.
  let followUpDate = null;
  const fud = vd.followUpDate;
  if (fud) {
    const d = new Date(fud);
    if (!Number.isNaN(d.getTime())) followUpDate = d;
  }

  const createdAt = lead?.created_at ? new Date(lead.created_at) : null;
  const ageMs = createdAt ? (now - createdAt) : 0;

  const followUpDueToday = !!(followUpDate && isActive && followUpDate <= endOfDay(now));
  const followUpOverdue = !!(followUpDate && isActive && followUpDate < startOfDay(now));
  // Cold-going leads: 48h old, no follow-up resolution, still active, never contacted.
  const neverContacted = status === 'new';
  const stale = isActive && neverContacted && ageMs >= STALE_THRESHOLD_MS;

  // Recommendation: AI-provided sentence wins; otherwise derive a sensible default.
  let recommendation = vd.aiRecommendation && String(vd.aiRecommendation).trim();
  if (!recommendation) {
    if (followUpDueToday) recommendation = 'Follow up today — scheduled callback is due.';
    else if (stale) recommendation = 'Lead is going cold — reach out to re-engage.';
    else if (intent === 'high') recommendation = 'Call today — high-intent lead with no follow-up yet.';
    else if (status === 'waiting_on_customer') recommendation = 'Check back with the customer.';
    else recommendation = 'Review and decide on next step.';
  }

  // Buckets used by Today's Priorities — ordered by priority floor below.
  let bucket = 'other';
  if (followUpDueToday) bucket = 'follow_up_due';
  else if (intent === 'high' && neverContacted) bucket = 'high_intent_new';
  else if (stale) bucket = 'stale';
  else if (status === 'waiting_on_customer') bucket = 'waiting';

  // Priority floor by bucket gives stable ranking; intra-bucket tiebreaker is
  // overdueness (older follow-up date first) then lead age.
  const BUCKET_FLOOR = {
    follow_up_due: 4000,
    high_intent_new: 3000,
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
  const summaryDetail = [primary, dateHint && `Delivery ${dateHint}`].filter(Boolean).join(' — ');

  let estimatedRevenue = null;
  if (typeof vd.estimatedRevenue === 'number' && !Number.isNaN(vd.estimatedRevenue)) {
    estimatedRevenue = vd.estimatedRevenue;
  } else if (vd.quotedPrice) {
    // Parse "$300", "300", "$300-$400" → midpoint.
    const nums = String(vd.quotedPrice).match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length === 1) estimatedRevenue = Number(nums[0]);
    else if (nums && nums.length >= 2) estimatedRevenue = (Number(nums[0]) + Number(nums[1])) / 2;
  }

  return {
    intent,
    followUpDate,
    followUpDueToday,
    followUpOverdue,
    stale,
    priority,
    bucket,
    recommendation,
    summaryDetail,
    estimatedRevenue,
    isActive,
  };
}

function startOfDay(d) {
  const c = new Date(d); c.setHours(0, 0, 0, 0); return c;
}
function endOfDay(d) {
  const c = new Date(d); c.setHours(23, 59, 59, 999); return c;
}
export { startOfDay, endOfDay, isSameLocalDay };
