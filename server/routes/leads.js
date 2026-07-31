const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { sendPaymentSms } = require('../services/smsService');
const jobLifecycle = require('../services/jobLifecycle');
const { initiateClickToCall } = require('../services/callService');
const { logActivity, getActivityForLead } = require('../services/activityLog');
const { emitToBusiness } = require('../socket');
const { attachBusiness, requireAuth } = require('../middleware/auth');
const { reconcileCustomersForBusiness, recomputeCustomerStatus, findOrCreateCustomerForLead, normalizePhone } = require('../services/customerService');
const { describeBooking } = require('../services/leadActivityText');
const { sendToAll } = require('../services/apns');
const { JOB_STATUS, LEGACY_STATUS, ACTIVE_JOB_STATUS_SET } = require('../config/jobStatus');

// Shared with the iOS app, which doesn't send a token yet — soft auth scopes the
// request to the caller's business when a token is present, else to Valley Binz.
router.use(attachBusiness);

// The name carried on the lead ROW itself (no customer join) — vd.customerName, else
// the split first/last columns. Null when the call lead was never named.
function leadOwnName(lead) {
  let vd = {};
  try { vd = JSON.parse(lead.vertical_data || '{}'); } catch {}
  return vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
    || null;
}

// A lead's display name: its own name, else the linked customer's stored name resolved
// via a PLAIN row lookup by customer_id (never the write-on-read customer/engagement
// layer). So an unnamed call/booked lead still shows the known customer's name instead
// of "Unknown". Returns null when neither the lead nor the customer has a name.
function getLeadDisplayName(lead) {
  const own = leadOwnName(lead);
  if (own) return own;
  if (lead.customer_id) {
    try {
      const c = db.prepare('SELECT first_name, last_name, display_name FROM customers WHERE id = ? AND business_id = ?')
        .get(lead.customer_id, lead.business_id);
      const nm = c && (c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' '));
      if (nm) return nm;
    } catch { /* customers table absent / not migrated — no fallback */ }
  }
  return null;
}

// Attach a resolved `customer_name` to any lead that has no name of its own, via ONE
// batched lookup of the linked customer rows by customer_id (plain SELECT — never the
// write-on-read customer layer). Lets the dashboard rows the client fetches carry the
// real customer name so the Action Queue / schedule never show "Unknown" for a lead
// whose customer profile is named. Mutates + returns the array.
function attachCustomerNames(businessId, leads) {
  if (!Array.isArray(leads) || !leads.length) return leads;
  const needy = leads.filter((l) => l.customer_id && !leadOwnName(l));
  if (!needy.length) return leads;
  const ids = [...new Set(needy.map((l) => l.customer_id))];
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, first_name, last_name, display_name FROM customers WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})`
    ).all(businessId, ...ids);
  } catch { rows = []; /* customers table absent / not migrated */ }
  const byId = new Map(rows.map((c) => [c.id, c]));
  for (const l of needy) {
    const c = byId.get(l.customer_id);
    const nm = c && (c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' '));
    if (nm) l.customer_name = nm;
  }
  return leads;
}

// Append a timestamped line to the lead's free-text internal log.
function appendInternalNote(leadId, existingNotes, line) {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${line}`;
  const combined = existingNotes ? `${existingNotes}\n${entry}` : entry;
  db.prepare('UPDATE leads SET internal_notes = ? WHERE id = ?').run(combined, leadId);
}

// Pickup date = delivery date + rental duration (whole days). Mirrors the
// client booking modal's calcPickupFromDuration so manual entries land on the
// same pickup the dispatcher would expect. Returns ISO YYYY-MM-DD or null.
function calcPickupFromDuration(deliveryISO, days) {
  if (!deliveryISO || !(days >= 1)) return null;
  const d = new Date(`${deliveryISO}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

// ── Booked-schedule write guard ────────────────────────────────────────────────
// A confirmed (booked/operational) job's schedule is load-bearing — it drives the
// calendar, inventory, completion, and payment. Once a job is booked, its
// delivery/pickup/time/duration must not be silently lost on the write path:
//   • An EMPTY incoming schedule field never nulls a non-empty booked value
//     (protects against a partial save blanking good data — applies to ALL callers).
//   • A real (non-empty) schedule CHANGE to a booked job is applied directly for the
//     OWNER (an authenticated edit — the normal Edit Job Details / Mark Booked PUT),
//     but a CALL-DRIVEN / automated change is diverted to an approval item instead
//     of being written (see the reschedule-approval flow in PUT /:id).
// Unbooked leads (inquiries/opportunities) are never gated — booking, rescheduling,
// and clearing all behave exactly as before until a job is actually booked.
// The confirmed/operational set (EXCLUDING completed) is the canonical ACTIVE_JOB_STATUS_SET.

function isEmptyScheduleVal(v) {
  return v === undefined || v === null || v === '';
}

// Mutates `updates` (flat columns) and `vdPatch` (vertical_data patch) in place to
// enforce the guard above, returning the call-driven changes it diverted as
// { field, from, to } entries. A no-op for any lead that isn't already booked.
function guardBookedSchedule({ existing, updates, vdPatch, currentVd, req }) {
  const diverted = [];
  const existingBooked = ACTIVE_JOB_STATUS_SET.has(existing.job_status) || existing.status === LEGACY_STATUS.BOOKED;
  if (!existingBooked) return diverted;

  // Owner edits carry a valid JWT (attachBusiness populates req.user); the iOS app
  // and any automated/call-driven caller do not. A caller may also self-identify as
  // call-driven via source:'call' | automated:true. Owner edits are NEVER gated.
  const isOwnerEdit = !!req.user && req.body.source !== 'call' && req.body.automated !== true;

  // The four schedule fields, with where each lives (flat column vs vertical_data).
  const fields = [
    { key: 'delivery_date', loc: 'flat', incoming: updates.delivery_date, current: existing.delivery_date },
    { key: 'pickup_date', loc: 'flat', incoming: updates.pickup_date, current: existing.pickup_date },
    { key: 'scheduled_time', loc: 'flat', incoming: updates.scheduled_time, current: existing.scheduled_time },
    { key: 'rentalDuration', loc: 'vd', incoming: vdPatch ? vdPatch.rentalDuration : undefined, current: currentVd.rentalDuration },
  ];

  const drop = (f) => {
    if (f.loc === 'flat') delete updates[f.key];
    else if (vdPatch) delete vdPatch[f.key];
  };

  for (const f of fields) {
    if (f.incoming === undefined) continue;               // not in this request — untouched
    // (a) Never let an empty incoming value null a non-empty booked value.
    if (isEmptyScheduleVal(f.incoming)) {
      if (!isEmptyScheduleVal(f.current)) drop(f);         // preserve existing booked value
      continue;
    }
    // (b) A real (non-empty) change to a booked schedule field.
    if (String(f.incoming) === String(f.current ?? '')) continue;   // same value — nothing to guard
    if (isOwnerEdit) continue;                             // owner meant it — apply directly
    diverted.push({ field: f.key, from: f.current ?? null, to: f.incoming });  // call-driven → divert
    drop(f);
  }

  return diverted;
}

// Human-readable summary of a diverted reschedule, for the activity log + UI.
function describeReschedule(diverted) {
  const LABELS = {
    delivery_date: 'delivery date', pickup_date: 'pickup date',
    scheduled_time: 'delivery time', rentalDuration: 'duration',
  };
  const parts = diverted.map(d => `${LABELS[d.field] || d.field} ${d.from || 'not set'} → ${d.to}`);
  return `Customer requested reschedule — ${parts.join(', ')}`.slice(0, 500);
}

// Device tokens registered for a business (mirrors upload.js). Best-effort.
function getBusinessDeviceTokens(businessId) {
  try {
    return db.prepare('SELECT device_token FROM devices WHERE business_id = ?')
      .all(businessId).map(d => d.device_token);
  } catch {
    return [];
  }
}

// Push the owner an approval prompt for a call-driven reschedule (mirrors the
// new-lead push in upload.js — same { type, leadId } data the iOS app routes on).
function notifyRescheduleApproval(lead) {
  try {
    const tokens = getBusinessDeviceTokens(lead.business_id);
    const name = getLeadDisplayName(lead) || 'A customer';
    sendToAll(tokens, 'Reschedule request', `${name} asked to change a booked job — tap to approve`, {
      type: 'reschedule_approval', leadId: lead.id,
    }).catch(err => console.error('[leads] reschedule push failed:', err.message));
  } catch (err) {
    console.error('[leads] reschedule notify error:', err.message);
  }
}

// Sibling of notifyRescheduleApproval for a call-driven cancellation cue — the owner
// confirms or disregards it from the Action Queue (confirm-first; never auto-cancels).
function notifyCancelApproval(lead) {
  try {
    const tokens = getBusinessDeviceTokens(lead.business_id);
    const name = getLeadDisplayName(lead) || 'A customer';
    sendToAll(tokens, 'Cancellation request', `${name} may want to cancel a booked job — tap to review`, {
      type: 'cancel_approval', leadId: lead.id,
    }).catch(err => console.error('[leads] cancel push failed:', err.message));
  } catch (err) {
    console.error('[leads] cancel notify error:', err.message);
  }
}

// Push the owner a "draft invoice ready to review" prompt for a call-driven swap /
// extension (mirrors notifyRescheduleApproval). The draft is NOT sent to the customer —
// the owner reviews + sends it from the Action Queue (Part 2). Best-effort; never throws.
function notifyInvoiceReview(lead, { kind, amount } = {}) {
  try {
    const tokens = getBusinessDeviceTokens(lead.business_id);
    const name = getLeadDisplayName(lead) || 'A customer';
    const what = kind === 'swap_extension'
      ? 'swap out the dumpster and extend the rental'
      : kind === 'extension' ? 'extend the rental' : 'swap out the dumpster';
    const amt = amount != null ? ` ($${amount})` : '';
    sendToAll(tokens, 'Invoice to review', `${name} called to ${what} — a draft invoice${amt} is ready to review`, {
      type: 'invoice_review', leadId: lead.id,
    }).catch(err => console.error('[leads] invoice-review push failed:', err.message));
  } catch (err) {
    console.error('[leads] invoice-review notify error:', err.message);
  }
}

// ── Shared owner-approval producers ─────────────────────────────────────────────
// Record a call-driven schedule change or cancellation as a PENDING request on the
// BOOKED lead's vertical_data (the booked schedule itself is never touched), then run
// the standard trio: timeline log + socket refresh + owner push. The dashboard's
// Action Queue already renders these (rescheduleRequest → Approve/Reject, cancelRequest
// → Confirm/Disregard) with no client change. Both the PUT /:id handler (owner edit
// diverted by guardBookedSchedule) and the webhook (call-intent classifier) call these,
// so the shape and side-effects live in exactly one place. parse→set→stringify→UPDATE
// follows the existing cancel handler's idiom.

// changes: [{ field: 'delivery_date'|'pickup_date'|'scheduled_time'|'rentalDuration', from, to }]
// — the exact shape guardBookedSchedule returns. Only the fields that actually changed.
// rescheduleRequest carries the snake_case schedule columns + camelCase rentalDuration
// that handleRescheduleDecision reads back on Approve; extra keys (requestedAt) are ignored.
function recordRescheduleRequest(bookedLead, changes) {
  if (!bookedLead || !Array.isArray(changes) || !changes.length) return bookedLead || null;
  let vd = {};
  try { vd = bookedLead.vertical_data ? JSON.parse(bookedLead.vertical_data) : {}; } catch { vd = {}; }
  const rescheduleRequest = { requestedAt: new Date().toISOString() };
  for (const c of changes) rescheduleRequest[c.field] = c.to;
  vd.rescheduleRequest = rescheduleRequest;

  const now = new Date().toISOString();
  db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(vd), now, bookedLead.id);
  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(bookedLead.id);

  logActivity(updated.id, 'reschedule_requested', describeReschedule(changes));
  emitToBusiness(updated.business_id, 'lead_updated', updated);
  notifyRescheduleApproval(updated);
  return updated;
}

// Sets cancelRequest (any truthy value — no sub-fields are read by the client) and
// clears any prior cancelDismissedAt so a fresh cancellation cue re-surfaces. Never
// sets a sibling dismissal marker (the client gates on !vd.cancelDismissedAt).
function recordCancelRequest(bookedLead, { reason } = {}) {
  if (!bookedLead) return null;
  let vd = {};
  try { vd = bookedLead.vertical_data ? JSON.parse(bookedLead.vertical_data) : {}; } catch { vd = {}; }
  vd.cancelRequest = { reason: reason || null, requestedAt: new Date().toISOString() };
  delete vd.cancelDismissedAt;

  const now = new Date().toISOString();
  db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(vd), now, bookedLead.id);
  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(bookedLead.id);

  const line = reason
    ? `Customer expressed intent to cancel — ${reason}`.slice(0, 500)
    : 'Customer expressed intent to cancel a booked job';
  logActivity(updated.id, 'cancel_requested', line);
  emitToBusiness(updated.business_id, 'lead_updated', updated);
  notifyCancelApproval(updated);
  return updated;
}

// GET /api/leads
router.get('/', (req, res) => {
  try {
    const { status, job_status, intent, search, sort, order, discarded, vertical } = req.query;

    let query = 'SELECT * FROM leads WHERE 1=1';
    const params = [];

    // Scope to the caller's business.
    query += ' AND business_id = ?';
    params.push(req.business.id);

    // Exclude discarded leads by default
    if (discarded !== 'include') {
      query += ' AND (discarded = 0 OR discarded IS NULL)';
    }

    // Missed calls are NOT leads — they only ever surface in the dashboard's
    // Action Queue, which opts in with includeMissed=true. Every other list,
    // count, and query (All Opportunities, Booked Jobs, lead lists, iOS) must
    // never see them, so exclude call_type = 'missed_call' by default.
    if (req.query.includeMissed !== 'true') {
      query += " AND (call_type != 'missed_call' OR call_type IS NULL)";
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (job_status) {
      query += ' AND job_status = ?';
      params.push(job_status);
    }

    if (intent) {
      query += ' AND customer_intent = ?';
      params.push(intent);
    }

    if (vertical) {
      // 'auto_dealer' is the default; include rows where vertical is NULL too
      // so legacy leads created before the vertical column existed still appear.
      if (vertical === 'auto_dealer') {
        query += " AND (vertical = ? OR vertical IS NULL)";
      } else {
        query += ' AND vertical = ?';
      }
      params.push(vertical);
    }

    if (search) {
      query += ' AND (customer_first_name LIKE ? OR customer_last_name LIKE ? OR phone LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    const allowedSort = [
      'created_at', 'updated_at', 'customer_last_name',
      'customer_intent', 'status', 'salesperson_name',
    ];
    const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortCol} ${sortDir}`;

    const leads = db.prepare(query).all(...params);
    // Fill a resolved customer_name from the linked customer for leads with no name of
    // their own, so dashboard rows show the real name instead of "Unknown".
    attachCustomerNames(req.business.id, leads);
    res.json(leads);
  } catch (err) {
    console.error('GET /leads error:', err);
    res.status(500).json({ error: 'Failed to retrieve leads' });
  }
});

// GET /api/leads/all — raw debug view: every lead for this business. Excludes
// discarded rows so binned (soft-deleted-customer) leads don't leak here — every
// other list already hides discarded, and this is the one raw path that didn't.
router.get('/all', (req, res) => {
  try {
    const leads = db.prepare('SELECT * FROM leads WHERE business_id = ? AND (discarded = 0 OR discarded IS NULL) ORDER BY created_at DESC').all(req.business.id);
    res.json(leads);
  } catch (err) {
    console.error('GET /leads/all error:', err);
    res.status(500).json({ error: 'Failed to retrieve leads' });
  }
});

// GET /api/leads/:id
router.get('/:id', (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, req.business.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    console.error('GET /leads/:id error:', err);
    res.status(500).json({ error: 'Failed to retrieve lead' });
  }
});

// GET /api/leads/:id/activity — full activity timeline for a lead, newest first
router.get('/:id/activity', (req, res) => {
  try {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, req.business.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(getActivityForLead(req.params.id));
  } catch (err) {
    console.error('GET /leads/:id/activity error:', err);
    res.status(500).json({ error: 'Failed to retrieve activity' });
  }
});

// GET /api/leads/:id/customer — resolve the CUSTOMER that owns this lead, robustly.
// The /leads/:id page is retired; every inbound navigation to a per-call lead
// redirects to the owning customer profile, and this is the resolver behind it.
// leads.customer_id is NULL for freshly-extracted (not-yet-reconciled), discarded,
// and deleted-customer leads, so we never trust the raw column:
// findOrCreateCustomerForLead does a normalized-phone match (or creates the
// person's own record when there's no phone/match) and we persist the link, exactly
// as reconcileCustomersForBusiness would. This guarantees every navigable lead
// resolves to a customer and never dead-ends. Read-or-create only — it never
// touches the call/transcription/extraction or booking pipeline. Business-scoped
// via the same attachBusiness as the rest of /api/leads; it widens no
// unauthenticated surface.
router.get('/:id/customer', (req, res) => {
  try {
    const businessId = req.business.id;
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const customerId = findOrCreateCustomerForLead(businessId, lead);
    // findOrCreateCustomerForLead returns null when the lead's phone belongs to a
    // BINNED (soft-deleted) customer — we never resurrect it here; restoring is an
    // explicit owner action. Treat as not-found rather than resolving into the Trash.
    if (!customerId) return res.status(404).json({ error: 'Customer not found' });

    // Persist the reconciliation so the lead stays linked and surfaces under the
    // right person on the next read (mirrors reconcileCustomersForBusiness's write).
    if (lead.customer_id !== customerId) {
      db.prepare('UPDATE leads SET customer_id = ? WHERE id = ? AND business_id = ?')
        .run(customerId, lead.id, businessId);
      recomputeCustomerStatus(customerId);
    }

    res.json({ customerId });
  } catch (err) {
    console.error('GET /leads/:id/customer error:', err);
    res.status(500).json({ error: 'Failed to resolve customer' });
  }
});

// PUT /api/leads/:id
router.put('/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const allowedFields = [
      'status', 'discarded', 'sub_vertical', 'outcome',
      'job_status', 'raw_delivery_date', 'delivery_date', 'scheduled_time', 'pickup_date', 'estimated_revenue',
      'customer_first_name', 'customer_last_name', 'phone', 'email', 'address',
      'voi_year', 'voi_make', 'voi_model', 'voi_trim', 'voi_color',
      'voi_stock_number', 'voi_vin', 'voi_new_or_used',
      'trade_year', 'trade_make', 'trade_model', 'trade_trim', 'trade_color',
      'trade_mileage', 'trade_condition', 'trade_payoff', 'trade_owned_or_leased',
      'budget_monthly', 'budget_total', 'down_payment', 'financing_interest',
      'credit_concerns', 'co_buyer',
      'appointment_set', 'appointment_date', 'appointment_time',
      'customer_intent', 'visit_type',
      'salesperson_name', 'lead_source',
      'call_summary', 'additional_notes', 'objections',
      'flag_urgent', 'flag_needs_manager', 'flag_duplicate_suspect', 'flag_reason',
      'paid_at', 'internal_notes',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // vertical_data is stored as a JSON blob. Allow partial merges, and auto-mirror
    // the flat delivery_date / pickup_date columns into vertical_data so the Lead
    // Detail page's field-pack display picks up changes from any caller (Confirm
    // Booking modal, schedule editor, etc.) without each caller needing to
    // duplicate the keys. Clone the patch so the booked-schedule guard can drop
    // diverted keys without mutating the request body.
    const vdPatch = (req.body.vertical_data && typeof req.body.vertical_data === 'object')
      ? { ...req.body.vertical_data }
      : null;

    let currentVd = {};
    try { currentVd = JSON.parse(existing.vertical_data || '{}'); } catch { currentVd = {}; }

    // Booked-schedule guard: protect a booked job's schedule from being nulled by
    // an empty save, and divert call-driven schedule changes to owner approval.
    // Owner edits pass through untouched. No-op for unbooked leads. Mutates
    // `updates` / `vdPatch` in place; returns the diverted call-driven changes.
    const divertedReschedule = guardBookedSchedule({ existing, updates, vdPatch, currentVd, req });

    // A diverted call-driven reschedule (guardBookedSchedule held it back) is NOT
    // written into this update — it's recorded as a PENDING request on the booked
    // lead's vertical_data below via the shared recordRescheduleRequest producer, so
    // the request shape + side-effects live in one place (also used by the webhook
    // call-intent path). The booked schedule itself stays unchanged either way.
    const needsVdMerge = vdPatch !== null
      || updates.delivery_date !== undefined
      || updates.pickup_date !== undefined;

    if (needsVdMerge) {
      const merged = { ...currentVd, ...(vdPatch || {}) };
      if (updates.delivery_date !== undefined) {
        merged.deliveryDate = updates.delivery_date;
        merged.deliveryDateISO = updates.delivery_date;
      }
      if (updates.pickup_date !== undefined) {
        merged.pickupDate = updates.pickup_date;
      }
      updates.vertical_data = JSON.stringify(merged);
    }

    // ── Payment-gated lifecycle reroute (home_services) ──────────────────────────
    // Booking is INITIATED, not completed, on this write: setting a job to 'booked'
    // while it's unpaid routes it to 'pending_payment' (email the link; reserve
    // nothing) — payment is what books it and pulls the dumpster. And 'completed' is
    // gated on full payment: an unpaid completion attempt lands in
    // 'awaiting_final_payment' instead. Forward transitions only; owner edits to
    // other fields and the reschedule-approval flow are untouched.
    let emailPaymentLink = false;
    // Base-rental invoice flags, set in the booking reroute below: whether this write
    // INITIATES booking (→ create the one base invoice) and whether it's paid at
    // booking (cash / already-paid → settle that invoice so the rollup stays paid).
    let initiateBaseInvoice = false;
    let baseInvoiceMarkPaid = false;
    // Explicit owner override (Mark Paid / book-without-link): book the job now
    // WITHOUT emailing a payment link — payment was collected outside Stream, so the
    // booking reserves the dumpster immediately. Confirmed in the UI and never
    // auto-set. When present it lets 'booked' persist for a job the invoice rollup
    // still reads as unpaid, instead of the normal reroute to pending_payment.
    const bookWithoutPayment = req.body.book_without_payment === true;
    const isHomeServicesLead = existing.vertical === 'home_services';
    if (isHomeServicesLead && updates.job_status !== undefined && updates.job_status !== existing.job_status) {
      const target = updates.job_status;
      const leadPaidAt = updates.paid_at !== undefined ? updates.paid_at : existing.paid_at;
      const payNow = jobLifecycle.paymentStatusFromInvoices(businessId, {
        leadIds: [existing.id], customerId: existing.customer_id || null, leadPaidAt,
      });
      const isPaid = payNow === 'paid';
      if (target === JOB_STATUS.BOOKED || target === JOB_STATUS.PENDING_PAYMENT) {
        // Booking is being initiated → materialize the base-rental invoice (below).
        initiateBaseInvoice = true;
        if (!isPaid && !bookWithoutPayment) {
          updates.job_status = JOB_STATUS.PENDING_PAYMENT;
          if (!existing.payment_link_emailed_at) emailPaymentLink = true;
        } else {
          // Already paid, or a cash book-without-payment override → 'booked' persists;
          // settle the base invoice so the rollup reads paid (not just lead.paid_at).
          baseInvoiceMarkPaid = true;
        }
      } else if (target === JOB_STATUS.COMPLETED && !isPaid) {
        updates.job_status = JOB_STATUS.AWAITING_FINAL_PAYMENT;
      }
    }

    // A pure call-driven reschedule can arrive with NO other field updates (the guard
    // dropped the schedule change); still fall through to record it below. Only run the
    // main UPDATE when there's actually something to write.
    const hasUpdates = Object.keys(updates).length > 0;
    if (!hasUpdates && !divertedReschedule.length) {
      return res.json(existing);
    }

    let updated = existing;
    if (hasUpdates) {
      updates.updated_at = new Date().toISOString();

      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = [...Object.values(updates), req.params.id, businessId];

      db.prepare(`UPDATE leads SET ${setClauses} WHERE id = ? AND business_id = ?`).run(...values);

      updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    }

    // Log a status_change touchpoint whenever job_status actually changes, and
    // refresh the linked customer's derived lifecycle status so the Customers
    // section reflects the new stage (no-op if the lead isn't linked yet).
    // Booking gets a single richer line ("Dumpster booked — 20 yard · delivery …")
    // instead of the generic "Status changed to booked" — one clean event, not two.
    if (updates.job_status !== undefined && updated.job_status !== existing.job_status) {
      let description;
      if (updated.job_status === JOB_STATUS.BOOKED) description = describeBooking(updated);
      else if (updated.job_status === JOB_STATUS.PENDING_PAYMENT) description = 'Booking initiated — payment link emailed (payment reserves the dumpster)';
      else description = `Status changed to ${updated.job_status}`;
      logActivity(updated.id, 'status_change', description);
      if (updated.customer_id) recomputeCustomerStatus(updated.customer_id);
    }

    // The Edit Job Details modal sends a prebuilt, timezone-correct summary of
    // exactly what the owner changed (size, delivery date, duration, time,
    // follow-up) — e.g. "Job details updated — delivery date Jun 26 → Jun 30".
    // Persist it as ONE audit line. The client omits it when nothing changed, so
    // there are no empty events. Bounded + fixed type — not a general log sink.
    const editSummary = typeof req.body.job_edit_summary === 'string'
      ? req.body.job_edit_summary.trim() : '';
    if (editSummary) {
      logActivity(updated.id, 'job_updated', editSummary.slice(0, 500));
    }

    // Owner recorded payment (Mark Paid sets paid_at) → recompute the payment axis
    // and auto-advance the lifecycle (pending_payment → booked and reserve+schedule,
    // or awaiting_final_payment → completed when fully paid). Re-read so the response
    // reflects any advance.
    if (updates.paid_at !== undefined && updates.paid_at) {
      try {
        jobLifecycle.advanceOnPayment(businessId, updated.id);
        updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
      } catch (e) { console.error('[leads] advanceOnPayment error:', e.message); }
    }

    // Booking initiated on this write → materialize the base-rental charge as a real
    // 'sent' invoice (the SAME mechanism the weight overage uses) so it shows in the
    // Invoices section and feeds the settled rollup that gates completion. One per job
    // (deduped in the helper). A cash / already-paid booking settles it so the rollup
    // reads paid. On an unpaid booking (emailPaymentLink) it EMAILS the modern /invoice
    // link (contract + e-signature + card) — the sole booking notice, replacing the
    // legacy /pay email. Re-read so the response reflects any advance (mark-paid → booked).
    if (initiateBaseInvoice) {
      try {
        jobLifecycle.ensureBaseInvoice(businessId, updated, { emailLink: emailPaymentLink, markPaidNow: baseInvoiceMarkPaid, via: 'owner' });
        updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
      } catch (e) { console.error('[leads] ensureBaseInvoice error:', e.message); }
    }

    // A call-driven attempt to change the booked schedule was diverted (not written).
    // Record it as a pending reschedule request via the shared producer (own write +
    // timeline log + socket refresh + owner push) so it surfaces as a Tier-1 "approve
    // reschedule?" item in the Action Queue. The schedule itself was preserved by
    // guardBookedSchedule above. Also covers a pure-reschedule PUT (no other updates).
    if (divertedReschedule.length) {
      updated = recordRescheduleRequest(updated, divertedReschedule) || updated;
    }

    res.json(updated);
  } catch (err) {
    console.error('PUT /leads/:id error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// POST /api/leads/:id/resend-payment-sms
router.post('/:id/resend-payment-sms', async (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, req.business.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const result = await sendPaymentSms(lead, true);

    const updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, req.business.id);

    if (result.sent) {
      emitToBusiness(updated.business_id, 'payment_sms_sent', {
        leadId: updated.id,
        customerName: result.customerName,
        phone: result.phone,
      });
    }

    res.json({ ...result, lead: updated });
  } catch (err) {
    console.error('POST /leads/:id/resend-payment-sms error:', err);
    res.status(500).json({ error: 'Failed to resend payment SMS' });
  }
});

// POST /api/leads/:id/call — outbound click-to-call. Twilio rings Austin's
// cell first, then bridges him to the customer with the Valley Binz number as
// the caller ID the customer sees.
router.post('/:id/call', async (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, req.business.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const customerName = getLeadDisplayName(lead);
    const result = await initiateClickToCall(lead, customerName);

    if (!result.success) {
      const msgByReason = {
        no_credentials: 'Calling is not configured',
        no_user_number: 'Your phone number is not configured',
        no_phone: 'This lead has no valid phone number',
      };
      const message = msgByReason[result.reason] || result.error || 'Call failed';
      // Log the failed attempt too, so the timeline is complete.
      appendInternalNote(lead.id, lead.internal_notes, `Outbound call attempt failed: ${message}`);
      const status = result.reason === 'no_phone' ? 400 : 502;
      return res.status(status).json({ error: message, reason: result.reason });
    }

    appendInternalNote(
      lead.id,
      lead.internal_notes,
      `Outbound click-to-call initiated to ${result.customerPhone} (call SID ${result.callSid}). Your phone will ring first.`
    );
    logActivity(lead.id, 'outbound_call', 'Outbound call initiated');

    res.json({ success: true, callSid: result.callSid });
  } catch (err) {
    console.error('POST /leads/:id/call error:', err);
    res.status(500).json({ error: 'Failed to start call' });
  }
});

// POST /api/leads/manual — owner-created lead/job for customers who didn't come
// in through a phone call (walk-in, text, email, manual entry). Web-dashboard
// only, so it requires a real token rather than the soft attachBusiness above.
router.post('/manual', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const b = req.body || {};
    const str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

    // Contact
    const firstName = str(b.firstName);
    const lastName = str(b.lastName);
    const phone = str(b.phone);
    const email = str(b.email);

    // Optional explicit customer link (from the customer profile's Create Job flow).
    // Today leads reconcile to a customer by phone only; when the owner starts a job
    // FROM a customer profile we link that customer directly (validated below), so the
    // job lands under the right person even if the phone is edited. NULL → phone
    // reconciliation runs after insert, exactly as before.
    const customerIdRaw = b.customerId == null ? null : Number(b.customerId);

    // Job details (dumpster_rental). vertical/sub_vertical are accepted so this
    // endpoint stays usable as more verticals get manual entry, defaulting to the
    // home_services dumpster_rental schema the form is built around.
    const vertical = str(b.vertical) || 'home_services';
    const subVertical = str(b.subVertical) || 'dumpster_rental';
    const dumpsterSize = str(b.dumpsterSize);
    const debrisType = str(b.debrisType);
    const deliveryDate = str(b.deliveryDate); // ISO YYYY-MM-DD from the date picker
    const rentalDurationDays = b.rentalDuration === '' || b.rentalDuration == null
      ? null : Number(b.rentalDuration);
    const deliveryAddress = str(b.deliveryAddress);
    // Contact/primary address for the customer (billing-style), distinct from the
    // per-job delivery address above. When the form's "same as delivery" box is checked
    // the client sends the same value for both. Applied to the customer below (new
    // customers only), never to the job's vertical_data.
    const contactAddress = str(b.contactAddress);
    const accessNotes = str(b.accessNotes);
    const scheduledTime = str(b.scheduledTime); // "HH:mm" delivery time (optional)

    // Quote / payment. When the owner leaves the price blank we fall back to the
    // configured pricing model (resolver) below, so a booked job still gets a computed
    // amount — the same resolver the client prefill and auto-book use. An explicit
    // price always wins (owner-overridable).
    let priceNum = b.price === '' || b.price == null ? null : Number(b.price);
    let hasPrice = priceNum != null && !Number.isNaN(priceNum);
    // "Mark Paid" is the book-without-link override: the owner collected payment
    // outside Stream (cash/card in person). It books immediately AND records the
    // payment — no link is emailed — and is treated the same as an explicit paid
    // status below.
    const markPaid = b.markPaid === true;
    const paymentStatus = (markPaid || b.paymentStatus === 'paid')
      ? 'Paid' : (b.paymentStatus === 'not_paid' ? 'Not paid' : null);

    // Status / intent. "Send Payment Link" / "Book Job" (or picking Booked)
    // INITIATES booking, which is payment-gated: unpaid → pending_payment (email the
    // link, reserve nothing); already paid — Mark Paid or an explicit paid status —
    // → booked immediately (reserved). Booking a job and recording payment are
    // independent axes, so Mark Paid does both in one shot.
    const book = b.book === true;
    const chosenJobStatus = [JOB_STATUS.INQUIRY, JOB_STATUS.OPPORTUNITY, JOB_STATUS.BOOKED].includes(b.jobStatus)
      ? b.jobStatus : JOB_STATUS.INQUIRY;
    const wantsBooked = book || markPaid || chosenJobStatus === JOB_STATUS.BOOKED;
    const alreadyPaid = paymentStatus === 'Paid';
    const jobStatus = wantsBooked
      ? (alreadyPaid ? JOB_STATUS.BOOKED : JOB_STATUS.PENDING_PAYMENT)
      : chosenJobStatus;
    const intent = ['cold', 'warm', 'high'].includes(b.intent) ? b.intent : null;
    const notes = str(b.notes);

    // Validation: minimal contact only (name + phone). Job details are ALL optional —
    // a customer can be created with every job field blank; the lead lands as an
    // inquiry with those fields shown blank + editable on the profile (Edit Job
    // Details). Creation and job entry are one pass; nothing here forces a size, date,
    // or price up front.
    if (!firstName) return res.status(400).json({ error: 'Customer first name is required' });
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    // Resolve an explicit customer link if one was supplied and belongs to this
    // business. Invalid/foreign ids are ignored (we fall back to phone reconcile),
    // never trusted, so this can't attach a job to another tenant's customer.
    let linkedCustomerId = null;
    // Whether a customer already exists for this booking (explicit link or a phone
    // match). Drives the contact-address no-clobber below: a brand-new customer gets the
    // typed contact address; an existing customer's saved address is left untouched.
    let customerPreexisted = false;
    if (Number.isFinite(customerIdRaw)) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?').get(customerIdRaw, businessId);
      if (cust) { linkedCustomerId = cust.id; customerPreexisted = true; }
    }

    // ── Same-phone / different-name confirm gate ─────────────────────────────────
    // A phone number maps to exactly ONE customer (matching is phone-only). When this
    // booking wasn't started from a specific customer profile (no explicit
    // linkedCustomerId) and the entered phone already belongs to a DIFFERENT-named
    // customer, don't silently attach the booking to that person — stop and let the
    // owner decide. They re-submit the SAME payload with confirmDifferentName:true to
    // attach it to that existing customer (linked directly, exactly like the
    // book-from-profile path), or cancel and fix the number. This is a per-request
    // flag, never a stored setting, and it changes neither the matcher nor the
    // one-phone-one-customer rule — it only asks first.
    const confirmDifferentName = b.confirmDifferentName === true;
    if (!linkedCustomerId) {
      const np = normalizePhone(phone);
      // A binned (soft-deleted) customer isn't an active customer: don't prompt
      // "belongs to X" for a trashed X, and don't attach this booking to it. The new
      // lead stays unlinked (reconcile's guard won't resurrect the binned customer)
      // until that customer is restored — deleted_at IS NULL scopes to active only.
      const existingCustomer = np
        ? db.prepare('SELECT * FROM customers WHERE business_id = ? AND normalized_phone = ? AND deleted_at IS NULL').get(businessId, np)
        : null;
      if (existingCustomer) {
        customerPreexisted = true;
        // The customer's real name only (no phone/"Unknown" fallback): a nameless
        // existing customer isn't a "different name", so it never prompts.
        const existingName = (existingCustomer.display_name
          || [existingCustomer.first_name, existingCustomer.last_name].filter(Boolean).join(' ')
          || existingCustomer.company
          || '').trim();
        const enteredName = [firstName, lastName].filter(Boolean).join(' ').trim();
        const namesDiffer = existingName && enteredName
          && existingName.toLowerCase() !== enteredName.toLowerCase();
        if (namesDiffer && !confirmDifferentName) {
          // Nothing is created yet — the client shows a confirm dialog with these.
          // Sent as 409 (not 200) ON PURPOSE: a non-2xx makes any client fail SAFE —
          // it surfaces the error instead of treating this as a created lead and
          // redirecting to a lead that doesn't exist. The confirm-aware client reads
          // the body to open its dialog; `error` is a sensible fallback message for
          // any client that doesn't.
          return res.status(409).json({
            needsConfirmation: true,
            reason: 'phone_belongs_to_different_customer',
            existingCustomer: { id: existingCustomer.id, name: existingName },
            error: `This phone number already belongs to ${existingName}.`,
          });
        }
        // Names match/blank → fall through: linkedCustomerId stays null and phone
        // reconcile attaches + enriches this customer exactly as before. Confirmed
        // different name → link the booking DIRECTLY to that existing customer, the
        // same explicit link the book-from-profile path uses.
        if (namesDiffer) linkedCustomerId = existingCustomer.id;
      }
    }

    // No explicit price but we have a size → compute the suggested amount from the
    // pricing model (base rental for the duration + any flat delivery fee), applying
    // the linked customer's discount/override. Best-effort; leaves blank if unpriceable.
    if (!hasPrice && dumpsterSize) {
      try {
        const ps = require('../services/pricingService');
        const custRow = linkedCustomerId
          ? db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(linkedCustomerId, businessId)
          : null;
        const q = ps.resolvePrice(businessId, { size: dumpsterSize, days: rentalDurationDays >= 1 ? rentalDurationDays : 1, customer: custRow });
        if (q.priceable && q.total != null) {
          const delivery = ps.getDeliveryFee(businessId);
          priceNum = ps.round2(q.total + (delivery ? delivery.amount : 0));
          hasPrice = true;
        }
      } catch (e) { console.error('[leads/manual] price resolve error:', e.message); }
    }

    const pickupDate = calcPickupFromDuration(deliveryDate, rentalDurationDays);
    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    const quotedPrice = hasPrice ? `$${priceNum}` : null;
    const isBooked = jobStatus === JOB_STATUS.BOOKED;
    const isPendingPayment = jobStatus === JOB_STATUS.PENDING_PAYMENT;
    const outcome = (isBooked || isPendingPayment) ? 'booked' : 'quote_requested';

    // vertical_data mirrors the dumpster_rental field pack so the Industry
    // Details / Quote sections render the same as a call-captured lead.
    const verticalData = {
      customerName: fullName || null,
      dumpsterSize: dumpsterSize || null,
      debrisType: debrisType || null,
      deliveryAddress: deliveryAddress || null,
      accessNotes: accessNotes || null,
      quotedPrice,
      paymentStatus,
      intentLevel: intent,
      outcome,
      source: 'manual',
    };
    if (deliveryDate) {
      verticalData.deliveryDate = deliveryDate;
      verticalData.deliveryDateISO = deliveryDate;
      verticalData.rawDeliveryDate = deliveryDate;
    }
    if (pickupDate) verticalData.pickupDate = pickupDate;
    if (rentalDurationDays >= 1) verticalData.rentalDuration = `${Math.round(rentalDurationDays)} days`;
    if (notes) {
      verticalData.notes = notes;
      // Surface the owner's note as the at-a-glance recommendation on cards.
      verticalData.aiRecommendation = notes;
    }

    const nowISO = new Date().toISOString();
    const legacyStatus = isBooked ? 'booked' : 'new';
    // Already-collected payment: record it and skip the payment link below.
    const paidAt = alreadyPaid ? nowISO : null;
    const paymentStatusCol = alreadyPaid ? 'paid' : 'unpaid';

    const insert = db.prepare(`
      INSERT INTO leads (
        business_id, customer_id, vertical, sub_vertical, source, call_type, extraction_type,
        customer_first_name, customer_last_name, phone, email,
        status, job_status, outcome, customer_intent,
        delivery_date, raw_delivery_date, pickup_date, scheduled_time, estimated_revenue,
        paid_at, payment_status, vertical_data, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(
      businessId, linkedCustomerId, vertical, subVertical, 'manual', 'manual', 'manual',
      firstName, lastName || null, phone, email || null,
      legacyStatus, jobStatus, outcome, intent || null,
      deliveryDate || null, deliveryDate || null, pickupDate || null, scheduledTime || null, hasPrice ? priceNum : null,
      paidAt, paymentStatusCol, JSON.stringify(verticalData), nowISO, nowISO
    );

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(result.lastInsertRowid));

    logActivity(lead.id, 'note_added', 'Lead manually created by owner');

    // Attach the new lead to a customer. An explicit customer_id (Create Job from a
    // profile) was set on insert above — just refresh that customer's derived status.
    // Otherwise fall back to find-or-create by phone so it still surfaces under the
    // right person in the Customers section.
    try {
      if (linkedCustomerId) recomputeCustomerStatus(linkedCustomerId);
      else reconcileCustomersForBusiness(businessId);
    } catch (e) { console.error('[leads/manual] reconcile error:', e.message); }

    // Contact address → the customer's primary/contact address. No-clobber: only a
    // customer this booking just CREATED gets it set; an existing customer's saved
    // address is left untouched for now (the edit page will own updates to it). The
    // per-job delivery address is unaffected — it lives in vertical_data.deliveryAddress
    // and still drives the schedule/driver. Reconcile seeds a new customer's address
    // from the delivery address; for a contractor (different contact vs delivery site)
    // this makes the typed contact address authoritative instead.
    if (contactAddress && !customerPreexisted) {
      try {
        const linkedRow = db.prepare('SELECT customer_id FROM leads WHERE id = ?').get(lead.id);
        const newCustomerId = linkedRow && linkedRow.customer_id;
        if (newCustomerId) {
          db.prepare('UPDATE customers SET address = ?, updated_at = ? WHERE id = ? AND business_id = ?')
            .run(contactAddress, new Date().toISOString(), newCustomerId, businessId);
        }
      } catch (e) { console.error('[leads/manual] contact address error:', e.message); }
    }

    // Booking initiated (Send Payment Link / Book Job / Mark Paid) → materialize the
    // base-rental charge as a real 'sent' invoice, the SAME mechanism the weight
    // overage uses. It shows in the profile's Invoices section and feeds the settled
    // rollup that gates completion. Cash "Mark Paid" (alreadyPaid) settles the base
    // invoice so it counts as paid in the rollup — not just lead.paid_at. Deduped in
    // the helper (exactly one base invoice per job). Re-read so customer_id (just
    // reconciled) links the invoice to the right person.
    if (wantsBooked) {
      try {
        const bookedLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
        // emailLink:true → an unpaid booking EMAILS the modern /invoice link (contract +
        // e-signature + card); a booked+paid entry (markPaidNow: alreadyPaid) settles it
        // and sends nothing. Replaces the legacy /pay payment-link email.
        jobLifecycle.ensureBaseInvoice(businessId, bookedLead, { emailLink: true, markPaidNow: alreadyPaid, via: 'manual' });
      } catch (e) { console.error('[leads/manual] base invoice error:', e.message); }
    }

    emitToBusiness(lead.business_id, 'new_lead', lead);
    res.status(201).json(lead);
  } catch (err) {
    console.error('POST /leads/manual error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

// POST /api/leads/:id/dump-ticket — manual weight / dump-ticket entry for a returned
// unit (the OCR feature will call the SAME jobLifecycle path with source:'ocr'). Body:
//   { weightTons?, swap?, unitsRemaining?, note? }
// Records the ticket + any overage (invoice when a rate is configured, else flagged),
// then advances the lifecycle SWAP-SAFELY (only past active_rental once no unit is
// still out). Web-dashboard only → hard auth.
router.post('/:id/dump-ticket', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const b = req.body || {};
    const weightTons = b.weightTons === '' || b.weightTons == null ? null : Number(b.weightTons);
    if (weightTons != null && (Number.isNaN(weightTons) || weightTons < 0)) {
      return res.status(400).json({ error: 'weightTons must be a non-negative number' });
    }
    const result = jobLifecycle.recordDumpTicket(businessId, lead, {
      weightTons,
      swap: b.swap === true,
      unitsRemaining: b.unitsRemaining,
      note: typeof b.note === 'string' ? b.note.trim() : null,
      source: 'manual',
    });
    if (result.error === 'not_found') return res.status(404).json({ error: 'Lead not found' });

    const updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    res.json({
      lead: updated,
      overage: result.overage || null,
      advancedTo: result.advancedTo || null,
      unitsOut: result.unitsOut,
      overageInvoiceId: result.overageInvoiceId || null,
    });
  } catch (err) {
    console.error('POST /leads/:id/dump-ticket error:', err);
    res.status(500).json({ error: 'Failed to record dump ticket' });
  }
});

// POST /api/leads/:id/cancel — resolve a confirm-first cancellation (the Action
// Queue "Customer expressed intent to cancel — confirm or disregard" item). Body:
//   { confirm: true }  → move the job to the 'lost' terminal state.
//   { confirm: false } → disregard: leave the job unchanged, and stamp the call so
//                        the nudge stops re-surfacing.
// Confirm-first by design — a detected cancellation intent NEVER auto-cancels. Web
// dashboard only → hard auth.
router.post('/:id/cancel', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    let vd = {};
    try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
    const now = new Date().toISOString();
    const confirm = req.body && req.body.confirm === true;

    if (confirm) {
      vd.cancelledAt = now;
      vd.closeReason = 'cancelled';
      delete vd.cancelRequest;
      db.prepare('UPDATE leads SET job_status = ?, vertical_data = ?, updated_at = ? WHERE id = ?')
        .run(JOB_STATUS.LOST, JSON.stringify(vd), now, lead.id);
      logActivity(lead.id, 'status_change', 'Cancellation confirmed — job marked lost');
    } else {
      // Disregard: record that the owner dismissed the cancellation cue so the
      // Action Queue nudge doesn't keep re-appearing. Job left exactly as-is.
      vd.cancelDismissedAt = now;
      delete vd.cancelRequest;
      db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(vd), now, lead.id);
      logActivity(lead.id, 'note_added', 'Cancellation cue disregarded — job unchanged');
    }

    const updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (updated.customer_id) recomputeCustomerStatus(updated.customer_id);
    emitToBusiness(updated.business_id, 'lead_updated', updated);
    res.json({ lead: updated, cancelled: confirm });
  } catch (err) {
    console.error('POST /leads/:id/cancel error:', err);
    res.status(500).json({ error: 'Failed to resolve cancellation' });
  }
});

// Extension inventory warning: would keeping this size out `extraDays` more days collide
// with a later booking of the same size? The extra-days window is [pickup, pickup+N), and
// the size is short if no unit is free across it (same overlapping-active-jobs math the
// booking modal uses). Returns the warning object or null. Shared by the review GET and the
// extension recompute route so BOTH report the same conflict for a given extra-days value.
// Read-only availability math — never mutates anything.
function computeExtensionWarning(businessId, lead, size, extraDays) {
  const n = Math.max(0, Math.round(Number(extraDays)) || 0);
  if (n < 1 || !size || !lead || !lead.pickup_date) return null;
  try {
    const inv = require('../services/inventoryService');
    const basePickup = String(lead.pickup_date).slice(0, 10);
    const newPickup = inv.addDaysToISO(basePickup, n);
    const avail = inv.getAvailabilityForSize(size, basePickup, newPickup, lead.id, businessId);
    if (avail && avail.available <= 0) {
      return {
        size, extraDays: n, basePickup, newPickup,
        booked: avail.booked, quantity: avail.quantity,
        message: `Extending keeps a ${size} out ${n} more day(s) (through ${newPickup}), but every ${size} is already committed to another job in that window. Approving may leave you short a unit — confirm before sending.`,
      };
    }
  } catch (e) { console.error('[leads] extension warning failed:', e.message); }
  return null;
}

// GET /api/leads/:id/invoice-review — the pending call-driven DRAFT (Part 1) plus a
// SERVER-COMPUTED extension inventory warning. This runs the overlapping-active-jobs
// availability math, so it deliberately lives on the request/render path (hard auth,
// web dashboard) and is NEVER called from the Twilio webhook. Read-only.
router.get('/:id/invoice-review', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    let vd = {};
    try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
    const pir = vd.pendingInvoiceReview || null;
    if (!pir || !pir.invoiceId) {
      return res.json({ pendingInvoiceReview: null, invoice: null, extensionWarning: null, extensionNeedsRate: vd.extensionNeedsRate || null });
    }

    const invoiceService = require('../services/invoiceService');
    const invoice = invoiceService.getInvoice(businessId, pir.invoiceId) || null;

    // Extension inventory warning + the owner's editable extra-days control. The current
    // extra-days = the extension line's quantity (0 when the draft has no extension line yet).
    const extLine = invoice && Array.isArray(invoice.line_items)
      ? invoice.line_items.find((li) => li.line_type === 'service' && /^Rental extension/i.test(li.description || ''))
      : null;
    const extraDays = extLine ? (Math.max(0, Math.round(Number(extLine.quantity))) || 0) : 0;
    const size = pir.size || vd.dumpsterSize || null;
    const extensionWarning = computeExtensionWarning(businessId, lead, size, extraDays);

    // Extension review control: the size's day rate + the current extra-days so the owner can
    // set/adjust the extension on the review screen. Present whenever a size resolves — even a
    // swap-only draft, so the owner can ADD an extension here. needsRate → the size has no day
    // rate configured yet (the owner must add one on the Pricing page before it can be billed).
    let extensionReview = null;
    if (size) {
      const pricingService = require('../services/pricingService');
      const probe = pricingService.resolveExtensionPrice(businessId, { size, extraDays: Math.max(1, extraDays || 1) });
      extensionReview = {
        size, extraDays,
        dayRate: probe.needsRate ? null : probe.dayRate,
        needsRate: !!probe.needsRate,
        pickupDate: lead.pickup_date ? String(lead.pickup_date).slice(0, 10) : null,
      };
    }

    // Swap delivery date (owner-editable on the review screen): the swap window = the
    // ORIGINAL pickup date − this date (days remaining in the rental; a swap never extends
    // it). Default to the stored date, else the business's today. Only present when the
    // draft actually carries a swap line, so a pure-extension draft shows no control.
    let swapReview = null;
    const swapLine = invoice && Array.isArray(invoice.line_items)
      ? invoice.line_items.find((li) => li.line_type === 'service' && /^Swap replacement/i.test(li.description || ''))
      : null;
    if (swapLine && lead.pickup_date) {
      const swapDeliveryDate = pir.swapDeliveryDate || jobLifecycle.businessLocalToday(businessId);
      const days = jobLifecycle.daysBetweenISO(swapDeliveryDate, lead.pickup_date);
      swapReview = {
        size: pir.size || vd.dumpsterSize || null,
        swapDeliveryDate,
        pickupDate: String(lead.pickup_date).slice(0, 10),
        days: days != null && days >= 1 ? days : null,
      };
    }

    res.json({ pendingInvoiceReview: pir, invoice, extensionWarning, extensionReview, extensionNeedsRate: vd.extensionNeedsRate || null, swapReview });
  } catch (err) {
    console.error('GET /leads/:id/invoice-review error:', err);
    res.status(500).json({ error: 'Failed to load invoice review' });
  }
});

// POST /api/leads/:id/invoice-review/resolve — clear the pending draft-invoice marker
// after the owner acts from the review surface. Body:
//   { action: 'sent' }    → owner approved; the draft was delivered via the normal
//                           /api/invoices/:id/send flow. Just clear the marker + log.
//   { action: 'discard' } → dismiss a misclassified swap/extension: clear the marker,
//                           delete the still-inert draft, and drop any needs-rate note.
// Never sends anything itself (send goes through the existing endpoint) and never
// auto-applies a change to the customer — it only resolves owner-review state. Hard auth.
router.post('/:id/invoice-review/resolve', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    let vd = {};
    try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
    const pir = vd.pendingInvoiceReview || null;
    if (!pir) {
      const cur = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
      return res.json({ lead: cur, resolved: false, alreadyResolved: true });
    }

    const now = new Date().toISOString();
    const action = req.body && req.body.action === 'discard' ? 'discard' : 'sent';
    if (action === 'discard') {
      const invoiceId = pir.invoiceId;
      delete vd.pendingInvoiceReview;
      delete vd.extensionNeedsRate;   // dismissing the whole call-driven review
      db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vd), now, lead.id);
      // Remove the inert draft so it doesn't linger in the Invoices list.
      try {
        const invoiceService = require('../services/invoiceService');
        const r = invoiceService.deleteInvoice(businessId, invoiceId);
        if (r && r.ok) emitToBusiness(businessId, 'invoice_updated', { id: Number(invoiceId), deleted: true });
      } catch (e) { console.error('[leads] discard draft delete failed:', e.message); }
      logActivity(lead.id, 'note_added', 'Call-driven draft invoice discarded — not sent');
    } else {
      // 'sent': the delivery already happened via /invoices/:id/send — just clear the marker.
      delete vd.pendingInvoiceReview;
      db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vd), now, lead.id);
      logActivity(lead.id, 'note_added', 'Call-driven draft invoice reviewed and sent');
    }

    const updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (updated.customer_id) recomputeCustomerStatus(updated.customer_id);
    emitToBusiness(updated.business_id, 'lead_updated', updated);
    res.json({ lead: updated, resolved: true, action });
  } catch (err) {
    console.error('POST /leads/:id/invoice-review/resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve invoice review' });
  }
});

// POST /api/leads/:id/invoice-review/recompute-swap — the owner set/changed the swap's
// delivery date on the review screen. Recompute the swap line's day count (ORIGINAL pickup
// − delivery date = days remaining in the rental) and its price via the existing
// resolveSwapPrice, rewrite ONLY that line on the draft, and remember the date on the
// review marker. The pickup date is NEVER moved (a swap doesn't extend the rental). Never
// recomputes a signed/paid invoice (respects the invoice lock). Body: { swapDeliveryDate }.
// Hard auth, web dashboard only.
router.post('/:id/invoice-review/recompute-swap', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    let vd = {};
    try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
    const pir = vd.pendingInvoiceReview || null;
    if (!pir || !pir.invoiceId) return res.status(400).json({ error: 'No pending invoice review' });
    if (!lead.pickup_date) return res.status(400).json({ error: 'Job has no pickup date to measure the swap window against' });

    const swapDeliveryDate = typeof (req.body && req.body.swapDeliveryDate) === 'string' ? req.body.swapDeliveryDate.slice(0, 10) : null;
    if (!swapDeliveryDate || !/^\d{4}-\d{2}-\d{2}$/.test(swapDeliveryDate)) {
      return res.status(400).json({ error: 'swapDeliveryDate must be a YYYY-MM-DD date' });
    }
    const pickup = String(lead.pickup_date).slice(0, 10);
    const days = jobLifecycle.daysBetweenISO(swapDeliveryDate, pickup);
    if (days == null || days < 1) {
      return res.status(400).json({ error: 'The swap delivery date must be before the pickup date.' });
    }

    const invoiceService = require('../services/invoiceService');
    const invoice = invoiceService.getInvoice(businessId, pir.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Draft invoice not found' });
    if (invoice.status === 'signed' || invoice.status === 'paid') {
      return res.status(409).json({ error: 'This invoice is already signed or paid and can no longer be recomputed.' });
    }
    const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
    const swapIdx = items.findIndex((li) => li.line_type === 'service' && /^Swap replacement/i.test(li.description || ''));
    if (swapIdx < 0) return res.status(400).json({ error: 'This invoice has no swap line to recompute' });

    const size = pir.size || vd.dumpsterSize || null;
    const customer = lead.customer_id
      ? db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(lead.customer_id, businessId)
      : null;
    const pricingService = require('../services/pricingService');
    const sw = pricingService.resolveSwapPrice(businessId, { size, days, customer });
    if (!sw || sw.mode === 'off' || sw.amount == null) {
      return res.status(400).json({ error: `No swap price is configured for ${size || 'this size'}.` });
    }
    const description = `Swap replacement — ${size} (${days} day${days === 1 ? '' : 's'})`;

    // Rewrite ONLY the swap line (new remaining-days label + recomputed price); every other
    // line is passed through untouched. updateInvoice recomputes the totals authoritatively.
    const nextItems = items.map((li, i) => (i === swapIdx
      ? { ...li, description, quantity: 1, unit_rate: sw.amount }
      : li)).map((li) => ({
      description: li.description, line_type: li.line_type, quantity: li.quantity,
      unit: li.unit || null, unit_rate: li.unit_rate, service_key: li.service_key || null,
    }));
    const upd = invoiceService.updateInvoice(businessId, pir.invoiceId, { line_items: nextItems });
    if (upd.error) return res.status(upd.error === 'locked' ? 409 : 400).json({ error: upd.error });

    // Remember the chosen date on the review marker + refresh the shown draft amount.
    const now = new Date().toISOString();
    pir.swapDeliveryDate = swapDeliveryDate;
    if (upd.invoice && upd.invoice.total != null) pir.amount = upd.invoice.total;
    vd.pendingInvoiceReview = pir;
    db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vd), now, lead.id);
    try { emitToBusiness(businessId, 'invoice_updated', { id: Number(pir.invoiceId) }); } catch { /* non-fatal */ }

    res.json({ ok: true, swapDeliveryDate, days, amount: sw.amount, description, invoice: upd.invoice });
  } catch (err) {
    console.error('POST /leads/:id/invoice-review/recompute-swap error:', err);
    res.status(500).json({ error: 'Failed to recompute swap' });
  }
});

// POST /api/leads/:id/invoice-review/recompute-extension — the owner set/changed the extension's
// EXTRA DAYS on the review screen. Reprice via resolveExtensionPrice (extraDays × the size's day
// rate) and rewrite ONLY the extension line on the draft (swap + every other line untouched):
//   • extraDays >= 1 and the size has a day rate → add the priced extension line, or update it in
//     place; quantity = extraDays so the paid-extension pickup hook advances by exactly that many.
//   • extraDays === 0 → remove the extension line entirely.
//   • the size has no day rate → remove any extension line and flag needs-rate (never invent a
//     price — same deliberate block the create path uses).
// The pickup_date is NEVER moved here — it advances only when the extension invoice is PAID
// (applyExtensionOnPayment reads the settled line's quantity). Never recomputes a signed/paid
// invoice (respects the invoice lock → 409). Body: { extraDays }. Hard auth, web dashboard only.
router.post('/:id/invoice-review/recompute-extension', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    let vd = {};
    try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
    const pir = vd.pendingInvoiceReview || null;
    if (!pir || !pir.invoiceId) return res.status(400).json({ error: 'No pending invoice review' });

    const rawDays = Number(req.body && req.body.extraDays);
    if (!Number.isFinite(rawDays) || rawDays < 0) {
      return res.status(400).json({ error: 'extraDays must be a number >= 0' });
    }
    const extraDays = Math.max(0, Math.round(rawDays));

    const invoiceService = require('../services/invoiceService');
    const invoice = invoiceService.getInvoice(businessId, pir.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Draft invoice not found' });
    if (invoice.status === 'signed' || invoice.status === 'paid') {
      return res.status(409).json({ error: 'This invoice is already signed or paid and can no longer be recomputed.' });
    }
    const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
    const extIdx = items.findIndex((li) => li.line_type === 'service' && /^Rental extension/i.test(li.description || ''));

    const size = pir.size || vd.dumpsterSize || null;
    if (extraDays >= 1 && !size) {
      return res.status(400).json({ error: 'This job has no dumpster size to price an extension against.' });
    }

    // Canonical passthrough shape updateInvoice expects (matches recompute-swap): every line
    // other than the extension is handed back verbatim so nothing else on the draft moves.
    const canon = (li) => ({
      description: li.description, line_type: li.line_type, quantity: li.quantity,
      unit: li.unit || null, unit_rate: li.unit_rate, service_key: li.service_key || null,
    });

    let nextItems;
    let priced = null;
    let needsRate = false;
    let description = null;
    if (extraDays === 0) {
      // Zero extra days → drop the extension line entirely; clear any needs-rate note.
      nextItems = items.filter((_, i) => i !== extIdx).map(canon);
      delete vd.extensionNeedsRate;
    } else {
      const pricingService = require('../services/pricingService');
      const ext = pricingService.resolveExtensionPrice(businessId, { size, extraDays });
      if (ext.needsRate || ext.dayRate == null || ext.amount == null) {
        // No day rate for this size — never invent a price. Drop any priced line + flag needs-rate.
        needsRate = true;
        nextItems = items.filter((_, i) => i !== extIdx).map(canon);
        vd.extensionNeedsRate = { size, extraDays, at: new Date().toISOString() };
      } else {
        priced = ext;
        // Keep the 'Rental extension' prefix (applyExtensionOnPayment matches it) and
        // quantity = extraDays (that hook reads it at settlement) so pickup advances by N.
        description = `Rental extension — ${extraDays} extra day${extraDays === 1 ? '' : 's'}${size ? ` (${size})` : ''}`;
        const extLine = { description, line_type: 'service', quantity: extraDays, unit: 'day', unit_rate: ext.dayRate, service_key: null };
        nextItems = extIdx >= 0
          ? items.map((li, i) => (i === extIdx ? extLine : canon(li)))
          : [...items.map(canon), extLine];
        delete vd.extensionNeedsRate;
      }
    }

    const upd = invoiceService.updateInvoice(businessId, pir.invoiceId, { line_items: nextItems });
    if (upd.error) return res.status(upd.error === 'locked' ? 409 : 400).json({ error: upd.error });

    // Keep the review marker honest: refresh the amount and re-derive kind/parts from the
    // resulting lines (swap-only, extension-only, or both) so the Action Queue label matches.
    const finalItems = (upd.invoice && Array.isArray(upd.invoice.line_items)) ? upd.invoice.line_items : nextItems;
    const hasSwap = finalItems.some((li) => li.line_type === 'service' && /^Swap replacement/i.test(li.description || ''));
    const hasExt = finalItems.some((li) => li.line_type === 'service' && /^Rental extension/i.test(li.description || ''));
    const parts = [...(hasSwap ? ['swap'] : []), ...(hasExt ? ['extension'] : [])];
    pir.parts = parts;
    pir.kind = parts.length === 2 ? 'swap_extension' : (parts[0] || pir.kind || 'extension');
    if (upd.invoice && upd.invoice.total != null) pir.amount = upd.invoice.total;
    vd.pendingInvoiceReview = pir;
    const now = new Date().toISOString();
    db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vd), now, lead.id);
    try { emitToBusiness(businessId, 'invoice_updated', { id: Number(pir.invoiceId) }); } catch { /* non-fatal */ }
    try { emitToBusiness(businessId, 'lead_updated', db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(lead.id, businessId)); } catch { /* non-fatal */ }

    const extensionWarning = computeExtensionWarning(businessId, lead, size, extraDays);
    res.json({
      ok: true,
      extraDays,
      removed: extraDays === 0,
      needsRate,
      amount: priced ? priced.amount : null,
      dayRate: priced ? priced.dayRate : null,
      description,
      extensionWarning,
      invoice: upd.invoice,
    });
  } catch (err) {
    console.error('POST /leads/:id/invoice-review/recompute-extension error:', err);
    res.status(500).json({ error: 'Failed to recompute extension' });
  }
});

// DELETE /api/leads/:id
router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, req.business.id);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    db.prepare('DELETE FROM leads WHERE id = ? AND business_id = ?').run(req.params.id, req.business.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /leads/:id error:', err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

module.exports = router;
// Pure helpers exported for unit tests; the router itself ignores extra props.
module.exports.guardBookedSchedule = guardBookedSchedule;
module.exports.describeReschedule = describeReschedule;
// Shared owner-approval producers — also called by the webhook call-intent classifier
// so the reschedule/cancel request shape + side-effects live in exactly one place.
module.exports.recordRescheduleRequest = recordRescheduleRequest;
module.exports.recordCancelRequest = recordCancelRequest;
// Call-driven draft-invoice review push — fired by the webhook after a swap/extension
// draft is created (the draft itself is minted by jobLifecycle.ensureCallDrivenReviewInvoice).
module.exports.notifyInvoiceReview = notifyInvoiceReview;
