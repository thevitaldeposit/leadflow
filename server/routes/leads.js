const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { sendPaymentSms } = require('../services/smsService');
const { sendPaymentLinkEmail } = require('../services/emailService');
const jobLifecycle = require('../services/jobLifecycle');
const { initiateClickToCall } = require('../services/callService');
const { logActivity, getActivityForLead } = require('../services/activityLog');
const { emitToBusiness } = require('../socket');
const { attachBusiness, requireAuth } = require('../middleware/auth');
const { reconcileCustomersForBusiness, recomputeCustomerStatus, findOrCreateCustomerForLead } = require('../services/customerService');
const { describeBooking } = require('../services/leadActivityText');
const { sendToAll } = require('../services/apns');
const { JOB_STATUS, LEGACY_STATUS, ACTIVE_JOB_STATUS_SET } = require('../config/jobStatus');

// Shared with the iOS app, which doesn't send a token yet — soft auth scopes the
// request to the caller's business when a token is present, else to Valley Binz.
router.use(attachBusiness);

function getLeadDisplayName(lead) {
  let vd = {};
  try { vd = JSON.parse(lead.vertical_data || '{}'); } catch {}
  return vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
    || null;
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
    res.json(leads);
  } catch (err) {
    console.error('GET /leads error:', err);
    res.status(500).json({ error: 'Failed to retrieve leads' });
  }
});

// GET /api/leads/all — raw debug view: every lead for this business, no filtering
router.get('/all', (req, res) => {
  try {
    const leads = db.prepare('SELECT * FROM leads WHERE business_id = ? ORDER BY created_at DESC').all(req.business.id);
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
    if (!customerId) return res.status(500).json({ error: 'Could not resolve customer' });

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

    // A diverted reschedule is recorded as a PENDING request on vertical_data —
    // the booked schedule itself stays unchanged — so the owner can approve it from
    // the Action Queue. Approving re-issues these values as an owner edit.
    let pendingReschedule = null;
    if (divertedReschedule.length) {
      pendingReschedule = { requestedAt: new Date().toISOString() };
      for (const d of divertedReschedule) pendingReschedule[d.field] = d.to;
    }

    const effectiveVdPatch = pendingReschedule
      ? { ...(vdPatch || {}), rescheduleRequest: pendingReschedule }
      : vdPatch;
    const needsVdMerge = effectiveVdPatch !== null
      || updates.delivery_date !== undefined
      || updates.pickup_date !== undefined;

    if (needsVdMerge) {
      const merged = { ...currentVd, ...(effectiveVdPatch || {}) };
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
      if ((target === JOB_STATUS.BOOKED || target === JOB_STATUS.PENDING_PAYMENT) && !isPaid && !bookWithoutPayment) {
        updates.job_status = JOB_STATUS.PENDING_PAYMENT;
        if (!existing.payment_link_emailed_at) emailPaymentLink = true;
      } else if (target === JOB_STATUS.COMPLETED && !isPaid) {
        updates.job_status = JOB_STATUS.AWAITING_FINAL_PAYMENT;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.json(existing);
    }

    updates.updated_at = new Date().toISOString();

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), req.params.id, businessId];

    db.prepare(`UPDATE leads SET ${setClauses} WHERE id = ? AND business_id = ?`).run(...values);

    let updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);

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

    // Booking initiation EMAILS the payment link (SMS retired for this while A2P
    // approval is pending — sendPaymentSms is left intact but unused here). The send
    // stamps payment_link_emailed_at and is fire-and-forget so it never blocks the PUT.
    if (emailPaymentLink) {
      sendPaymentLinkEmail(updated).then((result) => {
        if (result.sent) {
          emitToBusiness(updated.business_id, 'payment_link_emailed', {
            leadId: updated.id, to: result.to, customerName: result.customerName,
          });
        }
      }).catch((err) => console.error('[leads] payment email error:', err));
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

    // A call-driven attempt to change the booked schedule was diverted (not
    // written). Record it on the timeline and notify the owner so it surfaces as a
    // Tier-1 "approve reschedule?" item in the Action Queue. The schedule itself
    // was preserved by guardBookedSchedule above.
    if (divertedReschedule.length) {
      logActivity(updated.id, 'reschedule_requested', describeReschedule(divertedReschedule));
      emitToBusiness(updated.business_id, 'lead_updated', updated);
      notifyRescheduleApproval(updated);
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
    if (Number.isFinite(customerIdRaw)) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?').get(customerIdRaw, businessId);
      if (cust) linkedCustomerId = cust.id;
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

    // Booking initiated but unpaid → email the payment link (payment reserves the
    // dumpster). A booked+paid manual entry needs no link. Same email channel the
    // PUT booking transition + auto-book use.
    if (isPendingPayment) {
      sendPaymentLinkEmail(lead).then((r) => {
        if (r.sent) {
          emitToBusiness(lead.business_id, 'payment_link_emailed', {
            leadId: lead.id, to: r.to, customerName: r.customerName,
          });
        }
      }).catch((err) => console.error('[leads/manual] payment email error:', err));
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

// POST /api/leads/:id/email-payment-link — (re)send the payment link by EMAIL (the
// approved channel while SMS/A2P is pending). Used by the Open Job card's Payment
// Link action. Forces a resend even if one was already emailed.
router.post('/:id/email-payment-link', requireAuth, async (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, req.business.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const result = await sendPaymentLinkEmail(lead, true);
    const updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, req.business.id);
    if (result.sent) {
      emitToBusiness(updated.business_id, 'payment_link_emailed', {
        leadId: updated.id, to: result.to, customerName: result.customerName,
      });
    }
    res.json({ ...result, lead: updated });
  } catch (err) {
    console.error('POST /leads/:id/email-payment-link error:', err);
    res.status(500).json({ error: 'Failed to email payment link' });
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
