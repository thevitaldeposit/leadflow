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

// Resolve a human-readable delivery date string to YYYY-MM-DD using the
// call timestamp as "today". Returns null if the string cannot be resolved.
function resolveDeliveryDate(rawDate, callTimestamp = new Date()) {
  if (!rawDate) return null;

  const raw = String(rawDate).trim();

  // Already a valid ISO date — return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const lower = raw.toLowerCase();

  // Anchor "today" to the date portion of callTimestamp (UTC, avoids DST drift)
  const todayStr = callTimestamp.toISOString().slice(0, 10);
  const today = new Date(todayStr + 'T00:00:00Z');
  const todayDay = today.getUTCDay(); // 0=Sun … 6=Sat

  function addDays(base, n) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  if (lower === 'today') return addDays(today, 0);
  if (lower === 'tomorrow') return addDays(today, 1);

  const WEEKDAY = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

  // "next week" → the coming Monday
  if (lower === 'next week') {
    const delta = ((1 - todayDay + 7) % 7) + 7;
    return addDays(today, delta);
  }

  // "next <weekday>"
  const nextWd = lower.match(/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (nextWd) {
    const target = WEEKDAY[nextWd[1]];
    // "next Monday" means the Monday AFTER the coming one.
    // First find days until the next occurrence (same day → treat as 7, not 0),
    // then add another 7 to land on the week after that.
    const daysToNext = ((target - todayDay + 7) % 7) || 7;
    return addDays(today, daysToNext + 7);
  }

  // "this <weekday>" or bare "<weekday>"
  const bareOrThis = lower.match(/^(?:this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (bareOrThis) {
    const target = WEEKDAY[bareOrThis[1]];
    // Same weekday as call → assume customer means NEXT week (not today)
    const delta = ((target - todayDay + 7) % 7) || 7;
    return addDays(today, delta);
  }

  // "Month Day[ordinal][ , Year]"  e.g. "June 3", "June 3rd", "Jun 3, 2026"
  const MONTHS = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5,
    july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };
  const monthDay = lower.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?$/);
  if (monthDay && MONTHS[monthDay[1]] !== undefined) {
    const month = MONTHS[monthDay[1]];
    const day = parseInt(monthDay[2], 10);
    const year = monthDay[3] ? parseInt(monthDay[3], 10) : today.getUTCFullYear();
    const candidate = new Date(Date.UTC(year, month, day));
    // If no explicit year and the date is already past, bump to next year
    if (!monthDay[3] && candidate < today) {
      candidate.setUTCFullYear(today.getUTCFullYear() + 1);
    }
    return candidate.toISOString().slice(0, 10);
  }

  return null;
}

// Calculate pickup date from a resolved delivery ISO date and a rental duration string.
function calculatePickupDate(deliveryDateISO, rentalDuration) {
  if (!deliveryDateISO || !rentalDuration) return null;
  const days = parseRentalDays(rentalDuration);
  if (!days) return null;
  return addDaysToISO(deliveryDateISO, days);
}

module.exports = { autoAssignDumpster, parseRentalDays, addDaysToISO, normalizeSize, resolveDeliveryDate, calculatePickupDate };
