const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { addDaysToISO, getAvailabilityBySize } = require('../services/inventoryService');

// Every schedule route is scoped to the authenticated business.
router.use(requireAuth);

// ── GET /api/schedule/availability ────────────────────────────────────────────
// Query params: delivery_date (YYYY-MM-DD), rental_duration (days, integer)
// Returns per-size availability counts for the requested window.
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

    // Pool-based availability: owned quantity − units in service − overlapping
    // active jobs of that size.
    const bySizes = getAvailabilityBySize(delivery_date, pickupDate, null, req.business.id).map(p => ({
      size: p.size,
      ownedCount: p.quantity,
      unitsInService: p.units_in_service,
      bookedCount: p.booked,
      availableCount: p.available,
    }));

    res.json({ deliveryDate: delivery_date, pickupDate, rentalDuration: days, bySizes });
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
             job_status, delivery_date, pickup_date, estimated_revenue
      FROM leads
      WHERE vertical = 'home_services'
        AND business_id = ?
        AND (discarded = 0 OR discarded IS NULL)
        AND job_status IN ('booked', 'scheduled', 'delivered', 'active_rental', 'picked_up')
        AND (
          (delivery_date >= ? AND delivery_date <= ?)
          OR (pickup_date >= ? AND pickup_date <= ?)
          OR (delivery_date IS NOT NULL AND delivery_date <= ? AND (pickup_date IS NULL OR pickup_date >= ?))
        )
    `).all(req.business.id, firstDay, lastDay, firstDay, lastDay, lastDay, firstDay);

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
