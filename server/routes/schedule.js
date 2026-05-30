const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { normalizeSize, addDaysToISO } = require('../services/inventoryService');

// ── helpers ────────────────────────────────────────────────────────────────────

function getLeadName(lead) {
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    return vd.customerName || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || null;
  } catch {
    return [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || null;
  }
}

function getLeadSize(lead) {
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    return vd.dumpsterSize || null;
  } catch {
    return null;
  }
}

// ── GET /api/schedule/availability ────────────────────────────────────────────
// Query params: delivery_date (YYYY-MM-DD), rental_duration (days, integer)
// Returns availability grouped by dumpster size.
router.get('/availability', (req, res) => {
  try {
    const { delivery_date, rental_duration } = req.query;
    if (!delivery_date || !rental_duration) {
      return res.status(400).json({ error: 'delivery_date and rental_duration are required' });
    }

    const days = parseInt(rental_duration, 10);
    if (isNaN(days) || days < 1) {
      return res.status(400).json({ error: 'rental_duration must be a positive integer' });
    }

    const pickupDate = addDaysToISO(delivery_date, days);

    // All non-retired dumpsters
    const dumpsters = db.prepare(
      "SELECT * FROM dumpsters WHERE status != 'out_of_service' ORDER BY size ASC, asset_number ASC"
    ).all();

    // All booked leads with date windows (exclude discarded)
    const bookedLeads = db.prepare(`
      SELECT id, assigned_dumpster_id, delivery_date, pickup_date,
             customer_first_name, customer_last_name, vertical_data
      FROM leads
      WHERE assigned_dumpster_id IS NOT NULL
        AND delivery_date IS NOT NULL
        AND pickup_date IS NOT NULL
        AND (discarded = 0 OR discarded IS NULL)
        AND job_status NOT IN ('completed', 'picked_up', 'cancelled', 'lost', 'spam')
    `).all();

    // Map dumpster id → conflicting lead (the first conflict found)
    const conflictMap = new Map();
    for (const lead of bookedLeads) {
      if (lead.delivery_date < pickupDate && lead.pickup_date > delivery_date) {
        if (!conflictMap.has(lead.assigned_dumpster_id)) {
          conflictMap.set(lead.assigned_dumpster_id, lead);
        }
      }
    }

    // All future leads per dumpster (for next-available calculation)
    // For each unavailable dumpster, find all conflicting windows and compute
    // the earliest date after all conflicts clear.
    const futureLeadsByDumpster = new Map();
    for (const lead of bookedLeads) {
      if (!futureLeadsByDumpster.has(lead.assigned_dumpster_id)) {
        futureLeadsByDumpster.set(lead.assigned_dumpster_id, []);
      }
      futureLeadsByDumpster.get(lead.assigned_dumpster_id).push(lead);
    }

    // Group dumpsters by size
    const sizeMap = new Map();
    for (const d of dumpsters) {
      const size = d.size || 'Unknown';
      if (!sizeMap.has(size)) sizeMap.set(size, { available: [], unavailable: [] });
      const group = sizeMap.get(size);
      const conflict = conflictMap.get(d.id) || null;
      if (conflict) {
        group.unavailable.push({ ...d, conflict: {
          leadId: conflict.id,
          customerName: getLeadName(conflict),
          deliveryDate: conflict.delivery_date,
          pickupDate: conflict.pickup_date,
        }});
      } else {
        group.available.push(d);
      }
    }

    // Compute next available date per size
    function nextAvailableDateForSize(size) {
      const sizeDumpsters = dumpsters.filter(d => d.size === size);
      let earliest = null;
      for (const d of sizeDumpsters) {
        const leads = futureLeadsByDumpster.get(d.id) || [];
        // Sort conflicts by pickup_date DESC — the last pickup_date after conflicts
        const overlapping = leads.filter(l => l.delivery_date < pickupDate && l.pickup_date > delivery_date);
        if (overlapping.length === 0) return delivery_date; // already available
        const lastPickup = overlapping.reduce((max, l) => l.pickup_date > max ? l.pickup_date : max, '');
        if (!earliest || lastPickup < earliest) earliest = lastPickup;
      }
      return earliest; // day the last conflict returns
    }

    const result = [];
    for (const [size, group] of sizeMap) {
      const nextAvailable = group.available.length === 0
        ? nextAvailableDateForSize(size)
        : null;
      result.push({
        size,
        totalCount: group.available.length + group.unavailable.length,
        availableCount: group.available.length,
        available: group.available.map(d => ({ id: d.id, asset_number: d.asset_number, size: d.size })),
        unavailable: group.unavailable.map(d => ({
          id: d.id,
          asset_number: d.asset_number,
          size: d.size,
          conflict: d.conflict,
        })),
        nextAvailableDate: nextAvailable,
      });
    }

    // Sort sizes numerically
    result.sort((a, b) => {
      const na = normalizeSize(a.size) || 999;
      const nb = normalizeSize(b.size) || 999;
      return na - nb;
    });

    res.json({ deliveryDate: delivery_date, pickupDate, rentalDuration: days, bySizes: result });
  } catch (err) {
    console.error('GET /schedule/availability error:', err);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// ── GET /api/schedule/calendar ─────────────────────────────────────────────────
// Query params: year (YYYY), month (1-12)
// Returns all leads with activity in that month: deliveries, pickups, active rentals.
router.get('/calendar', (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);

    const monthStr = String(month).padStart(2, '0');
    const firstDay = `${year}-${monthStr}-01`;
    const lastDayDate = new Date(year, month, 0); // last day of month
    const lastDay = `${year}-${monthStr}-${String(lastDayDate.getDate()).padStart(2, '0')}`;

    // Fetch all relevant leads:
    // - delivery_date in month, OR
    // - pickup_date in month, OR
    // - active rental spanning into the month (delivery before month-end, pickup after month-start or null)
    const leads = db.prepare(`
      SELECT id, customer_first_name, customer_last_name, vertical_data, sub_vertical,
             job_status, delivery_date, pickup_date, estimated_revenue, assigned_dumpster_id
      FROM leads
      WHERE vertical = 'home_services'
        AND (discarded = 0 OR discarded IS NULL)
        AND job_status NOT IN ('lost', 'spam')
        AND (
          (delivery_date >= ? AND delivery_date <= ?)
          OR (pickup_date >= ? AND pickup_date <= ?)
          OR (delivery_date IS NOT NULL AND delivery_date <= ? AND (pickup_date IS NULL OR pickup_date >= ?))
        )
    `).all(firstDay, lastDay, firstDay, lastDay, lastDay, firstDay);

    // Build day-by-day map for the entire month
    const dayMap = {};
    const totalDays = lastDayDate.getDate();

    for (let d = 1; d <= totalDays; d++) {
      const dayStr = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
      dayMap[dayStr] = { deliveries: [], pickups: [], activeRentals: [] };
    }

    for (const lead of leads) {
      let vd = {};
      try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch {}
      const summary = {
        id: lead.id,
        customerName: vd.customerName || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown',
        dumpsterSize: vd.dumpsterSize || null,
        address: vd.deliveryAddress || null,
        assetNumber: null, // will look up if needed
        jobStatus: lead.job_status,
        deliveryDate: lead.delivery_date,
        pickupDate: lead.pickup_date,
      };

      if (lead.delivery_date && dayMap[lead.delivery_date]) {
        dayMap[lead.delivery_date].deliveries.push(summary);
      }
      if (lead.pickup_date && dayMap[lead.pickup_date]) {
        dayMap[lead.pickup_date].pickups.push(summary);
      }

      // Mark active rentals: all days between delivery and pickup (exclusive of delivery and pickup days)
      if (lead.delivery_date && lead.pickup_date) {
        for (let d = 1; d <= totalDays; d++) {
          const dayStr = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
          if (dayStr > lead.delivery_date && dayStr < lead.pickup_date && dayMap[dayStr]) {
            dayMap[dayStr].activeRentals.push(summary);
          }
        }
      }
    }

    res.json({ year, month, days: dayMap });
  } catch (err) {
    console.error('GET /schedule/calendar error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar' });
  }
});

module.exports = router;
