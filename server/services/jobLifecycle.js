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
  let swapCharge = null;
  if (swap && size) {
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
  advanceOnPayment,
  advanceForInvoice,
  advanceDueDeliveries,
  getOverageConfig,
  computeOverage,
  recordDumpTicket,
  ensureBaseInvoice,
  canComplete,
};
