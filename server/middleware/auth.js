const { verifyToken } = require('../services/authService');
const db = require('../db/database');

// Pull a single cookie value out of the raw Cookie header. Avoids adding a
// cookie-parser dependency since this is the only place that reads cookies.
function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// Authentication guard. Reads a JWT from the `Authorization: Bearer <token>`
// header or the httpOnly `token` cookie, verifies it, loads the user and
// business it points to, and attaches them as req.user (without password_hash)
// and req.business. Responds 401 if the token is missing, invalid/expired, or no
// longer resolves to a live user/business.
//
// NOTE: This middleware is intentionally NOT wired into any existing route yet.
// Phase 1 builds the foundation only; protected routes adopt it in a later phase.
function requireAuth(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
    if (!token) token = readCookie(req, 'token');
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = db.prepare(
      'SELECT id, business_id, email, role, created_at FROM users WHERE id = ?'
    ).get(payload.userId);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });

    const business = db.prepare(
      'SELECT id, name, owner_first_name, slug, twilio_phone_number, user_phone_number, created_at FROM businesses WHERE id = ?'
    ).get(user.business_id);
    if (!business) return res.status(401).json({ error: 'Business no longer exists' });

    req.user = user;
    req.business = business;
    next();
  } catch (err) {
    console.error('[auth] middleware error:', err);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

module.exports = requireAuth;
