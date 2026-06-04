const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

// Settings are per-business. NOTE: the settings table's PRIMARY KEY is still
// `key` alone (globally unique), which is fine while only Valley Binz exists but
// must become a composite (business_id, key) before a second business is onboarded.
function readAll(businessId) {
  const rows = db.prepare('SELECT key, value FROM settings WHERE business_id = ?').all(businessId);
  const obj = {};
  for (const row of rows) {
    try { obj[row.key] = JSON.parse(row.value); } catch { obj[row.key] = row.value; }
  }
  return obj;
}

// GET /api/settings
router.get('/', requireAuth, (req, res) => {
  try {
    res.json(readAll(req.business.id));
  } catch (err) {
    console.error('GET /settings error:', err);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// PUT /api/settings
router.put('/', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at, business_id) VALUES (?, ?, ?, ?)'
    );
    // node:sqlite's DatabaseSync has no transaction() helper (that is a
    // better-sqlite3 API), so drive BEGIN/COMMIT/ROLLBACK directly.
    db.exec('BEGIN');
    try {
      for (const [k, v] of Object.entries(req.body)) {
        stmt.run(k, JSON.stringify(v), new Date().toISOString(), businessId);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json(readAll(businessId));
  } catch (err) {
    console.error('PUT /settings error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
