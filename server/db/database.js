const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const FALLBACK_PATH = path.join(__dirname, 'leadflow.db');

function resolveDbPath() {
  const raw = process.env.DATABASE_PATH;
  return raw ? path.resolve(raw) : FALLBACK_PATH;
}

function ensureWritable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Verify we can actually write — mkdirSync succeeds even on read-only mounts
  // when the directory already exists.
  const probe = path.join(dir, '.write-probe');
  fs.writeFileSync(probe, '');
  fs.unlinkSync(probe);
}

function openDatabase(dbPath) {
  const dbDir = path.dirname(dbPath);

  console.log('[db] DATABASE_PATH env  :', process.env.DATABASE_PATH || '(not set)');
  console.log('[db] Resolved DB path   :', dbPath);
  console.log('[db] DB directory exists:', fs.existsSync(dbDir));
  console.log('[db] DB file exists     :', fs.existsSync(dbPath));

  ensureWritable(dbDir);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  console.log('[db] Database opened successfully:', dbPath);
  return db;
}

let db;
const primaryPath = resolveDbPath();

try {
  db = openDatabase(primaryPath);
} catch (err) {
  console.error('[db] Failed to open database at', primaryPath);
  console.error('[db] Error:', err.message);

  if (primaryPath !== FALLBACK_PATH) {
    console.warn('[db] Falling back to local database:', FALLBACK_PATH);
    try {
      db = openDatabase(FALLBACK_PATH);
      console.warn('[db] WARNING: running on fallback DB — data will not persist across redeploys.');
      console.warn('[db] Fix: ensure the Railway volume at /data is mounted and writable.');
    } catch (fallbackErr) {
      console.error('[db] Fallback also failed:', fallbackErr.message);
      throw fallbackErr;
    }
  } else {
    throw err;
  }
}

module.exports = db;
