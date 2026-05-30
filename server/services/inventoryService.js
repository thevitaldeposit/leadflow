const db = require('../db/database');

// Normalize a size string to a leading integer for comparison.
// "10 yard", "10-yard dumpster", "10 yd", "10" → 10
function normalizeSize(s) {
  if (!s) return null;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Find an available dumpster for a date window and optionally a requested size,
// assign it to the lead, and return the result.
//
// deliveryDate / pickupDate: YYYY-MM-DD strings
// requestedSize: raw size string from AI ("10 yard", "20 yard dumpster", etc.) or null
//
// Returns { assigned: true, dumpster } or { assigned: false }
function autoAssignDumpster(leadId, requestedSize, deliveryDate, pickupDate) {
  const requestedNum = normalizeSize(requestedSize);

  // All active dumpsters
  const dumpsters = db.prepare(
    "SELECT * FROM dumpsters WHERE status != 'out_of_service' ORDER BY asset_number ASC"
  ).all();

  // Dumpster IDs already locked into a conflicting job window
  const conflictRows = db.prepare(`
    SELECT DISTINCT assigned_dumpster_id
    FROM leads
    WHERE assigned_dumpster_id IS NOT NULL
      AND delivery_date IS NOT NULL
      AND pickup_date IS NOT NULL
      AND delivery_date < ?
      AND pickup_date > ?
      AND (discarded = 0 OR discarded IS NULL)
      AND id != ?
  `).all(pickupDate, deliveryDate, leadId);
  const conflictSet = new Set(conflictRows.map(r => r.assigned_dumpster_id));

  const match = dumpsters.find(d => {
    if (conflictSet.has(d.id)) return false;
    if (requestedNum !== null && normalizeSize(d.size) !== requestedNum) return false;
    return true;
  });

  const now = new Date().toISOString();

  if (match) {
    db.prepare('UPDATE leads SET assigned_dumpster_id = ?, updated_at = ? WHERE id = ?')
      .run(match.id, now, leadId);
    db.prepare('UPDATE dumpsters SET status = ?, current_job_id = ?, updated_at = ? WHERE id = ?')
      .run('on_job', leadId, now, match.id);
    return { assigned: true, dumpster: match };
  }

  db.prepare('UPDATE leads SET needs_dumpster_assignment = 1, updated_at = ? WHERE id = ?')
    .run(now, leadId);
  return { assigned: false };
}

// Parse a rental duration string to integer days.
// "7 days" → 7, "1 week" → 7, "2 weeks" → 14, "10" → 10, etc.
function parseRentalDays(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (s.includes('week')) return Math.round(num * 7);
  if (s.includes('month')) return Math.round(num * 30);
  return Math.round(num);
}

// Add N days to a YYYY-MM-DD string, return YYYY-MM-DD.
function addDaysToISO(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = { autoAssignDumpster, parseRentalDays, addDaysToISO, normalizeSize };
