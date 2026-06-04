const { verifyToken } = require('../services/authService');
const db = require('../db/database');
const { BUSINESS_COLUMNS, getDefaultBusiness } = require('../services/businesses');

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

// Extract a JWT from the Authorization: Bearer header or the httpOnly `token`
// cookie. Returns the raw token string, or null when none is present.
function readToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  return readCookie(req, 'token');
}

// Resolve a request's token to its live { user, business }. Returns null if the
// token is missing, invalid/expired, or no longer points at a real user/business.
// `user` excludes password_hash; `business` is the public column set.
function loadAuth(req) {
  const token = readToken(req);
  if (!token) return null;

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }

  const user = db
    .prepare('SELECT id, business_id, email, role, created_at FROM users WHERE id = ?')
    .get(payload.userId);
  if (!user) return null;

  const business = db
    .prepare(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE id = ?`)
    .get(user.business_id);
  if (!business) return null;

  return { user, business };
}

// Hard authentication guard for protected routes. Attaches req.user and
// req.business, or responds 401 when the request carries no valid token.
function requireAuth(req, res, next) {
  try {
    const auth = loadAuth(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    req.user = auth.user;
    req.business = auth.business;
    next();
  } catch (err) {
    console.error('[auth] requireAuth error:', err);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Soft business resolver for shared routes that some clients still call without a
// token (the iOS app, and the web dashboard before its login lands). A valid token
// scopes the request to that user's business; anything else falls back to the
// default business (Valley Binz) so existing single-tenant behavior is preserved.
// Never responds 401 — it only attaches req.business (and req.user when known).
function attachBusiness(req, res, next) {
  try {
    const auth = loadAuth(req);
    if (auth) {
      req.user = auth.user;
      req.business = auth.business;
    } else {
      req.user = null;
      req.business = getDefaultBusiness();
    }
    next();
  } catch (err) {
    console.error('[auth] attachBusiness error:', err);
    // Best-effort: never block a shared route on a resolver failure.
    req.user = null;
    try { req.business = getDefaultBusiness(); } catch { req.business = null; }
    next();
  }
}

module.exports = { requireAuth, attachBusiness };
