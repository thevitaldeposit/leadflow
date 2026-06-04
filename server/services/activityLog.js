const db = require('../db/database');

// Human-readable duration suffix for call/voicemail descriptions, e.g.
// 45 → "45s", 83 → "1m 23s". Returns '' for missing/zero durations.
function formatDuration(seconds) {
  const s = Math.round(Number(seconds));
  if (!s || s <= 0) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

// Append one touchpoint to a lead's activity timeline. Best-effort: a logging
// failure must never break the request that triggered it.
function logActivity(leadId, activityType, description) {
  if (!leadId) return;
  try {
    // business_id is derived from the lead so the timeline entry is scoped to the
    // same tenant without every caller having to pass it.
    db.prepare(
      `INSERT INTO activity_log (lead_id, activity_type, description, business_id)
       VALUES (?, ?, ?, (SELECT business_id FROM leads WHERE id = ?))`
    ).run(leadId, activityType, description || null, leadId);
  } catch (err) {
    console.error('[activityLog] Failed to log activity:', err.message);
  }
}

// All timeline entries for a lead, most recent first. id is the tiebreaker so
// entries created in the same second keep their insertion order.
function getActivityForLead(leadId) {
  return db.prepare(
    'SELECT id, lead_id, activity_type, description, created_at FROM activity_log WHERE lead_id = ? ORDER BY created_at DESC, id DESC'
  ).all(leadId);
}

module.exports = { logActivity, getActivityForLead, formatDuration };
