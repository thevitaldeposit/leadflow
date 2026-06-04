const db = require('../db/database');
const { getDefaultBusinessId } = require('./businesses');

// Used everywhere a timezone is needed but none is configured yet.
const DEFAULT_TIMEZONE = 'America/Chicago';

// Read a single settings value for one business, parsing the JSON the settings
// route stores. Best-effort: any failure returns null so callers can fall back to
// defaults. businessId defaults to the default tenant for callers without context.
function getSetting(key, businessId = getDefaultBusinessId()) {
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ? AND business_id = ?')
      .get(key, businessId);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  } catch {
    return null;
  }
}

// The business's local IANA timezone, used to resolve relative dates like
// "tomorrow" against the local calendar rather than raw UTC.
function getTimezone(businessId = getDefaultBusinessId()) {
  const tz = getSetting('timezone', businessId);
  return (typeof tz === 'string' && tz.trim()) ? tz.trim() : DEFAULT_TIMEZONE;
}

module.exports = { getSetting, getTimezone, DEFAULT_TIMEZONE };
