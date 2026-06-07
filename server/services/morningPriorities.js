// Morning Priorities — every day at 8am local server time, push the top
// action item to all registered Home Services devices. Mirrors the
// prioritization logic the web dashboard runs client-side so what the user
// sees in the notification matches what they'll see when they open the app.

const db = require('../db/database');
const { sendToAll } = require('./apns');
const { getDefaultBusinessId } = require('./businesses');

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
const STALE_THRESHOLD_MS = 48 * MS_HOUR;
const TERMINAL_STATUSES = new Set(['booked', 'lost', 'spam']);

function safeParse(json) {
  if (!json) return {};
  try { return JSON.parse(json); } catch { return {}; }
}

function endOfDay(d) {
  const c = new Date(d); c.setHours(23, 59, 59, 999); return c;
}
function startOfDay(d) {
  const c = new Date(d); c.setHours(0, 0, 0, 0); return c;
}

// Parse a stored follow-up date into an absolute Date. Mirrors the client's
// parseFollowUpDate (verticalConfig.js): naive SQLite "YYYY-MM-DD HH:MM:SS" is
// UTC (append "Z"), and date-only "YYYY-MM-DD" anchors to local end-of-day so a
// future follow-up never reads as past from a timezone misparse.
function parseFollowUpDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
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

function getActionState(lead, now) {
  const vd = safeParse(lead.vertical_data);
  const status = lead.status || 'new';
  const isActive = !TERMINAL_STATUSES.has(status);

  let intent = ['high', 'warm', 'cold'].includes(vd.intentLevel) ? vd.intentLevel : null;
  if (!intent) {
    if (vd.urgency === 'ASAP' || vd.emergencyStatus === true) intent = 'high';
    else intent = 'warm';
  }

  const followUpDate = parseFollowUpDate(vd.followUpDate);

  const createdAt = lead.created_at ? new Date(lead.created_at) : null;
  const ageMs = createdAt ? (now - createdAt) : 0;

  const followUpDueToday = !!(followUpDate && isActive && followUpDate <= endOfDay(now));
  const stale = isActive && status === 'new' && ageMs >= STALE_THRESHOLD_MS;

  let bucket = 'other';
  if (followUpDueToday) bucket = 'follow_up_due';
  else if (intent === 'high' && status === 'new') bucket = 'high_intent_new';
  else if (stale) bucket = 'stale';
  else if (status === 'waiting_on_customer') bucket = 'waiting';

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
  priority += Math.min(100, ageMs / MS_HOUR);

  return { vd, intent, followUpDueToday, stale, bucket, priority, isActive };
}

function leadFullName(lead, vd) {
  return vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
    || 'Unknown Customer';
}

// Returns { totals, top } where top is { name, summary } | null. Scoped to one
// business so each tenant's morning push reflects only its own leads.
function computeMorningSummary(now = new Date(), businessId = getDefaultBusinessId()) {
  const leads = db.prepare(
    "SELECT * FROM leads WHERE vertical = 'home_services' AND business_id = ? AND (discarded = 0 OR discarded IS NULL)"
  ).all(businessId);

  const enriched = leads
    .map(l => ({ lead: l, state: getActionState(l, now) }))
    .filter(e => e.state.isActive);

  const priorityLeads = enriched
    .filter(e => ['follow_up_due', 'high_intent_new', 'stale', 'waiting'].includes(e.state.bucket))
    .sort((a, b) => b.state.priority - a.state.priority);

  const followUpsToday = enriched.filter(e => e.state.followUpDueToday).length;
  const highIntent = enriched.filter(e => e.state.intent === 'high').length;
  const staleCount = enriched.filter(e => e.state.stale).length;
  const booked = leads.filter(l => l.status === 'booked').length;

  let top = null;
  if (priorityLeads.length > 0) {
    const { lead, state } = priorityLeads[0];
    const name = leadFullName(lead, state.vd);
    const pack = state.vd;
    const detail = pack.dumpsterSize
      ? `${pack.dumpsterSize}${pack.deliveryDate ? `, delivery ${pack.deliveryDate}` : ''}`
      : (pack.serviceType || '');
    top = { name, detail, leadId: lead.id };
  }

  return {
    totals: { followUpsToday, highIntent, staleCount, booked, total: priorityLeads.length },
    top,
  };
}

// Build and push the morning summary for a single business to its own devices.
async function sendMorningPrioritiesForBusiness(businessId) {
  const summary = computeMorningSummary(new Date(), businessId);

  const devices = db.prepare(
    "SELECT device_token FROM devices WHERE (vertical = 'home_services' OR vertical IS NULL) AND business_id = ?"
  ).all(businessId).map(r => r.device_token).filter(Boolean);

  if (devices.length === 0) {
    console.log(`[morning] No registered devices for business ${businessId} — skipping push`);
    return;
  }

  const title = 'Good morning';
  let body;
  if (summary.totals.total === 0) {
    body = 'No urgent actions today. Inbox is clear.';
  } else if (summary.top) {
    const lead = `${summary.top.name}${summary.top.detail ? ` — ${summary.top.detail}` : ''}`;
    body = `${summary.totals.followUpsToday} follow-up${summary.totals.followUpsToday === 1 ? '' : 's'} due today. Start with ${lead}.`;
  } else {
    body = `${summary.totals.total} lead${summary.totals.total === 1 ? '' : 's'} need attention today.`;
  }

  console.log(`[morning] Pushing to ${devices.length} device(s) for business ${businessId}: ${body}`);
  await sendToAll(devices, title, body, {
    type: 'morning_priorities',
    leadId: summary.top?.leadId,
  });
}

// Fan out the 8am push across every business so each tenant gets its own data.
async function sendMorningPriorities() {
  const businesses = db.prepare('SELECT id FROM businesses').all();
  for (const { id } of businesses) {
    try {
      await sendMorningPrioritiesForBusiness(id);
    } catch (err) {
      console.error(`[morning] Failed to send morning priorities for business ${id}:`, err.message);
    }
  }
}

// Schedule the next 8am wall-clock fire and re-schedule itself each day so
// DST shifts are handled correctly (vs. a naive 24-hour setInterval).
function scheduleNext8am() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const delay = next - now;
  console.log(`[morning] Next morning priorities scheduled for ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`);

  const timer = setTimeout(async () => {
    try {
      await sendMorningPriorities();
    } catch (err) {
      console.error('[morning] Failed to send morning priorities:', err);
    }
    scheduleNext8am();
  }, delay);
  // Don't keep the event loop alive solely for this timer.
  timer.unref();
}

function start() {
  if (process.env.LEADFLOW_DISABLE_MORNING_PUSH === 'true') {
    console.log('[morning] Disabled via LEADFLOW_DISABLE_MORNING_PUSH');
    return;
  }
  scheduleNext8am();
}

module.exports = {
  start,
  sendMorningPriorities,
  computeMorningSummary,
  // Exposed so the Morning Brief endpoint can reuse the exact same lead
  // enrichment + naming logic that powers the 8am push.
  getActionState,
  leadFullName,
  safeParse,
};
