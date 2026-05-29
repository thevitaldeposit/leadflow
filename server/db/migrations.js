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
  // Home Services Phase 1 redesign: outcome lives alongside status so users can
  // track funnel stage (Quote Sent, Appointment Scheduled, etc.) independently
  // of pipeline state (Needs Follow Up, Booked, Lost).
  'ALTER TABLE leads ADD COLUMN outcome TEXT',
];

function runMigrations() {
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

  console.log('Database migrations completed successfully.');
}

runMigrations();

module.exports = { runMigrations };
