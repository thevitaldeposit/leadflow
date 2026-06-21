const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { attachBusiness } = require('../middleware/auth');

// iOS device registration doesn't send a token yet — soft auth scopes the device
// to the caller's business when a token is present, else to Valley Binz.
router.use(attachBusiness);

// POST /api/devices/register
// Registers (or updates) a device for this business. Keyed on the APNs
// device_token. Optionally also records the Twilio Voice fields used for
// incoming calls: voipToken (the PushKit VoIP push token) and identity (the
// Twilio Voice client identity the device registered under). Those two are
// additive — when omitted they leave any previously stored value untouched
// (COALESCE), so an APNs-only call never clobbers the voice registration and a
// voice-only refresh never clobbers the APNs token.
router.post('/register', (req, res) => {
  try {
    const { deviceToken, userName, businessName, vertical, voipToken, identity } = req.body;
    if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.trim().length === 0) {
      return res.status(400).json({ error: 'deviceToken is required' });
    }

    const token = deviceToken.trim();
    const voip = typeof voipToken === 'string' && voipToken.trim().length > 0 ? voipToken.trim() : null;
    const voiceIdentity = typeof identity === 'string' && identity.trim().length > 0 ? identity.trim() : null;
    const businessId = req.business.id;
    const existing = db.prepare('SELECT id FROM devices WHERE device_token = ?').get(token);

    if (existing) {
      db.prepare(`
        UPDATE devices SET
          user_name = ?,
          business_name = ?,
          vertical = ?,
          business_id = ?,
          voip_token = COALESCE(?, voip_token),
          voice_identity = COALESCE(?, voice_identity),
          updated_at = CURRENT_TIMESTAMP
        WHERE device_token = ?
      `).run(userName || null, businessName || null, vertical || null, businessId, voip, voiceIdentity, token);
    } else {
      db.prepare(`
        INSERT INTO devices (device_token, user_name, business_name, vertical, business_id, voip_token, voice_identity)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(token, userName || null, businessName || null, vertical || null, businessId, voip, voiceIdentity);
    }

    // Diagnostic: confirm whether THIS registration carried the Voice fields the
    // inbound-call TwiML needs (getActiveAppClientIdentity requires both a
    // voice_identity AND a voip_token on the row). APNs-only registrations omit
    // them (COALESCE keeps any prior value). Never log the full VoIP token.
    if (voip || voiceIdentity) {
      const voipPrefix = voip ? `${voip.slice(0, 10)}… (len ${voip.length})` : 'unchanged';
      console.log(`[devices] voice registration ${existing ? 'updated' : 'created'} for business_${businessId}: identity=${voiceIdentity || 'unchanged'} voip_token=${voipPrefix}`);
    } else {
      console.log(`[devices] APNs-only registration for business_${businessId} (no voip_token/identity in this request — voice fields left untouched)`);
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
