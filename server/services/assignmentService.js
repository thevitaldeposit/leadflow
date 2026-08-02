const db = require('../db/database');
const { getAsset, updateAsset } = require('./assetService');
const { normalizeSize } = require('./inventoryService');
const { sizeKeyMatches } = require('./sizeKey');
const { logActivity } = require('./activityLog');

// ── Unit ↔ job assignments (pickup rework, Phase 2b) ─────────────────────────
//
// Which physical dumpster sat on which job. The `assignments` table was created
// empty in 2a; this is the layer that fills it:
//   drop    → new row (dropped_at = now), asset status 'out'
//   pickup  → stamp picked_up_at on that row, asset status 'at_yard'
//
// A job can hold several assignments over its life (a swap = the replacement is a
// second row), which is why this is a link table and not a column on the lead.
//
// CAPTURE ONLY. This module deliberately does not touch overage, dump tickets,
// units_out, the swap markers (pendingSwapOuts / swapOutsApplied), or the
// completion gate — per-unit attribution is Phase 2c. It also doesn't feed
// availability: 2a's math is a pure per-size count and must never require a unit
// to be assigned, so `out` / `at_yard` stay location state only.

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

  // Note the size only when the driver substituted a different one than the job asked
  // for — that's the detail worth reading back on the timeline.
  let jobSize = null;
  try { jobSize = (lead.vertical_data ? JSON.parse(lead.vertical_data) : {}).dumpsterSize || null; } catch { /* ignore */ }
  const substituted = jobSize && !sizeKeyMatches(asset.size, jobSize);
  logActivity(
    lead.id,
    'note_added',
    `Unit ${asset.label} dropped on site${substituted ? ` — ${asset.size} substituted for the ${jobSize} requested` : ''}`
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

module.exports = {
  listAssignments,
  onSiteAssignments,
  onSiteAssignmentsForLeads,
  openAssignmentForAsset,
  assignableAssets,
  unitsForLead,
  dropUnit,
  pickUpUnit,
};
