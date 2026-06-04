// One-time seed: create the first owner user for Valley Binz (business_id = 1).
//
//   Usage:  node server/db/seedValleyBinzUser.js [email]
//
// Generates a strong temporary password, prints it to the console ONCE, then
// stores only its bcrypt hash. Re-running is safe: if the business already has a
// user (or the email is taken) it makes no changes. Log in via POST
// /api/auth/login with the printed credentials, then change the password.

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const db = require('./database');
const { initDatabase } = require('./database');
const { hashPassword } = require('../services/authService');

const DEFAULT_EMAIL = 'thevitaldeposit@gmail.com';

async function main() {
  const email = (process.argv[2] || DEFAULT_EMAIL).trim().toLowerCase();

  initDatabase();
  // Ensure the businesses/users tables exist + Valley Binz is seeded. Idempotent.
  require('./migrations');

  const business =
    db.prepare("SELECT id, name FROM businesses WHERE slug = 'valley-binz'").get() ||
    db.prepare('SELECT id, name FROM businesses ORDER BY id ASC LIMIT 1').get();

  if (!business) {
    console.error('[seed] No business found — start the server once so migrations seed Valley Binz, then retry.');
    process.exit(1);
  }

  const existingForBusiness = db
    .prepare('SELECT id, email FROM users WHERE business_id = ?')
    .get(business.id);
  if (existingForBusiness) {
    console.log(`[seed] A user already exists for "${business.name}" (business_id ${business.id}): ${existingForBusiness.email}`);
    console.log('[seed] No changes made.');
    process.exit(0);
  }

  const emailTaken = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (emailTaken) {
    console.log(`[seed] Email ${email} is already registered. No changes made.`);
    process.exit(0);
  }

  // ~24-char URL-safe password — strong, and easy to copy out of the log.
  const tempPassword = crypto.randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(tempPassword);

  const info = db
    .prepare("INSERT INTO users (business_id, email, password_hash, role) VALUES (?, ?, ?, 'owner')")
    .run(business.id, email, passwordHash);

  console.log('');
  console.log('==================================================================');
  console.log('  Valley Binz owner account created');
  console.log('------------------------------------------------------------------');
  console.log(`  business     : ${business.name} (id ${business.id})`);
  console.log(`  user id      : ${Number(info.lastInsertRowid)}`);
  console.log(`  email        : ${email}`);
  console.log(`  TEMP PASSWORD: ${tempPassword}`);
  console.log('------------------------------------------------------------------');
  console.log('  Save this password now — it is shown only once and is never');
  console.log('  stored in plaintext. Log in, then change it.');
  console.log('==================================================================');
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
