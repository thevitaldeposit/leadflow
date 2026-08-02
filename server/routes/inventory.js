const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { getAvailabilityBySize, getFleetBySize, getNextAvailableDate } = require('../services/inventoryService');

// Every inventory route is scoped to the authenticated business.
router.use(requireAuth);

// Per-size inventory API. Mounted at /api/dumpsters for URL back-compat; every
// row represents a SIZE, not an individual unit.
//
// Since Phase 2a the per-size counts are DERIVED FROM THE ASSET REGISTRY
// (`assets`, managed at /api/assets) rather than typed into inventory_pool —
// see inventoryService.getFleetBySize. inventory_pool remains as the per-size
// registry (row id + notes) and its counts are mirrored from the fleet, so the
// response shape is unchanged for every existing caller.
//
// GET /api/dumpsters
// Optional params:
//   delivery_date + pickup_date — YYYY-MM-DD. When both are present, each size
//     also includes a computed `available` count for that window (owned quantity
//     minus units in service minus overlapping active jobs of that size).
//   exclude_lead_id — omit this lead's own booking from the availability count.
router.get('/', (req, res) => {
  try {
    const businessId = req.business.id;
    const { delivery_date, pickup_date, exclude_lead_id } = req.query;

    if (delivery_date && pickup_date) {
      // Date-availability mode: sizes with computed availability.
      return res.json(getAvailabilityBySize(delivery_date, pickup_date, exclude_lead_id || null, businessId));
    }

    // Plain management list, sorted numerically by size.
    res.json(getFleetBySize(businessId));
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

// POST /api/dumpsters — register a new size
// Counts are NOT accepted here any more: since Phase 2a `quantity` and
// `units_in_service` are derived from the asset registry and re-mirrored on
// every fleet change, so a typed number would just be overwritten. Add units at
// /api/assets instead. A size registered here starts empty (0 owned).
router.post('/', (req, res) => {
  try {
    const { size, notes } = req.body;
    if (!size || !String(size).trim()) {
      return res.status(400).json({ error: 'size is required' });
    }

    const stmt = db.prepare(
      'INSERT INTO inventory_pool (size, quantity, units_in_service, notes, business_id) VALUES (?, 0, 0, ?, ?)'
    );
    const result = stmt.run(String(size).trim(), notes || null, req.business.id);
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

// PUT /api/dumpsters/:id — rename a size or edit its notes.
// Counts are derived from the asset registry (see POST above) and are not
// editable here; change the fleet at /api/assets.
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

// DELETE /api/dumpsters/:id — remove a size from the registry.
// Only an empty size can be removed: while units of that size are still in the
// fleet the size is real, and dropping the row would only lose its notes.
router.delete('/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM inventory_pool WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Inventory pool not found' });

    const fleetRow = getFleetBySize(businessId).find(g => g.id === existing.id);
    if (fleetRow && fleetRow.quantity > 0) {
      return res.status(409).json({ error: `Retire the ${fleetRow.quantity} ${existing.size} unit(s) first` });
    }

    db.prepare('DELETE FROM inventory_pool WHERE id = ? AND business_id = ?').run(req.params.id, businessId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /dumpsters/:id error:', err);
    res.status(500).json({ error: 'Failed to delete inventory pool' });
  }
});

module.exports = router;
