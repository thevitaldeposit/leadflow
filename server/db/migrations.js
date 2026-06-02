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

  console.log('Database migrations completed successfully.');
}

try {
  runMigrations();
} catch (err) {
  console.error('[migrations] Migration failed:', err.message);
  throw err;
}

module.exports = { runMigrations };
