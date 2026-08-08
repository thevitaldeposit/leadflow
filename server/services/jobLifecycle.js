const db = require('../db/database');
const { JOB_STATUS, PAYMENT_STATUS, mapLegacyJobStatus } = require('../config/jobStatus');
const { logActivity } = require('./activityLog');
const { getSetting } = require('./settingsService');
const { emitToBusiness } = require('../socket');

// ── Job lifecycle engine ───────────────────────────────────────────────────────
// The single owner of forward lifecycle transitions and the PAYMENT axis:
//   inquiry → pending_payment → booked → active_rental → awaiting_final_payment → completed
// Forward progress auto-advances (no confirmation). Any change to an ALREADY-SET
// value (cancel, reschedule, date change) is confirm-first and lives elsewhere (the
// Action Queue / reschedule-approval flow) — this module never does those.
//
// Fence: this NEVER touches the call/transcription/extraction pipeline, the
// booking-signal computation, date-extraction math, recording, or Twilio VOICE. It
// consumes stored fields (job_status, invoices, delivery_date, units_out) and writes
// only job_status / payment_status / units_out / paid_at / vertical_data.dumpTickets.
//
// Reservation + scheduling are IMPLICIT in job_status membership: a job occupies the
// pool + calendar exactly while job_status ∈ ACTIVE_JOB_STATUSES (booked, active_rental,
// + legacy scheduled/delivered). So advancing to 'booked' reserves + schedules, and
// pending_payment (not in that set) reserves nothing — no explicit reserve write needed.

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

// ── Weight units: entered in POUNDS, stored in TONS ────────────────────────────
// The owner types pounds (what a scale prints); TONS stay the stored unit so every
// pricing_config weight allowance and every previously recorded ticket keeps its
// meaning. tonsFromLbs is the ONE place that divides by 2000 — the routes call it and
// nothing downstream (computeOverage, the invoice line, the pool) ever sees pounds.
// Pounds are rounded to a whole pound first, which makes lbs → tons → lbs exact
// (any integer / 2000 has at most 4 decimals).
const LBS_PER_TON = 2000;
function tonsFromLbs(lbs) {
  const n = Number(lbs);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((Math.round(n) / LBS_PER_TON) * 10000) / 10000;
}
function lbsFromTons(tons) {
  const n = Number(tons);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * LBS_PER_TON);
}
function nowIso() { return new Date().toISOString(); }
function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseVd(lead) {
  try { return lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { return {}; }
}
// Whole-day difference between two YYYY-MM-DD dates, both anchored at UTC midnight —
// the SAME convention rentalDaysFromLead uses for the base rental (so a swap and the
// base rental count days identically). Returns null on unparseable input. Anchoring
// both endpoints the same way is what fixes the old local-vs-UTC off-by-one.
function daysBetweenISO(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const a = new Date(`${String(startISO).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(endISO).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Today's calendar date (YYYY-MM-DD) in the BUSINESS's timezone — the correct default
// for a swap's delivery date. Server-local (localTodayStr) can be a day ahead of the
// business (e.g. a UTC host after the business's local midnight), which is exactly what
// mispriced a swap by a day; resolve the business day instead.
function businessLocalToday(businessId) {
  try {
    const { getTimezone } = require('./settingsService');
    const { localDateInTimeZone } = require('./inventoryService');
    return localDateInTimeZone(new Date(), getTimezone(businessId));
  } catch { return localTodayStr(); }
}

// Days a swap replacement stays out: its delivery date (the swap-out day) → the job's
// pickup date, min 1 — the days REMAINING in the original rental (a swap never extends
// it, so the pickup date is the fixed endpoint). Uses the base-rental day convention via
// daysBetweenISO. The caller may pass an explicit swap delivery date (owner-set on the
// review screen); when omitted, defaults to server-local today (the dump-ticket path).
// Falls back to the configured rental duration when there's no pickup date.
function swapWindowDays(lead, swapDeliveryDate = null) {
  const pd = lead && lead.pickup_date;
  const start = swapDeliveryDate || localTodayStr();
  if (pd) {
    const days = daysBetweenISO(start, pd);
    if (days != null && days >= 1) return days;
  }
  try { return require('./pricingService').rentalDaysFromLead(lead); } catch { return 1; }
}
function loadLead(businessId, leadOrId) {
  if (leadOrId && typeof leadOrId === 'object') return leadOrId;
  return db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(leadOrId, businessId);
}
function bumpCustomer(lead) {
  if (!lead || !lead.customer_id) return;
  try { require('./customerService').recomputeCustomerStatus(lead.customer_id); } catch { /* non-fatal */ }
}
function emit(lead) {
  try { emitToBusiness(lead.business_id, 'lead_updated', lead); } catch { /* non-fatal */ }
}
// Write job_status onto the row + in-memory lead. Never used to move BACKWARD — all
// callers here only advance forward or set a gated terminal.
function setJobStatus(lead, status, at = nowIso()) {
  db.prepare('UPDATE leads SET job_status = ?, updated_at = ? WHERE id = ?').run(status, at, lead.id);
  lead.job_status = status;
  lead.updated_at = at;
}

// ── PAYMENT axis: the "all invoices settled" rollup ────────────────────────────
// A job's invoices = those linked to any of the job's lead ids, PLUS customer-level
// invoices (lead_id null) for the customer. Only real BILLS count: draft (not yet a
// bill) and void (cancelled) are excluded. Settled = status 'paid' OR paid_at set.
//   all settled → 'paid' · some → 'partial' · none → 'unpaid'
//   no real bills at all → fall back to the lead's own paid_at (manual/legacy).
// This REPLACES the old "any paid invoice ⇒ paid" behavior, which was wrong for a
// multi-invoice job (e.g. a booking invoice + a later weight-overage invoice).
function paymentStatusFromInvoices(businessId, { leadIds = [], customerId = null, leadPaidAt = null } = {}) {
  const ids = leadIds.filter((v) => v != null);
  const clauses = [];
  const params = [businessId];
  if (ids.length) { clauses.push(`lead_id IN (${ids.map(() => '?').join(', ')})`); params.push(...ids); }
  if (customerId) { clauses.push('(lead_id IS NULL AND customer_id = ?)'); params.push(customerId); }
  if (!clauses.length) return leadPaidAt ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;

  let rows = [];
  try {
    rows = db.prepare(`
      SELECT status, paid_at FROM invoices
      WHERE business_id = ? AND status IN ('sent','signed','paid') AND (${clauses.join(' OR ')})
    `).all(...params);
  } catch { rows = []; /* invoices table absent / not migrated */ }

  if (!rows.length) return leadPaidAt ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;
  const settled = rows.filter((r) => r.status === 'paid' || r.paid_at != null).length;
  if (settled === 0) return PAYMENT_STATUS.UNPAID;
  if (settled === rows.length) return PAYMENT_STATUS.PAID;
  return PAYMENT_STATUS.PARTIAL;
}

// Compute + persist a job lead's payment_status from its invoices (+ its own paid_at).
// Stamps paid_at when it becomes fully paid so engagement completion and the /pay page
// agree. Only ever SETS paid_at (refunds are reflected via the invoice's own state).
function recomputeLeadPaymentStatus(businessId, leadOrId) {
  const lead = loadLead(businessId, leadOrId);
  if (!lead) return null;
  const status = paymentStatusFromInvoices(businessId, {
    leadIds: [lead.id],
    customerId: lead.customer_id || null,
    leadPaidAt: lead.paid_at || null,
  });
  const at = nowIso();
  if (status === PAYMENT_STATUS.PAID && !lead.paid_at) {
    db.prepare('UPDATE leads SET payment_status = ?, paid_at = ?, updated_at = ? WHERE id = ?')
      .run(status, at, at, lead.id);
    lead.payment_status = status; lead.paid_at = at; lead.updated_at = at;
  } else if (lead.payment_status !== status) {
    db.prepare('UPDATE leads SET payment_status = ?, updated_at = ? WHERE id = ?').run(status, at, lead.id);
    lead.payment_status = status; lead.updated_at = at;
  }
  return status;
}

// ── On payment: advance pending_payment → booked, or awaiting_final_payment → completed ─
// Call after any invoice for the job settles (manual mark-paid, Stripe, or a lead
// paid_at write). Recomputes payment_status first, then advances if the gate is met.
// Completion is GATED: awaiting_final_payment → completed only when fully paid AND no
// unit is still out.
// ── Double-pay race: book it anyway, but flag the conflict ─────────────────────
// An unpaid payment link holds NOTHING (pending_payment is not an active status), so
// two links for the last unit of a size can both be paid. Booking is gated at every
// owner-initiated path, but this one can't be: the money is already collected.
// So we always let the payment book the job — never bounce a customer's payment —
// and, when the fleet can't actually cover the window, raise the SAME inventory-
// conflict signal auto-book uses so the owner sees it at the top of the Action Queue
// and resolves the double-book (reschedule, sub a size, or rent one in).
// Best-effort: a failure here must never undo a completed payment's booking.
function flagPaymentInventoryConflict(businessId, lead) {
  try {
    if (!lead.delivery_date || !lead.pickup_date) return false;
    const inv = require('./inventoryService');
    const size = parseVd(lead).dumpsterSize || null;
    // Exclude this lead: it was just advanced to 'booked', so it now counts itself.
    const cap = inv.assertCapacity(businessId, {
      size, deliveryDate: lead.delivery_date, pickupDate: lead.pickup_date, excludeLeadId: lead.id,
    });
    if (cap.ok) return false;

    const sizeLabel = size || 'requested size';
    const note = `INVENTORY CONFLICT: payment booked a ${sizeLabel} for ${lead.delivery_date} to ${lead.pickup_date}, but no unit is free for those dates. The payment was kept — resolve the double-book with the customer.`;
    const recommendation = `INVENTORY CONFLICT — This paid booking exceeds your ${sizeLabel} fleet for ${lead.delivery_date}. Call the customer to reschedule, or cover it with another unit.`;
    const flagged = inv.flagInventoryConflict(lead, { note, recommendation });
    if (flagged) logActivity(lead.id, 'note_added', note);
    return flagged;
  } catch (e) {
    console.error('[jobLifecycle] capacity re-check failed:', e.message);
    return false;
  }
}

function advanceOnPayment(businessId, leadOrId) {
  const lead = loadLead(businessId, leadOrId);
  if (!lead) return null;
  const pay = recomputeLeadPaymentStatus(businessId, lead);
  const js = mapLegacyJobStatus(lead.job_status);

  if (js === JOB_STATUS.PENDING_PAYMENT && pay === PAYMENT_STATUS.PAID) {
    setJobStatus(lead, JOB_STATUS.BOOKED);
    logActivity(lead.id, 'status_change', 'Payment received — job booked; dumpster reserved and scheduled');
    flagPaymentInventoryConflict(businessId, lead);
    bumpCustomer(lead); emit(lead);
    return { lead, advancedTo: JOB_STATUS.BOOKED, paymentStatus: pay };
  }
  if (js === JOB_STATUS.AWAITING_FINAL_PAYMENT && pay === PAYMENT_STATUS.PAID && (lead.units_out || 0) <= 0) {
    setJobStatus(lead, JOB_STATUS.COMPLETED);
    logActivity(lead.id, 'status_change', 'Final balance paid — job completed');
    bumpCustomer(lead); emit(lead);
    return { lead, advancedTo: JOB_STATUS.COMPLETED, paymentStatus: pay };
  }
  return { lead, advancedTo: null, paymentStatus: pay };
}

// ── Time-driven forward advance: booked → active_rental when the delivery date arrives ─
// Run opportunistically before customer/dashboard reads (reconcile-on-read style) so
// it advances promptly without a cron; forward-only + idempotent. Initializes
// units_out to 1 (a job knows how many dumpsters are out) — no booking-time unit-count
// field exists, so 1 is the default; swaps keep a unit out until the final ticket.
function advanceDueDeliveries(businessId) {
  const today = localTodayStr();
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT * FROM leads
      WHERE business_id = ? AND vertical = 'home_services'
        AND (discarded = 0 OR discarded IS NULL)
        AND job_status IN ('booked','scheduled')
        AND delivery_date IS NOT NULL AND delivery_date <= ?
    `).all(businessId, today);
  } catch { return 0; }
  let advanced = 0;
  const at = nowIso();
  for (const lead of rows) {
    const unitsOut = lead.units_out == null ? 1 : lead.units_out;
    db.prepare("UPDATE leads SET job_status = 'active_rental', units_out = ?, updated_at = ? WHERE id = ?")
      .run(unitsOut, at, lead.id);
    logActivity(lead.id, 'status_change', 'Delivery date reached — rental now active');
    bumpCustomer(lead);
    advanced++;
  }
  return advanced;
}

// ── Weight overage config — now READ from the size's pricing_config ─────────────
// The allowance (weight_allowance_tons) + rate ($/ton over) live on the size's price
// row (Prompt A → Prompt B). We read them via the pricing resolver for the ticket's
// size, falling back to the legacy per-business settings only when the size has no
// configured value (backward-compatible). If neither yields a number we record the
// weight and flag that the rate/allowance is needed rather than inventing one.
function getOverageConfig(businessId, size = null) {
  let allowance = null, rate = null;
  if (size) {
    try {
      const cfg = require('./pricingService').getSizeWeightConfig(businessId, size);
      if (cfg.allowanceTons != null && cfg.allowanceTons >= 0) allowance = cfg.allowanceTons;
      if (cfg.ratePerTon != null && cfg.ratePerTon > 0) rate = cfg.ratePerTon;
    } catch { /* pricing unavailable — fall through to legacy settings */ }
  }
  if (allowance == null) {
    const inc = Number(getSetting('overageIncludedTons', businessId));
    if (Number.isFinite(inc) && inc >= 0) allowance = inc;
  }
  if (rate == null) {
    const r = Number(getSetting('overageRatePerTon', businessId));
    if (Number.isFinite(r) && r > 0) rate = r;
  }
  return { includedTons: allowance, ratePerTon: rate };
}

// ── Does a SWAP REPLACEMENT's haul get its own weight allowance? (2d) ──────────
// Business-level, because it's a billing policy rather than a property of a size:
//   'full' (DEFAULT) — the replacement is a fresh rental and carries the size's normal
//                      included tons. This is exactly what every job did before 2d, so
//                      an unset business bills identically to before.
//   'none'           — the replacement haul carries NO included tons (operators whose
//                      swap fee already covers the dump; the customer's allowance was
//                      spent on the first can).
// Only ever consulted for a haul already identified as a swap replacement — the job's
// ORIGINAL unit is never affected.
const SWAP_ALLOWANCE_KEY = 'swapWeightAllowance';
function getSwapAllowanceMode(businessId) {
  const v = getSetting(SWAP_ALLOWANCE_KEY, businessId);
  return String(v == null ? '' : v).trim().toLowerCase() === 'none' ? 'none' : 'full';
}

// Compute overage for a recorded weight against the size's configured allowance/rate.
// Returns a descriptor; `needsRate`/`needsAllowance` flag missing config so the UI can
// surface "set overage pricing" instead of a wrong dollar amount. `size` selects the
// price row the allowance/rate come from.
//
// `replacementHaul` says this weight came off a SWAP REPLACEMENT (decided by the caller
// — see isReplacementHaul). It's the ONE place the per-business swap-allowance toggle is
// applied: on 'none' the included tons for this haul become 0 (and no allowance config is
// "needed" — zero is the configured answer). getOverageConfig / getSizeWeightConfig stay
// pure per-size resolvers.
function computeOverage(businessId, weightTons, { size = null, replacementHaul = false } = {}) {
  const w = Number(weightTons);
  if (!Number.isFinite(w) || w < 0) return { weightTons: null, overTons: 0, amount: null, needsRate: false, needsAllowance: false };
  const cfg = getOverageConfig(businessId, size);
  const ratePerTon = cfg.ratePerTon;
  const swapAllowance = replacementHaul ? getSwapAllowanceMode(businessId) : 'full';
  const includedTons = (replacementHaul && swapAllowance === 'none') ? 0 : cfg.includedTons;
  if (includedTons == null) return { weightTons: w, includedTons: null, overTons: 0, amount: null, needsRate: false, needsAllowance: true, replacementHaul };
  const overTons = round2(Math.max(0, w - includedTons));
  if (overTons <= 0) return { weightTons: w, includedTons, overTons: 0, amount: 0, needsRate: false, needsAllowance: false, replacementHaul, swapAllowance };
  if (ratePerTon == null) return { weightTons: w, includedTons, overTons, amount: null, needsRate: true, needsAllowance: false, replacementHaul, swapAllowance };
  return { weightTons: w, includedTons, overTons, ratePerTon, amount: round2(overTons * ratePerTon), needsRate: false, needsAllowance: false, replacementHaul, swapAllowance };
}

// Whether a swap replacement has ALREADY been billed for this job on a REAL (non-draft)
// invoice — i.e. a call-driven swap draft the owner reviewed + sent, or any prior sent/
// paid swap line. Now that swaps are billed pay-in-advance FROM THE CALL, the dump-ticket
// path must NOT add a second swap line when one is already on a live bill (double-billing).
// A still-DRAFT call swap does not count (not yet a bill) — only sent/signed/paid do, so an
// un-reviewed draft never blocks the ticket from billing the swap the normal way.
function swapAlreadyBilled(businessId, leadId) {
  if (!leadId) return false;
  try {
    return !!db.prepare(`
      SELECT 1 FROM invoices i
      JOIN invoice_line_items li ON li.invoice_id = i.id
      WHERE i.business_id = ? AND i.lead_id = ?
        AND i.status IN ('sent','signed','paid')
        AND li.line_type = 'service' AND li.description LIKE 'Swap replacement%'
      LIMIT 1
    `).get(businessId, leadId);
  } catch { return false; /* invoices tables absent / not migrated */ }
}

// ── Is THIS haul a swap replacement's? (2d) ───────────────────────────────────
// Two conditions, both required:
//   1. the job actually had a swap — a paid call-driven one (vd.swapOutsApplied), a
//      manual/consumed one recorded on an earlier ticket (t.swap / t.swapOut), or a
//      live swap line already billed for the job;
//   2. the can this weight came off is NOT the FIRST unit the job ever held (earliest
//      drop). The original unit's haul is always the original rental's.
// Both together are what separates a genuine swap replacement from a DELIVERY-TIME
// substitution (a different can dropped before anything was swapped — condition 1 fails)
// and from the swap-OUT haul itself (the original can coming back — condition 2 fails).
// No assignment (legacy jobs, iOS, pre-2b) → false, so those bill exactly as before.
function isReplacementHaul(businessId, lead, vd, assignment) {
  if (!assignment) return false;
  const tickets = Array.isArray(vd.dumpTickets) ? vd.dumpTickets : [];
  const hadSwap = (Array.isArray(vd.swapOutsApplied) && vd.swapOutsApplied.length > 0)
    || tickets.some((t) => t && (t.swap || t.swapOut))
    || swapAlreadyBilled(businessId, lead.id);
  if (!hadSwap) return false;
  try {
    // listAssignments is newest-drop first, so the job's first unit is the last row.
    const all = require('./assignmentService').listAssignments(businessId, lead.id);
    const first = all.length ? all[all.length - 1] : null;
    return !!(first && Number(first.id) !== Number(assignment.id));
  } catch { return false; /* assignments unavailable — bill as an ordinary haul */ }
}

// Email an invoice's public link to the customer, fire-and-forget. The system-driven
// bills route through here (the auto-book payment link, the weight/overage + swap
// bill) — nobody is sitting in front of a screen to be told it failed, so a bill we
// COULDN'T deliver is written to the job's timeline instead of only the server log.
// Otherwise an invoice with no address on file reads as "created" and looks sent.
// Owner-initiated sends never reach here: those are blocked up front by the
// email-required guards on the booking + invoice-send routes.
function emailInvoiceLink(businessId, inv, leadId) {
  require('./emailService').sendInvoiceLinkEmail({ ...inv, business_id: businessId })
    .then((r) => {
      if (r && r.sent) return;
      const reason = (r && r.reason) || 'unknown';
      console.log(`[jobLifecycle] invoice email not sent (inv ${inv.id}): ${reason}`);
      if (!leadId) return;
      const why = reason === 'no_email'
        ? 'no email address on file'
        : reason === 'no_email_provider' ? 'email is not configured' : reason;
      logActivity(leadId, 'note_added', `Invoice ${inv.invoice_number} could NOT be emailed — ${why}. Send it from the invoice once an address is added.`);
    })
    .catch((e) => console.error('[jobLifecycle] invoice email error:', e.message));
}

// Bill a ticket's line items as ONE 'sent' invoice for the job: resolve a customer
// (a booked job is linked by reconcile-on-read, but resolve one defensively so a bill
// never silently vanishes), create, mark sent, log, and email it. Shared by the
// record path and the weight-correction path so a corrected weight bills exactly the
// way the original entry would have. Returns the invoice, or null when nothing could
// be billed.
function createTicketInvoice(businessId, lead, lineItems, bits = '') {
  if (!lineItems.length) return null;
  let customerId = lead.customer_id;
  if (!customerId) {
    try { customerId = require('./customerService').findOrCreateCustomerForLead(businessId, lead); } catch { customerId = null; }
  }
  if (!customerId) return null;
  try {
    const invoiceService = require('./invoiceService');
    const inv = invoiceService.createInvoice(businessId, {
      customer_id: customerId,
      lead_id: lead.id,
      line_items: lineItems,
    });
    // 'sent' so it counts as an outstanding bill in the settled rollup (blocks completion).
    invoiceService.markSent(businessId, inv.id);
    logActivity(lead.id, 'invoice_created', `Invoice ${inv.invoice_number} created${bits ? ` (${bits})` : ''}`);
    // Email the bill to the customer (same Resend path as the payment link).
    emailInvoiceLink(businessId, inv, lead.id);
    return inv;
  } catch (e) {
    console.error('[jobLifecycle] ticket invoice failed:', e.message);
    return null;
  }
}

// A stored (tons) weight written back in the unit the owner actually entered, so the
// timeline reads in pounds: "7,000 lbs (3.5 tons)".
function describeWeight(tons) {
  if (tons == null || !Number.isFinite(Number(tons))) return 'weight not entered';
  return `${lbsFromTons(tons).toLocaleString('en-US')} lbs (${Number(tons)} tons)`;
}

// The overage line for a recorded weight, or null when there's nothing chargeable
// (under the allowance, or no configured rate). One builder so the record path and
// the correction path always produce an identically-shaped line.
function overageLineItem(overage, size) {
  if (!overage || !(overage.overTons > 0) || overage.amount == null || !(overage.amount > 0)) return null;
  return {
    description: `Weight overage — ${overage.overTons} ton(s) over ${overage.includedTons} included${size ? ` (${size})` : ''}`,
    quantity: overage.overTons,
    unit: 'ton',
    unit_rate: overage.ratePerTon,
    line_type: 'overage',
  };
}

// Names the swap-allowance policy in the timeline when it actually bit — it's the reason
// the WHOLE weight billed rather than just the tons over the usual allowance.
function noAllowanceNote(overage) {
  return overage && overage.replacementHaul && overage.swapAllowance === 'none'
    ? ' · swap replacement — no weight allowance'
    : '';
}

// ── Manual dump-ticket / weight entry (the trigger; OCR reuses this SAME path) ──
// The owner enters the weight for a returned unit. This:
//   (a) records the ticket + computes any overage (generating a 'sent' overage invoice
//       when a rate is configured, else flagging that the rate is needed), and
//   (b) advances the lifecycle — SWAP-SAFE: it only advances past active_rental when NO
//       dumpster is still out (units_out reaches 0). A swap-out (a replacement dropped)
//       keeps a unit out, so the first of two tickets never completes the job.
// The future photo-OCR feature calls this with the same shape (it just auto-fills what
// the owner types now) — pass source:'ocr'.
//
// ── Phase 2c: the weight belongs to a UNIT, and the unit names the job ─────────
// Pass `assignmentId` (the can that came back) and THAT assignment's job is what gets
// billed and what advances — not whichever lead the owner happened to have open. Three
// things follow from anchoring on the assignment, and nothing else changes:
//   • the overage prices against the size of the unit ON THE GROUND (read off the
//     asset), so a swap to a different size bills the right allowance/rate;
//   • units_out, the swap markers and the completion gate run on the assignment's
//     job — two concurrent jobs now settle independently. HOW completion is decided
//     is untouched: still units_out reaching 0, still the same marker logic;
//   • the assignment is stamped weighed_at and its unit returns to 'available'.
// No assignmentId (a job delivered before unit capture existed, an older client, the
// iOS app) → the by-lead path below is byte-identical to before.
// `photoPath` and `dumpSite` are RECORD-KEEPING ONLY (guided pickup flow): the
// photographed scale ticket kept as evidence for a disputed overage, and which
// landfill the load went to. Neither is read by any pricing, allowance, units_out,
// swap or completion decision — they are written onto the ticket and nowhere else.
function recordDumpTicket(businessId, leadOrId, { weightTons = null, swap = false, unitsRemaining, note = null, source = 'manual', assignmentId = null, photoPath = null, dumpSite = null } = {}) {
  let assignment = null;
  if (assignmentId !== null && assignmentId !== undefined && assignmentId !== '') {
    assignment = require('./assignmentService').getAssignment(businessId, assignmentId);
    if (!assignment) return { error: 'assignment_not_found' };
    // One haul, one ticket. A second weight for the same unit would decrement units_out
    // twice; corrections go through updateDumpTicketWeight instead.
    if (assignment.weighed_at) return { error: 'already_weighed', unitLabel: assignment.label };
    if (!assignment.lead_id) return { error: 'assignment_has_no_job', unitLabel: assignment.label };
  }

  const lead = loadLead(businessId, assignment ? assignment.lead_id : leadOrId);
  if (!lead) return { error: 'not_found' };
  const at = nowIso();
  const vd = parseVd(lead);
  // The job's booked size — still what a swap REPLACEMENT's rental is priced on
  // (that charge is about the can going out, not the one coming back).
  const jobSize = vd.dumpsterSize || null;
  // The size the overage is priced against: the unit that actually came back. Falls
  // back to the job's size when no unit was captured (legacy jobs), which is exactly
  // what this used before.
  const size = (assignment && assignment.size) || jobSize;

  // Is this the haul of a SWAP REPLACEMENT (not the job's original can)? Decided here,
  // from the assignment already in hand, and stored on the ticket below so a later weight
  // correction reprices against the same allowance. Only matters when the business set
  // the swap allowance to 'none'; on the default ('full') it changes nothing.
  const replacementHaul = isReplacementHaul(businessId, lead, vd, assignment);

  // Overage is priced against THIS unit's size (allowance + $/ton from pricing_config),
  // with the swap-replacement allowance policy applied for a replacement haul.
  const overage = weightTons != null && weightTons !== ''
    ? computeOverage(businessId, weightTons, { size, replacementHaul })
    : null;

  // Swap-safe units-out accounting. Default: one dumpster comes back per ticket.
  // A PAID call-driven swap leaves an outstanding swap-out marker (vd.pendingSwapOuts, a
  // counter). The FIRST ordinary ticket after it is the swap-out haul — the original unit
  // pulled during the swap — so it keeps a unit out (the replacement) and consumes one
  // marker. The job then completes only when the replacement is finally picked up (the
  // next ticket).
  //
  // The MARKER IS AUTHORITATIVE: an outstanding swap-out is consumed by this haul whether
  // or not the owner also ticked the `swap` checkbox. The checkbox used to be checked
  // FIRST and short-circuited this branch, so ticking it on a paid swap (the natural thing
  // to do — a replacement really was dropped) left the marker armed and silently demanded
  // a phantom THIRD ticket before the job could complete. Checking the marker first makes
  // the box a no-op when it's redundant and keeps completion at two tickets.
  //
  // A checked box with NO pending marker is the genuine manual swap — no paid swap invoice
  // exists — and still holds the unit out and bills the replacement rental below, exactly
  // as before.
  const pendingSwapOuts = Math.max(0, Math.round(Number(vd.pendingSwapOuts) || 0));
  const before = lead.units_out == null ? 1 : lead.units_out;
  let after;
  let consumedSwapOut = false;
  // Whether this haul left a REPLACEMENT unit on site — i.e. the owner still owes us the
  // drop of the can that took its place (drives the client's "record the replacement" prompt).
  let heldForReplacement = false;
  if (unitsRemaining != null && Number.isFinite(Number(unitsRemaining))) {
    after = Math.max(0, Math.round(Number(unitsRemaining)));   // explicit owner/OCR override
  } else if (pendingSwapOuts > 0) {
    after = before;                                            // paid call-driven swap-out haul → replacement still out
    consumedSwapOut = true;
    heldForReplacement = true;
  } else if (swap) {
    after = before;                                            // manual swap checkbox → replacement dropped, a unit is still out
    heldForReplacement = true;
  } else {
    after = Math.max(0, before - 1);                           // final pickup for this unit
  }

  // ── Bill this ticket: overage on the returned unit + a swap replacement's rental ──
  // Both are priced from the size's pricing_config and land as line items on ONE
  // 'sent' invoice for the job (so they count as outstanding bills in the settled
  // rollup and block completion until paid). The invoice needs a customer; a booked
  // job is linked by reconcile-on-read, but resolve one defensively so a bill never
  // silently vanishes. A swapped unit is a NEW rental → its own weight allowance.
  const lineItems = [];
  const overLine = overageLineItem(overage, size);
  if (overLine) lineItems.push(overLine);
  // Swap replacement rental, priced over the swap window (today → pickup) per the
  // size's swap config (same_as_rate → normal resolver; custom → custom price; off → none).
  // SKIP billing it here when a call-driven swap invoice was already sent/paid for this job
  // (swaps are now billed pay-in-advance from the call) — otherwise the swap is double-billed.
  let swapCharge = null;
  const swapPreBilled = !!(swap && jobSize) && swapAlreadyBilled(businessId, lead.id);
  if (swap && jobSize && !swapPreBilled) {
    try {
      const pricingService = require('./pricingService');
      const customerRow = lead.customer_id
        ? db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(lead.customer_id, businessId)
        : null;
      const sw = pricingService.resolveSwapPrice(businessId, { size: jobSize, days: swapWindowDays(lead), customer: customerRow });
      if (sw && sw.mode !== 'off' && sw.amount != null && sw.amount > 0) {
        swapCharge = sw.amount;
        lineItems.push({
          description: `Swap replacement — ${jobSize} (${swapWindowDays(lead)} day${swapWindowDays(lead) === 1 ? '' : 's'})`,
          quantity: 1,
          unit: null,
          unit_rate: sw.amount,
          line_type: 'service',
        });
      }
    } catch (e) { console.error('[jobLifecycle] swap pricing failed:', e.message); }
  }

  const bits = [
    overage && overage.overTons > 0 && overage.amount ? `overage $${overage.amount}` : null,
    swapCharge ? `swap $${swapCharge}` : null,
  ].filter(Boolean).join(' + ');
  const ticketInvoice = createTicketInvoice(businessId, lead, lineItems, bits);
  const overageInvoiceId = ticketInvoice ? ticketInvoice.id : null;

  const ticket = {
    at,
    source,
    note: note || null,
    weightTons: overage ? overage.weightTons : null,
    includedTons: overage ? (overage.includedTons ?? null) : null,
    overageTons: overage ? overage.overTons : 0,
    overageAmount: overage ? overage.amount : null,
    overageNeedsRate: overage ? !!overage.needsRate : false,
    overageNeedsAllowance: overage ? !!overage.needsAllowance : false,
    swap: !!swap,
    swapCharge: swapCharge != null ? swapCharge : null,
    swapAlreadyBilled: swapPreBilled,
    swapOut: consumedSwapOut,   // this haul was the original unit pulled during a paid swap
    unitsOutAfter: after,
    invoiceId: overageInvoiceId,
    // Which physical can this weight came off, and the size its overage was priced
    // against — so a later correction re-prices against the SAME size (not the job's
    // current one, which a swap may since have changed) and the timeline names the unit.
    size,
    assignmentId: assignment ? assignment.id : null,
    assetId: assignment ? assignment.asset_id : null,
    unitLabel: assignment ? assignment.label : null,
    // Whether this weight was a swap REPLACEMENT's haul — pinned so a weight correction
    // re-prices against the same allowance basis instead of re-deriving it from a job
    // whose assignments/markers have since moved on.
    replacementHaul,
    // Evidence + logistics, not inputs: the photographed scale ticket behind this
    // weight (stored on the persistent volume) and the dump site the load went to.
    photoPath: photoPath ? String(photoPath) : null,
    dumpSite: dumpSite && dumpSite.name
      ? { id: dumpSite.id ?? null, name: String(dumpSite.name), address: dumpSite.address || null }
      : null,
  };
  vd.dumpTickets = Array.isArray(vd.dumpTickets) ? vd.dumpTickets : [];
  vd.dumpTickets.push(ticket);
  vd.overageNeedsRate = ticket.overageNeedsRate || ticket.overageNeedsAllowance || vd.overageNeedsRate || false;
  // Consume one outstanding swap-out marker: the replacement is still on site, so units_out
  // was left unchanged above; drop the counter so the NEXT ordinary ticket is the real
  // final pickup that completes the job.
  if (consumedSwapOut) vd.pendingSwapOuts = pendingSwapOuts - 1;

  db.prepare('UPDATE leads SET units_out = ?, vertical_data = ?, updated_at = ? WHERE id = ?')
    .run(after, JSON.stringify(vd), at, lead.id);
  lead.units_out = after; lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;

  // Close the unit out: weighed_at stamped, can back in the available pool, so it
  // leaves the yard queue and can't be weighed onto a second job. Non-fatal — the
  // ticket above is already the billing record of truth.
  if (assignment) {
    try { require('./assignmentService').markWeighed(businessId, assignment.id, at); }
    catch (e) { console.error('[jobLifecycle] markWeighed failed:', e.message); }
  }

  const wStr = describeWeight(overage ? overage.weightTons : null);
  const unitStr = assignment ? ` · Unit ${assignment.label}` : '';
  const oStr = overage && overage.overTons > 0
    ? (overage.amount != null ? ` · overage ${overage.overTons}t ($${overage.amount})` : ` · overage ${overage.overTons}t (rate not configured)`)
    : '';
  // The marker wins the description too — a box ticked on top of a paid swap is the same
  // haul, not a second one.
  const swapNote = consumedSwapOut
    ? ' · swap-out haul (paid swap) — replacement still on site'
    : (swap
      ? (swapPreBilled ? ' · swap-out, unit still on site (swap already billed from the call)' : ' · swap-out, unit still on site')
      : '');
  const siteStr = ticket.dumpSite ? ` · ${ticket.dumpSite.name}` : '';
  logActivity(lead.id, 'note_added', `Dump ticket recorded (${wStr})${unitStr}${siteStr}${swapNote}${oStr}${noAllowanceNote(overage)}`);

  // Advance only when the LAST unit is back (swap-safe). Completion is gated on payment.
  let advancedTo = null;
  if (after <= 0) {
    const pay = recomputeLeadPaymentStatus(businessId, lead);
    if (pay === PAYMENT_STATUS.PAID) {
      setJobStatus(lead, JOB_STATUS.COMPLETED, at);
      logActivity(lead.id, 'status_change', 'Last unit returned and fully paid — job completed');
      advancedTo = JOB_STATUS.COMPLETED;
    } else {
      setJobStatus(lead, JOB_STATUS.AWAITING_FINAL_PAYMENT, at);
      logActivity(lead.id, 'status_change', 'Last unit returned — awaiting final payment');
      advancedTo = JOB_STATUS.AWAITING_FINAL_PAYMENT;
    }
    bumpCustomer(lead);
  }
  emit(lead);
  // `swapOut` tells the caller this haul left a REPLACEMENT can on site, so the UI can ask
  // for that unit's drop right now (it's the only way the replacement becomes a real
  // assignment and can later be picked up / weighed like any other unit).
  return {
    lead,
    overage,
    advancedTo,
    unitsOut: after,
    overageInvoiceId,
    swapOut: heldForReplacement,
    pendingSwapOuts: Math.max(0, Math.round(Number(vd.pendingSwapOuts) || 0)),
  };
}

// ── Correct a recorded weight — the DUMP TICKET is the single source of truth ───
// The owner mistyped a weight (or the scale ticket read differently). This rewrites
// the ticket in place and then makes everything downstream agree with it:
//   • vd.dumpTickets[index] — the source of truth — gets the new weight + recomputed
//     overage, and remembers what it was corrected from.
//   • the ticket's overage INVOICE LINE is rewritten from the new weight (removed when
//     the corrected weight is under the allowance; the invoice is voided if that leaves
//     it with nothing to bill; a fresh bill is raised if the correction newly creates a
//     chargeable overage). Any OTHER line on that invoice — notably a swap replacement —
//     is preserved untouched.
//   • an append-only "weight corrected" activity entry records the change (the original
//     entry stays; we never mutate history).
// LOCKED: if that ticket's invoice is already signed or paid it is settled money /
// dispute evidence — the edit is refused ({ error: 'locked' }) so weight corrections are
// steered through the ticket rather than silently rewriting a paid bill.
//
// Deliberately does NOT touch units_out, the swap markers (pendingSwapOuts /
// swapOutsApplied) or the swap line: only the weight and the weight's overage change.
// The lifecycle can still advance FORWARD (advanceOnPayment is forward-only and gated)
// when dropping a bogus overage leaves the job fully paid.
function updateDumpTicketWeight(businessId, leadOrId, { index, weightTons = null, source = 'manual' } = {}) {
  const lead = loadLead(businessId, leadOrId);
  if (!lead) return { error: 'not_found' };
  const vd = parseVd(lead);
  const tickets = Array.isArray(vd.dumpTickets) ? vd.dumpTickets : [];
  const i = Math.round(Number(index));
  if (!Number.isInteger(i) || i < 0 || i >= tickets.length) return { error: 'ticket_not_found' };
  const ticket = tickets[i];
  // Re-price against the size THIS ticket was recorded for — the unit that came back
  // (2c), not the job's current size, which a later swap may have changed. Tickets
  // written before 2c carry no size and fall back to the job's, exactly as before.
  const size = ticket.size || vd.dumpsterSize || null;
  const invoiceService = require('./invoiceService');

  // The live invoice this ticket billed to, if any (a voided one counts as gone).
  let invoice = null;
  if (ticket.invoiceId) {
    try { invoice = invoiceService.getInvoice(businessId, ticket.invoiceId); } catch { invoice = null; }
    if (invoice && invoice.status === 'void') invoice = null;
  }
  if (invoice && (invoice.status === 'signed' || invoice.status === 'paid' || invoice.signed_at || invoice.paid_at)) {
    return { error: 'locked', invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, invoiceStatus: invoice.status };
  }

  const prevTons = ticket.weightTons != null ? Number(ticket.weightTons) : null;
  // Same allowance basis the ticket was recorded on: its stored swap-replacement flag
  // (like the stored size), so a correction can't silently switch the haul between the
  // replacement policy and the normal one.
  const overage = weightTons != null
    ? computeOverage(businessId, weightTons, { size, replacementHaul: !!ticket.replacementHaul })
    : null;
  const overLine = overageLineItem(overage, size);

  const at = nowIso();
  let invoiceId = invoice ? invoice.id : null;
  let invoiceNote = null;

  if (invoice) {
    // Rewrite this ticket's overage line on its existing invoice, keeping every other
    // line (e.g. the swap replacement rental) exactly as it is.
    const kept = (invoice.line_items || []).filter((li) => li.line_type !== 'overage');
    const items = overLine ? [...kept, overLine] : kept;
    if (!items.length) {
      // Nothing left to bill — void it rather than leave a $0 'sent' invoice sitting in
      // the settled rollup blocking completion forever.
      const r = invoiceService.updateInvoice(businessId, invoice.id, { status: 'void' });
      if (r && r.error) return { error: r.error };
      invoiceId = null;
      invoiceNote = `invoice ${invoice.invoice_number} voided (no charge)`;
    } else {
      const r = invoiceService.updateInvoice(businessId, invoice.id, { line_items: items });
      if (r && r.error) return { error: r.error };
      invoiceNote = overLine
        ? `invoice ${invoice.invoice_number} updated to $${r.invoice.total}`
        : `overage removed from invoice ${invoice.invoice_number}`;
    }
    try { emitToBusiness(businessId, 'invoice_updated', { id: invoice.id }); } catch { /* non-fatal */ }
  } else if (overLine) {
    // The corrected weight is chargeable but this ticket has no live invoice (it was
    // under the allowance before, or its invoice was voided) — bill it now exactly the
    // way the original entry would have.
    const inv = createTicketInvoice(businessId, lead, [overLine], `overage $${overage.amount}`);
    if (inv) {
      invoiceId = inv.id;
      invoiceNote = `invoice ${inv.invoice_number} created ($${inv.total})`;
      try { emitToBusiness(businessId, 'invoice_updated', { id: inv.id }); } catch { /* non-fatal */ }
    }
  }

  tickets[i] = {
    ...ticket,
    weightTons: overage ? overage.weightTons : null,
    includedTons: overage ? (overage.includedTons ?? null) : null,
    overageTons: overage ? overage.overTons : 0,
    overageAmount: overage ? overage.amount : null,
    overageNeedsRate: overage ? !!overage.needsRate : false,
    overageNeedsAllowance: overage ? !!overage.needsAllowance : false,
    invoiceId,
    editedAt: at,
    editedFromTons: prevTons,
    editSource: source,
  };
  vd.dumpTickets = tickets;
  // Recompute the job-level flag across ALL tickets so correcting a weight also clears a
  // stale "overage recorded but not priced" warning (and re-raises it when warranted).
  vd.overageNeedsRate = tickets.some((t) => t.overageNeedsRate || t.overageNeedsAllowance);

  db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(vd), at, lead.id);
  lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;

  const oStr = overage && overage.overTons > 0
    ? (overage.amount != null ? ` · overage ${overage.overTons}t ($${overage.amount})` : ` · overage ${overage.overTons}t (rate not configured)`)
    : ' · no overage';
  logActivity(
    lead.id, 'note_added',
    `Weight corrected — ${describeWeight(prevTons)} → ${describeWeight(overage ? overage.weightTons : null)}${oStr}${noAllowanceNote(overage)}${invoiceNote ? ` · ${invoiceNote}` : ''}`
  );

  // The invoice total changed, so the payment rollup may have. Forward-only + gated:
  // this can complete a job whose last blocking charge just went away, never un-complete one.
  try { advanceOnPayment(businessId, lead); } catch (e) { console.error('[jobLifecycle] weight-correction advance error:', e.message); }
  bumpCustomer(lead); emit(lead);
  return { lead, index: i, ticket: tickets[i], overage, invoiceId };
}

// ── Base-rental invoice on booking (mirrors the overage path in recordDumpTicket) ──
// When a job is booked/initiated (manual Create Job, the PUT "Book" transition, or
// auto-book), materialize the SAME base-rental charge the booking amount already
// shows as a real 'sent' invoice — so every charge is an invoice in the Invoices
// section and the settled rollup gates completion on it, identical to how the weight
// overage becomes an invoice. Reuses invoiceService end-to-end; builds NO new invoice
// system, and never touches extraction / booking-signal / recording / caller ID /
// Twilio VOICE.
//
// EXACTLY ONE base invoice per job: a base invoice is one carrying a 'rental'
// line_type line tied to the lead. If one already exists (any non-void status) we
// skip, so repeated booking / PUT / re-save calls never duplicate it. The overage
// invoice (`overage` weight line + swap `service` line) is a DIFFERENT invoice and is
// never mistaken for the base.
function baseInvoiceExists(businessId, leadId) {
  if (!leadId) return false;
  try {
    return !!db.prepare(`
      SELECT 1 FROM invoices i
      JOIN invoice_line_items li ON li.invoice_id = i.id
      WHERE i.business_id = ? AND i.lead_id = ? AND i.status != 'void' AND li.line_type = 'rental'
      LIMIT 1
    `).get(businessId, leadId);
  } catch { return false; /* invoices tables absent / not migrated */ }
}

// Create the one base-rental invoice for a job if it doesn't already have one.
//   • Line items come from invoiceService.suggestItemsFromLead — the EXACT pricing the
//     Create-Job amount + invoice prefill already use (base rental size×duration, any
//     extra-day line, an enabled flat delivery fee); their total equals the shown
//     booking amount. The primary rental line is re-tagged line_type 'rental' as the
//     base-invoice marker (amounts untouched).
//   • The invoice is created 'sent' so the job stays pending_payment until it's paid;
//     paying it (Stripe on the invoice OR the invoice's Mark Paid) runs the existing
//     advanceForInvoice → advanceOnPayment → booked, the SAME path the overage uses.
//   • markPaidNow (cash / book-without-online-payment): settle the base invoice so it
//     COUNTS as paid in the rollup — not just lead.paid_at — then advance the lifecycle.
//   • emailLink defaults false: the three booking entry points still send the legacy
//     payment-link email while the /pay page stays, so the invoice doesn't double-email.
function ensureBaseInvoice(businessId, leadOrId, { emailLink = false, markPaidNow = false, via = 'owner' } = {}) {
  const lead = loadLead(businessId, leadOrId);
  if (!lead) return { error: 'not_found' };

  // Base-rental invoices are a dumpster (home_services) concept — the pricing +
  // overage model this mirrors is dumpster-only. Auto-dealer leads are left untouched.
  if (lead.vertical && lead.vertical !== 'home_services') return { skipped: 'not_home_services' };

  // Exactly one base invoice per job.
  if (baseInvoiceExists(businessId, lead.id)) return { skipped: 'exists' };

  // Resolve a customer (a booked job is normally linked by reconcile-on-read, but
  // resolve one defensively so the bill never silently vanishes — same as the overage).
  let customerId = lead.customer_id;
  if (!customerId) {
    try { customerId = require('./customerService').findOrCreateCustomerForLead(businessId, lead); } catch { customerId = null; }
  }
  if (!customerId) return { skipped: 'no_customer' };
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(customerId, businessId);

  // Same pricing the booking amount + invoice prefill use. Tag the primary rental line
  // 'rental' (the base-invoice marker for the dedup above); amounts are unchanged.
  const invoiceService = require('./invoiceService');
  let items = [];
  try { items = invoiceService.suggestItemsFromLead(businessId, lead, customer) || []; } catch { items = []; }
  if (!items.length) return { skipped: 'no_line_items' };
  items = items.map((it, i) => (i === 0 ? { ...it, line_type: 'rental' } : it));

  try {
    const inv = invoiceService.createInvoice(businessId, {
      customer_id: customerId,
      lead_id: lead.id,
      line_items: items,
    });
    // 'sent' so it counts as an outstanding bill in the settled rollup (blocks
    // completion until paid) — exactly like the overage invoice.
    invoiceService.markSent(businessId, inv.id);
    let invoice = inv;
    logActivity(lead.id, 'invoice_created', `Base rental invoice ${inv.invoice_number} created ($${inv.total})`);

    if (markPaidNow) {
      // Cash / book-without-online-payment: settle the base invoice so the rollup reads
      // paid (not just lead.paid_at), then advance the lifecycle the same way the
      // invoice mark-paid route does.
      try {
        const r = invoiceService.markPaid(businessId, inv.id, { method: 'manual', reference: 'Booked — paid outside Stream' });
        if (r && r.invoice) invoice = r.invoice;
        logActivity(lead.id, 'invoice_paid', `Base rental invoice ${inv.invoice_number} marked paid`);
        advanceForInvoice(businessId, invoice);
      } catch (e) { console.error('[jobLifecycle] base invoice mark-paid failed:', e.message); }
    } else if (emailLink) {
      // Same Resend path as the overage bill + the payment link.
      emailInvoiceLink(businessId, inv, lead.id);
    }

    try { emitToBusiness(businessId, 'invoice_updated', { id: inv.id }); } catch { /* non-fatal */ }
    return { invoice, created: true };
  } catch (e) {
    console.error('[jobLifecycle] base invoice creation failed:', e.message);
    return { error: 'create_failed' };
  }
}

// ── Call-driven draft invoice (swap and/or extension) — held for owner review ────
// When the call-intent classifier detects a SWAP and/or an EXTENSION on a caller's open,
// booked job, materialize the correctly-priced charge(s) as a DRAFT invoice the owner reviews
// before it's sent — NOT a live bill. A single call can ask for BOTH (replace the unit AND
// keep it longer): we then put a swap line AND an extension line on the SAME draft, each
// priced by its OWN resolver (resolveSwapPrice / resolveExtensionPrice). Mirrors
// ensureBaseInvoice (home_services fence, customer resolution, createInvoice) but STOPS at
// 'draft': it never calls markSent, so the draft is inert (excluded from the settled rollup —
// jobLifecycle's payment rollup ignores 'draft' — so it blocks nothing) until Part 2's review
// surface sends it. The swap line keeps the EXACT shape/description recordDumpTicket builds, so
// the swapAlreadyBilled dedup + the editor + send flow all read it as-is.
//
// Idempotent: ONE draft per pending review (it may hold up to two lines). A re-processed call
// (Twilio retry, redeploy) finds vd.pendingInvoiceReview pointing at a still-DRAFT invoice and
// skips, so drafts never stack. Once that draft is resolved (sent/paid → no longer a pending
// review, or voided), the marker no longer blocks, so a later distinct change can create a
// fresh draft.
//
// EXTENSION with no configured day rate: a PURE extension creates NO draft — it flags the job
// "needs a day rate" (deliberate block) and returns { needsRate }, mirroring the overage
// needs-rate path. But when the SAME call ALSO has a chargeable swap, the swap draft is still
// created and the extension's needs-rate note is attached — we don't drop the whole draft just
// because the extension half can't be priced yet.
function pendingReviewDraftExists(businessId, vd) {
  const id = vd && vd.pendingInvoiceReview && vd.pendingInvoiceReview.invoiceId;
  if (!id) return false;
  try {
    const inv = db.prepare('SELECT status FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
    return !!inv && inv.status === 'draft';   // still awaiting review → don't stack another draft
  } catch { return false; }
}

// `source` is a LABEL ONLY — 'call' (the classifier) or 'manual' (the owner tapped
// Swap out on an active rental). It changes the activity-log wording and the marker
// so the review screen can say where the draft came from; the pricing, the draft, the
// marker's idempotency, the review item and every payment hook behave identically.
function ensureCallDrivenReviewInvoice(businessId, bookedLeadOrId, { swap = null, extension = null, source = 'call' } = {}) {
  const isManual = source === 'manual';
  const originPhrase = isManual ? 'from a manual swap request' : 'from call';
  const lead = loadLead(businessId, bookedLeadOrId);
  if (!lead) return { error: 'not_found' };
  const wantSwap = !!swap;
  const wantExtension = !!extension;
  if (!wantSwap && !wantExtension) return { error: 'bad_kind' };
  // Dumpster (home_services) concept only — same fence as ensureBaseInvoice.
  if (lead.vertical && lead.vertical !== 'home_services') return { skipped: 'not_home_services' };

  const vd = parseVd(lead);
  // A swap may replace with a DIFFERENT size; that replacement size is what the whole job —
  // and the extension riding along on it — prices against. Otherwise price the booked size.
  const jobSize = (swap && swap.size) || vd.dumpsterSize || null;
  if (!jobSize) return { skipped: 'no_size' };

  // Idempotency: never stack a second draft while one is still pending review.
  if (pendingReviewDraftExists(businessId, vd)) return { skipped: 'exists' };

  const pricingService = require('./pricingService');

  // Price the extension up-front (if asked) to learn whether it's chargeable. A PURE extension
  // with no configured day rate surfaces a needs-rate prompt and creates NO draft — done BEFORE
  // resolving a customer so that prompt never spuriously creates a customer row (unchanged).
  const extraDaysN = wantExtension ? Math.max(1, Math.round(Number(extension.extraDays)) || 1) : null;
  const extPrice = wantExtension
    ? pricingService.resolveExtensionPrice(businessId, { size: jobSize, extraDays: extraDaysN })
    : null;
  const extPriceable = !!(extPrice && !extPrice.needsRate && extPrice.amount != null && extPrice.amount > 0);

  if (wantExtension && !extPriceable && !wantSwap) {
    const at = nowIso();
    vd.extensionNeedsRate = { size: jobSize, extraDays: extraDaysN, at };
    db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vd), at, lead.id);
    lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;
    logActivity(lead.id, 'note', `Customer asked to EXTEND ${extraDaysN} more day(s) — set a day rate for ${jobSize} on the Pricing page to invoice this extension (no draft created).`.slice(0, 500));
    emit(lead);
    return { needsRate: true, size: jobSize, extraDays: extraDaysN };
  }

  // Resolve the customer the SAME way ensureBaseInvoice does — customer_id can be NULL on an
  // auto-booked job nobody has opened in Customers yet, so the fallback is required. Only
  // findOrCreateCustomerForLead is touched (customers table only; never the write-on-read layer).
  let customerId = lead.customer_id;
  if (!customerId) {
    try { customerId = require('./customerService').findOrCreateCustomerForLead(businessId, lead); } catch { customerId = null; }
  }
  if (!customerId) return { skipped: 'no_customer' };
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(customerId, businessId);

  // Build a line per PRICEABLE signal — up to two on the ONE draft. The swap line keeps the
  // exact shape/description recordDumpTicket uses so the swapAlreadyBilled dedup keeps working.
  const lineItems = [];
  const parts = [];

  // The swap's delivery date defaults to the business's today; the owner can retune it on
  // the review screen (→ recompute-swap route), which re-derives days + price from here.
  const swapDeliveryDate = wantSwap ? businessLocalToday(businessId) : null;
  if (wantSwap) {
    const days = swapWindowDays(lead, swapDeliveryDate);
    const sw = pricingService.resolveSwapPrice(businessId, { size: jobSize, days, customer });
    if (sw && sw.mode !== 'off' && sw.amount != null && sw.amount > 0) {
      lineItems.push({
        description: `Swap replacement — ${jobSize} (${days} day${days === 1 ? '' : 's'})`,
        service_key: null, line_type: 'service', quantity: 1, unit: null, unit_rate: sw.amount,
      });
      parts.push('swap');
    }
  }

  if (wantExtension && extPriceable) {
    lineItems.push({
      description: `Rental extension — ${extraDaysN} extra day${extraDaysN === 1 ? '' : 's'}${jobSize ? ` (${jobSize})` : ''}`,
      service_key: null, line_type: 'service', quantity: extraDaysN, unit: 'day', unit_rate: extPrice.dayRate,
    });
    parts.push('extension');
  }

  // Extension asked for but not priceable (a chargeable swap kept us going): remember to attach
  // its needs-rate note so the owner knows the extension still needs a day rate to be added.
  const extensionNeedsRate = wantExtension && !extPriceable;

  if (!lineItems.length) {
    // Nothing chargeable landed. If an extension needed a rate (and the swap, if any, had no
    // charge), surface the needs-rate prompt; otherwise there is simply nothing to bill.
    if (extensionNeedsRate) {
      const at = nowIso();
      vd.extensionNeedsRate = { size: jobSize, extraDays: extraDaysN, at };
      db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vd), at, lead.id);
      lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;
      logActivity(lead.id, 'note', `Customer asked to EXTEND ${extraDaysN} more day(s) — set a day rate for ${jobSize} on the Pricing page to invoice this extension (no draft created).`.slice(0, 500));
      emit(lead);
      return { needsRate: true, size: jobSize, extraDays: extraDaysN };
    }
    return { skipped: 'no_charge' };
  }

  const kind = parts.length === 2 ? 'swap_extension' : parts[0];
  const amount = round2(lineItems.reduce((s, li) => s + Number(li.unit_rate) * Number(li.quantity), 0));

  // Create the DRAFT invoice (never markSent). createInvoice is self-contained — plain
  // inserts/selects, no reconcile / payment recompute / delivery auto-advance — so it's safe
  // from the webhook path. Then write the single idempotency marker + fire log/socket.
  try {
    const invoiceService = require('./invoiceService');
    const inv = invoiceService.createInvoice(businessId, {
      customer_id: customerId,
      lead_id: lead.id,
      line_items: lineItems,
    });
    const at = nowIso();
    vd.pendingInvoiceReview = { invoiceId: inv.id, kind, amount, size: jobSize, parts, requestedAt: at, swapDeliveryDate: parts.includes('swap') ? swapDeliveryDate : null, source: isManual ? 'manual' : 'call' };
    if (extensionNeedsRate) vd.extensionNeedsRate = { size: jobSize, extraDays: extraDaysN, at };
    db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vd), at, lead.id);
    lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;
    const label = kind === 'swap_extension' ? 'swap + extension' : kind;
    logActivity(lead.id, 'invoice_created', `Draft ${label} invoice ${inv.invoice_number} created ${originPhrase} — review before sending ($${amount})`);
    if (extensionNeedsRate) {
      logActivity(lead.id, 'note', `Customer also asked to EXTEND ${extraDaysN} more day(s) — set a day rate for ${jobSize} on the Pricing page to add the extension to this invoice.`.slice(0, 500));
    }
    try { emitToBusiness(businessId, 'invoice_updated', { id: inv.id }); } catch { /* non-fatal */ }
    emit(lead);
    return { invoice: inv, created: true, kind, amount, parts, extensionNeedsRate };
  } catch (e) {
    console.error('[jobLifecycle] call-driven draft invoice failed:', e.message);
    return { error: 'create_failed' };
  }
}

// ── Extension payment hook: a PAID extension invoice pushes the pickup date out ──
// When an invoice carrying a call-driven EXTENSION line settles, extend the job's
// pickup_date (and vd.rentalDuration) by the extension's N days — the ONE genuinely
// new lifecycle side-effect of the review feature. Scoped STRICTLY to invoices that
// carry an extension line, so base / swap / overage payments never move a pickup date.
// (Paying a SWAP invoice is just the green light — the physical rotation / units_out
// still happens later at dump-ticket entry, so a swap has no date effect here.)
//
// Detection mirrors swapAlreadyBilled: a line_type='service' line whose description
// starts with 'Rental extension'. The day count is that line's quantity, READ AT
// SETTLEMENT TIME so any owner edit in the review editor is respected. Idempotent via
// vd.extensionsApplied (invoice ids), so webhook retries / re-syncs never double-extend.
function invoiceExtensionDays(businessId, invoiceId) {
  if (!invoiceId) return 0;
  try {
    const rows = db.prepare(`
      SELECT li.quantity AS q FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      WHERE i.business_id = ? AND li.invoice_id = ?
        AND li.line_type = 'service' AND li.description LIKE 'Rental extension%'
    `).all(businessId, invoiceId);
    return rows.reduce((s, r) => s + (Math.max(0, Math.round(Number(r.q))) || 0), 0);
  } catch { return 0; /* invoices tables absent / not migrated */ }
}

function applyExtensionOnPayment(businessId, invoice) {
  if (!invoice || !invoice.lead_id) return null;
  // Only a settled invoice extends anything (advanceForInvoice is always post-payment,
  // but guard so a future caller can't move a date off an unpaid invoice).
  if (!(invoice.status === 'paid' || invoice.paid_at)) return null;
  const extraDays = invoiceExtensionDays(businessId, invoice.id);
  if (extraDays < 1) return null;   // not an extension invoice — base/swap/overage untouched

  const lead = loadLead(businessId, invoice.lead_id);
  if (!lead) return null;
  const vd = parseVd(lead);
  vd.extensionsApplied = Array.isArray(vd.extensionsApplied) ? vd.extensionsApplied : [];
  if (vd.extensionsApplied.includes(invoice.id)) return null;   // already extended for this invoice

  // Base the new pickup on the current pickup date (fall back to delivery + current
  // duration). Mark applied even if we can't resolve a base date, so a paid extension
  // never silently retries the log on every later settle event.
  const inv = require('./inventoryService');
  let basePickup = lead.pickup_date ? String(lead.pickup_date).slice(0, 10) : null;
  if (!basePickup && lead.delivery_date) {
    const curDays = inv.parseRentalDays(vd.rentalDuration) || 0;
    if (curDays > 0) basePickup = inv.addDaysToISO(String(lead.delivery_date).slice(0, 10), curDays);
  }
  const at = nowIso();
  vd.extensionsApplied.push(invoice.id);

  if (basePickup) {
    const newPickup = inv.addDaysToISO(basePickup, extraDays);
    const curDays = inv.parseRentalDays(vd.rentalDuration);
    if (curDays != null) vd.rentalDuration = `${curDays + extraDays} days`;
    db.prepare('UPDATE leads SET pickup_date = ?, vertical_data = ?, updated_at = ? WHERE id = ?')
      .run(newPickup, JSON.stringify(vd), at, lead.id);
    lead.pickup_date = newPickup; lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;
    logActivity(lead.id, 'status_change', `Extension paid — pickup date extended ${extraDays} day(s) to ${newPickup}`);
  } else {
    db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(vd), at, lead.id);
    lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;
    logActivity(lead.id, 'note_added', `Extension paid (${extraDays} day(s)) — set a pickup date to reflect the new rental end.`);
  }
  bumpCustomer(lead); emit(lead);
  return { lead, extraDays, pickupDate: lead.pickup_date };
}

// ── Swap payment hook: a PAID swap invoice registers an outstanding swap-out ──────
// When an invoice carrying a call-driven SWAP line settles, record on the booked lead that
// one replacement dumpster is still deployed — vd.pendingSwapOuts, a COUNTER so two paid
// swaps stack. The next ordinary dump ticket reads that marker and treats itself as the
// swap-out haul (keeps a unit out instead of completing the job — see recordDumpTicket).
// Payment is the trigger: a swap is only authorized once paid (pay-in-advance). Scoped
// STRICTLY to invoices carrying a swap line, so base/extension/overage payments are no-ops.
//
// Detection mirrors swapAlreadyBilled / applyExtensionOnPayment: a line_type='service' line
// whose description starts with 'Swap replacement'. The count is the sum of those lines'
// quantities (normally 1 each). Idempotent via vd.swapOutsApplied (invoice ids), so webhook
// retries / re-syncs never double-count a swap.
function invoiceSwapCount(businessId, invoiceId) {
  if (!invoiceId) return 0;
  try {
    const rows = db.prepare(`
      SELECT li.quantity AS q FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      WHERE i.business_id = ? AND li.invoice_id = ?
        AND li.line_type = 'service' AND li.description LIKE 'Swap replacement%'
    `).all(businessId, invoiceId);
    return rows.reduce((s, r) => s + (Math.max(0, Math.round(Number(r.q))) || 0), 0);
  } catch { return 0; /* invoices tables absent / not migrated */ }
}

function applySwapOutOnPayment(businessId, invoice) {
  if (!invoice || !invoice.lead_id) return null;
  // Only a settled invoice arms the marker (advanceForInvoice is always post-payment, but
  // guard so a future caller can't arm it off an unpaid invoice).
  if (!(invoice.status === 'paid' || invoice.paid_at)) return null;
  const swaps = invoiceSwapCount(businessId, invoice.id);
  if (swaps < 1) return null;   // not a swap invoice — base/extension/overage untouched

  const lead = loadLead(businessId, invoice.lead_id);
  if (!lead) return null;
  const vd = parseVd(lead);

  // A swap billed BY a dump ticket already HAPPENED — that ticket held the unit out when
  // it was recorded. Paying its bill must not arm a marker for the same rotation, or the
  // job silently demands one ticket more than there are cans (the manual-swap mirror of
  // the checkbox double-arm). Only a call-driven swap, billed AHEAD of the haul, arms
  // anything. Identified by the ticket that raised this very invoice.
  const tickets = Array.isArray(vd.dumpTickets) ? vd.dumpTickets : [];
  if (tickets.some((t) => t && t.invoiceId != null && Number(t.invoiceId) === Number(invoice.id) && (t.swap || t.swapOut))) {
    return null;
  }

  vd.swapOutsApplied = Array.isArray(vd.swapOutsApplied) ? vd.swapOutsApplied : [];
  if (vd.swapOutsApplied.includes(invoice.id)) return null;   // already registered for this invoice

  const at = nowIso();
  vd.pendingSwapOuts = Math.max(0, Math.round(Number(vd.pendingSwapOuts) || 0)) + swaps;
  vd.swapOutsApplied.push(invoice.id);
  db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(vd), at, lead.id);
  lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;
  logActivity(lead.id, 'status_change', `Swap paid — replacement dumpster still deployed; job stays open until it's picked up${swaps > 1 ? ` (×${swaps})` : ''}`);
  bumpCustomer(lead); emit(lead);
  return { lead, swaps, pendingSwapOuts: vd.pendingSwapOuts };
}

// Advance whatever job(s) an invoice settlement affects. A lead-linked invoice
// advances that job; a customer-level invoice (lead_id null) advances the customer's
// open job(s) awaiting money (pending_payment → booked, awaiting_final_payment →
// completed). Called from the manual mark-paid route AND the Stripe Connect webhook.
function advanceForInvoice(businessId, invoice) {
  if (!invoice) return;
  const targets = new Set();
  if (invoice.lead_id) {
    targets.add(invoice.lead_id);
  } else if (invoice.customer_id) {
    try {
      const rows = db.prepare(`
        SELECT id FROM leads WHERE business_id = ? AND customer_id = ?
          AND job_status IN ('pending_payment','awaiting_final_payment')
      `).all(businessId, invoice.customer_id);
      rows.forEach((r) => targets.add(r.id));
    } catch { /* invoices/leads shape unexpected — skip */ }
  }
  for (const leadId of targets) {
    try { advanceOnPayment(businessId, leadId); } catch (e) { console.error('[jobLifecycle] advanceForInvoice error:', e.message); }
  }
  // A paid EXTENSION invoice also pushes the rental's pickup date out by its N days
  // (scoped to extension-line invoices only; base/swap/overage are no-ops here).
  try { applyExtensionOnPayment(businessId, invoice); } catch (e) { console.error('[jobLifecycle] applyExtensionOnPayment error:', e.message); }
  // A paid SWAP invoice arms an outstanding swap-out so the next dump ticket keeps the
  // replacement unit out instead of completing the job (scoped to swap-line invoices only).
  try { applySwapOutOnPayment(businessId, invoice); } catch (e) { console.error('[jobLifecycle] applySwapOutOnPayment error:', e.message); }
}

// Whether a job may transition to 'completed' right now: gated on full payment.
// Used by the leads PUT handler to reject / reroute a premature manual completion.
function canComplete(businessId, leadOrId) {
  const lead = loadLead(businessId, leadOrId);
  if (!lead) return false;
  const pay = recomputeLeadPaymentStatus(businessId, lead);
  return pay === PAYMENT_STATUS.PAID;
}

module.exports = {
  paymentStatusFromInvoices,
  recomputeLeadPaymentStatus,
  advanceOnPayment,
  advanceForInvoice,
  applyExtensionOnPayment,
  applySwapOutOnPayment,
  advanceDueDeliveries,
  getOverageConfig,
  getSwapAllowanceMode,
  computeOverage,
  recordDumpTicket,
  updateDumpTicketWeight,
  tonsFromLbs,
  lbsFromTons,
  ensureBaseInvoice,
  ensureCallDrivenReviewInvoice,
  canComplete,
  daysBetweenISO,
  businessLocalToday,
  swapWindowDays,
};
