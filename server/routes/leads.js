const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { sendPaymentSms } = require('../services/smsService');
const { initiateClickToCall } = require('../services/callService');
const { logActivity, getActivityForLead } = require('../services/activityLog');
const { emitToBusiness } = require('../socket');
const { attachBusiness, requireAuth } = require('../middleware/auth');

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
    // duplicate the keys.
    const vdPatch = (req.body.vertical_data && typeof req.body.vertical_data === 'object')
      ? req.body.vertical_data
      : null;
    const needsVdMerge = vdPatch !== null
      || updates.delivery_date !== undefined
      || updates.pickup_date !== undefined;

    if (needsVdMerge) {
      let current = {};
      try { current = JSON.parse(existing.vertical_data || '{}'); } catch { current = {}; }
      const merged = { ...current, ...(vdPatch || {}) };
      if (updates.delivery_date !== undefined) {
        merged.deliveryDate = updates.delivery_date;
        merged.deliveryDateISO = updates.delivery_date;
      }
      if (updates.pickup_date !== undefined) {
        merged.pickupDate = updates.pickup_date;
      }
      updates.vertical_data = JSON.stringify(merged);
    }

    if (Object.keys(updates).length === 0) {
      return res.json(existing);
    }

    updates.updated_at = new Date().toISOString();

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), req.params.id, businessId];

    db.prepare(`UPDATE leads SET ${setClauses} WHERE id = ? AND business_id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(req.params.id, businessId);

    // Log a status_change touchpoint whenever job_status actually changes.
    if (updates.job_status !== undefined && updated.job_status !== existing.job_status) {
      logActivity(updated.id, 'status_change', `Status changed to ${updated.job_status}`);
    }

    // Trigger payment SMS when a job transitions to booked for the first time
    const wasBooked = existing.job_status === 'booked';
    const isNowBooked = updated.job_status === 'booked';
    const isHomeServices = updated.vertical === 'home_services';
    if (!wasBooked && isNowBooked && isHomeServices && !updated.payment_sms_sent_at) {
      sendPaymentSms(updated).then((result) => {
        if (result.sent) {
          emitToBusiness(updated.business_id, 'payment_sms_sent', {
            leadId: updated.id,
            customerName: result.customerName,
            phone: result.phone,
          });
        }
      }).catch((err) => console.error('[leads] SMS send error:', err));
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

    // Quote / payment
    const priceNum = b.price === '' || b.price == null ? null : Number(b.price);
    const hasPrice = priceNum != null && !Number.isNaN(priceNum);
    const paymentStatus = b.paymentStatus === 'paid'
      ? 'Paid' : (b.paymentStatus === 'not_paid' ? 'Not paid' : null);

    // Status / intent. "Book Job" forces booked; otherwise honor the dropdown.
    const book = b.book === true;
    const chosenJobStatus = ['inquiry', 'opportunity', 'booked'].includes(b.jobStatus)
      ? b.jobStatus : 'inquiry';
    const jobStatus = book ? 'booked' : chosenJobStatus;
    const intent = ['cold', 'warm', 'high'].includes(b.intent) ? b.intent : null;
    const notes = str(b.notes);

    // Validation: name + phone + at least one job detail field.
    if (!firstName) return res.status(400).json({ error: 'Customer first name is required' });
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    const hasJobDetail = !!(
      dumpsterSize || debrisType || deliveryDate || (rentalDurationDays >= 1) ||
      deliveryAddress || accessNotes || hasPrice
    );
    if (!hasJobDetail) {
      return res.status(400).json({ error: 'Add at least one job detail (size, date, address, price, etc.)' });
    }

    const pickupDate = calcPickupFromDuration(deliveryDate, rentalDurationDays);
    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    const quotedPrice = hasPrice ? `$${priceNum}` : null;
    const isBooked = jobStatus === 'booked';
    const outcome = isBooked ? 'booked' : 'quote_requested';

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
    const paidAt = paymentStatus === 'Paid' ? nowISO : null;

    const insert = db.prepare(`
      INSERT INTO leads (
        business_id, vertical, sub_vertical, source, call_type, extraction_type,
        customer_first_name, customer_last_name, phone, email,
        status, job_status, outcome, customer_intent,
        delivery_date, raw_delivery_date, pickup_date, estimated_revenue,
        paid_at, vertical_data, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(
      businessId, vertical, subVertical, 'manual', 'manual', 'manual',
      firstName, lastName || null, phone, email || null,
      legacyStatus, jobStatus, outcome, intent || null,
      deliveryDate || null, deliveryDate || null, pickupDate || null, hasPrice ? priceNum : null,
      paidAt, JSON.stringify(verticalData), nowISO, nowISO
    );

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(result.lastInsertRowid));

    logActivity(lead.id, 'note_added', 'Lead manually created by owner');

    // Booked directly → same payment SMS path the PUT booking transition uses,
    // unless the owner already marked it paid.
    if (isBooked && !paidAt) {
      sendPaymentSms(lead).then((r) => {
        if (r.sent) {
          emitToBusiness(lead.business_id, 'payment_sms_sent', {
            leadId: lead.id,
            customerName: r.customerName,
            phone: r.phone,
          });
        }
      }).catch((err) => console.error('[leads/manual] SMS send error:', err));
    }

    emitToBusiness(lead.business_id, 'new_lead', lead);
    res.status(201).json(lead);
  } catch (err) {
    console.error('POST /leads/manual error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
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
