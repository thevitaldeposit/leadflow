const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/dumpsters
// Optional params:
//   status              — exact status match (management/admin views)
//   delivery_date       — YYYY-MM-DD, used with pickup_date for availability check
//   pickup_date         — YYYY-MM-DD, used with delivery_date for availability check
//   exclude_lead_id     — omit this lead's own booking from the conflict check
//   exclude_unserviceable — any truthy value: hide needs_service + out_of_service
//
// Availability-check mode (delivery_date + pickup_date, no status param):
//   Mirrors the schedule.js availability checker.  A dumpster is considered
//   available if its status is not needs_service/out_of_service AND no existing
//   booked job overlaps the requested window.  on_job dumpsters whose current
//   job ends before the requested delivery date correctly appear as available.
router.get('/', (req, res) => {
  try {
    const { status, delivery_date, pickup_date, exclude_lead_id, exclude_unserviceable } = req.query;
    const conditions = [];
    const params = [];

    if (status) {
      // Explicit status filter — used by management/inventory views
      conditions.push('status = ?');
      params.push(status);
    } else if (delivery_date && pickup_date) {
      // Date-availability mode: the status field is NOT the availability signal —
      // date-overlap is.  Only exclude units that are physically unserviceable.
      conditions.push("status NOT IN ('needs_service', 'out_of_service')");
    } else if (exclude_unserviceable) {
      // Booking context with no date yet — hide unserviceable from the picker
      conditions.push("status NOT IN ('needs_service', 'out_of_service')");
    }

    if (delivery_date && pickup_date) {
      // Exclude dumpsters whose confirmed bookings overlap the requested window.
      // Matches schedule.js: job_delivery < req_pickup AND job_pickup > req_delivery
      let subquery = `id NOT IN (
        SELECT assigned_dumpster_id FROM leads
        WHERE assigned_dumpster_id IS NOT NULL
        AND job_status IN ('booked','scheduled','delivered','active_rental','picked_up')
        AND delivery_date < ?
        AND pickup_date > ?`;
      params.push(pickup_date, delivery_date);
      if (exclude_lead_id) {
        subquery += ' AND id != ?';
        params.push(exclude_lead_id);
      }
      subquery += ')';
      conditions.push(subquery);
    }

    let query = 'SELECT * FROM dumpsters';
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY asset_number ASC';

    const dumpsters = db.prepare(query).all(...params);
    res.json(dumpsters);
  } catch (err) {
    console.error('GET /dumpsters error:', err);
    res.status(500).json({ error: 'Failed to retrieve dumpsters' });
  }
});

// POST /api/dumpsters
router.post('/', (req, res) => {
  try {
    const { asset_number, size, status = 'available', notes } = req.body;
    if (!asset_number) return res.status(400).json({ error: 'asset_number is required' });

    const stmt = db.prepare(
      'INSERT INTO dumpsters (asset_number, size, status, notes) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(asset_number, size || null, status, notes || null);
    const created = db.prepare('SELECT * FROM dumpsters WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Asset number already exists' });
    }
    console.error('POST /dumpsters error:', err);
    res.status(500).json({ error: 'Failed to create dumpster' });
  }
});

// PUT /api/dumpsters/:id
router.put('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM dumpsters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Dumpster not found' });

    const allowed = ['asset_number', 'size', 'status', 'current_job_id', 'notes'];
    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0) return res.json(existing);

    updates.updated_at = new Date().toISOString();
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE dumpsters SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), req.params.id);

    const updated = db.prepare('SELECT * FROM dumpsters WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('PUT /dumpsters/:id error:', err);
    res.status(500).json({ error: 'Failed to update dumpster' });
  }
});

// DELETE /api/dumpsters/:id
router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM dumpsters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Dumpster not found' });
    db.prepare('DELETE FROM dumpsters WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /dumpsters/:id error:', err);
    res.status(500).json({ error: 'Failed to delete dumpster' });
  }
});

module.exports = router;
