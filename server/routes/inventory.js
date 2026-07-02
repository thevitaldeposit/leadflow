const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { getAvailabilityBySize, getNextAvailableDate, normalizeSize } = require('../services/inventoryService');

// Every inventory route is scoped to the authenticated business.
router.use(requireAuth);

// Pool-based inventory API. Mounted at /api/dumpsters for URL back-compat, but
// every row represents a SIZE (a pool), not an individual asset.
// inventory_pool is keyed by a composite UNIQUE(business_id, size) (see
// migrations.js), so each tenant has its own per-size pools.
//
// GET /api/dumpsters
// Optional params:
//   delivery_date + pickup_date — YYYY-MM-DD. When both are present, each pool
//     also includes a computed `available` count for that window (owned quantity
//     minus units in service minus overlapping active jobs of that size).
//   exclude_lead_id — omit this lead's own booking from the availability count.
router.get('/', (req, res) => {
  try {
    const businessId = req.business.id;
    const { delivery_date, pickup_date, exclude_lead_id } = req.query;

    if (delivery_date && pickup_date) {
      // Date-availability mode: return pools with computed availability.
      const rows = getAvailabilityBySize(delivery_date, pickup_date, exclude_lead_id || null, businessId);
      // Merge in notes for display (getAvailabilityBySize omits them).
      const notesById = new Map(
        db.prepare('SELECT id, notes FROM inventory_pool WHERE business_id = ?').all(businessId).map(r => [r.id, r.notes])
      );
      return res.json(rows.map(r => ({ ...r, notes: notesById.get(r.id) || null })));
    }

    // Plain management list, sorted numerically by size.
    const pools = db.prepare('SELECT * FROM inventory_pool WHERE business_id = ?').all(businessId);
    pools.sort((a, b) => (normalizeSize(a.size) || 999) - (normalizeSize(b.size) || 999));
    res.json(pools);
  } catch (err) {
    console.error('GET /dumpsters error:', err);
    res.status(500).json({ error: 'Failed to retrieve inventory' });
  }
});

// GET /api/dumpsters/next-available — the earliest delivery date after the
// requested one on which a unit of `size` is free for the same rental length.
// Powers the "Next available: …" hint on the manual-booking surfaces when the
// requested window is full. Advisory: the owner can still choose to overbook.
// Params: size, delivery_date (YYYY-MM-DD), rental_duration (days), exclude_lead_id?
router.get('/next-available', (req, res) => {
  try {
    const businessId = req.business.id;
    const { size, delivery_date, rental_duration, exclude_lead_id } = req.query;
    if (!size || !delivery_date || !rental_duration) {
      return res.status(400).json({ error: 'size, delivery_date, and rental_duration are required' });
    }
    const days = parseInt(rental_duration, 10);
    if (!(days >= 1)) return res.status(400).json({ error: 'rental_duration must be a positive integer' });

    const nextAvailableDate = getNextAvailableDate(size, delivery_date, days, exclude_lead_id || null, businessId);
    res.json({ nextAvailableDate: nextAvailableDate || null });
  } catch (err) {
    console.error('GET /dumpsters/next-available error:', err);
    res.status(500).json({ error: 'Failed to compute next availability' });
  }
});

// POST /api/dumpsters — add a new size pool
router.post('/', (req, res) => {
  try {
    const { size, quantity = 0, units_in_service = 0, notes } = req.body;
    if (!size || !String(size).trim()) {
      return res.status(400).json({ error: 'size is required' });
    }

    const qty = Math.max(0, parseInt(quantity, 10) || 0);
    const inService = Math.max(0, parseInt(units_in_service, 10) || 0);

    const stmt = db.prepare(
      'INSERT INTO inventory_pool (size, quantity, units_in_service, notes, business_id) VALUES (?, ?, ?, ?, ?)'
    );
    const result = stmt.run(String(size).trim(), qty, inService, notes || null, req.business.id);
    const created = db.prepare('SELECT * FROM inventory_pool WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A pool for this size already exists' });
    }
    console.error('POST /dumpsters error:', err);
    res.status(500).json({ error: 'Failed to create inventory pool' });
  }
});

// PUT /api/dumpsters/:id — edit a size, quantity, units in service, or notes
router.put('/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM inventory_pool WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Inventory pool not found' });

    const updates = {};
    if (req.body.size !== undefined) {
      if (!String(req.body.size).trim()) return res.status(400).json({ error: 'size cannot be empty' });
      updates.size = String(req.body.size).trim();
    }
    if (req.body.quantity !== undefined) {
      updates.quantity = Math.max(0, parseInt(req.body.quantity, 10) || 0);
    }
    if (req.body.units_in_service !== undefined) {
      updates.units_in_service = Math.max(0, parseInt(req.body.units_in_service, 10) || 0);
    }
    if (req.body.notes !== undefined) updates.notes = req.body.notes || null;

    if (Object.keys(updates).length === 0) return res.json(existing);

    updates.updated_at = new Date().toISOString();
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE inventory_pool SET ${setClauses} WHERE id = ? AND business_id = ?`)
      .run(...Object.values(updates), req.params.id, businessId);

    const updated = db.prepare('SELECT * FROM inventory_pool WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    res.json(updated);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A pool for this size already exists' });
    }
    console.error('PUT /dumpsters/:id error:', err);
    res.status(500).json({ error: 'Failed to update inventory pool' });
  }
});

// DELETE /api/dumpsters/:id — remove a size pool
router.delete('/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM inventory_pool WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Inventory pool not found' });
    db.prepare('DELETE FROM inventory_pool WHERE id = ? AND business_id = ?').run(req.params.id, businessId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /dumpsters/:id error:', err);
    res.status(500).json({ error: 'Failed to delete inventory pool' });
  }
});

module.exports = router;
