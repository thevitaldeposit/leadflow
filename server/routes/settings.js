const express = require('express');
const router = express.Router();
const db = require('../db/database');

function readAll() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const row of rows) {
    try { obj[row.key] = JSON.parse(row.value); } catch { obj[row.key] = row.value; }
  }
  return obj;
}

// GET /api/settings
router.get('/', (req, res) => {
  try {
    res.json(readAll());
  } catch (err) {
    console.error('GET /settings error:', err);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// PUT /api/settings
router.put('/', (req, res) => {
  try {
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
    );
    const upsertMany = db.transaction((pairs) => {
      for (const [k, v] of pairs) {
        stmt.run(k, JSON.stringify(v), new Date().toISOString());
      }
    });
    upsertMany(Object.entries(req.body));
    res.json(readAll());
  } catch (err) {
    console.error('PUT /settings error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
