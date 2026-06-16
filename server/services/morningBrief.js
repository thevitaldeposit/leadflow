// Morning Brief — the dashboard's daily COO-style briefing. Reuses the same
// lead-prioritization logic that powers the 8am push (morningPriorities.js),
// assembles a structured snapshot of the business's day, and asks Claude to
// turn it into 3-5 punchy, actionable bullets. The result is cached per
// business per local day so a page refresh never re-calls the model.

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const { getTimezone } = require('./settingsService');
const { getActionState, leadFullName } = require('./morningPriorities');

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MODEL = 'claude-sonnet-4-6';
const MS_DAY = 24 * 60 * 60 * 1000;

// In-memory daily cache keyed by `${businessId}:${localDate}`. Resets on
// restart, which is fine — the brief regenerates lazily on the next request.
const cache = new Map();

// ── time helpers (business timezone aware) ──────────────────────────────────

// Current local date (YYYY-MM-DD) and hour (0-23) in the business's timezone.
function businessClock(tz, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0; // some ICU builds emit "24" at midnight
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
  } catch {
    // Bad/unknown timezone → fall back to server local time.
    const d = now;
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hour: d.getHours(),
    };
  }
}

// Add `n` days to a YYYY-MM-DD string, staying in calendar space.
function addDaysStr(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Normalize any stored delivery/pickup value to its YYYY-MM-DD calendar day.
function dayOf(value) {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

// ── snapshot ────────────────────────────────────────────────────────────────

// Build the structured operational snapshot the model writes from. Pulls the
// same lead set the 8am push uses and enriches every lead with getActionState.
function buildSnapshot(businessId, todayStr, now = new Date()) {
  const tomorrowStr = addDaysStr(todayStr, 1);
  const in30Str = addDaysStr(todayStr, 30);

  const business = db
    .prepare('SELECT name FROM businesses WHERE id = ?')
    .get(businessId);

  // Missed calls aren't leads, so they never count toward the brief's metrics.
  const leads = db.prepare(
    "SELECT * FROM leads WHERE vertical = 'home_services' AND business_id = ? AND (discarded = 0 OR discarded IS NULL) AND (call_type != 'missed_call' OR call_type IS NULL)"
  ).all(businessId);

  const enriched = leads.map((lead) => ({ lead, state: getActionState(lead, now) }));

  const quoted = (lead, vd) =>
    vd.quotedPrice || (lead.estimated_revenue ? `$${Math.round(lead.estimated_revenue)}` : null);

  // Top pre-booked opportunities ranked exactly as the push ranks them.
  const priorityLeads = enriched
    .filter((e) => e.state.isActive && e.state.isOpportunity)
    .sort((a, b) => b.state.priority - a.state.priority)
    .slice(0, 5)
    .map(({ lead, state }) => {
      const vd = state.vd;
      const createdAt = lead.created_at ? new Date(lead.created_at) : null;
      const daysSinceCreated = createdAt ? Math.floor((now - createdAt) / MS_DAY) : null;
      return {
        name: leadFullName(lead, vd),
        intent: state.intent,
        service: vd.dumpsterSize || vd.serviceType || vd.equipmentType || null,
        quotedPrice: quoted(lead, vd),
        daysSinceInquiry: daysSinceCreated,
        followUp: state.followUpOverdue ? 'overdue' : (state.followUpDueToday ? 'due today' : null),
        urgency: vd.urgency || null,
      };
    });

  // Booked/scheduled jobs delivering today or tomorrow that are missing the
  // delivery address or payment — operational risk the owner must clear first.
  const atRiskJobs = [];
  for (const { lead, state } of enriched) {
    if (lead.job_status !== 'booked' && lead.job_status !== 'scheduled') continue;
    const vd = state.vd;
    const d = dayOf(lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate);
    if (d !== todayStr && d !== tomorrowStr) continue;
    const missing = [];
    if (!vd.deliveryAddress) missing.push('delivery address');
    if (!lead.paid_at) missing.push('payment');
    if (missing.length === 0) continue;
    atRiskJobs.push({
      name: leadFullName(lead, vd),
      when: d === todayStr ? 'today' : 'tomorrow',
      missing,
      size: vd.dumpsterSize || null,
      price: quoted(lead, vd),
    });
  }

  // Upcoming deliveries in the next 30 days (pipeline of confirmed work).
  const upcomingDeliveries = enriched
    .filter(({ lead, state }) => {
      if (!['booked', 'scheduled'].includes(lead.job_status)) return false;
      const d = dayOf(lead.delivery_date || state.vd.deliveryDateISO || state.vd.deliveryDate);
      return d && d >= todayStr && d <= in30Str;
    }).length;

  const weekAgo = new Date(now - 7 * MS_DAY);
  const counts = {
    followUpsDueToday: enriched.filter((e) => e.state.followUpDueToday).length,
    overdueFollowUps: enriched.filter((e) => e.state.followUpOverdue).length,
    highIntentOpportunities: enriched.filter((e) => e.state.isOpportunity && e.state.intent === 'high').length,
    goingCold: enriched.filter((e) => e.state.stale).length,
    newLeadsLast7Days: leads.filter((l) => l.created_at && new Date(l.created_at) >= weekAgo).length,
    upcomingDeliveries,
  };

  return {
    date: todayStr,
    businessName: business?.name || 'your business',
    counts,
    priorityLeads,
    atRiskJobs,
  };
}

// ── generation ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a sharp Chief Operating Officer briefing a busy home-services business owner first thing in the morning. You are given a JSON snapshot of the day's operational state.

Write 3 to 5 short bullet points. Each bullet is ONE concrete, actionable insight — the kind a COO would tell a CEO. Rules:
- Lead with the action or the money. Be specific: name customers, cite dollar amounts, and reference timing when the data provides it.
- Order by urgency and impact: at-risk jobs (missing payment/address, delivering today/tomorrow) and money on the table come first.
- Use ONLY facts present in the snapshot. Never invent names, prices, dates, or counts. If a detail isn't provided, don't reference it.
- Keep each bullet to one or two sentences. Confident, plain, operator-to-operator tone. No emojis, no preamble.
- Return ONLY a JSON array of strings, e.g. ["...", "..."]. No markdown, no surrounding text.`;

// Parse the model's reply into a clean array of bullet strings.
function parseBullets(rawText) {
  let text = String(rawText || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    const first = text.indexOf('[');
    const last = text.lastIndexOf(']');
    if (first !== -1 && last > first) {
      try { arr = JSON.parse(text.slice(first, last + 1)); } catch { arr = null; }
    }
  }
  if (!Array.isArray(arr)) return null;
  const bullets = arr
    .filter((b) => typeof b === 'string' && b.trim())
    .map((b) => b.trim())
    .slice(0, 5);
  return bullets.length ? bullets : null;
}

// Deterministic bullets from the snapshot — used when the model is unavailable
// or returns something unusable, so the banner always has content.
function fallbackBullets(snapshot) {
  const out = [];
  for (const job of snapshot.atRiskJobs.slice(0, 2)) {
    out.push(`${job.name}'s delivery is ${job.when} and is missing ${job.missing.join(' & ')}. Resolve this first.`);
  }
  if (snapshot.counts.followUpsDueToday > 0) {
    const top = snapshot.priorityLeads[0];
    const lead = top
      ? ` Start with ${top.name}${top.quotedPrice ? ` — quoted ${top.quotedPrice}` : ''}.`
      : '';
    const n = snapshot.counts.followUpsDueToday;
    out.push(`You have ${n} follow-up${n === 1 ? '' : 's'} due today.${lead}`);
  } else if (snapshot.priorityLeads[0]) {
    const top = snapshot.priorityLeads[0];
    out.push(`Top lead to call: ${top.name}${top.quotedPrice ? ` — quoted ${top.quotedPrice}` : ''}${top.service ? ` (${top.service})` : ''}.`);
  }
  if (snapshot.counts.goingCold > 0) {
    const n = snapshot.counts.goingCold;
    out.push(`${n} lead${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} going cold (48h+ with no contact). Reach out today to recover ${n === 1 ? 'it' : 'them'}.`);
  }
  if (snapshot.counts.upcomingDeliveries > 0 && out.length < 5) {
    const n = snapshot.counts.upcomingDeliveries;
    out.push(`${n} ${n === 1 ? 'delivery is' : 'deliveries are'} scheduled over the next 30 days — confirm logistics for upcoming jobs.`);
  }
  if (out.length === 0) {
    out.push('No urgent actions this morning — your pipeline is clear. Good time to chase older opportunities.');
  }
  return out.slice(0, 5);
}

async function generateBullets(snapshot) {
  if (!client) return fallbackBullets(snapshot);
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here is this morning's operational snapshot:\n\n${JSON.stringify(snapshot, null, 2)}\n\nWrite the morning brief now.`,
        },
      ],
    });
    const text = response.content?.[0]?.text;
    return parseBullets(text) || fallbackBullets(snapshot);
  } catch (err) {
    console.error('[morning-brief] Generation failed, using fallback:', err.message);
    return fallbackBullets(snapshot);
  }
}

// Public: returns { date, available, bullets } for a business.
// `available` is false before 6am local — the banner only shows in the morning.
async function getMorningBrief(businessId, now = new Date()) {
  const tz = getTimezone(businessId);
  const { date, hour } = businessClock(tz, now);

  if (hour < 6) return { date, available: false, bullets: [] };

  const key = `${businessId}:${date}`;
  const cached = cache.get(key);
  if (cached) return { date, available: true, bullets: cached.bullets };

  const snapshot = buildSnapshot(businessId, date, now);
  const bullets = await generateBullets(snapshot);

  // Cache today's result and drop any stale prior-day entries for this business.
  cache.set(key, { bullets, generatedAt: Date.now() });
  for (const k of cache.keys()) {
    if (k.startsWith(`${businessId}:`) && k !== key) cache.delete(k);
  }

  return { date, available: true, bullets };
}

module.exports = { getMorningBrief };
