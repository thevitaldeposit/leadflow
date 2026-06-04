const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

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
const TOKEN_TTL = '7d';

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

module.exports = { hashPassword, comparePassword, generateToken, verifyToken };
