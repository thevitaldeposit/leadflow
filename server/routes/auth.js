const express = require('express');
const router = express.Router();
const db = require('../db/database');
const {
  hashPassword,
  comparePassword,
  generateToken,
  sendPasswordResetForUser,
} = require('../services/authService');
const { requireAuth } = require('../middleware/auth');

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
// The multi-step signup flow calls this AFTER payment succeeds, passing the
// Stripe customer/subscription ids so the business lands subscribed. Twilio and
// user phone numbers are no longer collected at signup — they're set later in
// Settings — so they're omitted here (defaulting to NULL).
router.post('/register', async (req, res) => {
  try {
    const {
      businessName,
      firstName,
      lastName,
      ownerFirstName, // legacy alias for firstName
      email,
      password,
      industryType,
      stripeCustomerId,
      stripeSubscriptionId,
    } = req.body || {};

    if (!businessName || !email || !password) {
      return res.status(400).json({ error: 'businessName, email, and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const normEmail = String(email).trim().toLowerCase();
    const ownerFirst = firstName || ownerFirstName;

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    // A Stripe customer id means payment was just completed on the signup form,
    // so the business starts active; without one it starts inactive (soft-gated).
    const subscriptionStatus = stripeCustomerId ? 'active' : 'inactive';

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
          INSERT INTO businesses
            (name, owner_first_name, owner_last_name, slug, industry_type,
             stripe_customer_id, stripe_subscription_id, subscription_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          String(businessName),
          ownerFirst ? String(ownerFirst) : null,
          lastName ? String(lastName) : null,
          slug,
          industryType ? String(industryType) : null,
          stripeCustomerId ? String(stripeCustomerId) : null,
          stripeSubscriptionId ? String(stripeSubscriptionId) : null,
          subscriptionStatus
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

// POST /api/auth/change-password — replace the current user's password.
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // req.user from requireAuth excludes password_hash, so load the full row.
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const ok = await comparePassword(String(currentPassword), user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const passwordHash = await hashPassword(String(newPassword));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);

    res.json({ success: true });
  } catch (err) {
    console.error('POST /auth/change-password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// POST /api/auth/forgot-password — email a reset link if the account exists.
// Public (no auth). Always returns 200 with the same body whether or not the
// email matches an account, so the response never reveals which emails exist.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    const normEmail = String(email).trim().toLowerCase();

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail);
    if (user) {
      try {
        await sendPasswordResetForUser(user);
      } catch (mailErr) {
        // Log but don't surface — the generic 200 below keeps the endpoint from
        // revealing whether the address exists, even on a mail failure.
        console.error('POST /auth/forgot-password email send error:', mailErr);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /auth/forgot-password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/auth/reset-password — set a new password using a valid reset token.
// Public (no auth). The token must match and not be expired.
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'token and newPassword are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const now = new Date().toISOString();
    const user = db
      .prepare('SELECT * FROM users WHERE password_reset_token = ? AND password_reset_expires > ?')
      .get(String(token), now);
    if (!user) {
      return res.status(400).json({ error: 'Reset link is invalid or has expired' });
    }

    const passwordHash = await hashPassword(String(newPassword));
    db.prepare(
      'UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?'
    ).run(passwordHash, user.id);

    res.json({ success: true });
  } catch (err) {
    console.error('POST /auth/reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /api/auth/logout — clear the auth cookie.
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isProd, sameSite: 'lax' });
  res.json({ success: true });
});

module.exports = router;
