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
// Days a swap replacement stays out: today (the swap date) → the job's pickup date,
// min 1. Falls back to the configured rental duration when there's no pickup date.
function swapWindowDays(lead) {
  const pd = lead && lead.pickup_date;
  if (pd) {
    const a = new Date(`${localTodayStr()}T00:00:00Z`);
    const b = new Date(`${String(pd).slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
      const days = Math.round((b.getTime() - a.getTime()) / 86400000);
      if (days >= 1) return days;
    }
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

// Compute overage for a recorded weight against the size's configured allowance/rate.
// Returns a descriptor; `needsRate`/`needsAllowance` flag missing config so the UI can
// surface "set overage pricing" instead of a wrong dollar amount. `size` selects the
// price row the allowance/rate come from.
function computeOverage(businessId, weightTons, { size = null } = {}) {
  const w = Number(weightTons);
  if (!Number.isFinite(w) || w < 0) return { weightTons: null, overTons: 0, amount: null, needsRate: false, needsAllowance: false };
  const { includedTons, ratePerTon } = getOverageConfig(businessId, size);
  if (includedTons == null) return { weightTons: w, includedTons: null, overTons: 0, amount: null, needsRate: false, needsAllowance: true };
  const overTons = round2(Math.max(0, w - includedTons));
  if (overTons <= 0) return { weightTons: w, includedTons, overTons: 0, amount: 0, needsRate: false, needsAllowance: false };
  if (ratePerTon == null) return { weightTons: w, includedTons, overTons, amount: null, needsRate: true, needsAllowance: false };
  return { weightTons: w, includedTons, overTons, ratePerTon, amount: round2(overTons * ratePerTon), needsRate: false, needsAllowance: false };
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
  const size = vd.dumpsterSize || null;

  // Overage is priced against THIS unit's size (allowance + $/ton from pricing_config).
  const overage = weightTons != null && weightTons !== '' ? computeOverage(businessId, weightTons, { size }) : null;

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

  // ── Bill this ticket: overage on the returned unit + a swap replacement's rental ──
  // Both are priced from the size's pricing_config and land as line items on ONE
  // 'sent' invoice for the job (so they count as outstanding bills in the settled
  // rollup and block completion until paid). The invoice needs a customer; a booked
  // job is linked by reconcile-on-read, but resolve one defensively so a bill never
  // silently vanishes. A swapped unit is a NEW rental → its own weight allowance.
  const lineItems = [];
  if (overage && overage.overTons > 0 && overage.amount != null && overage.amount > 0) {
    lineItems.push({
      description: `Weight overage — ${overage.overTons} ton(s) over ${overage.includedTons} included${size ? ` (${size})` : ''}`,
      quantity: overage.overTons,
      unit: 'ton',
      unit_rate: overage.ratePerTon,
      line_type: 'overage',
    });
  }
  // Swap replacement rental, priced over the swap window (today → pickup) per the
  // size's swap config (same_as_rate → normal resolver; custom → custom price; off → none).
  // SKIP billing it here when a call-driven swap invoice was already sent/paid for this job
  // (swaps are now billed pay-in-advance from the call) — otherwise the swap is double-billed.
  let swapCharge = null;
  const swapPreBilled = !!(swap && size) && swapAlreadyBilled(businessId, lead.id);
  if (swap && size && !swapPreBilled) {
    try {
      const pricingService = require('./pricingService');
      const customerRow = lead.customer_id
        ? db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(lead.customer_id, businessId)
        : null;
      const sw = pricingService.resolveSwapPrice(businessId, { size, days: swapWindowDays(lead), customer: customerRow });
      if (sw && sw.mode !== 'off' && sw.amount != null && sw.amount > 0) {
        swapCharge = sw.amount;
        lineItems.push({
          description: `Swap replacement — ${size} (${swapWindowDays(lead)} day${swapWindowDays(lead) === 1 ? '' : 's'})`,
          quantity: 1,
          unit: null,
          unit_rate: sw.amount,
          line_type: 'service',
        });
      }
    } catch (e) { console.error('[jobLifecycle] swap pricing failed:', e.message); }
  }

  let overageInvoiceId = null;
  if (lineItems.length) {
    let customerId = lead.customer_id;
    if (!customerId) {
      try { customerId = require('./customerService').findOrCreateCustomerForLead(businessId, lead); } catch { customerId = null; }
    }
    if (customerId) {
      try {
        const invoiceService = require('./invoiceService');
        const inv = invoiceService.createInvoice(businessId, {
          customer_id: customerId,
          lead_id: lead.id,
          line_items: lineItems,
        });
        // 'sent' so it counts as an outstanding bill in the settled rollup (blocks completion).
        invoiceService.markSent(businessId, inv.id);
        overageInvoiceId = inv.id;
        const bits = [
          overage && overage.overTons > 0 && overage.amount ? `overage $${overage.amount}` : null,
          swapCharge ? `swap $${swapCharge}` : null,
        ].filter(Boolean).join(' + ');
        logActivity(lead.id, 'invoice_created', `Invoice ${inv.invoice_number} created${bits ? ` (${bits})` : ''}`);
        // Email the bill to the customer (same Resend path as the payment link).
        require('./emailService').sendInvoiceLinkEmail({ ...inv, business_id: businessId })
          .then((r) => { if (r && !r.sent) console.log(`[jobLifecycle] invoice email not sent (inv ${inv.id}): ${r.reason}`); })
          .catch((e) => console.error('[jobLifecycle] invoice email error:', e.message));
      } catch (e) { console.error('[jobLifecycle] ticket invoice failed:', e.message); }
    }
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
    swapCharge: swapCharge != null ? swapCharge : null,
    swapAlreadyBilled: swapPreBilled,
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
  const swapNote = swap
    ? (swapPreBilled ? ' · swap-out, unit still on site (swap already billed from the call)' : ' · swap-out, unit still on site')
    : '';
  logActivity(lead.id, 'note_added', `Dump ticket recorded (${wStr})${swapNote}${oStr}`);

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
      require('./emailService').sendInvoiceLinkEmail({ ...inv, business_id: businessId })
        .then((r) => { if (r && !r.sent) console.log(`[jobLifecycle] base invoice email not sent (inv ${inv.id}): ${r.reason}`); })
        .catch((e) => console.error('[jobLifecycle] base invoice email error:', e.message));
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

function ensureCallDrivenReviewInvoice(businessId, bookedLeadOrId, { swap = null, extension = null } = {}) {
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

  if (wantSwap) {
    const days = swapWindowDays(lead);
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
    vd.pendingInvoiceReview = { invoiceId: inv.id, kind, amount, size: jobSize, parts, requestedAt: at };
    if (extensionNeedsRate) vd.extensionNeedsRate = { size: jobSize, extraDays: extraDaysN, at };
    db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vd), at, lead.id);
    lead.vertical_data = JSON.stringify(vd); lead.updated_at = at;
    const label = kind === 'swap_extension' ? 'swap + extension' : kind;
    logActivity(lead.id, 'invoice_created', `Draft ${label} invoice ${inv.invoice_number} created from call — review before sending ($${amount})`);
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
  advanceDueDeliveries,
  getOverageConfig,
  computeOverage,
  recordDumpTicket,
  ensureBaseInvoice,
  ensureCallDrivenReviewInvoice,
  canComplete,
};
