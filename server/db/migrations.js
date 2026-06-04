const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const db = require('./database');

const NEW_COLUMNS = [
  'ALTER TABLE leads ADD COLUMN audio_file_path TEXT',
  'ALTER TABLE leads ADD COLUMN transcription_provider TEXT',
  'ALTER TABLE leads ADD COLUMN transcription_duration_seconds REAL',
  'ALTER TABLE leads ADD COLUMN auto_captured INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN discarded INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN caller_phone_raw TEXT',
  'ALTER TABLE leads ADD COLUMN raw_transcript TEXT',
  // iOS CallKit columns
  'ALTER TABLE leads ADD COLUMN vertical TEXT DEFAULT \'auto_dealer\'',
  'ALTER TABLE leads ADD COLUMN source TEXT',
  'ALTER TABLE leads ADD COLUMN caller_number TEXT',
  'ALTER TABLE leads ADD COLUMN call_direction TEXT',
  'ALTER TABLE leads ADD COLUMN call_duration INTEGER',
  'ALTER TABLE leads ADD COLUMN captured_by TEXT',
  'ALTER TABLE leads ADD COLUMN vertical_data TEXT',
  'ALTER TABLE leads ADD COLUMN confidence INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN sub_vertical TEXT',
  // Home Services Phase 1 redesign
  'ALTER TABLE leads ADD COLUMN outcome TEXT',
  // Phase 2: full job lifecycle model
  'ALTER TABLE leads ADD COLUMN job_status TEXT DEFAULT \'inquiry\'',
  'ALTER TABLE leads ADD COLUMN assigned_dumpster_id INTEGER',
  'ALTER TABLE leads ADD COLUMN raw_delivery_date TEXT',
  'ALTER TABLE leads ADD COLUMN delivery_date TEXT',
  'ALTER TABLE leads ADD COLUMN pickup_date TEXT',
  'ALTER TABLE leads ADD COLUMN estimated_revenue REAL',
  // Phase 2: auto-booking detection
  'ALTER TABLE leads ADD COLUMN auto_booked INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN needs_dumpster_assignment INTEGER DEFAULT 0',
  // Payment system
  'ALTER TABLE leads ADD COLUMN paid_at TEXT',
  'ALTER TABLE leads ADD COLUMN payment_sms_sent_at TEXT',
  // Recording lifecycle
  'ALTER TABLE leads ADD COLUMN recording_deleted_at TEXT',
  // Voicemail capture: distinguishes voicemail leads from answered calls
  'ALTER TABLE leads ADD COLUMN call_type TEXT',
  // Free-text internal log (outbound click-to-call attempts, etc.)
  'ALTER TABLE leads ADD COLUMN internal_notes TEXT',
];

// ── Multi-tenancy: per-business unique constraints ──────────────────────────
// Phase 1 attached business_id to settings and inventory_pool but left their
// UNIQUE constraints global (settings UNIQUE(key) via its PK, inventory_pool
// UNIQUE(size)). Those collide the moment a second tenant exists — two
// businesses can't both have a `businessName` setting or a 20-yard pool. Each
// table must instead be UNIQUE(business_id, <col>). SQLite can't alter a
// constraint in place, so the table is rebuilt with the documented
// create-new / copy / drop-old / rename recipe.

// True once `table` has a UNIQUE constraint that includes business_id — i.e. the
// composite-key migration has already run. Inspecting the actual unique indexes
// (rather than matching CREATE-TABLE text) keeps the check robust to formatting.
function hasBusinessScopedUnique(table) {
  for (const idx of db.prepare(`PRAGMA index_list(${table})`).all()) {
    if (!idx.unique) continue;
    const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all().map((c) => c.name);
    if (cols.includes('business_id')) return true;
  }
  return false;
}

// Rebuild `table` in place using `createNewSql` (which must create
// `${table}_new`) and copy `columns` across. Follows SQLite's documented safe
// schema-change procedure: foreign keys are disabled around the swap, the work
// runs inside a single transaction, and FK integrity is verified before commit.
function rebuildTableInPlace(table, createNewSql, columns) {
  const cols = columns.join(', ');
  // PRAGMA foreign_keys is a no-op inside a transaction, so toggle it outside.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      db.exec(createNewSql);
      db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      const violations = db.prepare(`PRAGMA foreign_key_check(${table})`).all();
      if (violations.length > 0) {
        throw new Error(
          `foreign_key_check failed after rebuilding ${table}: ${JSON.stringify(violations)}`
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    // Restore the connection-level setting database.js opened with, even on error.
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigrations() {
  console.log('[migrations] Starting schema migrations…');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  for (const stmt of NEW_COLUMNS) {
    try {
      db.exec(stmt);
    } catch (e) {
      // Column already exists — safe to ignore
      if (!e.message.includes('duplicate column name')) {
        throw e;
      }
    }
  }

  // Backfill: any existing home_services lead without a sub_vertical defaults to
  // dumpster_rental so the field-pack-driven detail view has something to render.
  db.prepare(
    "UPDATE leads SET sub_vertical = 'dumpster_rental' WHERE vertical = 'home_services' AND (sub_vertical IS NULL OR sub_vertical = '')"
  ).run();

  // Devices table for APNs tokens
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_token TEXT NOT NULL UNIQUE,
      user_name TEXT,
      business_name TEXT,
      vertical TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Caller ID stashed by /twilio/voice for later lookup in /twilio/recording,
  // which doesn't reliably include the From field.
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_sessions (
      call_sid TEXT PRIMARY KEY,
      from_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Pool-based inventory (replaces the legacy per-asset `dumpsters` table).
  // Inventory is tracked as a count of units per size; availability for a date
  // range is computed by comparing owned quantity against jobs of that size that
  // are active during the range. `units_in_service` temporarily reduces the
  // available count for units that are down for maintenance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      size TEXT NOT NULL UNIQUE,
      quantity INTEGER NOT NULL DEFAULT 0,
      units_in_service INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // One-time migration from the legacy per-asset `dumpsters` table: group assets
  // by size, with quantity = unit count and units_in_service = count of units that
  // were flagged needs_service. Retired (out_of_service) units are excluded from
  // owned quantity. Runs only while the old table still exists and the pool is
  // empty, then drops the old table.
  const dumpstersExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='dumpsters'"
  ).get();
  if (dumpstersExists) {
    const poolCount = db.prepare('SELECT COUNT(*) AS n FROM inventory_pool').get().n;
    if (poolCount === 0) {
      const grouped = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(size), ''), 'Unspecified') AS size,
               COUNT(*) AS quantity,
               SUM(CASE WHEN status = 'needs_service' THEN 1 ELSE 0 END) AS units_in_service
        FROM dumpsters
        WHERE status != 'out_of_service'
        GROUP BY COALESCE(NULLIF(TRIM(size), ''), 'Unspecified')
      `).all();
      const insertPool = db.prepare(
        'INSERT INTO inventory_pool (size, quantity, units_in_service) VALUES (?, ?, ?)'
      );
      for (const row of grouped) {
        insertPool.run(row.size, row.quantity, row.units_in_service || 0);
      }
      console.log(`[migrations] Migrated ${grouped.length} size group(s) from dumpsters → inventory_pool`);
    }
    db.exec('DROP TABLE dumpsters');
    console.log('[migrations] Dropped legacy dumpsters table');
  }

  // Settings key-value store (used by payment page and SMS service)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Activity timeline — one row per lead touchpoint (calls, SMS, status changes,
  // voicemails, notes). Rows are removed with their lead via ON DELETE CASCADE.
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_lead ON activity_log(lead_id)');

  // One-time backfill from existing leads: each lead gets an inbound_call (or
  // voicemail) entry at its created_at, plus an sms_sent entry for any lead that
  // already had a payment link sent. Guarded on an empty table so re-running
  // migrations never duplicates rows.
  const activityCount = db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
  if (activityCount === 0) {
    const fmtDur = (sec) => {
      const s = Math.round(Number(sec));
      if (!s || s <= 0) return '';
      if (s < 60) return ` (${s}s)`;
      const m = Math.floor(s / 60);
      const r = s % 60;
      return r ? ` (${m}m ${r}s)` : ` (${m}m)`;
    };
    const existingLeads = db.prepare(
      'SELECT id, created_at, call_type, call_duration, transcription_duration_seconds, payment_sms_sent_at FROM leads'
    ).all();
    const insertActivity = db.prepare(
      'INSERT INTO activity_log (lead_id, activity_type, description, created_at) VALUES (?, ?, ?, ?)'
    );
    for (const lead of existingLeads) {
      const dur = fmtDur(lead.call_duration || lead.transcription_duration_seconds);
      if (lead.call_type === 'voicemail') {
        insertActivity.run(lead.id, 'voicemail', `Voicemail received${dur}`, lead.created_at);
      } else {
        insertActivity.run(lead.id, 'inbound_call', `Inbound call received${dur}`, lead.created_at);
      }
      if (lead.payment_sms_sent_at) {
        insertActivity.run(lead.id, 'sms_sent', 'Payment link sent via SMS', lead.payment_sms_sent_at);
      }
    }
    console.log(`[migrations] Backfilled activity_log for ${existingLeads.length} lead(s)`);
  }

  // ── Multi-tenancy foundation (Phase 1) ────────────────────────────────────
  // Purely additive: add a businesses table and a users table, then attach a
  // business_id to every pre-existing table so each row is scoped to a tenant.
  // No existing column is dropped or renamed and no existing route changes.
  // Auth middleware is NOT applied to any route in this phase.

  // One row per tenant. Valley Binz is seeded as row 1 below so all of the
  // existing single-tenant data has a home.
  db.exec(`
    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      owner_first_name TEXT,
      slug TEXT UNIQUE,
      twilio_phone_number TEXT,
      user_phone_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Login accounts, each belonging to one business. password_hash stores a
  // bcrypt hash — never a plaintext password.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id),
      email TEXT UNIQUE,
      password_hash TEXT,
      role TEXT DEFAULT 'owner',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Attach business_id to every pre-existing table. SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so we reuse the NEW_COLUMNS pattern above:
  // attempt the ALTER and swallow only the "duplicate column name" error, which
  // makes this idempotent across restarts. A column-level REFERENCES is allowed
  // by ALTER TABLE ADD COLUMN because the implicit default is NULL.
  const TENANT_TABLES = ['leads', 'inventory_pool', 'activity_log', 'call_sessions', 'devices', 'settings'];
  for (const table of TENANT_TABLES) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN business_id INTEGER REFERENCES businesses(id)`);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Seed Valley Binz as the first business (business_id = 1) if no matching
  // business exists yet, so all pre-existing data can be attributed to it.
  // Name/owner come from the settings store (values are JSON-encoded) with
  // sensible fallbacks; phone numbers come from the Twilio env vars.
  const readSetting = (key) => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return row.value; }
    } catch {
      return null;
    }
  };

  let valleyBinz = db.prepare("SELECT id FROM businesses WHERE slug = 'valley-binz'").get();
  if (!valleyBinz) {
    const businessName = readSetting('businessName') || 'Valley Binz';
    const ownerFirstName = readSetting('ownerFirstName') || 'Austin';
    const info = db.prepare(`
      INSERT INTO businesses (name, owner_first_name, slug, twilio_phone_number, user_phone_number)
      VALUES (?, ?, 'valley-binz', ?, ?)
    `).run(
      String(businessName),
      String(ownerFirstName),
      process.env.TWILIO_PHONE_NUMBER || null,
      process.env.USER_PHONE_NUMBER || null
    );
    valleyBinz = { id: Number(info.lastInsertRowid) };
    console.log(`[migrations] Seeded business "${businessName}" (slug "valley-binz") as business_id = ${valleyBinz.id}`);
  }
  const valleyBinzId = valleyBinz.id;

  // Backfill: attribute every pre-existing row to Valley Binz. Idempotent —
  // only rows not yet assigned a business_id are touched.
  for (const table of TENANT_TABLES) {
    const result = db.prepare(
      `UPDATE ${table} SET business_id = ? WHERE business_id IS NULL`
    ).run(valleyBinzId);
    console.log(`[migrations] Migration complete — ${Number(result.changes)} rows in "${table}" updated to business_id = ${valleyBinzId}`);
  }

  // ── Multi-tenancy (Phase 2.1): per-business unique constraints ─────────────
  // Swap the global UNIQUE constraints on settings(key) and inventory_pool(size)
  // for composite UNIQUE(business_id, …) so a second tenant's settings keys and
  // inventory sizes no longer collide with Valley Binz's. Each rebuild runs once
  // per database (guarded by hasBusinessScopedUnique) and preserves every
  // existing row — including the business_id values backfilled just above. See
  // the rebuildTableInPlace / hasBusinessScopedUnique helpers above for the
  // safe-rebuild mechanics.
  if (!hasBusinessScopedUnique('settings')) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
    rebuildTableInPlace(
      'settings',
      `CREATE TABLE settings_new (
        key TEXT NOT NULL,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        business_id INTEGER REFERENCES businesses(id),
        UNIQUE(business_id, key)
      )`,
      ['key', 'value', 'updated_at', 'business_id']
    );
    const after = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
    console.log(`[migrations] Rebuilt settings with UNIQUE(business_id, key) — ${after}/${before} rows preserved`);
  }

  if (!hasBusinessScopedUnique('inventory_pool')) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM inventory_pool').get().n;
    // `id` is copied verbatim so leads.assigned_dumpster_id keeps pointing at the
    // same pool rows after the rebuild.
    rebuildTableInPlace(
      'inventory_pool',
      `CREATE TABLE inventory_pool_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        size TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        units_in_service INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        business_id INTEGER REFERENCES businesses(id),
        UNIQUE(business_id, size)
      )`,
      ['id', 'size', 'quantity', 'units_in_service', 'notes', 'created_at', 'updated_at', 'business_id']
    );
    const after = db.prepare('SELECT COUNT(*) AS n FROM inventory_pool').get().n;
    console.log(`[migrations] Rebuilt inventory_pool with UNIQUE(business_id, size) — ${after}/${before} rows preserved`);
  }

  console.log('Database migrations completed successfully.');
}

try {
  runMigrations();
} catch (err) {
  console.error('[migrations] Migration failed:', err.message);
  throw err;
}

module.exports = { runMigrations };
