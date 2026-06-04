const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { attachBusiness } = require('../middleware/auth');

// iOS device registration doesn't send a token yet — soft auth scopes the device
// to the caller's business when a token is present, else to Valley Binz.
router.use(attachBusiness);

// POST /api/devices/register
router.post('/register', (req, res) => {
  try {
    const { deviceToken, userName, businessName, vertical } = req.body;
    if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.trim().length === 0) {
      return res.status(400).json({ error: 'deviceToken is required' });
    }

    const token = deviceToken.trim();
    const businessId = req.business.id;
    const existing = db.prepare('SELECT id FROM devices WHERE device_token = ?').get(token);

    if (existing) {
      db.prepare(`
        UPDATE devices SET user_name = ?, business_name = ?, vertical = ?, business_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE device_token = ?
      `).run(userName || null, businessName || null, vertical || null, businessId, token);
    } else {
      db.prepare(`
        INSERT INTO devices (device_token, user_name, business_name, vertical, business_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(token, userName || null, businessName || null, vertical || null, businessId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /devices/register error:', err);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// DELETE /api/devices/unregister
router.delete('/unregister', (req, res) => {
  try {
    const { deviceToken } = req.body;
    if (!deviceToken) return res.status(400).json({ error: 'deviceToken is required' });
    db.prepare('DELETE FROM devices WHERE device_token = ? AND business_id = ?').run(deviceToken.trim(), req.business.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /devices/unregister error:', err);
    res.status(500).json({ error: 'Failed to unregister device' });
  }
});

module.exports = router;
