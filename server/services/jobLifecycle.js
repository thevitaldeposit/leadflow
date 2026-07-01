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
function nowIso() { return new Date().toISOString(); }
function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseVd(lead) {
  try { return lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { return {}; }
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

// ── Booking initiation: → pending_payment (or straight to booked if already paid) ─
// The owner clicking "Book" or auto-book firing INITIATES booking. Nothing is
// reserved/scheduled yet — a payment link is emailed, and only payment advances the
// job to 'booked'. If the job is already paid (e.g. the owner collected cash and
// marked it paid), it books immediately. `via` labels the trigger for logs.
function initiateBooking(businessId, leadOrId, { via = 'owner', emailLink = true } = {}) {
  const lead = loadLead(businessId, leadOrId);
  if (!lead) return { error: 'not_found' };
  const pay = recomputeLeadPaymentStatus(businessId, lead);
  if (pay === PAYMENT_STATUS.PAID) {
    setJobStatus(lead, JOB_STATUS.BOOKED);
    logActivity(lead.id, 'status_change', 'Payment already received — job booked; dumpster reserved and scheduled');
    bumpCustomer(lead);
    emit(lead);
    return { lead, status: JOB_STATUS.BOOKED, emailed: false };
  }
  setJobStatus(lead, JOB_STATUS.PENDING_PAYMENT);
  logActivity(lead.id, 'status_change', 'Booking initiated — payment link emailed (payment reserves the dumpster)');
  bumpCustomer(lead);
  let emailed = false;
  if (emailLink) emailed = true; // actual send is fire-and-forget below
  emit(lead);
  if (emailLink) {
    // Fire-and-forget: don't block the transition on email delivery.
    try {
      require('./emailService').sendPaymentLinkEmail(lead)
        .then((r) => { if (r && !r.sent) console.log(`[jobLifecycle] payment email not sent (lead ${lead.id}): ${r.reason}`); })
        .catch((e) => console.error('[jobLifecycle] payment email error:', e.message));
    } catch (e) { console.error('[jobLifecycle] payment email dispatch error:', e.message); }
  }
  return { lead, status: JOB_STATUS.PENDING_PAYMENT, emailed };
}

// ── On payment: advance pending_payment → booked, or awaiting_final_payment → completed ─
// Call after any invoice for the job settles (manual mark-paid, Stripe, or a lead
// paid_at write). Recomputes payment_status first, then advances if the gate is met.
// Completion is GATED: awaiting_final_payment → completed only when fully paid AND no
// unit is still out.
function advanceOnPayment(businessId, leadOrId) {
  const lead = loadLead(businessId, leadOrId);
  if (!lead) return null;
  const pay = recomputeLeadPaymentStatus(businessId, lead);
  const js = mapLegacyJobStatus(lead.job_status);

  if (js === JOB_STATUS.PENDING_PAYMENT && pay === PAYMENT_STATUS.PAID) {
    setJobStatus(lead, JOB_STATUS.BOOKED);
    logActivity(lead.id, 'status_change', 'Payment received — job booked; dumpster reserved and scheduled');
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

// ── Weight overage config (per-business settings; NOT hardcoded) ────────────────
// The pricing model for weight overage is a later prompt. For now we read two
// optional per-business settings; if either is missing we record the weight and flag
// that the rate/allowance is needed rather than inventing a number.
function getOverageConfig(businessId) {
  const inc = Number(getSetting('overageIncludedTons', businessId));
  const rate = Number(getSetting('overageRatePerTon', businessId));
  return {
    includedTons: Number.isFinite(inc) && inc >= 0 ? inc : null,
    ratePerTon: Number.isFinite(rate) && rate > 0 ? rate : null,
  };
}

// Compute overage for a recorded weight against the configured allowance/rate.
// Returns a descriptor; `needsRate`/`needsAllowance` flag missing config so the UI can
// surface "overage needs a rate" instead of a wrong dollar amount.
function computeOverage(businessId, weightTons) {
  const w = Number(weightTons);
  if (!Number.isFinite(w) || w < 0) return { weightTons: null, overTons: 0, amount: null, needsRate: false, needsAllowance: false };
  const { includedTons, ratePerTon } = getOverageConfig(businessId);
  if (includedTons == null) return { weightTons: w, includedTons: null, overTons: 0, amount: null, needsRate: false, needsAllowance: true };
  const overTons = round2(Math.max(0, w - includedTons));
  if (overTons <= 0) return { weightTons: w, includedTons, overTons: 0, amount: 0, needsRate: false, needsAllowance: false };
  if (ratePerTon == null) return { weightTons: w, includedTons, overTons, amount: null, needsRate: true, needsAllowance: false };
  return { weightTons: w, includedTons, overTons, ratePerTon, amount: round2(overTons * ratePerTon), needsRate: false, needsAllowance: false };
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
function recordDumpTicket(businessId, leadOrId, { weightTons = null, swap = false, unitsRemaining, note = null, source = 'manual' } = {}) {
  const lead = loadLead(businessId, leadOrId);
  if (!lead) return { error: 'not_found' };
  const at = nowIso();
  const vd = parseVd(lead);

  const overage = weightTons != null && weightTons !== '' ? computeOverage(businessId, weightTons) : null;

  // Swap-safe units-out accounting. Default: one dumpster comes back per ticket.
  const before = lead.units_out == null ? 1 : lead.units_out;
  let after;
  if (unitsRemaining != null && Number.isFinite(Number(unitsRemaining))) {
    after = Math.max(0, Math.round(Number(unitsRemaining)));   // explicit owner/OCR override
  } else if (swap) {
    after = before;                                            // replacement dropped → a unit is still out
  } else {
    after = Math.max(0, before - 1);                           // final pickup for this unit
  }

  // Generate the overage invoice only when we can price it. When a rate isn't
  // configured we still record the weight + flag it (do not hardcode any numbers).
  let overageInvoiceId = null;
  if (overage && overage.overTons > 0 && overage.amount != null && overage.amount > 0 && lead.customer_id) {
    try {
      const invoiceService = require('./invoiceService');
      const inv = invoiceService.createInvoice(businessId, {
        customer_id: lead.customer_id,
        lead_id: lead.id,
        line_items: [{
          description: `Weight overage — ${overage.overTons} ton(s) over ${overage.includedTons} included`,
          quantity: overage.overTons,
          unit: 'ton',
          unit_rate: overage.ratePerTon,
          line_type: 'overage',
        }],
      });
      // 'sent' so it counts as an outstanding bill in the settled rollup (blocks completion).
      invoiceService.markSent(businessId, inv.id);
      overageInvoiceId = inv.id;
      logActivity(lead.id, 'invoice_created', `Overage invoice ${inv.invoice_number} created ($${overage.amount})`);
    } catch (e) { console.error('[jobLifecycle] overage invoice failed:', e.message); }
  }

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
    unitsOutAfter: after,
    invoiceId: overageInvoiceId,
  };
  vd.dumpTickets = Array.isArray(vd.dumpTickets) ? vd.dumpTickets : [];
  vd.dumpTickets.push(ticket);
  vd.overageNeedsRate = ticket.overageNeedsRate || ticket.overageNeedsAllowance || vd.overageNeedsRate || false;

  db.prepare('UPDATE leads SET units_out = ?, vertical_data = ?, updated_at = ? WHERE id = ?')
    .run(after, JSON.stringify(vd), at, lead.id);
  lead.units_out = after; lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;

  const wStr = overage && overage.weightTons != null ? `${overage.weightTons} tons` : 'weight not entered';
  const oStr = overage && overage.overTons > 0
    ? (overage.amount != null ? ` · overage ${overage.overTons}t ($${overage.amount})` : ` · overage ${overage.overTons}t (rate not configured)`)
    : '';
  logActivity(lead.id, 'note_added', `Dump ticket recorded (${wStr})${swap ? ' · swap-out, unit still on site' : ''}${oStr}`);

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
  return { lead, overage, advancedTo, unitsOut: after, overageInvoiceId };
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
  initiateBooking,
  advanceOnPayment,
  advanceForInvoice,
  advanceDueDeliveries,
  getOverageConfig,
  computeOverage,
  recordDumpTicket,
  canComplete,
};
