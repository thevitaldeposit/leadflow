const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/dumpsters
router.get('/', (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM dumpsters';
    const params = [];
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
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
