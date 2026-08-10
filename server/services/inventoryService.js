const db = require('../db/database');
const { ACTIVE_JOB_STATUSES } = require('../config/jobStatus');
// The canonical string size key ("20 yard" → "20yd") shared with the pricing layer
// so a size→rate join is reliable (see services/sizeKey.js). This module's own
// availability math still keys off the numeric normalizeSize() below; normalizeSizeKey
// is re-exported so both inventory and pricing resolve sizes through one helper.
const { normalizeSizeKey } = require('./sizeKey');

// Normalize a size string to a leading integer for comparison.
// "10 yard", "10-yard dumpster", "10 yd", "10" → 10
function normalizeSize(s) {
  if (!s) return null;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Job statuses that occupy a unit from the pool while active come from the canonical
// module (ACTIVE_JOB_STATUSES — a confirmed job, EXCLUDING completed).

// Count confirmed jobs, grouped by normalized size, whose [delivery, pickup)
// window overlaps the requested window. Job size is read from
// vertical_data.dumpsterSize. Returns Map<normalizedSize:number, count>.
//
// deliveryDate / pickupDate: YYYY-MM-DD strings
// excludeLeadId: omit this lead's own booking from the count (optional)
// businessId: scope the count to one tenant's jobs
function getActiveJobCountsBySize(deliveryDate, pickupDate, excludeLeadId = null, businessId) {
  const rows = db.prepare(`
    SELECT id, vertical_data
    FROM leads
    WHERE vertical = 'home_services'
      AND business_id = ?
      AND delivery_date IS NOT NULL
      AND pickup_date IS NOT NULL
      AND (discarded = 0 OR discarded IS NULL)
      AND job_status IN (${ACTIVE_JOB_STATUSES.map(() => '?').join(', ')})
      AND delivery_date < ?
      AND pickup_date > ?
  `).all(businessId, ...ACTIVE_JOB_STATUSES, pickupDate, deliveryDate);

  const exclude = excludeLeadId != null ? Number(excludeLeadId) : null;
  const counts = new Map();
  for (const r of rows) {
    if (exclude != null && r.id === exclude) continue;
    let size = null;
    try {
      const vd = r.vertical_data ? JSON.parse(r.vertical_data) : {};
      size = vd.dumpsterSize;
    } catch { /* ignore malformed vertical_data */ }
    const n = normalizeSize(size);
    if (n === null) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return counts;
}

// Group sizes for counting. Two spellings of the same size ("20 yard" / "20 yd")
// must land in one bucket, so the key is the leading integer the availability math
// already keys off. Sizes with no number keep their own bucket.
function sizeGroupKey(size) {
  const n = normalizeSize(size);
  return n !== null ? `n:${n}` : `raw:${String(size || '').trim().toLowerCase()}`;
}

// Per-size fleet counts, read from the ASSET REGISTRY (Phase 2a). This is the
// source of "how many do I own" — `inventory_pool.quantity` is no longer read.
//
//   quantity          active (non-retired) assets of that size
//   units_in_service  those of them flagged out_of_service
//   units_at_yard     those of them flagged at_yard — picked up, awaiting a dump
//
// so `quantity − units_in_service − units_at_yard` is the sellable count.
//
// `at_yard` is a FULL can: it came back off a job and can't go out again until it's
// weighed/dumped (the weekend case — collected Saturday, landfill shut till Monday).
// Counting it as sellable let the booking paths promise a dumpster that physically
// cannot be delivered, so it is subtracted here. The deduction clears itself: a weigh
// puts the unit back to 'available' (assignmentService.markWeighed) and re-dropping it
// moves it to 'out'. `out` stays ignored — a unit on a job is already accounted for by
// the overlapping-job count below, and double-subtracting it would refuse good bookings.
//
// `inventory_pool` is still read — but only as the per-size registry that carries
// the row `id` and `notes`, and to keep a size visible after its last unit is
// retired. Sizes that only exist in the fleet get a row with a null id.
function getFleetBySize(businessId) {
  const groups = new Map();
  const upsert = (key, size) => {
    let g = groups.get(key);
    if (!g) {
      g = { id: null, size, notes: null, quantity: 0, units_in_service: 0, units_at_yard: 0 };
      groups.set(key, g);
    }
    return g;
  };

  for (const p of db.prepare('SELECT id, size, notes FROM inventory_pool WHERE business_id = ?').all(businessId)) {
    const g = upsert(sizeGroupKey(p.size), p.size);
    // First pool row for a size wins the id/label; later duplicates only add notes.
    if (g.id === null) { g.id = p.id; g.size = p.size; }
    if (!g.notes) g.notes = p.notes || null;
  }

  for (const a of db.prepare('SELECT size, status FROM assets WHERE business_id = ? AND active = 1').all(businessId)) {
    const g = upsert(sizeGroupKey(a.size), a.size);
    g.quantity += 1;
    // Mutually exclusive on purpose — a unit is deducted once, never twice.
    if (a.status === 'out_of_service') g.units_in_service += 1;
    else if (a.status === 'at_yard') g.units_at_yard += 1;
  }

  const rows = [...groups.values()];
  rows.sort((a, b) => (normalizeSize(a.size) || 999) - (normalizeSize(b.size) || 999));
  return rows;
}

// Compute availability for every size for a given date window.
// available = owned quantity − units_in_service − units_at_yard − overlapping active
// jobs of that size.
//
// The at-yard term is what stops a full can being sold: it is subtracted for EVERY
// window, near-term or far-future, because nothing in the system knows when a unit
// will actually be dumped (landfill hours, the driver's route, the weekend). Being
// conservative here costs a callback; the alternative promised a dumpster that
// couldn't be delivered.
//
// Returns an array sorted numerically by size. Scoped to one tenant's inventory.
function getAvailabilityBySize(deliveryDate, pickupDate, excludeLeadId = null, businessId) {
  const fleet = getFleetBySize(businessId);
  const counts = getActiveJobCountsBySize(deliveryDate, pickupDate, excludeLeadId, businessId);

  const result = fleet.map(p => {
    const n = normalizeSize(p.size);
    const booked = (n !== null ? counts.get(n) : 0) || 0;
    const owned = p.quantity || 0;
    const inService = p.units_in_service || 0;
    const atYard = p.units_at_yard || 0;
    const available = Math.max(0, owned - inService - atYard - booked);
    return {
      id: p.id,
      size: p.size,
      quantity: owned,
      units_in_service: inService,
      units_at_yard: atYard,
      notes: p.notes || null,
      booked,
      available,
    };
  });

  result.sort((a, b) => (normalizeSize(a.size) || 999) - (normalizeSize(b.size) || 999));
  return result;
}

// Availability for a single requested size (matched by leading number).
// Returns the size's availability row, or null if no matching pool exists.
function getAvailabilityForSize(requestedSize, deliveryDate, pickupDate, excludeLeadId = null, businessId) {
  const requestedNum = normalizeSize(requestedSize);
  if (requestedNum === null) return null;
  const all = getAvailabilityBySize(deliveryDate, pickupDate, excludeLeadId, businessId);
  return all.find(a => normalizeSize(a.size) === requestedNum) || null;
}

// The earliest delivery date AFTER `deliveryDate` on which a unit of the requested
// size is free for the SAME rental length. Used by the manual-booking surfaces to
// answer "if today's window is full, when's the next opening?" — advisory only, so
// the caller can still intentionally overbook. Scans forward one day at a time up to
// `horizonDays`; returns a YYYY-MM-DD string, or null if no opening in that horizon
// (or if there's no pool for the size at all). Pure availability math — no writes,
// no auto-book logic.
function getNextAvailableDate(requestedSize, deliveryDate, rentalDays, excludeLeadId = null, businessId, horizonDays = 60) {
  const days = Number(rentalDays);
  if (!deliveryDate || !(days >= 1)) return null;
  if (normalizeSize(requestedSize) === null) return null;

  for (let offset = 1; offset <= horizonDays; offset++) {
    const candidateDelivery = addDaysToISO(deliveryDate, offset);
    const candidatePickup = addDaysToISO(candidateDelivery, days);
    const avail = getAvailabilityForSize(requestedSize, candidateDelivery, candidatePickup, excludeLeadId, businessId);
    // A null row means the size has no pool — nothing will ever be available for it.
    if (avail === null) return null;
    if (avail.available > 0) return candidateDelivery;
  }
  return null;
}

// ── Capacity enforcement ───────────────────────────────────────────────────────
// The ONE answer to "can I book a unit of this size for [delivery, pickup)?", shared
// by every owner-initiated booking path (manual create, Confirm Booking / Send
// Payment Link / Mark Paid), by the auto-book gate, and by the payment-time race
// check in jobLifecycle.
//
// It is a thin wrapper over getAvailabilityForSize — the availability math itself is
// unchanged: available = owned − out_of_service − at_yard − overlapping PAID/ACTIVE jobs.
// Unpaid holds (pending_payment) deliberately reserve nothing, which is exactly why
// jobLifecycle re-checks at payment time.
//
// Returns { ok, reason, available, quantity, size, message }:
//   ok:true  → a unit is free, OR capacity is not evaluable here
//              ('no_window' / 'no_size' — the callers enforce those separately —
//               and 'no_fleet', a business that hasn't set up inventory at all,
//               which must not have every booking refused)
//   ok:false → 'size_not_owned' (fleet exists but not this size) or 'none_available'
function assertCapacity(businessId, { size, deliveryDate, pickupDate, excludeLeadId = null } = {}) {
  const base = { available: null, quantity: null, size: size || null, message: null };
  if (!deliveryDate || !pickupDate) return { ...base, ok: true, reason: 'no_window' };
  if (normalizeSize(size) === null) return { ...base, ok: true, reason: 'no_size' };

  // A business with no inventory configured has nothing to enforce against — gating
  // it would refuse every booking it ever tries to make.
  if (getFleetBySize(businessId).length === 0) return { ...base, ok: true, reason: 'no_fleet' };

  const row = getAvailabilityForSize(size, deliveryDate, pickupDate, excludeLeadId, businessId);
  if (!row) {
    return {
      ...base,
      ok: false,
      reason: 'size_not_owned',
      available: 0,
      quantity: 0,
      message: `No ${size} in your fleet. Add one in Inventory, or pick a size you own.`,
    };
  }
  if (row.available > 0) {
    return { ...base, ok: true, reason: 'available', available: row.available, quantity: row.quantity };
  }
  // Name the at-yard units in the refusal — "all 2 are booked" reads like a bug when
  // the owner can see one sitting in the yard. It's there, it's just still full.
  let why = ` — all ${row.quantity} are booked or out of service for those dates.`;
  if (row.units_at_yard > 0) {
    why = ` — ${row.units_at_yard} of ${row.quantity} ${row.units_at_yard === 1 ? 'is' : 'are'} at the yard`
      + ' awaiting a dump, the rest are booked or out of service. Record the weight to free it.';
  }
  return {
    ...base,
    ok: false,
    reason: 'none_available',
    available: 0,
    quantity: row.quantity,
    message: `No ${size} available for ${formatWindow(deliveryDate, pickupDate)}`
      + (row.quantity ? why : '.'),
  };
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-08-12" + "2026-08-15" → "Aug 12–15"; across months → "Aug 30–Sep 2".
// Plain string math on the ISO parts — no Date, no timezone to get wrong.
function formatWindow(deliveryDate, pickupDate) {
  const part = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? { mon: Number(m[2]), day: Number(m[3]) } : null;
  };
  const a = part(deliveryDate);
  const b = part(pickupDate);
  if (!a) return `${deliveryDate} to ${pickupDate}`;
  const label = (p) => `${MONTH_ABBR[p.mon - 1] || p.mon} ${p.day}`;
  if (!b) return label(a);
  return a.mon === b.mon ? `${label(a)}–${b.day}` : `${label(a)}–${label(b)}`;
}

// Raise the SAME inventory-conflict signal the auto-book gate uses, WITHOUT changing
// the job's status. Used at payment time: a completed payment always books (we never
// bounce the customer's money), so when the fleet can't actually cover it the job
// stands and the owner gets a top-of-Action-Queue flag to resolve the double-book.
// Writes vertical_data + internal_notes only; the caller logs the timeline event.
function flagInventoryConflict(lead, { note, recommendation }) {
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  if (vd.inventoryConflict === true) return false; // already flagged — don't re-stamp

  vd.inventoryConflict = true;
  vd.aiRecommendation = recommendation;
  vd.urgency = 'ASAP';
  vd.followUpDate = new Date().toISOString();
  vd.followUpReason = 'Inventory conflict — no unit free for these dates';

  const existingNotes = (lead.internal_notes || '').trim();
  const internalNotes = existingNotes ? `${note}\n\n${existingNotes}` : note;
  const serializedVd = JSON.stringify(vd);
  const nowISO = new Date().toISOString();

  db.prepare('UPDATE leads SET internal_notes = ?, vertical_data = ?, updated_at = ? WHERE id = ?')
    .run(internalNotes, serializedVd, nowISO, lead.id);

  lead.internal_notes = internalNotes;
  lead.vertical_data = serializedVd;
  lead.updated_at = nowISO;
  return true;
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

// Format a moment as its YYYY-MM-DD calendar date in a given IANA timezone.
// en-CA yields YYYY-MM-DD; the timeZone option shifts to the local date, so a
// late-evening call west of UTC reports the local day rather than UTC's day.
function localDateInTimeZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    // Unknown/invalid timezone — fall back to UTC date rather than throwing.
    return date.toISOString().slice(0, 10);
  }
}

// Resolve a human-readable delivery date string to YYYY-MM-DD using the
// call timestamp as "today", anchored to the business's local timeZone.
// Returns null if the string cannot be resolved OR if the customer gave an
// ambiguous/non-specific date.
function resolveDeliveryDate(rawDate, callTimestamp = new Date(), timeZone = 'America/Chicago') {
  if (!rawDate) return null;

  const raw = String(rawDate).trim();

  // ISO passthrough first — this is already a resolved date, skip ambiguity check.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Reject ambiguous language — we must not guess a specific date from a vague phrase.
  // Better to store null and prompt the user to confirm than to schedule the wrong day.
  const lower0 = raw.toLowerCase();
  if (
    lower0.includes(' or ') ||          // "today or tomorrow", "Monday or Tuesday"
    lower0.includes('maybe') ||          // "maybe Monday"
    lower0.includes('sometime') ||       // "sometime this week"
    lower0.includes('flexible') ||       // "flexible"
    lower0.includes('not sure') ||       // "not sure yet"
    lower0.includes('unsure') ||
    lower0.includes('possibly') ||
    lower0.includes('probably') ||
    lower0.includes('around ') ||        // "around Monday", "around the 5th"
    lower0.includes('ish') ||            // "Mondayish"
    /^\d{1,2}\s*[-–]\s*\d{1,2}$/.test(raw.trim())  // bare "5-6" or "5 - 6" day range
  ) {
    return null;
  }

  const lower = raw.toLowerCase();

  // Anchor "today" to the call date in the business's local timezone, NOT UTC.
  // The anchor itself is held as midnight-UTC so the day-offset math below stays
  // DST-proof; only integer days are ever added and we slice off the date.
  const todayStr = localDateInTimeZone(callTimestamp, timeZone);
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

// Resolve a rental-end / pickup phrase to an ISO date (YYYY-MM-DD).
//
// Customers describe the end of a rental relative to the start, e.g.
// "until Friday", "til next Monday", "through June 5", or the combined
// "tomorrow until friday". We strip the leading connective and hand the
// remaining date phrase to resolveDeliveryDate, which already anchors weekday
// math to the business timezone. This keeps the (correct) Node weekday logic
// authoritative instead of trusting the AI, which routinely lands a named
// weekday one day late (e.g. resolving Friday to the following Saturday).
//
// Returns null when no resolvable date is present.
const PICKUP_CONNECTIVE_RE = /\b(?:until|untill|til|till|through|thru|to|by)\s+(.+)$/i;
function resolvePickupPhrase(phrase, callTimestamp = new Date(), timeZone = 'America/Chicago') {
  if (!phrase) return null;
  const str = String(phrase).trim();
  const m = str.match(PICKUP_CONNECTIVE_RE);
  const datePart = (m ? m[1] : str).trim();
  return resolveDeliveryDate(datePart, callTimestamp, timeZone);
}

// Gate an AI-detected auto-booking on real pool availability.
//
// Inventory is pool-based: availability for the requested size is computed by
// the same date-overlap logic the booking modal and schedule page use
// (getAvailabilityForSize). Before a payment link goes out we must confirm a
// unit of the requested size is actually free for [delivery, pickup).
//
// If a unit is available → returns { blocked: false } and the booking proceeds.
// If none is available → the provisional booking is downgraded IN PLACE: the
// lead becomes a flagged high-intent opportunity that surfaces at the top of
// the Action Queue, no payment link is sent, and the conflict is recorded
// in internal_notes. Both `verticalData` (in memory) and the leads row (in DB)
// are mutated so the caller can re-check verticalData.autoBooked.
//
// Returns { blocked, pickupDate }.
function enforceAutoBookAvailability(lead, verticalData) {
  // Only confirmed auto-bookings with a known delivery date can conflict.
  if (!(verticalData.autoBooked === true && lead.delivery_date)) {
    return { blocked: false, pickupDate: lead.pickup_date || null };
  }

  // Determine the end of the rental window so we can test date overlap.
  let pickupDate = lead.pickup_date;
  if (!pickupDate && verticalData.rentalDuration) {
    const days = parseRentalDays(verticalData.rentalDuration);
    if (days) pickupDate = addDaysToISO(lead.delivery_date, days);
  }

  // Without a window we cannot evaluate overlap — leave the booking untouched.
  if (!pickupDate) {
    return { blocked: false, pickupDate: null };
  }

  // Persist a derived pickup date so schedule/availability views agree.
  if (!lead.pickup_date) {
    db.prepare('UPDATE leads SET pickup_date = ?, updated_at = ? WHERE id = ?')
      .run(pickupDate, new Date().toISOString(), lead.id);
    lead.pickup_date = pickupDate;
  }

  // Exclude this lead's own provisional booking from the overlap count, scoped
  // to the lead's own business.
  const avail = getAvailabilityForSize(verticalData.dumpsterSize, lead.delivery_date, pickupDate, lead.id, lead.business_id);
  if (avail && avail.available > 0) {
    return { blocked: false, pickupDate };
  }

  // ── INVENTORY CONFLICT — block the auto-booking ──────────────────────────
  const sizeLabel = verticalData.dumpsterSize || 'requested size';
  const recommendation = `INVENTORY CONFLICT — Customer agreed to book a ${sizeLabel} dumpster for ${lead.delivery_date} but no units are available. Call customer immediately to reschedule.`;
  const blockNote = `AUTO-BOOK BLOCKED: No ${sizeLabel} available for ${lead.delivery_date} to ${pickupDate}. Customer needs to be contacted to reschedule.`;

  // Downgrade the in-memory verticalData. Clearing autoBooked makes the caller's
  // `verticalData.autoBooked === true` payment-link check fall through. urgency
  // ASAP + an immediate followUpDate put the lead in the top Action Queue
  // tier; the aiRecommendation overrides any default text shown there.
  verticalData.autoBooked = false;
  verticalData.bookingConfidence = 'possible';
  verticalData.job_status = 'opportunity';
  verticalData.intentLevel = 'high';
  verticalData.urgency = 'ASAP';
  verticalData.outcome = 'quote_sent';
  verticalData.aiRecommendation = recommendation;
  verticalData.inventoryConflict = true;
  verticalData.followUpDate = new Date().toISOString();
  verticalData.followUpReason = 'Inventory conflict — call customer immediately to reschedule';

  const existingNotes = (lead.internal_notes || '').trim();
  const internalNotes = existingNotes ? `${blockNote}\n\n${existingNotes}` : blockNote;
  const serializedVd = JSON.stringify(verticalData);
  const nowISO = new Date().toISOString();

  db.prepare(`
    UPDATE leads
       SET job_status = 'opportunity',
           auto_booked = 0,
           outcome = 'quote_sent',
           internal_notes = ?,
           vertical_data = ?,
           updated_at = ?
     WHERE id = ?
  `).run(internalNotes, serializedVd, nowISO, lead.id);

  // Keep the in-memory row in sync with what we just persisted.
  lead.job_status = 'opportunity';
  lead.auto_booked = 0;
  lead.outcome = 'quote_sent';
  lead.internal_notes = internalNotes;
  lead.vertical_data = serializedVd;
  lead.updated_at = nowISO;

  return { blocked: true, pickupDate, recommendation, blockNote };
}

module.exports = {
  getActiveJobCountsBySize,
  getFleetBySize,
  getAvailabilityBySize,
  getAvailabilityForSize,
  getNextAvailableDate,
  assertCapacity,
  flagInventoryConflict,
  parseRentalDays,
  addDaysToISO,
  normalizeSize,
  normalizeSizeKey,
  localDateInTimeZone,
  resolveDeliveryDate,
  calculatePickupDate,
  resolvePickupPhrase,
  enforceAutoBookAvailability,
};
