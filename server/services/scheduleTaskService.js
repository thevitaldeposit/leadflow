const db = require('../db/database');
const { onSiteAssignmentsForLeads, assignmentTaskStateForLeads } = require('./assignmentService');

// ── The job TASK summary ──────────────────────────────────────────────────────
//
// One job, shaped for the thing a driver actually does with it: who/where, which
// physical unit is on the ground, and whether the day's drop or pickup is already
// handled. This used to be built inline inside the calendar route, which is why the
// dashboard's Today's Schedule — reading raw leads — could never render any of it.
//
// It is a pure READ. Nothing here writes, and it deliberately owns no logic: the
// on-site units and the done-ness both come from the existing assignment lookups
// (`onSiteAssignmentsForLeads`, `assignmentTaskStateForLeads`), and units_out /
// the swap markers / the completion gate are only passed through, never decided.

// The columns every task summary is built from. Shared so the calendar's month
// query and the single-job lookup can never drift apart.
const TASK_LEAD_COLUMNS = `
  id, customer_first_name, customer_last_name, vertical_data, sub_vertical,
  job_status, delivery_date, scheduled_time, pickup_date, estimated_revenue,
  phone, caller_number, caller_phone_raw, units_out,
  delivery_done_at, pickup_done_at
`;

// Build one summary from a lead row plus its already-fetched assignment state.
// `onSite` = that job's open assignments; `task` = its derived done-ness (or null
// for a job with no assignment rows at all).
function buildJobTaskSummary(lead, { onSite = [], task = null } = {}) {
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { /* malformed vertical_data */ }
  const state = task || { hasAssignments: false, dropRecorded: false, pickupSettled: false };

  return {
    id: lead.id,
    customerName: vd.customerName || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown',
    dumpsterSize: vd.dumpsterSize || null,
    address: vd.deliveryAddress || null,
    jobStatus: lead.job_status,
    deliveryDate: lead.delivery_date,
    scheduledTime: lead.scheduled_time || null,
    pickupDate: lead.pickup_date,
    // Everything the task screen needs, so recording a drop or a pickup never means
    // hunting through the customer profile. Same phone resolution order the customer
    // identity layer uses.
    phone: lead.phone || lead.caller_number || lead.caller_phone_raw || null,
    unitsOut: lead.units_out == null ? null : lead.units_out,
    dumpTickets: Array.isArray(vd.dumpTickets) ? vd.dumpTickets : [],
    overageNeedsRate: !!vd.overageNeedsRate,
    // A PAID swap still owed its swap-out haul. The weight form uses it to hide the
    // manual swap checkbox — the server already knows a replacement is coming, so
    // ticking it would be redundant.
    pendingSwapOuts: Math.max(0, Math.round(Number(vd.pendingSwapOuts) || 0)),
    // Physical unit(s) currently on this job — drives the "Unit 12" line on the
    // card and tells the drop/pickup steps what they're starting from.
    assignedUnits: onSite.map(a => ({
      assignmentId: a.id,
      assetId: a.asset_id,
      label: a.label,
      size: a.size,
      droppedAt: a.dropped_at,
    })),
    // ── Is this day's task done? (read-time only) ──────────────────────────────
    // dropRecorded  — a unit has been put on the ground for this job
    // pickupSettled — assignments EXIST and every one has been picked up
    // The "exist" clause is what keeps a legacy / no-assignment job VISIBLE: zero
    // rows derives nothing (an empty `every()` would be vacuously true and silently
    // hide real work), so those jobs fall back to the owner's explicit
    // delivery_done_at / pickup_done_at stamp instead.
    dropRecorded: state.hasAssignments ? state.dropRecorded : !!lead.delivery_done_at,
    pickupSettled: state.hasAssignments ? state.pickupSettled : !!lead.pickup_done_at,
    // Which basis the two booleans above came from, so the client can offer the
    // explicit "mark done" fallback only where there's nothing to derive from.
    hasAssignments: state.hasAssignments,
  };
}

// Summaries for a set of already-fetched lead rows, with the assignment lookups
// batched into one query each (the calendar renders a whole month this way).
function summariesForLeadRows(businessId, leads) {
  const ids = leads.map(l => l.id);
  const onSiteByLead = onSiteAssignmentsForLeads(businessId, ids);
  const taskStateByLead = assignmentTaskStateForLeads(businessId, ids);
  return leads.map(lead => buildJobTaskSummary(lead, {
    onSite: onSiteByLead.get(lead.id) || [],
    task: taskStateByLead.get(lead.id) || null,
  }));
}

// Fetch + summarize by id. Scoped to the business and to home services, and binned
// (discarded) jobs are excluded — the task screen must not open one. Unlike the
// calendar this does NOT filter on job_status: a task screen opened from a link
// should render whatever state the job is actually in.
function jobTaskSummariesByIds(businessId, leadIds = []) {
  const ids = [...new Set(leadIds.map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return [];
  const leads = db.prepare(`
    SELECT ${TASK_LEAD_COLUMNS}
    FROM leads
    WHERE business_id = ?
      AND vertical = 'home_services'
      AND (discarded = 0 OR discarded IS NULL)
      AND id IN (${ids.map(() => '?').join(', ')})
  `).all(businessId, ...ids);
  return summariesForLeadRows(businessId, leads);
}

function jobTaskSummary(businessId, leadId) {
  return jobTaskSummariesByIds(businessId, [leadId])[0] || null;
}

module.exports = {
  TASK_LEAD_COLUMNS,
  buildJobTaskSummary,
  summariesForLeadRows,
  jobTaskSummariesByIds,
  jobTaskSummary,
};
