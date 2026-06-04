const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { hashPassword, comparePassword, generateToken } = require('../services/authService');
const requireAuth = require('../middleware/auth');

// Mark the auth cookie Secure (HTTPS-only) in production; allow plain HTTP in dev.
const isProd = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'token';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days — matches the JWT TTL

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
  });
}

// Turn a business name into a URL-safe slug, e.g. "Valley Binz" -> "valley-binz".
function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'business'
  );
}

// Ensure the slug is unique by appending -2, -3, … if the base is taken.
function uniqueSlug(base) {
  let slug = base;
  let n = 1;
  while (db.prepare('SELECT 1 FROM businesses WHERE slug = ?').get(slug)) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

// Shape a user row for API responses — never leak password_hash.
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    businessId: user.business_id,
    createdAt: user.created_at,
  };
}

// POST /api/auth/register — create a new business + owner user, return a JWT.
router.post('/register', async (req, res) => {
  try {
    const { businessName, ownerFirstName, email, password, twilioPhoneNumber, userPhoneNumber } = req.body || {};

    if (!businessName || !email || !password) {
      return res.status(400).json({ error: 'businessName, email, and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const normEmail = String(email).trim().toLowerCase();

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = await hashPassword(String(password));
    const slug = uniqueSlug(slugify(businessName));

    // Create the business and its owner user atomically. node:sqlite's
    // DatabaseSync has no transaction() helper (that is a better-sqlite3 API),
    // so drive BEGIN/COMMIT/ROLLBACK directly.
    let businessId, userId;
    db.exec('BEGIN');
    try {
      const bizInfo = db
        .prepare(`
          INSERT INTO businesses (name, owner_first_name, slug, twilio_phone_number, user_phone_number)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          String(businessName),
          ownerFirstName ? String(ownerFirstName) : null,
          slug,
          twilioPhoneNumber || null,
          userPhoneNumber || null
        );
      businessId = Number(bizInfo.lastInsertRowid);
      const userInfo = db
        .prepare(`
          INSERT INTO users (business_id, email, password_hash, role)
          VALUES (?, ?, ?, 'owner')
        `)
        .run(businessId, normEmail, passwordHash);
      userId = Number(userInfo.lastInsertRowid);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
    const user = db
      .prepare('SELECT id, business_id, email, role, created_at FROM users WHERE id = ?')
      .get(userId);

    const token = generateToken(user, business);
    setAuthCookie(res, token);

    res.status(201).json({ token, user: publicUser(user), business });
  } catch (err) {
    console.error('POST /auth/register error:', err);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// POST /api/auth/login — verify credentials, return a JWT.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const normEmail = String(email).trim().toLowerCase();

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail);
    // Use the same generic message for an unknown email and a bad password so we
    // don't reveal which emails have accounts.
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const ok = await comparePassword(String(password), user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(user.business_id);
    const token = generateToken(user, business);
    setAuthCookie(res, token);

    res.json({ token, user: publicUser(user), business });
  } catch (err) {
    console.error('POST /auth/login error:', err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// GET /api/auth/me — current user + business (requires a valid token).
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), business: req.business });
});

// POST /api/auth/logout — clear the auth cookie.
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isProd, sameSite: 'lax' });
  res.json({ success: true });
});

module.exports = router;
