const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('../db/database');
const { sendPasswordResetEmail } = require('./emailService');

// JWT_SECRET must be set in the environment: locally in .env, and in the Railway
// project's environment variables for production. It is read LAZILY (never at
// module load) so a deployment missing the variable still boots and serves every
// existing route — only the new auth endpoints fail, and they fail clearly,
// until the secret is configured.
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured — set it in the environment (Railway env vars / .env)');
  }
  return secret;
}

const SALT_ROUNDS = 10;
// 30-day base lifetime. On top of this, GET /api/auth/me re-issues a fresh token
// on every check (sliding refresh), so an actively-used session never reaches the
// expiry wall; the long base is the cushion for stretches when the app is closed.
const TOKEN_TTL = '30d';

// Hash a plaintext password with bcrypt. Returns a promise.
function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

// Compare a plaintext password against a bcrypt hash. Resolves to a boolean.
function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Sign a JWT carrying the identity needed to scope a request to a tenant.
function generateToken(user, business) {
  return jwt.sign(
    {
      userId: user.id,
      businessId: business.id,
      businessSlug: business.slug,
    },
    getSecret(),
    { expiresIn: TOKEN_TTL }
  );
}

// Verify and decode a JWT. Throws if the token is missing, invalid, or expired.
function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

// ── Password reset ──────────────────────────────────────────────────────────
// One-hour reset token lifetime; the public reset page reads the token from the
// query string at this URL.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_URL_BASE = 'https://joinstream.app/reset-password';

// Issue a password-reset token for `user`, persist it with a 1-hour expiry, and
// email the reset link. Shared by the public forgot-password route and the admin
// panel's "Reset Password" action so both produce identical tokens and links.
// Throws if the email fails to send — callers decide whether to surface that.
async function sendPasswordResetForUser(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  db.prepare(
    'UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?'
  ).run(token, expires, user.id);
  const resetUrl = `${RESET_URL_BASE}?token=${token}`;
  await sendPasswordResetEmail(user.email, resetUrl);
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  sendPasswordResetForUser,
};
