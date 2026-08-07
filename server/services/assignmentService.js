const db = require('../db/database');
const { getAsset, updateAsset } = require('./assetService');
const { normalizeSize } = require('./inventoryService');
const { sizeKeyMatches, normalizeSizeKey } = require('./sizeKey');
const { logActivity } = require('./activityLog');
const { emitToBusiness } = require('../socket');

// ── Unit ↔ job assignments (pickup rework, Phase 2b + 2c) ────────────────────
//
// Which physical dumpster sat on which job. The `assignments` table was created
// empty in 2a; this is the layer that fills it:
//   drop    → new row (dropped_at = now), asset status 'out'
//   pickup  → stamp picked_up_at on that row, asset status 'at_yard'
//   weigh   → stamp weighed_at on that row, asset status 'available'  (2c)
//
// A job can hold several assignments over its life (a swap = the replacement is a
// second row), which is why this is a link table and not a column on the lead.
//
// Phase 2c makes the assignment the ANCHOR for weight attribution: the row names
// both the unit and the job, so a ticket bills the job the can actually sat on
// rather than whichever lead the owner had open. This module still owns none of
// that logic — it exposes the lookups (getAssignment, yardUnits) and the state
// stamp (markWeighed); overage, dump tickets, units_out, the swap markers
// (pendingSwapOuts / swapOutsApplied) and the completion gate all stay in
// jobLifecycle, unchanged in how they decide anything.
//
// It also doesn't feed availability: 2a's math is a pure per-size count and must
// never require a unit to be assigned, so `out` / `at_yard` / `available` stay
// location state only.

function nowIso() { return new Date().toISOString(); }

function fail(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function displayName(lead) {
  if (!lead) return 'another job';
  const name = [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ').trim();
  return name || `job #${lead.id}`;
}

// One assignment as the API shape: the row plus the unit's label/size, so a caller
// never has to re-join assets to render "Unit 12".
const ASSIGNMENT_SELECT = `
  SELECT asg.id, asg.asset_id, asg.lead_id, asg.dropped_at, asg.picked_up_at,
         asg.weighed_at, asg.notes,
         ast.label, ast.size, ast.status
  FROM assignments asg
  JOIN assets ast ON ast.id = asg.asset_id
`;

// Every unit this job has ever held, newest drop first (includes picked-up ones).
function listAssignments(businessId, leadId) {
  return db.prepare(`
    ${ASSIGNMENT_SELECT}
    WHERE asg.business_id = ? AND asg.lead_id = ?
    ORDER BY COALESCE(asg.dropped_at, asg.created_at) DESC, asg.id DESC
  `).all(businessId, leadId);
}

// The unit(s) physically ON SITE for a job: dropped and not yet picked up. This is
// both the pickup picker's option list and what the job/customer view displays.
function onSiteAssignments(businessId, leadId) {
  return db.prepare(`
    ${ASSIGNMENT_SELECT}
    WHERE asg.business_id = ? AND asg.lead_id = ? AND asg.picked_up_at IS NULL
    ORDER BY COALESCE(asg.dropped_at, asg.created_at) ASC, asg.id ASC
  `).all(businessId, leadId);
}

// On-site units for many jobs at once — one query behind the schedule calendar so a
// month of jobs doesn't fan out into a query per job. Returns Map<leadId, rows[]>.
function onSiteAssignmentsForLeads(businessId, leadIds = []) {
  const ids = [...new Set(leadIds.filter((id) => id != null))];
  const map = new Map();
  if (ids.length === 0) return map;

  const rows = db.prepare(`
    ${ASSIGNMENT_SELECT}
    WHERE asg.business_id = ? AND asg.picked_up_at IS NULL
      AND asg.lead_id IN (${ids.map(() => '?').join(', ')})
    ORDER BY COALESCE(asg.dropped_at, asg.created_at) ASC, asg.id ASC
  `).all(businessId, ...ids);

  for (const r of rows) {
    if (!map.has(r.lead_id)) map.set(r.lead_id, []);
    map.get(r.lead_id).push(r);
  }
  return map;
}

// ── Task completion, DERIVED (guided drop/pickup flow) ───────────────────────
// "Is this delivery / pickup actually done?" answered from the assignments that
// already exist — no new write-path state, no new column on the lead.
//
//   dropRecorded   — at least one unit has been dropped on this job
//   pickupSettled  — assignments EXIST and every one of them has been picked up
//
// The "exist" clause is the critical guard: a legacy job (delivered before unit
// capture) and a business with no fleet registered both have ZERO assignment rows,
// and `every()` over an empty list is vacuously true — which would silently hide
// real work from today's schedule. Zero rows therefore means "nothing derived
// here", and the caller falls back to the lead's own delivery_done_at /
// pickup_done_at stamps.
//
// Read-only. This filters on NOTHING (in particular not `picked_up_at IS NULL`,
// which is what the on-site lookups above use) because a settled task is exactly
// the case where no unit is on site any more.
function assignmentTaskStateForLeads(businessId, leadIds = []) {
  const ids = [...new Set(leadIds.filter((id) => id != null))];
  const map = new Map();
  if (ids.length === 0) return map;

  const rows = db.prepare(`
    SELECT lead_id,
           COUNT(*) AS total,
           SUM(CASE WHEN dropped_at IS NOT NULL THEN 1 ELSE 0 END) AS dropped,
           SUM(CASE WHEN picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS picked_up
    FROM assignments
    WHERE business_id = ? AND lead_id IN (${ids.map(() => '?').join(', ')})
    GROUP BY lead_id
  `).all(businessId, ...ids);

  for (const r of rows) {
    map.set(r.lead_id, {
      hasAssignments: r.total > 0,
      dropRecorded: r.dropped > 0,
      pickupSettled: r.total > 0 && r.picked_up === r.total,
    });
  }
  return map;
}

// One assignment by id, with its unit's label/size. The anchor Phase 2c weight
// attribution resolves against: this row names the unit AND the job, so a ticket
// carrying an assignment id bills that job no matter which screen it was entered from.
function getAssignment(businessId, id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return db.prepare(`${ASSIGNMENT_SELECT} WHERE asg.id = ? AND asg.business_id = ?`).get(n, businessId) || null;
}

// ── The YARD QUEUE (2c) ───────────────────────────────────────────────────────
// Units that came back but whose weight hasn't been entered yet — picked up, not
// weighed. This is the weekend case: several cans collected Saturday, weighed over
// the following days, each still owing its ticket to its OWN job. Oldest pickup
// first (the one that's been sitting longest is the one to clear).
//
// A row with no job is excluded — there'd be nothing to attribute its weight to.
// Rows are joined to the lead so the queue can name the customer without a query
// per unit.
function yardUnits(businessId) {
  const rows = db.prepare(`
    SELECT asg.id AS assignment_id, asg.asset_id, asg.lead_id,
           asg.dropped_at, asg.picked_up_at,
           ast.label, ast.size,
           l.customer_first_name, l.customer_last_name, l.vertical_data,
           l.job_status, l.units_out
    FROM assignments asg
    JOIN assets ast ON ast.id = asg.asset_id
    JOIN leads l ON l.id = asg.lead_id
    WHERE asg.business_id = ?
      AND asg.picked_up_at IS NOT NULL
      AND asg.weighed_at IS NULL
      AND (l.discarded = 0 OR l.discarded IS NULL)
    ORDER BY asg.picked_up_at ASC, asg.id ASC
  `).all(businessId);

  return rows.map((r) => {
    let vd = {};
    try { vd = r.vertical_data ? JSON.parse(r.vertical_data) : {}; } catch { vd = {}; }
    const name = [r.customer_first_name, r.customer_last_name].filter(Boolean).join(' ').trim();
    return {
      assignmentId: r.assignment_id,
      assetId: r.asset_id,
      leadId: r.lead_id,
      label: r.label,
      size: r.size,
      droppedAt: r.dropped_at,
      pickedUpAt: r.picked_up_at,
      jobStatus: r.job_status,
      unitsOut: r.units_out == null ? null : r.units_out,
      jobSize: vd.dumpsterSize || null,
      customerName: vd.customerName || name || `Job #${r.lead_id}`,
      address: vd.deliveryAddress || null,
    };
  });
}

// Close the loop on a weighed unit: stamp weighed_at and put the can back in the
// available pool. Called by jobLifecycle.recordDumpTicket once the ticket is written.
//
// A weight is only ever entered for a can that's off the job, so an assignment
// weighed without a recorded pickup is stamped picked up at the same moment —
// leaving it "on site" would keep offering it in the pickup picker forever and keep
// its unit blocked from the next job.
function markWeighed(businessId, assignmentId, at = nowIso()) {
  const row = getAssignment(businessId, assignmentId);
  if (!row) return null;
  if (row.picked_up_at) {
    db.prepare('UPDATE assignments SET weighed_at = ?, updated_at = ? WHERE id = ? AND business_id = ?')
      .run(at, at, row.id, businessId);
  } else {
    db.prepare('UPDATE assignments SET picked_up_at = ?, weighed_at = ?, updated_at = ? WHERE id = ? AND business_id = ?')
      .run(at, at, at, row.id, businessId);
  }
  // Location state only — availability counts neither 'at_yard' nor 'available'
  // differently, so this is purely "the can is ready to go out again".
  updateAsset(businessId, row.asset_id, { status: 'available' });
  return getAssignment(businessId, assignmentId);
}

// The open assignment for a unit ANYWHERE in the business — the guard behind "a unit
// can only be out on one job at a time". Carries the other job's name for the error.
function openAssignmentForAsset(businessId, assetId) {
  return db.prepare(`
    SELECT asg.*, l.customer_first_name, l.customer_last_name
    FROM assignments asg
    LEFT JOIN leads l ON l.id = asg.lead_id
    WHERE asg.business_id = ? AND asg.asset_id = ? AND asg.picked_up_at IS NULL
    ORDER BY asg.id DESC
    LIMIT 1
  `).get(businessId, assetId) || null;
}

// Units that can be dropped right now: in the fleet, not down for maintenance, and
// not already out on a job. `at_yard` counts — a unit that just came back is
// physically ready to go again, and requiring the owner to re-flag it 'available'
// on the fleet page would strand it after every pickup.
function assignableAssets(businessId) {
  const rows = db.prepare(`
    SELECT ast.*
    FROM assets ast
    WHERE ast.business_id = ?
      AND ast.active = 1
      AND ast.status != 'out_of_service'
      AND NOT EXISTS (
        SELECT 1 FROM assignments asg
        WHERE asg.asset_id = ast.id AND asg.picked_up_at IS NULL
      )
  `).all(businessId);

  rows.sort((a, b) => {
    const sizeDiff = (normalizeSize(a.size) || 999) - (normalizeSize(b.size) || 999);
    if (sizeDiff !== 0) return sizeDiff;
    return String(a.label).localeCompare(String(b.label), undefined, { numeric: true });
  });
  return rows;
}

// Everything the drop/pickup card needs in one call: what's on site now, what could
// be dropped (flagged for whether it matches the job's size, so the UI can default to
// the right size and still offer a substitution), and the job's full unit history.
function unitsForLead(businessId, lead) {
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  const jobSize = vd.dumpsterSize || null;

  return {
    leadId: lead.id,
    jobSize,
    onSite: onSiteAssignments(businessId, lead.id),
    available: assignableAssets(businessId).map((a) => ({
      id: a.id,
      label: a.label,
      size: a.size,
      status: a.status,
      sizeMatches: jobSize ? sizeKeyMatches(a.size, jobSize) : false,
    })),
    history: listAssignments(businessId, lead.id),
  };
}

// ── Size write-back (2c) ──────────────────────────────────────────────────────
// The job's `vd.dumpsterSize` is what availability counts against, what the pricing
// resolver joins on and what the UI displays. When the can actually on the ground is
// a different size — a swap to a bigger unit, or a substitution at delivery — that
// field went stale and everything downstream resolved against a size that isn't
// there. Dropping a unit is the moment we learn the truth, so write it back.
//
// The originally booked size is preserved once in `dumpsterSizeOriginal` (never
// overwritten by a later swap), so the quote the customer was given is still on the
// record. Refuses to write a size that isn't size-shaped ("Unspecified", a blank
// label) — a junk asset size must never clobber a good job size.
//
// Returns true when the job was actually rewritten. Pricing already issued (the base
// rental invoice) is untouched; this only changes what LATER math resolves against.
function writeBackJobSize(businessId, lead, newSize, previousSize) {
  if (normalizeSizeKey(newSize) == null) return false;
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  if (!vd.dumpsterSizeOriginal && previousSize) vd.dumpsterSizeOriginal = previousSize;
  vd.dumpsterSize = String(newSize).trim();

  const at = nowIso();
  db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(vd), at, lead.id);
  lead.vertical_data = JSON.stringify(vd);
  lead.updated_at = at;
  try { emitToBusiness(businessId, 'lead_updated', lead); } catch { /* non-fatal */ }
  return true;
}

// Record the DROP: this unit is now on this job. Required at delivery — the driver
// picks the actual number off the can, and the same action drops a swap replacement
// (a second open assignment on the same job).
function dropUnit(businessId, lead, { assetId, notes = null } = {}) {
  const id = Number(assetId);
  if (!Number.isFinite(id)) throw fail('assetId is required');

  const asset = getAsset(businessId, id);
  if (!asset) throw fail('Unit not found', 404);
  if (!asset.active) throw fail(`Unit ${asset.label} is retired from the fleet`);
  if (asset.status === 'out_of_service') {
    throw fail(`Unit ${asset.label} is out of service — put it back in service on the Inventory page first`);
  }

  const open = openAssignmentForAsset(businessId, id);
  if (open) {
    if (open.lead_id === lead.id) throw fail(`Unit ${asset.label} is already on this job`, 409);
    throw fail(`Unit ${asset.label} is already out on ${displayName(open)} — pick it up first`, 409);
  }

  const at = nowIso();
  const info = db.prepare(`
    INSERT INTO assignments (business_id, asset_id, lead_id, dropped_at, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(businessId, id, lead.id, at, notes ? String(notes) : null, at, at);

  // Location state only — updateAsset keeps the inventory_pool mirror in step, and
  // neither 'out' nor 'at_yard' changes what availability counts.
  updateAsset(businessId, id, { status: 'out' });

  // A different size than the job records is now the job's reality — write it back
  // (see writeBackJobSize). This is the size-changing-swap bug: dropping a bigger can
  // as the replacement never updated the job, so availability counted the old size and
  // every later price resolved against it.
  let jobSize = null;
  try { jobSize = (lead.vertical_data ? JSON.parse(lead.vertical_data) : {}).dumpsterSize || null; } catch { /* ignore */ }
  const substituted = jobSize && !sizeKeyMatches(asset.size, jobSize);
  const wroteBack = substituted && writeBackJobSize(businessId, lead, asset.size, jobSize);
  logActivity(
    lead.id,
    'note_added',
    `Unit ${asset.label} dropped on site${substituted ? ` — ${asset.size} substituted for the ${jobSize} requested${wroteBack ? `; job size updated to ${asset.size}` : ''}` : ''}`
  );

  return {
    assignment: db.prepare(`${ASSIGNMENT_SELECT} WHERE asg.id = ?`).get(Number(info.lastInsertRowid)),
    asset: getAsset(businessId, id),
    onSite: onSiteAssignments(businessId, lead.id),
  };
}

// Record the PICKUP: stamp the unit's open assignment and send it back to the yard.
// Only a unit actually on site for THIS job can be picked up from it.
function pickUpUnit(businessId, lead, { assetId } = {}) {
  const id = Number(assetId);
  if (!Number.isFinite(id)) throw fail('assetId is required');

  const assignment = db.prepare(`
    SELECT * FROM assignments
    WHERE business_id = ? AND lead_id = ? AND asset_id = ? AND picked_up_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(businessId, lead.id, id);

  const asset = getAsset(businessId, id);
  if (!assignment) {
    throw fail(
      asset ? `Unit ${asset.label} isn't on this job` : 'That unit is not assigned to this job',
      400
    );
  }

  const at = nowIso();
  db.prepare('UPDATE assignments SET picked_up_at = ?, updated_at = ? WHERE id = ?')
    .run(at, at, assignment.id);
  updateAsset(businessId, id, { status: 'at_yard' });

  logActivity(lead.id, 'note_added', `Unit ${asset.label} picked up and back at the yard`);

  return {
    assignment: db.prepare(`${ASSIGNMENT_SELECT} WHERE asg.id = ?`).get(assignment.id),
    asset: getAsset(businessId, id),
    onSite: onSiteAssignments(businessId, lead.id),
  };
}

// ── Releasing a deleted job's units ───────────────────────────────────────────
// Deleting a job (hard delete) or binning a customer (30-day Trash) used to leave
// the job's OPEN assignments untouched, so the dumpster that was out on it stayed
// invisible to `assignableAssets` — the drop picker kept hiding a can that has
// nowhere to be — and the asset sat on status 'out' forever. The date-window
// availability math already ignores deleted jobs (it counts leads, not units), so
// the two surfaces disagreed until the 30-day purge cascaded the rows away.
//
// Closing the assignment here is the fleet's view of the same fact: the job is gone,
// so the can is not on it. The open row is stamped picked up and the asset returns to
// 'available' (not 'at_yard' — there is no haul to weigh, and the yard queue excludes
// binned jobs anyway). Nothing else moves: units_out, the completion gate, the swap
// markers and every ticket already written are untouched, and a weighed/picked-up
// assignment stays exactly as it is so the job's unit history survives.
//
// Returns the labels of the units released.
function releaseUnitsForLead(businessId, leadId, { log = false } = {}) {
  const open = db.prepare(`
    SELECT asg.id, asg.asset_id, ast.label
    FROM assignments asg
    JOIN assets ast ON ast.id = asg.asset_id
    WHERE asg.business_id = ? AND asg.lead_id = ? AND asg.picked_up_at IS NULL
  `).all(businessId, leadId);
  if (open.length === 0) return [];

  const at = nowIso();
  for (const row of open) {
    db.prepare('UPDATE assignments SET picked_up_at = ?, updated_at = ? WHERE id = ?')
      .run(at, at, row.id);
    updateAsset(businessId, row.asset_id, { status: 'available' });
  }

  // Only worth a timeline entry when the lead survives the release (a binned
  // customer can be restored); a hard-deleted lead takes its timeline with it.
  if (log) {
    logActivity(
      leadId,
      'note_added',
      `Job deleted — ${open.map(r => `Unit ${r.label}`).join(', ')} released back to the fleet`
    );
  }
  return open.map(r => r.label);
}

module.exports = {
  listAssignments,
  onSiteAssignments,
  onSiteAssignmentsForLeads,
  assignmentTaskStateForLeads,
  openAssignmentForAsset,
  getAssignment,
  yardUnits,
  markWeighed,
  assignableAssets,
  unitsForLead,
  dropUnit,
  pickUpUnit,
  releaseUnitsForLead,
};
