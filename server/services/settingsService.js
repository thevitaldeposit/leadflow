const db = require('../db/database');

// Used everywhere a timezone is needed but none is configured yet.
const DEFAULT_TIMEZONE = 'America/Chicago';

// Read a single settings value, parsing the JSON the settings route stores.
// Best-effort: any failure returns null so callers can fall back to defaults.
function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  } catch {
    return null;
  }
}

// The business's local IANA timezone, used to resolve relative dates like
// "tomorrow" against the local calendar rather than raw UTC.
function getTimezone() {
  const tz = getSetting('timezone');
  return (typeof tz === 'string' && tz.trim()) ? tz.trim() : DEFAULT_TIMEZONE;
}

module.exports = { getSetting, getTimezone, DEFAULT_TIMEZONE };
