const db = require('../db/database');

// Columns safe to return as req.business — never password_hash or anything secret.
const BUSINESS_COLUMNS =
  'id, name, owner_first_name, slug, twilio_phone_number, user_phone_number, created_at';

// The default tenant. Until every client sends a token, tokenless requests on
// shared routes (leads/upload/devices) and Twilio calls that don't match a known
// number fall back to Valley Binz — the original single-tenant business seeded as
// the first row in the Phase 1 migration. Cached because the id never changes.
let _defaultId = null;

function getDefaultBusinessId() {
  if (_defaultId != null) return _defaultId;
  const row =
    db.prepare("SELECT id FROM businesses WHERE slug = 'valley-binz'").get() ||
    db.prepare('SELECT id FROM businesses ORDER BY id ASC LIMIT 1').get();
  _defaultId = row ? row.id : 1;
  return _defaultId;
}

function getDefaultBusiness() {
  return db
    .prepare(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE id = ?`)
    .get(getDefaultBusinessId());
}

// Map an inbound Twilio number (the webhook 'To' field) to the business that owns
// it. Returns the business id, or null when no business is registered for it.
function getBusinessIdByTwilioNumber(toNumber) {
  if (!toNumber) return null;
  const row = db
    .prepare('SELECT id FROM businesses WHERE twilio_phone_number = ?')
    .get(String(toNumber).trim());
  return row ? row.id : null;
}

module.exports = {
  BUSINESS_COLUMNS,
  getDefaultBusinessId,
  getDefaultBusiness,
  getBusinessIdByTwilioNumber,
};
