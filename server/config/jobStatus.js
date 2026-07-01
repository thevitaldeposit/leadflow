// ── Job status: the single source of truth (SERVER mirror) ─────────────────────
// Canonical definition of the leads.job_status vocabulary and every named status
// GROUP the server tests membership against. This is a hand-kept MIRROR of the
// client's definitions in client/src/utils/verticalConfig.js — the two module
// systems (CommonJS here, ES modules there) can't share one file, so these MUST be
// kept byte-for-byte identical in membership. Change one → change the other.
//
// PURE-REFACTOR NOTE: the memberships below are preserved EXACTLY as they were when
// these Sets/arrays were scattered and duplicated across the codebase — including
// the two known inconsistencies flagged for the upcoming job-lifecycle work. Do NOT
// "fix" a membership here without a deliberate behavior-change review.
//
// KNOWN INCONSISTENCIES (intentionally preserved — resolve in the lifecycle prompt):
//   • "Operational" means different things by side. The client's
//     OPERATIONAL_JOB_STATUSES INCLUDES 'completed'; the server's active-job set
//     (ACTIVE_JOB_STATUSES / ACTIVE_JOB_STATUS_SET) EXCLUDES it — 'completed' is
//     handled separately for the repeat-customer ladder, inventory, and calendar.
//   • "Terminal" means different things. TERMINAL_JOB_STATUSES = {completed, lost,
//     spam}; CLOSED_LOST_STATUSES = {lost, spam} (no 'completed'); and the legacy
//     fallback LEGACY_TERMINAL_STATUSES = {booked, lost, spam} runs over the OLD
//     leads.status vocabulary, where 'booked' meant "deal closed / not an open lead".

// The 10-value job_status lifecycle vocabulary.
const JOB_STATUS = Object.freeze({
  INQUIRY: 'inquiry',
  OPPORTUNITY: 'opportunity',
  BOOKED: 'booked',
  SCHEDULED: 'scheduled',
  DELIVERED: 'delivered',
  ACTIVE_RENTAL: 'active_rental',
  PICKED_UP: 'picked_up',
  COMPLETED: 'completed',
  LOST: 'lost',
  SPAM: 'spam',
});

// A confirmed job occupying the calendar / inventory, EXCLUDING completed. The array
// form is needed for SQL `IN (…)` placeholder generation + params; the Set form is
// for O(1) `.has()` membership. Previously duplicated (identical membership) as:
//   customerService.OPERATIONAL_STATUSES, leads.OPERATIONAL_BOOKED_STATUSES,
//   HomeServicesDashboard.PENDING_STATUSES, inventoryService.ACTIVE_JOB_STATUSES,
//   and the inline schedule.js `job_status IN (...)` literal.
const ACTIVE_JOB_STATUSES = Object.freeze([
  JOB_STATUS.BOOKED,
  JOB_STATUS.SCHEDULED,
  JOB_STATUS.DELIVERED,
  JOB_STATUS.ACTIVE_RENTAL,
  JOB_STATUS.PICKED_UP,
]);
const ACTIVE_JOB_STATUS_SET = new Set(ACTIVE_JOB_STATUSES);

// Operational INCLUDING completed — the client's isOperational / isOpportunity gate.
// (No server site uses this today; exported for vocabulary parity with the client.)
const OPERATIONAL_JOB_STATUSES = new Set([...ACTIVE_JOB_STATUSES, JOB_STATUS.COMPLETED]);

// Confirmed but not yet delivered — the "delivering soon / upcoming pipeline" pair.
// Previously duplicated as inline {booked, scheduled} tests in morningBrief and the
// dashboard.
const UPCOMING_JOB_STATUSES = Object.freeze([JOB_STATUS.BOOKED, JOB_STATUS.SCHEDULED]);
const UPCOMING_JOB_STATUS_SET = new Set(UPCOMING_JOB_STATUSES);

// Non-actionable terminal states INCLUDING completed — the client's isActive gate.
const TERMINAL_JOB_STATUSES = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.LOST, JOB_STATUS.SPAM]);

// Closed-lost / dead job_status values, EXCLUDING completed. Previously
// customerService.TERMINAL_STATUSES; also applied to the legacy leads.status column
// (lost/spam exist there with the same meaning).
const CLOSED_LOST_STATUSES = new Set([JOB_STATUS.LOST, JOB_STATUS.SPAM]);

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
// when a lead has no job_status yet. Previously verticalConfig's inline
// new Set(['booked','lost','spam']) and morningPriorities.TERMINAL_STATUSES.
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
  ACTIVE_JOB_STATUSES,
  ACTIVE_JOB_STATUS_SET,
  OPERATIONAL_JOB_STATUSES,
  UPCOMING_JOB_STATUSES,
  UPCOMING_JOB_STATUS_SET,
  TERMINAL_JOB_STATUSES,
  CLOSED_LOST_STATUSES,
  LEGACY_STATUS,
  LEGACY_TERMINAL_STATUSES,
  ENGAGEMENT_STATUS,
};
