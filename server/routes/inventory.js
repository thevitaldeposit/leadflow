const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { getAvailabilityBySize, normalizeSize } = require('../services/inventoryService');

// Pool-based inventory API. Mounted at /api/dumpsters for URL back-compat, but
// every row represents a SIZE (a pool), not an individual asset.
//
// GET /api/dumpsters
// Optional params:
//   delivery_date + pickup_date — YYYY-MM-DD. When both are present, each pool
//     also includes a computed `available` count for that window (owned quantity
//     minus units in service minus overlapping active jobs of that size).
//   exclude_lead_id — omit this lead's own booking from the availability count.
router.get('/', (req, res) => {
  try {
    const { delivery_date, pickup_date, exclude_lead_id } = req.query;

    if (delivery_date && pickup_date) {
      // Date-availability mode: return pools with computed availability.
      const rows = getAvailabilityBySize(delivery_date, pickup_date, exclude_lead_id || null);
      // Merge in notes for display (getAvailabilityBySize omits them).
      const notesById = new Map(
        db.prepare('SELECT id, notes FROM inventory_pool').all().map(r => [r.id, r.notes])
      );
      return res.json(rows.map(r => ({ ...r, notes: notesById.get(r.id) || null })));
    }

    // Plain management list, sorted numerically by size.
    const pools = db.prepare('SELECT * FROM inventory_pool').all();
    pools.sort((a, b) => (normalizeSize(a.size) || 999) - (normalizeSize(b.size) || 999));
    res.json(pools);
  } catch (err) {
    console.error('GET /dumpsters error:', err);
    res.status(500).json({ error: 'Failed to retrieve inventory' });
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
      'INSERT INTO inventory_pool (size, quantity, units_in_service, notes) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(String(size).trim(), qty, inService, notes || null);
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
    const existing = db.prepare('SELECT * FROM inventory_pool WHERE id = ?').get(req.params.id);
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
    db.prepare(`UPDATE inventory_pool SET ${setClauses} WHERE id = ?`)
      .run(...Object.values(updates), req.params.id);

    const updated = db.prepare('SELECT * FROM inventory_pool WHERE id = ?').get(req.params.id);
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
    const existing = db.prepare('SELECT * FROM inventory_pool WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Inventory pool not found' });
    db.prepare('DELETE FROM inventory_pool WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /dumpsters/:id error:', err);
    res.status(500).json({ error: 'Failed to delete inventory pool' });
  }
});

module.exports = router;
