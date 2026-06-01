const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { sendPaymentSms } = require('../services/smsService');
const { getIO } = require('../socket');

// GET /api/leads
router.get('/', (req, res) => {
  try {
    const { status, job_status, intent, search, sort, order, discarded, vertical } = req.query;

    let query = 'SELECT * FROM leads WHERE 1=1';
    const params = [];

    // Exclude discarded leads by default
    if (discarded !== 'include') {
      query += ' AND (discarded = 0 OR discarded IS NULL)';
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

// GET /api/leads/all — raw debug view: every lead, no filtering whatsoever
router.get('/all', (req, res) => {
  try {
    const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
    res.json(leads);
  } catch (err) {
    console.error('GET /leads/all error:', err);
    res.status(500).json({ error: 'Failed to retrieve leads' });
  }
});

// GET /api/leads/:id
router.get('/:id', (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    console.error('GET /leads/:id error:', err);
    res.status(500).json({ error: 'Failed to retrieve lead' });
  }
});

// PUT /api/leads/:id
router.put('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const allowedFields = [
      'status', 'discarded', 'sub_vertical', 'outcome',
      'job_status', 'raw_delivery_date', 'delivery_date', 'pickup_date', 'estimated_revenue',
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
      'paid_at',
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
    const values = [...Object.values(updates), req.params.id];

    db.prepare(`UPDATE leads SET ${setClauses} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);

    // Trigger payment SMS when a job transitions to booked for the first time
    const wasBooked = existing.job_status === 'booked';
    const isNowBooked = updated.job_status === 'booked';
    const isHomeServices = updated.vertical === 'home_services';
    if (!wasBooked && isNowBooked && isHomeServices && !updated.payment_sms_sent_at) {
      sendPaymentSms(updated).then((result) => {
        if (result.sent) {
          const io = getIO();
          if (io) {
            io.emit('payment_sms_sent', {
              leadId: updated.id,
              customerName: result.customerName,
              phone: result.phone,
            });
          }
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
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const result = await sendPaymentSms(lead, true);

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);

    if (result.sent) {
      const io = getIO();
      if (io) {
        io.emit('payment_sms_sent', {
          leadId: updated.id,
          customerName: result.customerName,
          phone: result.phone,
        });
      }
    }

    res.json({ ...result, lead: updated });
  } catch (err) {
    console.error('POST /leads/:id/resend-payment-sms error:', err);
    res.status(500).json({ error: 'Failed to resend payment SMS' });
  }
});

// DELETE /api/leads/:id
router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /leads/:id error:', err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

module.exports = router;
