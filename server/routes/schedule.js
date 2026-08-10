const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { addDaysToISO, getAvailabilityBySize } = require('../services/inventoryService');
const {
  TASK_LEAD_COLUMNS, summariesForLeadRows, jobTaskSummariesByIds, jobTaskSummary,
} = require('../services/scheduleTaskService');
const { ACTIVE_JOB_STATUSES } = require('../config/jobStatus');

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

    // Pool-based availability: owned quantity − units in service − units at the yard
    // (picked up, awaiting a dump) − overlapping active jobs of that size.
    const bySizes = getAvailabilityBySize(delivery_date, pickupDate, null, req.business.id).map(p => ({
      size: p.size,
      ownedCount: p.quantity,
      unitsInService: p.units_in_service,
      unitsAtYard: p.units_at_yard,
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
      SELECT ${TASK_LEAD_COLUMNS}
      FROM leads
      WHERE vertical = 'home_services'
        AND business_id = ?
        AND (discarded = 0 OR discarded IS NULL)
        AND job_status IN (${ACTIVE_JOB_STATUSES.map(() => '?').join(', ')})
        AND (
          (delivery_date >= ? AND delivery_date <= ?)
          OR (pickup_date >= ? AND pickup_date <= ?)
          OR (delivery_date IS NOT NULL AND delivery_date <= ? AND (pickup_date IS NULL OR pickup_date >= ?))
        )
    `).all(req.business.id, ...ACTIVE_JOB_STATUSES, firstDay, lastDay, firstDay, lastDay, lastDay, firstDay);

    // One task summary per job — the SAME shape the task screen and the dashboard's
    // Today's Schedule read (services/scheduleTaskService.js), with the on-site units
    // and the derived done-ness batched into one query each for the whole month.
    // Display state only: nothing is written, and units_out, the completion gate and
    // the swap markers are untouched.
    const summaryByLead = new Map(
      summariesForLeadRows(req.business.id, leads).map(s => [s.id, s])
    );

    // Build day-by-day map for the entire month
    const dayMap = {};
    const totalDays = lastDayDate.getDate();

    for (let d = 1; d <= totalDays; d++) {
      const dayStr = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
      dayMap[dayStr] = { deliveries: [], pickups: [], activeRentals: [] };
    }

    for (const lead of leads) {
      const summary = summaryByLead.get(lead.id);
      if (!summary) continue;

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

// ── GET /api/schedule/tasks?ids=1,2,3 ─────────────────────────────────────────
// The same task summaries the calendar embeds, for an arbitrary set of jobs. The
// dashboard's Today's Schedule picks its own rows out of the leads it already has
// and uses this to fill in the parts only the server can know (which unit is on
// site, whether the drop/pickup is done). Read-only; unknown ids are simply absent.
router.get('/tasks', (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return res.json({ tasks: [] });
    res.json({ tasks: jobTaskSummariesByIds(req.business.id, ids) });
  } catch (err) {
    console.error('GET /schedule/tasks error:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// ── GET /api/schedule/task/:leadId ────────────────────────────────────────────
// One job's task summary — what the /task/:leadId screen loads. Declared after
// /tasks so neither path can shadow the other.
router.get('/task/:leadId', (req, res) => {
  try {
    const task = jobTaskSummary(req.business.id, req.params.leadId);
    if (!task) return res.status(404).json({ error: 'Job not found' });
    res.json({ task });
  } catch (err) {
    console.error('GET /schedule/task/:leadId error:', err);
    res.status(500).json({ error: 'Failed to fetch the job' });
  }
});

module.exports = router;
