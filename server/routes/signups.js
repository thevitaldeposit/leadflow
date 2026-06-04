const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

// Allowed values for the "type of business" dropdown on the signup form. Anything
// outside this set is rejected so the admin table stays clean.
const BUSINESS_TYPES = ['Dumpster Rental', 'HVAC', 'Plumbing', 'Landscaping', 'Roofing', 'Other'];

// POST /api/signups — PUBLIC (no auth). Captures a prospect from the Stream
// marketing site. Kept deliberately permissive: it is the very first touchpoint,
// so we validate presence/shape but never block a real lead on a technicality.
router.post('/', (req, res) => {
  try {
    const { firstName, businessName, businessType, phone, email } = req.body || {};

    if (!firstName || !businessName || !businessType || !phone || !email) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (!BUSINESS_TYPES.includes(String(businessType))) {
      return res.status(400).json({ error: 'Invalid business type' });
    }

    const info = db
      .prepare(`
        INSERT INTO signups (first_name, business_name, business_type, phone, email, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        String(firstName).trim(),
        String(businessName).trim(),
        String(businessType).trim(),
        String(phone).trim(),
        String(email).trim().toLowerCase(),
        new Date().toISOString()
      );

    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (err) {
    console.error('POST /signups error:', err);
    res.status(500).json({ error: 'Failed to save signup' });
  }
});

// GET /api/signups — auth required. Powers the Stream admin dashboard table.
router.get('/', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM signups ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    console.error('GET /signups error:', err);
    res.status(500).json({ error: 'Failed to retrieve signups' });
  }
});

module.exports = router;
