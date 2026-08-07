import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  AlertTriangle, UserPlus, CalendarCheck2, Truck, CheckCircle2, DollarSign,
  Phone, CalendarSearch, Calendar, Sparkles, X, Check, ArrowRight, ArrowUpRight,
  ArrowDownRight, FileText, Briefcase, AlertCircle, Plus, ExternalLink,
} from 'lucide-react';
import { api } from '../../utils/api';
import socket from '../../socket';
import { getLeadActionState, parseVerticalData, OPERATIONAL_JOB_STATUSES, ACTIVE_JOB_STATUS_SET, UPCOMING_JOB_STATUS_SET, JOB_STATUS, LEGACY_STATUS, getTerminology, getSubVertical, formatTime12 } from '../../utils/verticalConfig';
import { playChime } from '../../utils/chime';
import IntentBadge from './IntentBadge';
import CriticalBadge from './CriticalBadge';
import VoicemailBadge from './VoicemailBadge';
import MissedCallBadge from './MissedCallBadge';
import ActiveRentalActions from './ActiveRentalActions';
import { getSettings, saveSettings } from '../../utils/settings';
import { Link, useNavigate } from 'react-router-dom';
import OnboardingBanner from '../OnboardingBanner';

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatMoney(amount) {
  return `$${Math.round(amount || 0).toLocaleString()}`;
}

// Percent change vs a baseline; null when there's no baseline to compare to.
function pctChange(cur, base) {
  if (!base || base <= 0) return null;
  return Math.round(((cur - base) / base) * 100);
}

function getLeadName(lead) {
  // customer_name is resolved server-side from the linked customer (GET /leads) for
  // leads with no name of their own, so an unnamed call/booked lead still shows the
  // known customer's name instead of "Unknown".
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    return vd.customerName || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || lead.customer_name || 'Unknown';
  } catch {
    return [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || lead.customer_name || 'Unknown';
  }
}

// Condense a free-text dumpster size ("20 yard dumpster") to a compact "20yd".
function formatSize(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\d+/);
  return m ? `${m[0]}yd` : String(raw);
}

// Normalize any stored date/datetime value to its YYYY-MM-DD calendar day.
function dayKey(value) {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

// A stored date as a short human day ("Aug 12"), read in local-calendar space so it
// never slips a day. Falls back to the raw value when it isn't a date we recognize.
function fmtDayLabel(value) {
  const key = dayKey(value);
  if (!key) return value ? String(value) : '';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Best-effort parse of a schedule time ("8:00 AM", "14:30", "9am") to minutes
// past midnight, for sorting. Returns null when unparseable (sorts last).
function parseTimeToMinutes(t) {
  if (!t) return null;
  const s = String(t).trim();
  let m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = m[3] && m[3].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60 + min;
  }
  m = /^(\d{1,2})\s*(am|pm)$/i.exec(s);
  if (m) {
    let h = Number(m[1]);
    const ap = m[2].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60;
  }
  return null;
}

function getFollowUpLabel(followUpDate) {
  if (!followUpDate) return null;
  const now = new Date();
  const diff = followUpDate - now;
  if (diff < 0) return 'Overdue';
  // Round to the nearest unit so a follow-up set 2h out doesn't display as "1h"
  // just because a few seconds elapsed before the badge rendered (1h59m -> 2h).
  const totalMinutes = Math.round(diff / 60000);
  if (totalMinutes < 60) return 'Due now';
  const hrs = Math.round(totalMinutes / 60);
  if (hrs < 24) return `Due in ${hrs}h`;
  const days = Math.round(totalMinutes / 1440);
  return `Due in ${days}d`;
}

// Compact "time since" label for a past timestamp (e.g. a missed call's age):
// "just now", "12m ago", "3h ago", "2d ago". Returns null for missing/future.
function getElapsedLabel(date) {
  if (!date) return null;
  const diff = Date.now() - new Date(date).getTime();
  if (Number.isNaN(diff) || diff < 0) return null;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hrs = Math.floor(minutes / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// Parse a YYYY-MM-DD string as a local-calendar date.  Avoids the UTC-midnight
// shift that `new Date("YYYY-MM-DD")` produces in negative-offset timezones —
// e.g. "2026-06-01" landing on May 31 23:00 local in EST/CDT.
function parseLocalDate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Format a YYYY-MM-DD date string without UTC shifting.
function formatDeliveryDate(value) {
  if (!value) return null;
  const [datePart] = String(value).split('T');
  const [year, month, day] = datePart.split('-');
  if (!year || !month || !day) return null;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Action Queue priority ranking ────────────────────────────────────────────
// The queue acts like an ops manager: "if the owner can make one call right now,
// who first?" Leads are bucketed into priority tiers (1 = most urgent) and sorted
// tier-first, then most-overdue follow-up, then highest revenue. See getAttentionTier.

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
// How long an outstanding balance may linger before the balance-chaser nudge fires.
const BALANCE_CHASE_DAYS = 3;

// End of a local calendar day (23:59:59.999) — used as the anchor for ASAP
// delivery-date expiry so the grace period counts from the delivery day's close.
function endOfLocalDay(d) {
  const c = new Date(d); c.setHours(23, 59, 59, 999); return c;
}

// Parse a SQLite/ISO timestamp to ms (naive "YYYY-MM-DD HH:MM:SS" is UTC).
function tsToMs(ts) {
  if (!ts) return null;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const ms = new Date(s).getTime();
  return Number.isNaN(ms) ? null : ms;
}
function daysSince(ts, now) {
  const ms = tsToMs(ts);
  return ms == null ? 0 : (now.getTime() - ms) / MS_DAY;
}
// True once `now` is on a later calendar day than `sinceTs` AND ≥18h have elapsed —
// approximates "by the next business day" (without weekend logic) for the
// pending-payment nudge.
function isPastNextDay(sinceTs, now) {
  const ms = tsToMs(sinceTs);
  if (ms == null) return false;
  const sinceDay = new Date(ms); sinceDay.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return today.getTime() > sinceDay.getTime() && (now.getTime() - ms) >= 18 * MS_HOUR;
}
// The customer's first name for a nudge, or a neutral fallback.
function leadFirstName(lead, vd) {
  const n = vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
    || 'This customer';
  return String(n).split(' ')[0] || 'This customer';
}

// True when a delivery date falls on today or tomorrow (local). Used to surface
// imminent deliveries that need a call now, even when the model didn't tag the
// lead as ASAP (e.g. it heard "tomorrow" and filed urgency under "This Week").
function isNearTermDelivery(d, now) {
  if (!d) return false;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  return day.getTime() === today.getTime() || day.getTime() === tomorrow.getTime();
}

// A lead carries a critical operational flag that must be manually resolved —
// inventory conflicts or an auto-book that was blocked. These never auto-expire.
function isCriticalLead(lead, vd) {
  const aiRec = String(vd.aiRecommendation || '');
  const notes = String(lead.internal_notes || '');
  return vd.inventoryConflict === true
    || /INVENTORY CONFLICT/i.test(aiRec)
    || /AUTO-BOOK BLOCKED/i.test(notes);
}

// Has this lead already been expired out of the queue? Once expired we stamp
// internal_notes so it stays out and isn't re-processed on the next load.
function isExpiredFlagged(lead) {
  return /Expired — no action taken/i.test(String(lead.internal_notes || ''));
}

// Has the owner manually dismissed this lead from the Action Queue? Dismissal
// stamps internal_notes (without changing job_status) so the lead drops out of
// the queue and stays out across reloads, while remaining in All Opportunities.
function isDismissedFlagged(lead) {
  return /Dismissed from Action Queue/i.test(String(lead.internal_notes || ''));
}

// Decides whether an enriched lead belongs in the Action Queue right now.
// Returns { inQueue, expired, reason }.
function classifyForQueue(e, now, cfg) {
  const { lead, state, vd } = e;

  // Missed calls aren't opportunities (getLeadActionState marks them inactive),
  // but they DO belong in the Action Queue until the owner acts on them, then
  // expire out after the grace window (default 24h). Handle them before the
  // opportunity gate below, which they would otherwise fail.
  if (lead.call_type === 'missed_call') {
    const neverContacted = (state.jobStatus === JOB_STATUS.INQUIRY || state.jobStatus == null) && lead.status === LEGACY_STATUS.NEW;
    if (!neverContacted) return { inQueue: false, expired: false, reason: null };
    const created = lead.created_at ? new Date(lead.created_at).getTime() : null;
    const active = created == null ? true : now.getTime() <= created + cfg.missedCallExpiryH * MS_HOUR;
    return { inQueue: active, expired: !active, reason: null };
  }

  // Operational (booked/scheduled) jobs only surface for the missing
  // address/payment risk — which is critical and never expires.
  if (state.isOperational) {
    const reason = bookedAttentionReason(lead, vd, now);
    return { inQueue: !!reason, expired: false, reason };
  }

  // Dead-end leads — the AI flagged no follow-up needed (customer declined, not
  // interested, going elsewhere). They stay in All Leads but never enter the
  // Action Queue, even when a stale/ASAP signal would otherwise pull them in.
  if (state.isDead) {
    return { inQueue: false, expired: false, reason: null };
  }

  if (!state.isOpportunity || !state.isActive) {
    return { inQueue: false, expired: false, reason: null };
  }

  const critical = isCriticalLead(lead, vd);
  const isVoicemail = lead.call_type === 'voicemail';
  const neverContacted = (state.jobStatus === JOB_STATUS.INQUIRY || state.jobStatus == null) && lead.status === LEGACY_STATUS.NEW;

  // Collect every qualifying reason with whether it's still within its window.
  const reasons = [];
  if (critical) reasons.push({ active: true }); // never expires

  if (state.followUpDate && state.followUpDate <= now) {
    const expireAt = state.followUpDate.getTime() + cfg.followupExpiryH * MS_HOUR;
    reasons.push({ active: now.getTime() <= expireAt });
  }

  const deliveryDate = parseLocalDate(lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate);

  if (String(vd.urgency || '').toLowerCase() === 'asap') {
    // No delivery date set → can't have expired by date; stays active.
    const active = deliveryDate ? now.getTime() <= endOfLocalDay(deliveryDate).getTime() + cfg.asapExpiryH * MS_HOUR : true;
    reasons.push({ active });
  }

  // Near-term delivery: a customer who wants delivery today or tomorrow needs a
  // call now even if the model didn't tag urgency as ASAP.
  if (isNearTermDelivery(deliveryDate, now)) {
    const active = now.getTime() <= endOfLocalDay(deliveryDate).getTime() + cfg.asapExpiryH * MS_HOUR;
    reasons.push({ active });
  }

  if (isVoicemail && neverContacted) {
    const created = lead.created_at ? new Date(lead.created_at).getTime() : null;
    const active = created == null ? true : now.getTime() <= created + cfg.voicemailExpiryH * MS_HOUR;
    reasons.push({ active });
  }

  if (reasons.length === 0) return { inQueue: false, expired: false, reason: null };

  const anyActive = reasons.some(r => r.active);
  return { inQueue: anyActive, expired: !anyActive, reason: null };
}

// Operational risk on an in-flight job that jumps it to the top tier. In priority
// order: (1) a detected cancellation cue to confirm/disregard; (2) a held reschedule
// request; (3) a pending-payment job that hasn't paid by the next business day (hot
// lead going cold); (4) a lingering outstanding balance (balance chaser — completion
// is blocked until it's settled); (5) a job delivering today/tomorrow still missing
// the delivery address (or, for legacy unpaid rows, payment).
function bookedAttentionReason(lead, vd, now) {
  const js = lead.job_status;

  // (1) Cancellation cue — confirm-first decision (never auto-cancels).
  if (vd.cancelRequest && !vd.cancelDismissedAt) {
    return 'Customer expressed intent to cancel — confirm or disregard';
  }
  // (2) Held reschedule request — booked schedule unchanged; owner decides.
  if (vd.rescheduleRequest) return 'Customer requested reschedule — approve?';

  // (2b) Call-driven DRAFT invoice (swap / extension) held for owner review + send.
  // The draft is inert until the owner reviews it in the real invoice editor.
  if (vd.pendingInvoiceReview && vd.pendingInvoiceReview.invoiceId) {
    const k = vd.pendingInvoiceReview.kind;
    const what = k === 'swap_extension' ? 'Swap + extension' : k === 'extension' ? 'Extension' : 'Swap';
    // Same item, same actions — the label just says where the request came from.
    return vd.pendingInvoiceReview.source === 'manual'
      ? `Manual ${what.toLowerCase()} invoice ready — review & send`
      : `${what} invoice ready — review & send`;
  }

  // (3) Pending-payment SALES nudge: booking initiated but unpaid by the next
  // business day. Nothing is reserved during pending_payment — this is about not
  // losing the deal, separate from inventory.
  if (js === JOB_STATUS.PENDING_PAYMENT && lead.payment_status !== 'paid' && !lead.paid_at) {
    return isPastNextDay(lead.updated_at || lead.created_at, now)
      ? "Customer expressed high intent but hasn't paid — follow up"
      : null;
  }

  // (4) Balance chaser: work done, money still owed for more than a few days.
  if (js === JOB_STATUS.AWAITING_FINAL_PAYMENT && lead.payment_status !== 'paid') {
    return daysSince(lead.updated_at || lead.created_at, now) >= BALANCE_CHASE_DAYS
      ? `${leadFirstName(lead, vd)} has an outstanding balance — job can't complete until it's settled`
      : null;
  }

  // (5) Imminent delivery still missing the delivery address (booked jobs are paid
  // by the payment gate, so payment is only flagged for legacy unpaid rows).
  if (!UPCOMING_JOB_STATUS_SET.has(js)) return null;
  const d = parseLocalDate(lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate);
  if (!d) return null;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.getTime() !== today.getTime() && d.getTime() !== tomorrow.getTime()) return null;
  const missing = [];
  if (!vd.deliveryAddress) missing.push('delivery address');
  if (lead.payment_status !== 'paid' && !lead.paid_at) missing.push('payment');
  if (missing.length === 0) return null;
  const when = d.getTime() === today.getTime() ? 'today' : 'tomorrow';
  return `Delivering ${when} — missing ${missing.join(' & ')}`;
}

// One-line summary of an approved reschedule, persisted as the job_updated audit
// line (same format as the Edit Job Details summary). Names only the fields the
// request actually proposed.
function describeRescheduleApplied(rr) {
  const parts = [];
  if (rr.delivery_date !== undefined) parts.push(`delivery date → ${formatDeliveryDate(rr.delivery_date) || rr.delivery_date}`);
  if (rr.pickup_date !== undefined) parts.push(`pickup date → ${formatDeliveryDate(rr.pickup_date) || rr.pickup_date}`);
  if (rr.scheduled_time !== undefined) parts.push(`delivery time → ${formatTime12(rr.scheduled_time) || rr.scheduled_time}`);
  if (rr.rentalDuration !== undefined) parts.push(`duration → ${rr.rentalDuration}`);
  return `Reschedule approved — ${parts.join(', ')}`;
}

// Assigns a lead to a priority tier (1 = most urgent, 6 = least).
function getAttentionTier(e, now = new Date()) {
  const { lead, state, vd, bookedReason } = e;

  // TIER 1 — CRITICAL: inventory conflicts, auto-book blocked, and at-risk
  // booked jobs (missing payment/address delivering today/tomorrow).
  if (isCriticalLead(lead, vd) || bookedReason) return 1;

  const isVoicemail = lead.call_type === 'voicemail';
  const neverContacted = (state.jobStatus === JOB_STATUS.INQUIRY || state.jobStatus == null) && lead.status === LEGACY_STATUS.NEW;

  // TIER 2 — VOICEMAIL UNCONTACTED: customer is waiting on a callback.
  if (isVoicemail && neverContacted) return 2;

  // MISSED CALLS — urgency decays with age. Fractional tiers slot them between
  // the existing integer tiers without disturbing them: fresh misses sit just
  // below voicemails (above ASAP), then progressively lower as they age out.
  if (lead.call_type === 'missed_call' && neverContacted) {
    const ageH = lead.created_at ? (now.getTime() - new Date(lead.created_at).getTime()) / MS_HOUR : 0;
    if (ageH < 1) return 2.5;   // first hour — high urgency, just after voicemails
    if (ageH < 2) return 4.5;   // 1–2h — below high-intent follow-ups
    if (ageH < 4) return 5.5;   // 2–4h — above the lowest standard tier
    return 6.5;                 // 4h+ — bottom of the queue (until 24h expiry)
  }

  // TIER 3 — ASAP or near-term delivery (today/tomorrow) leads.
  const deliveryDate = parseLocalDate(lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate);
  if (String(vd.urgency || '').toLowerCase() === 'asap' || isNearTermDelivery(deliveryDate, now)) return 3;

  // TIER 4 — OVERDUE FOLLOW-UPS WITH HIGH INTENT.
  if (state.followUpOverdue && (state.intent === 'high' || state.intent === 'warm')) return 4;

  // TIER 5 — DUE TODAY FOLLOW-UPS (any intent).
  if (state.followUpDueToday && !state.followUpOverdue) return 5;

  // TIER 6 — OVERDUE FOLLOW-UPS (standard, medium/low intent).
  return 6;
}

// Left-border accent communicating tier urgency.
function tierBorderClass(tier) {
  if (tier === 1) return ''; // Critical badge already signals urgency; no redundant red bar
  if (tier <= 3) return 'border-l-4 border-warning';
  if (tier <= 5) return 'border-l-4 border-warning';
  return 'border-l-4 border-divider';
}

// ─── sub-components ───────────────────────────────────────────────────────────

// Morning Brief — a dismissible, premium daily briefing rendered at the top of
// the dashboard. Bullets come from GET /api/dashboard/morning-brief (AI-generated,
// cached server-side for the day). The server decides availability (after 6am in
// the business timezone); the client only handles per-day dismissal.
const MORNING_BRIEF_DISMISS_KEY = 'leadflow:morningBriefDismissed';

function MorningBrief() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [bullets, setBullets] = useState([]);
  const dateRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.getMorningBrief()
      .then((data) => {
        if (cancelled) return;
        dateRef.current = data?.date || null;
        const dismissed = (() => { try { return localStorage.getItem(MORNING_BRIEF_DISMISS_KEY); } catch { return null; } })();
        const visible = !!data?.available
          && Array.isArray(data.bullets) && data.bullets.length > 0
          && dismissed !== data.date;
        setBullets(data?.bullets || []);
        setShow(visible);
      })
      .catch(() => { if (!cancelled) setShow(false); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    try { if (dateRef.current) localStorage.setItem(MORNING_BRIEF_DISMISS_KEY, dateRef.current); } catch { /* ignore */ }
    setShow(false);
  };

  if (loading || !show) return null;

  return (
    <section className="rounded-xl bg-sidebar text-content shadow-sm overflow-hidden">
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent/20 flex items-center justify-center flex-shrink-0">
              <Sparkles size={15} className="text-accent" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-bold tracking-tight">Morning Brief</p>
              <p className="text-[10px] uppercase tracking-widest text-muted">Stream</p>
            </div>
          </div>
          <button
            onClick={dismiss}
            aria-label="Dismiss morning brief"
            className="text-muted hover:text-content transition-colors p-1 -m-1 flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <ul className="mt-3.5 space-y-2">
          {bullets.map((b, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-content leading-snug">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <div className="mt-3.5 flex justify-end">
          <button
            onClick={() => navigate('/insights')}
            className="text-xs font-medium text-accent hover:text-content transition-colors inline-flex items-center gap-1"
          >
            View all insights <ArrowRight size={13} />
          </button>
        </div>
      </div>
    </section>
  );
}

// Clean, neutral top-banner metric tile. Only the icon carries color; the tile
// background stays neutral. iconColor defaults to gray when not supplied.
function MetricTile({ icon: Icon, label, value, iconColor = 'text-muted' }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm px-4 py-3.5 flex items-center gap-3">
      {Icon && <Icon size={18} className={`${iconColor} flex-shrink-0`} />}
      <div className="min-w-0">
        <p className="text-2xl font-bold text-content leading-tight">{value}</p>
        <p className="text-xs text-muted leading-tight mt-0.5 truncate">{label}</p>
      </div>
    </div>
  );
}

// Bottom-row summary tile: label, primary value, and a small secondary line.
function SummaryTile({ icon: Icon, label, value, sub }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm px-4 py-3.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        {Icon && <Icon size={14} className="text-muted flex-shrink-0" />}
        <p className="text-xs font-medium text-muted truncate">{label}</p>
      </div>
      <p className="text-xl font-bold text-content leading-tight">{value}</p>
      {sub && <p className="text-xs text-muted mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

// Small up/down trend indicator. Null value renders a muted dash (no baseline).
function TrendBadge({ value }) {
  if (value == null) return <span className="text-xs text-muted">—</span>;
  const up = value >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? 'text-success' : 'text-danger'}`}>
      <Icon size={12} />
      {up ? '+' : ''}{value}%
    </span>
  );
}

// Minimal inline SVG sparkline. Inherits color from the parent via currentColor.
function Sparkline({ data, width = 132, height = 36 }) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" className="overflow-visible">
      <polyline points={points} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Outbound click-to-call button. POSTs to the server, which rings the owner's
// phone first and then bridges to the customer. Disabled 5s after a successful
// trigger to guard against accidental double-calls.
function CallButton({ lead, name }) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null); // { type: 'info' | 'error', text }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const handleCall = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await api.callLead(lead.id);
      setToast({ type: 'info', text: `Calling ${name}… your phone will ring shortly` });
      setTimeout(() => setBusy(false), 5000);
    } catch {
      setToast({ type: 'error', text: 'Call failed, please try again' });
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={handleCall}
        disabled={busy}
        className={`p-1.5 rounded-lg transition-colors ${
          busy
            ? 'text-muted cursor-not-allowed'
            : 'text-muted hover:text-success hover:bg-success/10'
        }`}
        title={busy ? 'Calling…' : 'Call'}
      >
        <Phone size={14} />
      </button>
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-xs px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-slide-in ${
            toast.type === 'error' ? 'bg-danger text-content' : 'bg-well text-content'
          }`}
        >
          {toast.text}
        </div>
      )}
    </>
  );
}

// Compact Action Queue row. Shows intent/critical badge, name + phone, the
// operational reason it's in the queue, a time indicator, and call + dismiss.
function AttentionRow({ lead, state, tier, reason, onDismiss, onReschedule, onCancel, onInvoiceReview, onDiscardReview, onMissedCallClick }) {
  const navigate = useNavigate();
  const isMissedCall = lead.call_type === 'missed_call';
  const isVoicemail = lead.call_type === 'voicemail';
  // A pending call-driven reschedule swaps the call/dismiss actions for an
  // explicit Approve / Reject decision (see handleRescheduleDecision).
  const isReschedule = !!state.rescheduleRequested;
  // A detected cancellation cue swaps in an explicit Confirm / Disregard decision
  // (see handleCancelDecision). Never auto-cancels — the owner decides.
  const isCancel = !!state.cancelRequested;
  // A call-driven DRAFT invoice waiting to be reviewed: the primary action is Review
  // (opens the real invoice editor), with a Discard to drop a misclassified draft.
  const isInvoiceReview = !!state.invoiceReviewRequested;
  const name = getLeadName(lead);
  // Missed calls often have no name yet — fall back to the caller's number.
  const displayName = (isMissedCall && name === 'Unknown')
    ? (lead.phone || lead.caller_number || 'Unknown caller')
    : name;
  const showPhone = lead.phone && lead.phone !== displayName;
  const followUpLabel = getFollowUpLabel(state.followUpDate);
  // Missed calls track time elapsed since the call instead of a follow-up date.
  const elapsedLabel = isMissedCall && !followUpLabel ? getElapsedLabel(lead.created_at) : null;
  const reasonText = reason || state.recommendation;
  const reasonIsCritical = !!reason || tier === 1;

  // Action Queue badges — DISPLAY ONLY. This reads `tier`/`intent`/`call_type`
  // but never feeds the queue's sort (ordering is the `.sort()` on tier →
  // followUpDate → revenue, computed upstream and untouched here).
  // One priority badge by precedence: Critical > Voicemail > Missed Call.
  // High Intent shows alongside a Voicemail (the lone exception), or on its own
  // as the fallback when none of those three apply. "Warm"/"Cold" never render.
  const priorityBadge = tier === 1 ? 'critical' : isVoicemail ? 'voicemail' : isMissedCall ? 'missed_call' : null;
  const showHighIntent = state.intent === 'high' && (priorityBadge === 'voicemail' || priorityBadge === null);

  const handleDismissClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDismiss(lead.id);
  };

  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2.5 hover:bg-surface-2 cursor-pointer transition-colors ${tierBorderClass(tier)}`}
      onClick={() => {
        if (isMissedCall) return onMissedCallClick(lead);
        // For a review item the whole row opens the draft invoice editor — the primary,
        // obvious action (the old card click dead-ended on the customer profile).
        if (isInvoiceReview) return onInvoiceReview(lead);
        return navigate(`/leads/${lead.id}`);
      }}
    >
      <div className="flex-1 min-w-0">
        {/* Line 1: name, phone, then the type badge (right of the phone). The
            name truncates so this line never shoves the right-pinned status. */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-semibold text-content truncate min-w-0">{displayName}</span>
          {showPhone && <span className="text-xs text-muted flex-shrink-0">{lead.phone}</span>}
          {(priorityBadge || showHighIntent) && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {priorityBadge === 'critical' && <CriticalBadge size="xs" boxy />}
              {priorityBadge === 'voicemail' && <VoicemailBadge size="xs" boxy />}
              {priorityBadge === 'missed_call' && <MissedCallBadge size="xs" boxy />}
              {showHighIntent && <IntentBadge value="high" size="xs" boxy />}
            </div>
          )}
        </div>
        {reasonText && (
          <p className={`text-xs font-medium truncate mt-0.5 ${reasonIsCritical ? 'text-danger' : 'text-accent'}`}>
            {reasonText}
          </p>
        )}
      </div>
      {/* Status badge, pinned to a consistent right edge. The fixed-width action
          slot below sits to its right on every row, so all Overdue badges line
          up vertically regardless of name/description length (which truncate). */}
      {followUpLabel && (
        <span className={`text-xs font-medium px-2 py-0.5 rounded-md flex-shrink-0 ${
          followUpLabel === 'Overdue' || followUpLabel === 'Due now'
            ? 'bg-danger/10 text-danger'
            : 'bg-warning/10 text-warning'
        }`}>
          {followUpLabel}
        </span>
      )}
      {elapsedLabel && (
        <span className="text-xs font-medium px-2 py-0.5 rounded-md flex-shrink-0 bg-warning/10 text-warning">
          {elapsedLabel}
        </span>
      )}
      <div className={`flex items-center justify-end gap-0.5 flex-shrink-0 ${isInvoiceReview ? '' : 'w-14'}`} onClick={e => e.stopPropagation()}>
        {isCancel ? (
          <>
            {/* Confirm moves the job to Lost; Disregard leaves it unchanged and
                stops the cue from re-surfacing. Confirm-first — never auto-cancels. */}
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(lead, true); }}
              className="p-1.5 rounded-lg text-danger hover:bg-danger/10 transition-colors"
              title="Confirm cancellation (mark lost)"
              aria-label="Confirm cancellation"
            >
              <Check size={15} />
            </button>
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(lead, false); }}
              className="p-1.5 rounded-lg text-muted hover:text-content hover:bg-surface-2 transition-colors"
              title="Disregard — keep the job"
              aria-label="Disregard cancellation"
            >
              <X size={14} />
            </button>
          </>
        ) : isReschedule ? (
          <>
            {/* Approve applies the requested schedule (owner edit — allowed by the
                server guard); Reject leaves the booked schedule unchanged. Either
                clears the pending request so the item leaves the queue. */}
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReschedule(lead, true); }}
              className="p-1.5 rounded-lg text-success hover:bg-success/10 transition-colors"
              title="Approve reschedule"
              aria-label="Approve reschedule"
            >
              <Check size={15} />
            </button>
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReschedule(lead, false); }}
              className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-surface-2 transition-colors"
              title="Reject reschedule"
              aria-label="Reject reschedule"
            >
              <X size={14} />
            </button>
          </>
        ) : isInvoiceReview ? (
          <>
            {/* Review opens the real invoice editor for the draft (edit price/lines,
                see the extension inventory warning, then Approve & Send). Discard drops
                a misclassified draft and clears the marker — nothing reaches the customer. */}
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onInvoiceReview(lead); }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold text-white bg-accent hover:opacity-90 transition-colors"
              title="Review & approve draft invoice"
              aria-label="Review draft invoice"
            >
              <FileText size={13} /> Review
            </button>
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDiscardReview(lead); }}
              className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-surface-2 transition-colors"
              title="Discard draft (don't send)"
              aria-label="Discard draft invoice"
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            {lead.phone && <CallButton lead={lead} name={name} />}
            {/* Missed calls are dismissed via the decision modal's Discard, not the
                quick-dismiss X, so the owner makes an explicit create/discard call. */}
            {!isMissedCall && (
              <button
                onClick={handleDismissClick}
                className="p-1.5 rounded-lg text-muted hover:text-muted hover:bg-surface-2 transition-colors"
                title="Dismiss from Action Queue"
                aria-label="Dismiss from Action Queue"
              >
                <X size={14} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Decision modal opened from a missed-call row in the Action Queue. A missed
// call has zero context, so the owner explicitly decides: turn it into a real
// lead (opens the prefilled manual form) or discard it. There is no Lead Detail
// page for a missed call — it isn't a lead until "Create Lead" is chosen.
function MissedCallModal({ lead, onCreate, onDiscard, onClose }) {
  const phone = lead.phone || lead.caller_number || 'Unknown number';
  const elapsed = getElapsedLabel(lead.created_at);
  const when = lead.created_at
    ? new Date(lead.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <MissedCallBadge />
        </div>
        <h3 className="text-lg font-bold text-content mt-3">Missed Call</h3>
        <p className="text-sm text-muted mt-1">
          <span className="font-semibold">{phone}</span>
          {when && <span className="text-muted"> · {when}{elapsed ? ` (${elapsed})` : ''}</span>}
        </p>
        <p className="text-sm text-muted mt-3">
          This caller didn't leave a voicemail, so there's no context yet. Create a lead to start
          tracking them, or discard if it wasn't a customer.
        </p>
        <div className="flex flex-col gap-2 mt-5">
          <button
            onClick={() => onCreate(lead)}
            className="w-full text-sm font-medium text-content bg-accent hover:opacity-90 px-4 py-2.5 rounded-xl transition-colors"
          >
            Create Lead
          </button>
          <button
            onClick={() => onDiscard(lead)}
            className="w-full text-sm font-medium text-muted bg-surface-2 hover:bg-surface-2 px-4 py-2.5 rounded-xl transition-colors"
          >
            Discard
          </button>
        </div>
        <button
          onClick={onClose}
          className="w-full mt-2 text-xs text-muted hover:text-muted py-1 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const SCHEDULE_TYPE_BADGE = {
  DROP: 'bg-success/10 text-success',
  PICK: 'bg-brand/10 text-brand',
};

// DROP/PICK is this widget's own vocabulary; the task screen speaks the schedule's.
const SCHEDULE_TASK_TYPE = { DROP: 'delivery', PICK: 'pickup' };

function ScheduleItem({ item, task, onClick }) {
  const { lead, vd, type, label, time } = item;
  const name = getLeadName(lead);
  const size = formatSize(vd.dumpsterSize);
  const address = vd.deliveryAddress || null;
  // Assignment-derived state, from the same summary the Schedule page uses. Absent
  // until it loads (and for a job the server doesn't return), in which case the row
  // reads exactly as it always did.
  const onSiteUnits = task?.assignedUnits || [];
  const done = task ? (type === 'DROP' ? !!task.dropRecorded : !!task.pickupSettled) : false;

  return (
    <div
      onClick={onClick}
      className={`px-4 py-3 cursor-pointer transition-colors ${done ? 'opacity-55' : 'hover:bg-surface-2'}`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-20 flex-shrink-0 text-xs font-semibold ${time ? 'text-content' : 'text-muted'}`}>{time ? formatTime12(time) : 'Flexible'}</div>
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${SCHEDULE_TYPE_BADGE[type]}`}>
          {label || type}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-content truncate">{name}</span>
            {size && <span className="text-xs text-muted flex-shrink-0">{size}</span>}
            {done && (
              <span className="inline-flex items-center gap-1 flex-shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-success/10 text-success">
                <Check size={10} /> Done
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted truncate">
            {lead.phone && <span className="flex-shrink-0">{lead.phone}</span>}
            {address && <span className="truncate">{lead.phone ? '· ' : ''}{address}</span>}
          </div>
          {/* Which physical dumpster is sitting on this job right now — the same line
              the Schedule page's day cards carry. */}
          {onSiteUnits.length > 0 && (
            <p className="text-xs font-semibold text-brand mt-0.5 truncate">
              {onSiteUnits.map(u => `Unit ${u.label}`).join(', ')} on site
            </p>
          )}
        </div>
        {/* The customer profile, now an explicit affordance instead of what tapping
            the row does. */}
        <Link
          to={`/leads/${lead.id}`}
          onClick={(e) => e.stopPropagation()}
          title="Open customer profile"
          className="p-1.5 rounded-lg text-muted hover:bg-surface-2 hover:text-content transition-colors flex-shrink-0"
        >
          <ExternalLink size={13} />
        </Link>
      </div>
    </div>
  );
}

function TodaysSchedule({ items }) {
  const navigate = useNavigate();
  const todayLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // The assignment-derived half of each row (which unit is on site, is the task done)
  // exists only server-side, so it's fetched for the rows on screen. One request for
  // the whole list; a failure just leaves the rows in their plain form.
  const [tasks, setTasks] = useState({});
  const idKey = items.map(it => it.lead.id).join(',');

  useEffect(() => {
    const ids = [...new Set(idKey.split(',').filter(Boolean))];
    // Nothing to enrich. Any previously-loaded entries are keyed by id and simply
    // stop being looked up, so there's nothing to clear.
    if (ids.length === 0) return undefined;
    let alive = true;
    api.getJobTasks(ids)
      .then(d => {
        if (!alive) return;
        setTasks(Object.fromEntries((d.tasks || []).map(t => [String(t.id), t])));
      })
      .catch(() => { if (alive) setTasks({}); });
    return () => { alive = false; };
  }, [idKey]);

  return (
    <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden flex flex-col min-h-[440px]">
      <div className="px-4 py-3 border-b border-divider flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Calendar size={15} className="text-accent" />
          <h2 className="text-sm font-bold text-content">Today's Schedule</h2>
        </div>
        <span className="text-xs text-muted">{todayLabel}</span>
      </div>

      {items.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">Nothing scheduled for today.</div>
      ) : (
        <div className="divide-y divide-divider overflow-y-auto max-h-[360px] scrollbar-subtle">
          {items.map((it, i) => (
            <ScheduleItem
              key={`${it.lead.id}-${it.type}-${i}`}
              item={it}
              task={tasks[String(it.lead.id)]}
              // The card IS the task: same guided screen the Schedule page opens.
              onClick={() => navigate(`/task/${it.lead.id}?type=${SCHEDULE_TASK_TYPE[it.type] || 'delivery'}`)}
            />
          ))}
        </div>
      )}

      <div className="px-4 py-2.5 border-t border-divider mt-auto flex-shrink-0">
        <button
          onClick={() => navigate('/schedule')}
          className="text-xs font-medium text-accent hover:underline inline-flex items-center gap-1"
        >
          View full schedule <ArrowRight size={13} />
        </button>
      </div>
    </section>
  );
}

// ── Active Rentals ────────────────────────────────────────────────────────────
// The cans that are out at a customer right now. Today's Schedule only shows what
// happens TODAY, so an ongoing rental lives nowhere on this page — and it's the job
// the phone rings about ("come get it early", "I need another one"). Each row names
// the customer, the size, the unit actually on the ground and when it's due back,
// with the two on-demand actions and a tap-through to the job's task screen.
//
// Display + navigation only: the unit line comes from the same read-only task summary
// Today's Schedule uses, and the actions reuse the existing pickup task / swap flow.
function ActiveRentals({ items }) {
  const navigate = useNavigate();
  // Which physical unit is on each job — server-side knowledge, same batch endpoint
  // Today's Schedule uses. A failure just leaves the rows without the unit line.
  const [tasks, setTasks] = useState({});
  const idKey = items.map(it => it.lead.id).join(',');

  useEffect(() => {
    const ids = [...new Set(idKey.split(',').filter(Boolean))];
    if (ids.length === 0) return undefined;
    let alive = true;
    api.getJobTasks(ids)
      .then(d => {
        if (!alive) return;
        setTasks(Object.fromEntries((d.tasks || []).map(t => [String(t.id), t])));
      })
      .catch(() => { if (alive) setTasks({}); });
    return () => { alive = false; };
  }, [idKey]);

  if (items.length === 0) return null;

  return (
    <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-divider flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck size={15} className="text-warning" />
          <h2 className="text-sm font-bold text-content">Active Rentals</h2>
        </div>
        <span className="text-xs text-muted">{items.length} out</span>
      </div>

      <div className="divide-y divide-divider max-h-[360px] overflow-y-auto scrollbar-subtle">
        {items.map(({ lead, vd }) => {
          const task = tasks[String(lead.id)];
          const onSiteUnits = task?.assignedUnits || [];
          const size = formatSize(vd.dumpsterSize);
          const pickup = lead.pickup_date || vd.pickupDate || null;
          return (
            <div
              key={lead.id}
              onClick={() => navigate(`/task/${lead.id}?type=active`)}
              className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-surface-2 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-semibold text-content truncate">{getLeadName(lead)}</span>
                  {size && <span className="text-xs text-muted flex-shrink-0">{size}</span>}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted truncate">
                  {onSiteUnits.length > 0 && (
                    <span className="font-semibold text-brand flex-shrink-0">
                      {onSiteUnits.map(u => `Unit ${u.label}`).join(', ')}
                    </span>
                  )}
                  <span className="truncate">
                    {onSiteUnits.length > 0 ? '· ' : ''}
                    {pickup ? `Pickup ${fmtDayLabel(pickup)}` : 'No pickup date set'}
                  </span>
                </div>
              </div>
              <ActiveRentalActions
                leadId={lead.id}
                size={vd.dumpsterSize || null}
                compact
                className="flex-shrink-0"
              />
              <Link
                to={`/leads/${lead.id}`}
                onClick={(e) => e.stopPropagation()}
                title="Open customer profile"
                className="p-1.5 rounded-lg text-muted hover:bg-surface-2 hover:text-content transition-colors flex-shrink-0"
              >
                <ExternalLink size={13} />
              </Link>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Revenue & Reporting tile. Computes booked-revenue figures from the operational
// (booked → completed) jobs passed in. Revenue per job = estimated_revenue, with
// a fallback to the price parsed from vertical_data (state.estimatedRevenue).
// Booking date is approximated by updated_at, matching the rest of the dashboard.
function RevenuePanel({ jobs }) {
  const [range, setRange] = useState('month');

  const data = useMemo(() => {
    const now = new Date();
    const rev = (j) => j.lead.estimated_revenue || j.state.estimatedRevenue || 0;
    const bookingTime = (j) => (j.lead.updated_at ? new Date(j.lead.updated_at).getTime() : null);
    const deliveryDay = (j) => dayKey(j.lead.delivery_date || j.vd.deliveryDateISO || j.vd.deliveryDate);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const lastYearStart = new Date(now.getFullYear() - 1, 0, 1);
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);
    const monthElapsed = now - monthStart;
    const yearElapsed = now - yearStart;

    const sumBetween = (startMs, endMs) => jobs.reduce((s, j) => {
      const b = bookingTime(j);
      return (b != null && b >= startMs && b <= endMs) ? s + rev(j) : s;
    }, 0);

    const pad = (n) => String(n).padStart(2, '0');
    const mkDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const todayStr = mkDay(now);
    const in30 = new Date(now); in30.setDate(in30.getDate() + 30);
    const prev30 = new Date(now); prev30.setDate(prev30.getDate() - 30);
    const in30Str = mkDay(in30);
    const prev30Str = mkDay(prev30);

    const sumDelivery = (fromStr, toStr) => jobs.reduce((s, j) => {
      const d = deliveryDay(j);
      return (d && d >= fromStr && d <= toStr) ? s + rev(j) : s;
    }, 0);

    // Sparkline: booked revenue per month over the trailing 6 months.
    const spark = [];
    for (let i = 5; i >= 0; i--) {
      const ms = new Date(now.getFullYear(), now.getMonth() - i, 1).getTime();
      const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 1).getTime();
      spark.push(sumBetween(ms, me - 1));
    }

    return {
      thisWeek: sumBetween(weekStart.getTime(), now.getTime()),
      thisMonth: sumBetween(monthStart.getTime(), now.getTime()),
      lastMonth: sumBetween(lastMonthStart.getTime(), lastMonthStart.getTime() + monthElapsed),
      thisYear: sumBetween(yearStart.getTime(), now.getTime()),
      lastYear: sumBetween(lastYearStart.getTime(), lastYearStart.getTime() + yearElapsed),
      next30: sumDelivery(todayStr, in30Str),
      prev30: sumDelivery(prev30Str, todayStr),
      spark,
    };
  }, [jobs]);

  const primary = range === 'week' ? data.thisWeek : range === 'year' ? data.thisYear : data.thisMonth;
  const primaryLabel = range === 'week' ? 'This Week' : range === 'year' ? 'This Year' : 'This Month';

  return (
    <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-divider flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DollarSign size={15} className="text-success" />
          <h2 className="text-sm font-bold text-content">Booked Revenue</h2>
        </div>
        <div className="flex items-center gap-1">
          {[['week', 'Week'], ['month', 'Month'], ['year', 'Year']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setRange(val)}
              className={`text-[10px] font-semibold tracking-wide px-2 py-1 rounded transition-colors ${
                range === val ? 'bg-success/10 text-success' : 'text-muted hover:text-muted hover:bg-surface-2'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 py-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-3xl font-bold text-content leading-none">{formatMoney(primary)}</p>
            <p className="text-xs text-muted mt-1">Booked revenue · {primaryLabel}</p>
          </div>
          <div className="text-success flex-shrink-0">
            <Sparkline data={data.spark} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-divider">
          <div>
            <p className="text-xs text-muted mb-1">This Month</p>
            <p className="text-base font-bold text-content leading-tight">{formatMoney(data.thisMonth)}</p>
            <TrendBadge value={pctChange(data.thisMonth, data.lastMonth)} />
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Next 30 Days</p>
            <p className="text-base font-bold text-content leading-tight">{formatMoney(data.next30)}</p>
            <TrendBadge value={pctChange(data.next30, data.prev30)} />
          </div>
          <div>
            <p className="text-xs text-muted mb-1">This Year</p>
            <p className="text-base font-bold text-content leading-tight">{formatMoney(data.thisYear)}</p>
            <TrendBadge value={pctChange(data.thisYear, data.lastYear)} />
          </div>
        </div>
      </div>
    </section>
  );
}

// Mark Booked modal helpers
function parseRentalDays(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (s.includes('week')) return Math.round(num * 7);
  if (s.includes('month')) return Math.round(num * 30);
  return Math.round(num);
}

function calcPickupFromDuration(deliveryISO, rentalDuration) {
  if (!deliveryISO || !rentalDuration) return null;
  const days = parseRentalDays(rentalDuration);
  if (!days) return null;
  const d = new Date(deliveryISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatPickupDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Match a job's free-text size ("10 yard dumpster") to a pool size by leading number.
function sizeMatches(a, b) {
  const na = String(a || '').match(/\d+/);
  const nb = String(b || '').match(/\d+/);
  return na && nb && na[0] === nb[0];
}

function AvailabilityNote({ loading, availability, size }) {
  const label = size || 'this size';
  if (loading) return <p className="text-xs text-muted">Checking availability…</p>;
  if (!availability) {
    return <p className="text-xs text-warning">No {label} in inventory for the selected dates.</p>;
  }
  if (availability.available > 0) {
    return (
      <p className="text-sm font-semibold text-success">
        {availability.available} of {availability.quantity} available for this date
      </p>
    );
  }
  return <p className="text-sm font-semibold text-danger">No {label} available for selected dates</p>;
}

function BookedModal({ lead, onConfirm, onClose }) {
  const vd = parseVerticalData(lead);
  const t = getTerminology(lead.vertical, getSubVertical(lead));
  const extractedSize = vd.dumpsterSize || null;
  const [date, setDate] = useState(lead.delivery_date || vd.deliveryDate || '');
  const [rentalDays, setRentalDays] = useState(() => {
    const n = parseRentalDays(vd.rentalDuration);
    return n ? String(n) : '';
  });
  const [size, setSize] = useState(extractedSize || '');
  const [poolSizes, setPoolSizes] = useState([]);
  const [availability, setAvailability] = useState(null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const name = getLeadName(lead);

  const daysNum = Number(rentalDays);
  const pickupISO = (date && daysNum >= 1) ? calcPickupFromDuration(date, String(daysNum)) : null;
  const isValid = !!date && daysNum >= 1 && !!size;

  // Booking an unpaid job emails the customer a payment link, and the server refuses
  // that when there's no address to send it to. Surface the refusal here rather than
  // closing the modal as though the job were booked.
  const confirm = async () => {
    if (!isValid || saving) return;
    setSaving(true); setError(null);
    try {
      await onConfirm({ date, rentalDays: daysNum, size });
    } catch (err) {
      console.error('Confirm booking failed:', err);
      setError(err?.message || 'Could not book this job. Please try again.');
      setSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    api.getInventory()
      .then(rows => {
        if (cancelled) return;
        const sizes = (rows || []).map(r => r.size).filter(Boolean);
        setPoolSizes(sizes);
        if (extractedSize) {
          const match = sizes.find(s => sizeMatches(s, extractedSize));
          if (match) setSize(match);
        }
      })
      .catch(() => { if (!cancelled) setPoolSizes([]); });
    return () => { cancelled = true; };
  }, []);

  const sizeOptions = poolSizes.some(s => s === size) || !size ? poolSizes : [size, ...poolSizes];

  useEffect(() => {
    if (!date || !pickupISO || !size) { setAvailability(null); return; }
    let cancelled = false;
    setLoadingAvail(true);
    api.getInventory({ delivery_date: date, pickup_date: pickupISO, exclude_lead_id: lead.id })
      .then(rows => {
        if (cancelled) return;
        const match = (rows || []).find(r => sizeMatches(r.size, size)) || null;
        setAvailability(match);
        setLoadingAvail(false);
      })
      .catch(() => { if (!cancelled) { setAvailability(null); setLoadingAvail(false); } });
    return () => { cancelled = true; };
  }, [date, rentalDays, size, lead.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface rounded-2xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold text-content mb-1">Confirm Booking</h3>
        <p className="text-sm text-muted mb-5">{name}{size ? ` · ${size}` : ''}</p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
              {t.jobUnit} Size <span className="text-danger">*</span>
            </label>
            <select
              value={size}
              onChange={e => setSize(e.target.value)}
              className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-surface"
            >
              {!size && <option value="">Select a size…</option>}
              {sizeOptions.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
              {t.startDate} <span className="text-danger">*</span>
            </label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
              {t.durationLabel} (days) <span className="text-danger">*</span>
            </label>
            <input
              type="number"
              min="1"
              value={rentalDays}
              onChange={e => setRentalDays(e.target.value)}
              placeholder="e.g. 7"
              className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {pickupISO ? (
              <p className="text-xs text-muted mt-1">{t.endAction}: {formatPickupDate(pickupISO)}</p>
            ) : (
              <p className="text-xs text-muted mt-1">Enter duration to calculate {t.endAction.toLowerCase()} date</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Availability
            </label>
            {isValid ? (
              <AvailabilityNote loading={loadingAvail} availability={availability} size={size} />
            ) : (
              <p className="text-xs text-muted">Enter a delivery date and duration to check availability.</p>
            )}
          </div>
        </div>
        {error && (
          <p className="mt-4 text-sm text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{error}</p>
        )}
        <div className="flex gap-3 mt-6">
          <button
            onClick={confirm}
            disabled={!isValid || saving}
            className="flex-1 text-sm font-medium text-background bg-success hover:bg-success/90 disabled:bg-surface-2 disabled:text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
          >
            {saving ? 'Booking…' : 'Confirm Booking'}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 text-sm text-muted hover:text-content rounded-xl transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// Quick Availability Check — lightweight, button-triggered availability lookup
// for use during live calls. Reuses the shared /schedule/availability endpoint.
function QuickAvailabilityCheck() {
  const [sizes, setSizes] = useState([]);
  const [size, setSize] = useState('');
  const [date, setDate] = useState('');
  const [duration, setDuration] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { status, available, owned }

  useEffect(() => {
    let cancelled = false;
    api.getInventory()
      .then(rows => {
        if (!cancelled) setSizes((rows || []).map(r => r.size).filter(Boolean));
      })
      .catch(() => { if (!cancelled) setSizes([]); });
    return () => { cancelled = true; };
  }, []);

  const handleCheck = async () => {
    if (!size || !date || !duration || Number(duration) < 1) {
      setResult({ status: 'incomplete' });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const data = await api.getAvailability(date, duration);
      const match = (data.bySizes || []).find(s => s.size === size)
        || (data.bySizes || []).find(s => sizeMatches(s.size, size))
        || null;
      if (match && match.availableCount > 0) {
        setResult({ status: 'available', available: match.availableCount, owned: match.ownedCount });
      } else {
        setResult({ status: 'none' });
      }
    } catch {
      setResult({ status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-divider">
        <div className="flex items-center gap-2">
          <CalendarSearch size={15} className="text-accent" />
          <h2 className="text-sm font-bold text-content">Quick Availability Check</h2>
        </div>
        <p className="text-xs text-muted mt-0.5">Check dumpster availability in seconds</p>
      </div>

      <div className="px-4 py-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Dumpster Size
            </label>
            <select
              value={size}
              onChange={e => setSize(e.target.value)}
              className="w-full text-sm border border-divider rounded-lg px-3 py-2 bg-surface focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">Select size…</option>
              {sizes.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Delivery Date
            </label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Rental Duration (days)
            </label>
            <input
              type="number"
              min="1"
              max="365"
              placeholder="e.g. 7"
              value={duration}
              onChange={e => setDuration(e.target.value)}
              className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>

        <button
          onClick={handleCheck}
          disabled={loading}
          className="w-full mt-3 text-sm font-medium text-content bg-accent hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg transition-opacity"
        >
          {loading ? 'Checking…' : 'Check Availability'}
        </button>

        {result && (
          <div className="mt-3">
            {result.status === 'incomplete' && (
              <p className="text-sm text-muted">Please fill in all fields</p>
            )}
            {result.status === 'available' && (
              <p className="text-sm font-semibold text-success bg-success/10 rounded-lg px-3 py-2">
                {result.available} of {result.owned} available for {size} on {formatDeliveryDate(date)}
              </p>
            )}
            {result.status === 'none' && (
              <p className="text-sm font-semibold text-danger bg-danger/10 rounded-lg px-3 py-2">
                No {size} available for selected dates
              </p>
            )}
            {result.status === 'error' && (
              <p className="text-sm text-warning">Could not check availability — please try again.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── main dashboard ────────────────────────────────────────────────────────────

export default function HomeServicesDashboard() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bookingLead, setBookingLead] = useState(null);
  const [missedCallModal, setMissedCallModal] = useState(null);
  const [settings, setSettings] = useState(getSettings);
  const greeting = getGreeting();

  // Pull authoritative settings (incl. Action Queue grace periods) from the
  // server so expiry windows reflect what's configured on the Settings page.
  useEffect(() => {
    api.getSettings().then((server) => {
      if (server && Object.keys(server).length > 0) {
        saveSettings(server);
        setSettings(prev => ({ ...prev, ...server }));
      }
    }).catch(() => { /* fall back to localStorage defaults */ });
  }, []);

  // includeMissed=true: the dashboard is the ONLY place missed calls surface
  // (in the Action Queue). getLeadActionState keeps them out of every
  // opportunity/operational metric, and classifyForQueue handles their queue
  // membership explicitly.
  const load = useCallback(() => {
    return api.getLeads({ vertical: 'home_services', sort: 'created_at', order: 'desc', includeMissed: 'true' })
      .then(setLeads);
  }, []);

  useEffect(() => {
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    const handleNewLead = (lead) => {
      if (lead.vertical !== 'home_services') return;
      setLeads(prev => prev.some(l => l.id === lead.id) ? prev : [lead, ...prev]);
      playChime();
    };
    const handleLeadUpdated = (lead) => {
      if (lead.vertical !== 'home_services') return;
      // Upsert: patch the lead if it's already loaded, else INSERT it. A call-driven
      // review item arrives as a lead_updated for a BOOKED lead that may not be in the
      // current list (e.g. an older booked job); a patch-only .map silently dropped it,
      // so the "Review & send" item only appeared after a manual refresh. Upserting
      // surfaces it in the Action Queue in real time.
      setLeads(prev => prev.some(l => l.id === lead.id)
        ? prev.map(l => l.id === lead.id ? lead : l)
        : [lead, ...prev]);
    };
    // A missed-call placeholder merged into a later voicemail/conversation lead.
    const handleLeadRemoved = ({ id }) => {
      setLeads(prev => prev.filter(l => l.id !== id));
    };
    const handleReconnect = () => { loadRef.current().catch(console.error); };
    socket.on('new_lead', handleNewLead);
    socket.on('lead_updated', handleLeadUpdated);
    socket.on('lead_removed', handleLeadRemoved);
    socket.io.on('reconnect', handleReconnect);
    return () => {
      socket.off('new_lead', handleNewLead);
      socket.off('lead_updated', handleLeadUpdated);
      socket.off('lead_removed', handleLeadRemoved);
      socket.io.off('reconnect', handleReconnect);
    };
  }, []);

  // Dismiss a lead from the Action Queue. Non-destructive: stamps internal_notes
  // (which isDismissedFlagged keys off) without touching job_status, so the lead
  // leaves the queue but remains in All Opportunities. Optimistic, then synced.
  const handleDismiss = useCallback(async (id) => {
    const target = leads.find(l => l.id === id);
    if (!target) return;
    const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const prefix = target.internal_notes ? `${target.internal_notes}\n` : '';
    const internal_notes = `${prefix}Dismissed from Action Queue [${stamp}]`;
    setLeads(prev => prev.map(l => l.id === id ? { ...l, internal_notes } : l));
    try {
      const updated = await api.updateLead(id, { internal_notes });
      setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
    } catch (err) {
      console.error('Failed to dismiss lead', id, err);
    }
  }, [leads]);

  // Approve or reject a pending call-driven reschedule on a booked job. Approve
  // re-issues the requested schedule as an OWNER edit (authenticated → allowed by
  // the server's booked-schedule guard) and clears the request; reject just clears
  // the request, leaving the booked schedule untouched. Either way the pending
  // marker is removed so the item drops out of the Action Queue.
  const handleRescheduleDecision = useCallback(async (lead, approve) => {
    const vd = parseVerticalData(lead);
    const rr = vd.rescheduleRequest;
    if (!rr) return;

    const body = { vertical_data: { rescheduleRequest: null } };
    if (approve) {
      if (rr.delivery_date !== undefined) body.delivery_date = rr.delivery_date;
      if (rr.pickup_date !== undefined) body.pickup_date = rr.pickup_date;
      if (rr.scheduled_time !== undefined) body.scheduled_time = rr.scheduled_time;
      if (rr.rentalDuration !== undefined) body.vertical_data.rentalDuration = rr.rentalDuration;
      body.job_edit_summary = describeRescheduleApplied(rr);
    }

    // Optimistically drop the pending marker so the item leaves the queue at once;
    // the server response (authoritative schedule) then replaces the row.
    const clearedVd = JSON.stringify({ ...vd, rescheduleRequest: null });
    setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, vertical_data: clearedVd } : l));
    try {
      const updated = await api.updateLead(lead.id, body);
      setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
    } catch (err) {
      console.error('Failed to apply reschedule decision', lead.id, err);
      loadRef.current().catch(() => {}); // resync on failure
    }
  }, []);

  // Confirm or disregard a detected cancellation cue (confirm-first — never
  // auto-cancels). Confirm moves the job to Lost; disregard stamps the call so the
  // cue stops re-surfacing and leaves the job untouched. Either way the item drops
  // out of the Action Queue.
  const handleCancelDecision = useCallback(async (lead, confirm) => {
    // Optimistically clear the cue so the row leaves the queue immediately.
    const vd = parseVerticalData(lead);
    const clearedVd = JSON.stringify({ ...vd, cancelRequest: null, cancelDismissedAt: new Date().toISOString() });
    setLeads(prev => prev.map(l => l.id === lead.id
      ? { ...l, vertical_data: clearedVd, job_status: confirm ? 'lost' : l.job_status }
      : l));
    try {
      const res = await api.resolveCancel(lead.id, confirm);
      if (res && res.lead) setLeads(prev => prev.map(l => l.id === res.lead.id ? res.lead : l));
    } catch (err) {
      console.error('Failed to resolve cancellation', lead.id, err);
      loadRef.current().catch(() => {}); // resync on failure
    }
  }, []);

  // Open the call-driven draft in the real invoice editor (review mode). The editor
  // shows the server-computed extension inventory warning and the Approve & Send /
  // Discard actions; nothing reaches the customer until the owner approves + sends.
  const handleInvoiceReview = useCallback((lead) => {
    const vd = parseVerticalData(lead);
    const invId = vd.pendingInvoiceReview && vd.pendingInvoiceReview.invoiceId;
    if (!invId) return;
    navigate(`/invoices/${invId}/edit?review=${lead.id}`);
  }, [navigate]);

  // Discard a misclassified swap/extension draft without sending — clears the marker
  // (server also deletes the inert draft). Optimistically drop it from the queue.
  const handleDiscardInvoiceReview = useCallback(async (lead) => {
    const vd = parseVerticalData(lead);
    const clearedVd = JSON.stringify({ ...vd, pendingInvoiceReview: null });
    setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, vertical_data: clearedVd } : l));
    try {
      const res = await api.resolveInvoiceReview(lead.id, 'discard');
      if (res && res.lead) setLeads(prev => prev.map(l => l.id === res.lead.id ? res.lead : l));
    } catch (err) {
      console.error('Failed to discard invoice review', lead.id, err);
      loadRef.current().catch(() => {}); // resync on failure
    }
  }, []);

  // Missed-call decision modal actions. A missed call is not a lead until the
  // owner explicitly acts on it here.
  // Create Lead: open the manual form prefilled with the caller's number; the
  // form discards this missed-call placeholder once the real lead is saved.
  const handleMissedCallCreate = useCallback((lead) => {
    setMissedCallModal(null);
    navigate('/new/manual', {
      state: { phone: lead.phone || lead.caller_number || '', missedCallId: lead.id },
    });
  }, [navigate]);

  // Discard: permanently remove the missed call from the Action Queue and log it.
  const handleMissedCallDiscard = useCallback(async (lead) => {
    setMissedCallModal(null);
    setLeads(prev => prev.filter(l => l.id !== lead.id)); // optimistic
    const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const prefix = lead.internal_notes ? `${lead.internal_notes}\n` : '';
    const internal_notes = `${prefix}Missed call discarded by owner [${stamp}]`;
    try {
      await api.updateLead(lead.id, { discarded: 1, internal_notes });
    } catch (err) {
      console.error('Failed to discard missed call', lead.id, err);
      loadRef.current().catch(() => {}); // resync on failure
    }
  }, []);

  const handleBookedConfirm = useCallback(async ({ date, rentalDays, size }) => {
    if (!bookingLead) return;
    try {
      const updates = {
        job_status: 'booked',
        status: 'booked',
      };
      const vd = {};
      if (size) vd.dumpsterSize = size;
      if (date) {
        updates.delivery_date = date;
        vd.deliveryDate = date;
        vd.deliveryDateISO = date;
        if (rentalDays >= 1) {
          const pickup = calcPickupFromDuration(date, String(rentalDays));
          if (pickup) {
            updates.pickup_date = pickup;
            vd.pickupDate = pickup;
          }
          vd.rentalDuration = `${rentalDays} days`;
        }
      }
      if (Object.keys(vd).length) updates.vertical_data = vd;
      const updated = await api.updateLead(bookingLead.id, updates);
      setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
      setBookingLead(null);
    } catch (e) {
      console.error(e);
      // Re-throw so the modal stays open and shows why (the server refuses to book a
      // job into "payment link emailed" when there's no email to send it to).
      throw e;
    }
  }, [bookingLead]);

  const { needsAttention, toExpire, todaysSchedule, activeRentals, operationalLeads, metrics } = useMemo(() => {
    const now = new Date();
    const enriched = leads.map(l => ({ lead: l, state: getLeadActionState(l, now), vd: parseVerticalData(l) }));

    // Action Queue — membership + ranking logic is unchanged. classifyForQueue
    // decides who's in; getAttentionTier ranks them; expired/dismissed leads are
    // filtered out.
    const aqCfg = {
      asapExpiryH: Number(settings.action_queue_asap_expiry_hours) || 24,
      followupExpiryH: Number(settings.action_queue_followup_expiry_hours) || 48,
      voicemailExpiryH: Number(settings.action_queue_voicemail_expiry_hours) || 24,
      missedCallExpiryH: Number(settings.action_queue_missed_call_expiry_hours) || 24,
    };
    const classified = enriched.map(e => ({ ...e, q: classifyForQueue(e, now, aqCfg) }));

    const toExpire = classified
      .filter(e => e.q.expired && !isExpiredFlagged(e.lead))
      .map(e => e.lead);

    const needsAttention = classified
      .filter(e => e.q.inQueue && !isExpiredFlagged(e.lead) && !isDismissedFlagged(e.lead))
      .map(e => ({ ...e, bookedReason: e.q.reason, tier: getAttentionTier({ ...e, bookedReason: e.q.reason }, now) }))
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        const fa = a.state.followUpDate ? a.state.followUpDate.getTime() : Infinity;
        const fb = b.state.followUpDate ? b.state.followUpDate.getTime() : Infinity;
        if (fa !== fb) return fa - fb;
        const ra = a.lead.estimated_revenue || a.state.estimatedRevenue || 0;
        const rb = b.lead.estimated_revenue || b.state.estimatedRevenue || 0;
        return rb - ra;
      });

    // Operational jobs (booked → completed) — powers the revenue tile + job metrics.
    const operationalLeads = enriched.filter(e => e.state.isOperational);

    // ── Today's schedule ──────────────────────────────────────────────────────
    const pad = n => String(n).padStart(2, '0');
    const t = new Date();
    const todayStr = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;

    // A job only appears on Today's Schedule when something physically happens
    // today — a drop off (delivery_date) or a pick up (pickup_date). An ongoing
    // active rental with neither dated today is NOT shown.
    const todaysSchedule = [];
    for (const { lead, vd } of enriched) {
      if (!OPERATIONAL_JOB_STATUSES.has(lead.job_status)) continue;
      const term = getTerminology(lead.vertical, getSubVertical(lead));
      const deliveryStr = dayKey(lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate);
      const pickupStr = dayKey(lead.pickup_date || vd.pickupDate);
      if (deliveryStr === todayStr) {
        todaysSchedule.push({ lead, vd, type: 'DROP', label: term.startBadge, time: lead.scheduled_time || null });
      }
      if (pickupStr === todayStr) {
        todaysSchedule.push({ lead, vd, type: 'PICK', label: term.endBadge, time: lead.scheduled_time || null });
      }
    }
    const TYPE_ORDER = { DROP: 0, PICK: 1 };
    todaysSchedule.sort((a, b) => {
      const ta = parseTimeToMinutes(a.time);
      const tb = parseTimeToMinutes(b.time);
      if (ta != null && tb != null && ta !== tb) return ta - tb;
      if (ta != null && tb == null) return -1;
      if (ta == null && tb != null) return 1;
      return (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9);
    });

    // ── Active rentals ────────────────────────────────────────────────────────
    // The jobs that are physically out at a customer right now. Today's Schedule
    // deliberately shows only what HAPPENS today, so an ongoing rental with neither
    // date landing today appears nowhere — which is exactly the job you need when
    // the customer calls to have it picked up early or swapped. Anything already on
    // today's schedule is left there rather than listed twice.
    const onScheduleToday = new Set(todaysSchedule.map(it => it.lead.id));
    const activeRentals = enriched
      .filter(({ lead }) => (
        (lead.job_status === JOB_STATUS.DELIVERED || lead.job_status === JOB_STATUS.ACTIVE_RENTAL)
        && !onScheduleToday.has(lead.id)
      ))
      .sort((a, b) => {
        // Soonest pickup first; a rental with no pickup date sits at the end.
        const pa = dayKey(a.lead.pickup_date || a.vd.pickupDate) || '9999-99-99';
        const pb = dayKey(b.lead.pickup_date || b.vd.pickupDate) || '9999-99-99';
        return pa.localeCompare(pb);
      });

    // ── Metrics ────────────────────────────────────────────────────────────────
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);
    const revOf = (lead, state) => lead.estimated_revenue || state.estimatedRevenue || 0;

    const needsAttentionCount = needsAttention.length;
    // Missed calls aren't leads — keep them out of the New Leads count even
    // though they're fetched for the Action Queue.
    const newLeads7d = leads.filter(l => l.call_type !== 'missed_call' && l.created_at && new Date(l.created_at) >= weekStart).length;
    const bookedThisWeek = leads.filter(l =>
      (l.job_status === JOB_STATUS.BOOKED || l.status === LEGACY_STATUS.BOOKED) && l.updated_at && new Date(l.updated_at) >= weekStart
    ).length;

    // On Schedule — ALL booked/scheduled jobs with a future (today onward)
    // delivery date, regardless of when they were booked: the upcoming pipeline.
    const onSchedule = enriched.filter(({ lead, vd }) => {
      if (!UPCOMING_JOB_STATUS_SET.has(lead.job_status)) return false;
      const d = dayKey(lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate);
      return d && d >= todayStr;
    }).length;

    const completedMonth = leads.filter(l =>
      l.job_status === JOB_STATUS.COMPLETED && l.updated_at && new Date(l.updated_at) >= monthStart
    ).length;

    // Bottom row
    const opportunities = enriched.filter(e => e.state.isOpportunity && e.state.isActive);
    const estimatesCount = opportunities.length;
    const estimatesValue = opportunities.reduce((s, e) => s + revOf(e.lead, e.state), 0);

    const jobsTotal = operationalLeads.length;
    const jobsScheduled = onSchedule;

    const activeJobs = enriched.filter(e =>
      e.lead.job_status === JOB_STATUS.DELIVERED || e.lead.job_status === JOB_STATUS.ACTIVE_RENTAL
    ).length;

    // Pending invoices: operational jobs (excluding completed) not yet paid.
    const pending = enriched.filter(e => ACTIVE_JOB_STATUS_SET.has(e.lead.job_status) && !e.lead.paid_at);
    const pendingInvoicesCount = pending.length;
    const pendingInvoicesValue = pending.reduce((s, e) => s + revOf(e.lead, e.state), 0);

    // Overdue: unpaid jobs whose delivery date is already in the past.
    const overdue = pending.filter(e => {
      const d = dayKey(e.lead.delivery_date || e.vd.deliveryDateISO || e.vd.deliveryDate);
      return d && d < todayStr;
    });
    const overdueCount = overdue.length;
    const overdueValue = overdue.reduce((s, e) => s + revOf(e.lead, e.state), 0);

    return {
      needsAttention,
      toExpire,
      todaysSchedule,
      activeRentals,
      operationalLeads,
      metrics: {
        needsAttentionCount, newLeads7d, bookedThisWeek, onSchedule, completedMonth,
        estimatesCount, estimatesValue, jobsTotal, jobsScheduled, activeJobs,
        pendingInvoicesCount, pendingInvoicesValue, overdueCount, overdueValue,
      },
    };
  }, [leads, settings]);

  // Expiration runs on every dashboard load: any lead whose Action Queue grace
  // window has lapsed is moved to All Opportunities with an "Expired" stamp,
  // keeping it out of the queue on subsequent loads.
  const expiringRef = useRef(new Set());
  useEffect(() => {
    if (!toExpire || toExpire.length === 0) return;
    const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    toExpire.forEach((lead) => {
      if (expiringRef.current.has(lead.id)) return;
      expiringRef.current.add(lead.id);
      const prefix = lead.internal_notes ? `${lead.internal_notes}\n` : '';
      const internal_notes = `${prefix}Expired — no action taken [${stamp}]`;
      // Missed calls were never leads, so an expired one is discarded outright;
      // a real opportunity is downgraded back into All Opportunities.
      const patch = lead.call_type === 'missed_call'
        ? { discarded: 1, internal_notes }
        : { job_status: 'opportunity', internal_notes };
      api.updateLead(lead.id, patch)
        .then((updated) => {
          setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
        })
        .catch((err) => console.error('Failed to expire lead', lead.id, err))
        .finally(() => { expiringRef.current.delete(lead.id); });
    });
  }, [toExpire]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-content">{greeting}, {settings.ownerFirstName || 'there'}! 👋</h1>
          <p className="text-sm text-muted mt-1">Here's what's happening with your business today.</p>
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <button
            onClick={() => navigate('/new/manual')}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-content bg-brand hover:bg-brand-hover px-3.5 py-2 rounded-lg transition-colors"
          >
            <Plus size={15} /> Create Job
          </button>
          <p className="text-sm text-muted">{today}</p>
        </div>
      </div>

      {/* Morning Brief banner — renders only in the morning, until dismissed */}
      <MorningBrief />

      {/* Post-signup onboarding nudge — until the setup call activates features */}
      <OnboardingBanner />

      {/* Top metric tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <MetricTile icon={AlertTriangle} label="Action Queue" value={metrics.needsAttentionCount} iconColor="text-danger" />
        <MetricTile icon={UserPlus} label="New Leads" value={metrics.newLeads7d} iconColor="text-brand" />
        <MetricTile icon={CalendarCheck2} label="Booked This Week" value={metrics.bookedThisWeek} iconColor="text-success" />
        <MetricTile icon={Truck} label="On Schedule" value={metrics.onSchedule} iconColor="text-brand" />
        <MetricTile icon={CheckCircle2} label="Completed This Month" value={metrics.completedMonth} iconColor="text-success" />
      </div>

      {/* Action Queue (left 50%) | Today's Schedule (right 50%).
          Both panels share a min-height so they stay vertically matched, and
          each scrolls its own list internally instead of growing the page. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-stretch">
        {/* Action Queue */}
        <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden flex flex-col min-h-[440px]">
          <div className="px-4 py-3 border-b border-divider flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} className="text-danger" />
              <h2 className="text-sm font-bold text-content">Action Queue</h2>
            </div>
            {needsAttention.length > 0 && (
              <span className="text-xs bg-danger/10 text-danger px-2 py-0.5 rounded-full font-medium">
                {needsAttention.length} action{needsAttention.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {needsAttention.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted">
              Inbox clear — great work! 🎉
            </div>
          ) : (
            <div className="divide-y divide-divider overflow-y-auto max-h-[360px] scrollbar-subtle">
              {needsAttention.map(({ lead, state, tier, bookedReason }) => (
                <AttentionRow
                  key={lead.id}
                  lead={lead}
                  state={state}
                  tier={tier}
                  reason={bookedReason}
                  onDismiss={handleDismiss}
                  onReschedule={handleRescheduleDecision}
                  onCancel={handleCancelDecision}
                  onInvoiceReview={handleInvoiceReview}
                  onDiscardReview={handleDiscardInvoiceReview}
                  onMissedCallClick={setMissedCallModal}
                />
              ))}
            </div>
          )}
        </section>

        {/* Today's Schedule */}
        <TodaysSchedule items={todaysSchedule} />
      </div>

      {/* Active Rentals — what's out at a customer right now (renders nothing when
          nothing is out). Today's Schedule above shows only what happens today. */}
      <ActiveRentals items={activeRentals} />

      {/* Revenue & Reporting (~60%) | Quick Availability Check (~40%) */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-5 items-start">
        <RevenuePanel jobs={operationalLeads} />
        <QuickAvailabilityCheck />
      </div>

      {/* Bottom summary row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryTile icon={UserPlus} label="New Leads" value={metrics.newLeads7d} sub="Last 7 days" />
        <SummaryTile icon={FileText} label="Estimates" value={metrics.estimatesCount} sub={`${formatMoney(metrics.estimatesValue)} pending`} />
        <SummaryTile icon={Briefcase} label="Jobs" value={metrics.jobsTotal} sub={`${metrics.jobsScheduled} scheduled`} />
        <SummaryTile icon={Truck} label="Active Jobs" value={metrics.activeJobs} sub="In progress" />
        <SummaryTile icon={FileText} label="Pending Invoices" value={metrics.pendingInvoicesCount} sub={`${formatMoney(metrics.pendingInvoicesValue)} outstanding`} />
        <SummaryTile icon={AlertCircle} label="Overdue" value={metrics.overdueCount} sub={`${formatMoney(metrics.overdueValue)} overdue`} />
      </div>

      {/* Booked modal */}
      {bookingLead && (
        <BookedModal
          lead={bookingLead}
          onConfirm={handleBookedConfirm}
          onClose={() => setBookingLead(null)}
        />
      )}

      {/* Missed-call decision modal — Create Lead or Discard */}
      {missedCallModal && (
        <MissedCallModal
          lead={missedCallModal}
          onCreate={handleMissedCallCreate}
          onDiscard={handleMissedCallDiscard}
          onClose={() => setMissedCallModal(null)}
        />
      )}
    </div>
  );
}
