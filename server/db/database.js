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

  const instance = new DatabaseSync(dbPath);
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');
  console.log('[db] Database opened successfully:', dbPath);
  return instance;
}

let _db = null;

// Transparent proxy — route modules `require('./database')` at load time safely.
// Actual DB calls are deferred to request-handling time, after initDatabase() runs.
const proxy = new Proxy({}, {
  get(_, prop) {
    // initDatabase must be reachable before _db is set
    if (prop === 'initDatabase') return initDatabase;
    // Symbols are accessed by JS internals and Promise-detection — pass through safely
    if (typeof prop === 'symbol') return undefined;
    // 'then' check prevents accidental Promise-wrapping by frameworks
    if (prop === 'then') return undefined;
    if (!_db) throw new Error('[db] Database not ready — initDatabase() has not been called yet');
    const val = _db[prop];
    return typeof val === 'function' ? val.bind(_db) : val;
  },
});

// Called by startServer() in index.js inside the retry loop.
// Throws if the volume is not writable yet — the caller handles retries.
function initDatabase() {
  const primaryPath = resolveDbPath();
  try {
    _db = openDatabase(primaryPath);
  } catch (err) {
    console.error('[db] Failed to open database at', primaryPath, '—', err.message);
    if (primaryPath !== FALLBACK_PATH) {
      console.warn('[db] Falling back to local database:', FALLBACK_PATH);
      _db = openDatabase(FALLBACK_PATH);
      console.warn('[db] WARNING: running on fallback DB — data will not persist across redeploys.');
      console.warn('[db] Fix: ensure the Railway volume at /data is mounted and writable.');
    } else {
      throw err;
    }
  }
}

module.exports = proxy;
