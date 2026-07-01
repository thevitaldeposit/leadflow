// ── Job status: the single source of truth (SERVER mirror) ─────────────────────
// Canonical definition of the leads.job_status vocabulary and every named status
// GROUP the server tests membership against. This is a hand-kept MIRROR of the
// client's definitions in client/src/utils/verticalConfig.js — the two module
// systems (CommonJS here, ES modules there) can't share one file, so these MUST be
// kept byte-for-byte identical in membership. Change one → change the other.
//
// The rationalized lifecycle (see the job-lifecycle work):
//   inquiry → pending_payment → booked → active_rental → awaiting_final_payment → completed
//   plus terminal side-states: lost, spam.
// pending_payment / awaiting_final_payment are free-text values (no migration to add).
// The old mid-states scheduled / delivered / picked_up are RETIRED from active use
// (nothing transitions INTO them) but kept defined for back-compat; existing rows on
// them are mapped to the nearest active-chain state at READ time by mapLegacyJobStatus
// (never destructively rewritten).
//
// The two historical inconsistencies are now RESOLVED here (and identically on the client):
//   1. "Operational/active" EXCLUDES completed everywhere. A completed job is terminal —
//      it must not appear in active-job lists, inventory, or the schedule.
//   2. "Terminal" = { completed, lost, spam } everywhere. The legacy "booked = deal
//      closed" meaning is dropped; booked now means a confirmed, in-flight job.

// The full job_status lifecycle vocabulary (active chain + retired mid-states + terminal).
const JOB_STATUS = Object.freeze({
  INQUIRY: 'inquiry',
  OPPORTUNITY: 'opportunity',
  PENDING_PAYMENT: 'pending_payment',
  BOOKED: 'booked',
  // Retired mid-states — kept for back-compat, mapped at read time. Nothing transitions in.
  SCHEDULED: 'scheduled',
  DELIVERED: 'delivered',
  ACTIVE_RENTAL: 'active_rental',
  PICKED_UP: 'picked_up',
  AWAITING_FINAL_PAYMENT: 'awaiting_final_payment',
  COMPLETED: 'completed',
  LOST: 'lost',
  SPAM: 'spam',
});

// The separate PAYMENT axis (leads.payment_status). Independent of job_status so the
// UI can show "work done, still owed" (operational stage + payment state as two
// indicators). Derived from the job's invoices ("all settled" rollup) — see
// services/jobLifecycle.js.
const PAYMENT_STATUS = Object.freeze({
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
});

// RESERVES a unit from the pool + occupies the calendar/schedule. Booked is PAID +
// locked in (payment is what reserves the dumpster). EXCLUDES:
//   • pending_payment — booking initiated but unpaid, nothing reserved yet;
//   • awaiting_final_payment / picked_up — the unit is already back;
//   • completed — terminal.
// Legacy scheduled/delivered are kept so pre-lifecycle rows still occupy correctly
// (scheduled ≈ booked, delivered ≈ active_rental). The array form drives SQL
// `IN (…)` placeholder generation; the Set form is O(1) `.has()`.
const ACTIVE_JOB_STATUSES = Object.freeze([
  JOB_STATUS.BOOKED,
  JOB_STATUS.SCHEDULED,
  JOB_STATUS.DELIVERED,
  JOB_STATUS.ACTIVE_RENTAL,
]);
const ACTIVE_JOB_STATUS_SET = new Set(ACTIVE_JOB_STATUSES);

// A real, committed JOB — the deal is closed (paid) and it's somewhere in the
// fulfillment chain, EXCLUDING completed (handled separately for the repeat-customer
// ladder) and the unpaid pending_payment stage. Drives the engagement "is a Job"
// test and the customer lifecycle. Includes the post-return billing stage
// (awaiting_final_payment) and the legacy picked_up so those still read as jobs.
const CONFIRMED_JOB_STATUSES = Object.freeze([
  JOB_STATUS.BOOKED,
  JOB_STATUS.SCHEDULED,
  JOB_STATUS.DELIVERED,
  JOB_STATUS.ACTIVE_RENTAL,
  JOB_STATUS.PICKED_UP,
  JOB_STATUS.AWAITING_FINAL_PAYMENT,
]);
const CONFIRMED_JOB_STATUS_SET = new Set(CONFIRMED_JOB_STATUSES);

// Operational = the owner has committed to the job and it's in flight, from the
// moment booking is initiated (pending_payment) through the final-payment stage,
// EXCLUDING completed (terminal) — the client's isOperational gate. Resolves
// inconsistency #1: completed is NOT operational.
const OPERATIONAL_JOB_STATUSES = new Set([JOB_STATUS.PENDING_PAYMENT, ...CONFIRMED_JOB_STATUSES]);

// Confirmed + PAID but not yet delivered — the "delivering soon / upcoming pipeline"
// pair. (Legacy scheduled kept alongside booked.)
const UPCOMING_JOB_STATUSES = Object.freeze([JOB_STATUS.BOOKED, JOB_STATUS.SCHEDULED]);
const UPCOMING_JOB_STATUS_SET = new Set(UPCOMING_JOB_STATUSES);

// Non-actionable terminal states — the client's isActive gate. Standardized
// (inconsistency #2): { completed, lost, spam } everywhere.
const TERMINAL_JOB_STATUSES = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.LOST, JOB_STATUS.SPAM]);

// Closed-lost / dead job_status values, EXCLUDING completed. Also applied to the
// legacy leads.status column (lost/spam exist there with the same meaning).
const CLOSED_LOST_STATUSES = new Set([JOB_STATUS.LOST, JOB_STATUS.SPAM]);

// Map a RETIRED mid-state to its nearest active-chain equivalent for READ-time
// display + lifecycle logic. Non-destructive — the stored row is never rewritten;
// callers that care about the rationalized chain (labels, the lifecycle engine)
// route the stored value through this. Active-chain and terminal values pass through.
//   scheduled  → booked                  (confirmed, awaiting delivery)
//   delivered  → active_rental           (a unit is out)
//   picked_up  → awaiting_final_payment  (the unit is back; billing/closeout)
const LEGACY_STATE_MAP = Object.freeze({
  [JOB_STATUS.SCHEDULED]: JOB_STATUS.BOOKED,
  [JOB_STATUS.DELIVERED]: JOB_STATUS.ACTIVE_RENTAL,
  [JOB_STATUS.PICKED_UP]: JOB_STATUS.AWAITING_FINAL_PAYMENT,
});
function mapLegacyJobStatus(jobStatus) {
  return LEGACY_STATE_MAP[jobStatus] || jobStatus || null;
}

// ── Legacy leads.status vocabulary (parallel column, being phased out) ─────────
// job_status is the source of truth for the Phase-2 UI; a handful of readers still
// consult the older leads.status column as a fallback when job_status is null.
const LEGACY_STATUS = Object.freeze({
  NEW: 'new',
  NEEDS_FOLLOW_UP: 'needs_follow_up',
  WAITING_ON_CUSTOMER: 'waiting_on_customer',
  BOOKED: 'booked',
  LOST: 'lost',
  SPAM: 'spam',
  CONTACTED: 'contacted',
  QUOTE_SENT: 'quote_sent',
});

// Legacy status values meaning "not an active lead" — the fallback terminal set used
// when a lead has no job_status yet. (On the legacy column, 'booked' meant "deal
// closed / not an open lead"; kept only for that column's null-job_status fallback.)
const LEGACY_TERMINAL_STATUSES = new Set([
  LEGACY_STATUS.BOOKED,
  LEGACY_STATUS.LOST,
  LEGACY_STATUS.SPAM,
]);

// ── Engagement status (derived read-time in customerService) ───────────────────
// The reduced lifecycle one engagement (a single ongoing piece of business) can be
// in, folded from its calls' job_status/payment. inquiry → booked → completed, or
// a manually-closed inquiry → lost.
const ENGAGEMENT_STATUS = Object.freeze({
  INQUIRY: 'inquiry',
  BOOKED: 'booked',
  COMPLETED: 'completed',
  LOST: 'lost',
});

module.exports = {
  JOB_STATUS,
  PAYMENT_STATUS,
  ACTIVE_JOB_STATUSES,
  ACTIVE_JOB_STATUS_SET,
  CONFIRMED_JOB_STATUSES,
  CONFIRMED_JOB_STATUS_SET,
  OPERATIONAL_JOB_STATUSES,
  UPCOMING_JOB_STATUSES,
  UPCOMING_JOB_STATUS_SET,
  TERMINAL_JOB_STATUSES,
  CLOSED_LOST_STATUSES,
  mapLegacyJobStatus,
  LEGACY_STATUS,
  LEGACY_TERMINAL_STATUSES,
  ENGAGEMENT_STATUS,
};
