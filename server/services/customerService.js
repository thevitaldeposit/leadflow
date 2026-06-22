const db = require('../db/database');

// ── Customers: the person-level layer over the per-call `leads` table ──────────
// `leads` remains the per-call/per-inquiry record the Twilio pipeline inserts
// (untouched). This service groups those leads into one durable customer record
// per person per business — deduped by normalized phone — and keeps each lead
// linked via leads.customer_id WITHOUT changing any INSERT path. New
// pipeline-inserted leads are linked lazily by reconcileCustomersForBusiness(),
// which the customers routes call before every list/detail read.

// Operational job statuses = a confirmed job occupying the calendar/inventory.
// Mirrors verticalConfig/inventoryService; 'completed' is handled separately so
// it can drive the repeat-customer ladder.
const OPERATIONAL_STATUSES = new Set(['booked', 'scheduled', 'delivered', 'active_rental', 'picked_up']);
const TERMINAL_STATUSES = new Set(['lost', 'spam']);

// Lifecycle stages a customer can be in, derived from the set of their jobs (or
// set manually by the owner). Ordered from coldest to most valuable.
const CUSTOMER_STATUSES = ['lead', 'opportunity', 'booked', 'customer', 'repeat', 'inactive'];

// Reduce any phone string to a comparable digit key. Strips formatting, drops a
// leading US country code, and treats anything shorter than 7 digits as
// unusable (returns null) so junk/partial numbers don't collapse distinct
// anonymous callers into one customer.
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length < 7) return null;
  return digits;
}

// Pull a customer's identity fields out of a lead, preferring the same sources
// the rest of the app uses (vertical_data.customerName for the display name,
// the flat columns for the structured pieces, delivery/property address as a
// fallback address).
function leadIdentity(lead) {
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  const firstName = lead.customer_first_name || null;
  const lastName = lead.customer_last_name || null;
  const displayName = vd.customerName
    || [firstName, lastName].filter(Boolean).join(' ')
    || null;
  const phone = lead.phone || lead.caller_number || lead.caller_phone_raw || null;
  const email = lead.email || null;
  const address = lead.address || vd.deliveryAddress || vd.propertyAddress || null;
  return { firstName, lastName, displayName, phone, email, address };
}

// Derive a customer's lifecycle status from their (non-discarded) leads. A
// person is ranked by the most valuable thing they've done: two completed jobs
// → repeat; one → customer; an active job → booked; an open opportunity →
// opportunity; any live inquiry → lead; nothing live → inactive.
function deriveStatus(leadRows) {
  let completed = 0, active = 0, opp = 0, leadish = 0;
  for (const l of leadRows) {
    if (l.discarded) continue;
    const js = l.job_status || null;
    const legacy = l.status || null;
    if (js === 'completed') { completed++; continue; }
    if (OPERATIONAL_STATUSES.has(js) || legacy === 'booked') { active++; continue; }
    if (TERMINAL_STATUSES.has(js) || TERMINAL_STATUSES.has(legacy)) continue;
    if (js === 'opportunity') { opp++; continue; }
    leadish++; // inquiry / new / null — a live but un-quoted lead
  }
  if (completed >= 2) return 'repeat';
  if (completed === 1) return 'customer';
  if (active > 0) return 'booked';
  if (opp > 0) return 'opportunity';
  if (opp + leadish > 0) return 'lead';
  return 'inactive';
}

// Fill in customer fields that are still empty from a lead's identity. Never
// overwrites an existing value, so owner edits and earlier (richer) calls win.
function enrichCustomerFromLead(customer, ident) {
  const updates = {};
  if (!customer.first_name && ident.firstName) updates.first_name = ident.firstName;
  if (!customer.last_name && ident.lastName) updates.last_name = ident.lastName;
  if (!customer.display_name && ident.displayName) updates.display_name = ident.displayName;
  if (!customer.email && ident.email) updates.email = ident.email;
  if (!customer.address && ident.address) updates.address = ident.address;
  if (!customer.phone && ident.phone) updates.phone = ident.phone;
  if (Object.keys(updates).length === 0) return;
  const set = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE customers SET ${set} WHERE id = ?`).run(...Object.values(updates), customer.id);
}

// Find the customer a lead belongs to (by normalized phone), creating one if
// none exists. Leads with no usable phone always get their own record — distinct
// anonymous callers must never merge. Returns the customer id.
function findOrCreateCustomerForLead(businessId, lead) {
  const ident = leadIdentity(lead);
  const np = normalizePhone(ident.phone);

  if (np) {
    const existing = db.prepare(
      'SELECT * FROM customers WHERE business_id = ? AND normalized_phone = ?'
    ).get(businessId, np);
    if (existing) {
      enrichCustomerFromLead(existing, ident);
      return existing.id;
    }
  }

  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO customers
      (business_id, first_name, last_name, display_name, phone, normalized_phone, email, address, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lead', ?, ?)
  `).run(
    businessId,
    ident.firstName, ident.lastName, ident.displayName,
    ident.phone, np, ident.email, ident.address,
    now, now
  );
  return Number(info.lastInsertRowid);
}

// Recompute a customer's derived status (and bump updated_at). A customer whose
// status was set by hand (status_overridden) keeps it.
function recomputeCustomerStatus(customerId) {
  if (!customerId) return;
  const cust = db.prepare('SELECT id, status_overridden FROM customers WHERE id = ?').get(customerId);
  if (!cust) return;
  const now = new Date().toISOString();
  if (cust.status_overridden) {
    db.prepare('UPDATE customers SET updated_at = ? WHERE id = ?').run(now, customerId);
    return;
  }
  const leads = db.prepare('SELECT job_status, status, discarded FROM leads WHERE customer_id = ?').all(customerId);
  const status = deriveStatus(leads);
  db.prepare('UPDATE customers SET status = ?, updated_at = ? WHERE id = ?').run(status, now, customerId);
}

// Link every not-yet-linked, non-discarded lead for a business to a customer
// (creating customers as needed), then refresh the affected customers' status.
// Idempotent and cheap: only scans leads with customer_id IS NULL, so once a
// lead is linked it's skipped on subsequent passes. This is what keeps
// webhook-inserted leads attached to customers without touching the pipeline.
function reconcileCustomersForBusiness(businessId) {
  const leads = db.prepare(`
    SELECT * FROM leads
    WHERE business_id = ?
      AND customer_id IS NULL
      AND (discarded = 0 OR discarded IS NULL)
    ORDER BY created_at ASC, id ASC
  `).all(businessId);
  if (!leads.length) return 0;

  const touched = new Set();
  let linked = 0;
  for (const lead of leads) {
    const customerId = findOrCreateCustomerForLead(businessId, lead);
    if (!customerId) continue;
    db.prepare('UPDATE leads SET customer_id = ? WHERE id = ?').run(customerId, lead.id);
    touched.add(customerId);
    linked++;
  }
  for (const cid of touched) recomputeCustomerStatus(cid);
  return linked;
}

// Backfill across every business — used once by the migration.
function backfillAllCustomers() {
  let total = 0;
  const businesses = db.prepare('SELECT id FROM businesses').all();
  for (const b of businesses) total += reconcileCustomersForBusiness(b.id);
  return total;
}

// Parse a quoted price / estimated revenue off a lead into a number, mirroring
// verticalConfig.getLeadActionState so list totals match the dashboard.
function leadRevenue(lead) {
  if (typeof lead.estimated_revenue === 'number' && !Number.isNaN(lead.estimated_revenue)) {
    return lead.estimated_revenue;
  }
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  if (typeof vd.estimatedRevenue === 'number' && !Number.isNaN(vd.estimatedRevenue)) return vd.estimatedRevenue;
  if (vd.quotedPrice) {
    const nums = String(vd.quotedPrice).match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length === 1) return Number(nums[0]);
    if (nums && nums.length >= 2) return (Number(nums[0]) + Number(nums[1])) / 2;
  }
  return 0;
}

// A short service-summary string for a lead (used in the job-history list).
function leadServiceSummary(lead) {
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  if (lead.sub_vertical === 'dumpster_rental' || lead.vertical === 'home_services') {
    return [vd.dumpsterSize, vd.debrisType].filter(Boolean).join(' · ')
      || vd.serviceType || vd.equipmentType || 'Home Services';
  }
  if (lead.vertical === 'auto_dealer') {
    return [lead.voi_year, lead.voi_make, lead.voi_model].filter(Boolean).join(' ') || 'Auto Dealer';
  }
  return vd.serviceType || 'Lead';
}

// Shape a lead into a compact "job" row for the customer profile.
function toJob(lead) {
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  return {
    id: lead.id,
    job_status: lead.job_status || 'inquiry',
    status: lead.status || 'new',
    call_type: lead.call_type || null,
    vertical: lead.vertical || null,
    sub_vertical: lead.sub_vertical || null,
    service: leadServiceSummary(lead),
    address: lead.address || vd.deliveryAddress || vd.propertyAddress || null,
    delivery_date: lead.delivery_date || null,
    pickup_date: lead.pickup_date || null,
    estimated_revenue: leadRevenue(lead),
    paid_at: lead.paid_at || null,
    created_at: lead.created_at,
    updated_at: lead.updated_at,
  };
}

// Aggregate a customer's leads into the numbers the list/detail show.
function aggregateLeads(leadRows) {
  let jobs = 0, completed = 0, open = 0, revenue = 0;
  let lastActivityAt = null;
  const addresses = new Set();
  for (const l of leadRows) {
    if (l.discarded) continue;
    jobs++;
    const js = l.job_status || null;
    if (js === 'completed') completed++;
    else if (!TERMINAL_STATUSES.has(js) && !TERMINAL_STATUSES.has(l.status)) open++;
    revenue += leadRevenue(l);
    const ts = l.updated_at || l.created_at;
    if (ts && (!lastActivityAt || ts > lastActivityAt)) lastActivityAt = ts;
    const job = toJob(l);
    if (job.address) addresses.add(job.address.trim());
  }
  return { jobs, completed, open, revenue, lastActivityAt, addresses: [...addresses] };
}

// The customer's best display name, with sensible fallbacks.
function displayNameOf(customer) {
  return customer.display_name
    || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    || customer.company
    || customer.phone
    || 'Unknown';
}

// List customers for a business with rollup aggregates, optionally filtered by
// status and a free-text search over name/phone/email/company.
function listCustomers(businessId, { status, search } = {}) {
  const customers = db.prepare('SELECT * FROM customers WHERE business_id = ?').all(businessId);
  if (!customers.length) return [];

  // One query for all of the business's non-discarded leads, grouped in JS.
  const leads = db.prepare(`
    SELECT id, customer_id, job_status, status, discarded, estimated_revenue,
           vertical_data, created_at, updated_at, address, delivery_date, paid_at
    FROM leads
    WHERE business_id = ? AND customer_id IS NOT NULL AND (discarded = 0 OR discarded IS NULL)
  `).all(businessId);
  const byCustomer = new Map();
  for (const l of leads) {
    if (!byCustomer.has(l.customer_id)) byCustomer.set(l.customer_id, []);
    byCustomer.get(l.customer_id).push(l);
  }

  const term = search ? String(search).trim().toLowerCase() : null;
  const rows = customers.map((c) => {
    const agg = aggregateLeads(byCustomer.get(c.id) || []);
    return {
      id: c.id,
      display_name: displayNameOf(c),
      first_name: c.first_name,
      last_name: c.last_name,
      company: c.company,
      phone: c.phone,
      email: c.email,
      address: c.address,
      status: c.status || 'lead',
      status_overridden: !!c.status_overridden,
      discount_group_id: c.discount_group_id || null,
      created_at: c.created_at,
      jobs: agg.jobs,
      open_jobs: agg.open,
      completed_jobs: agg.completed,
      total_revenue: Math.round(agg.revenue),
      last_activity_at: agg.lastActivityAt || c.created_at,
    };
  });

  let filtered = rows;
  if (status && status !== 'all') filtered = filtered.filter((r) => r.status === status);
  if (term) {
    filtered = filtered.filter((r) =>
      (r.display_name && r.display_name.toLowerCase().includes(term)) ||
      (r.phone && r.phone.toLowerCase().includes(term)) ||
      (r.email && r.email.toLowerCase().includes(term)) ||
      (r.company && r.company.toLowerCase().includes(term))
    );
  }

  filtered.sort((a, b) => String(b.last_activity_at).localeCompare(String(a.last_activity_at)));
  return filtered;
}

// Full profile for one customer: contact, addresses, job history, the activity
// timeline aggregated across all their calls, and rollup totals. Pricing is
// composed separately (pricingService) by the route. Returns null if the
// customer doesn't exist for this business.
function getCustomerDetail(businessId, customerId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(customerId, businessId);
  if (!customer) return null;

  // All linked leads (newest first) — includes discarded so history is complete.
  const leadRows = db.prepare(
    'SELECT * FROM leads WHERE customer_id = ? AND business_id = ? ORDER BY created_at DESC, id DESC'
  ).all(customerId, businessId);

  const activeLeads = leadRows.filter((l) => !l.discarded);
  const agg = aggregateLeads(activeLeads);
  const jobs = activeLeads.map(toJob);

  // Addresses: the customer's primary plus every distinct job address.
  const addrSet = new Set();
  if (customer.address) addrSet.add(customer.address.trim());
  for (const a of agg.addresses) addrSet.add(a);

  // Activity across every linked lead (calls/SMS/notes), newest first.
  let activity = [];
  const allIds = leadRows.map((l) => l.id);
  if (allIds.length) {
    const placeholders = allIds.map(() => '?').join(', ');
    activity = db.prepare(`
      SELECT id, lead_id, activity_type, description, created_at
      FROM activity_log
      WHERE lead_id IN (${placeholders})
      ORDER BY created_at DESC, id DESC
    `).all(...allIds);
  }

  const group = customer.discount_group_id
    ? db.prepare('SELECT * FROM discount_groups WHERE id = ? AND business_id = ?').get(customer.discount_group_id, businessId)
    : null;

  return {
    id: customer.id,
    business_id: customer.business_id,
    display_name: displayNameOf(customer),
    first_name: customer.first_name,
    last_name: customer.last_name,
    company: customer.company,
    phone: customer.phone,
    email: customer.email,
    address: customer.address,
    status: customer.status || 'lead',
    status_overridden: !!customer.status_overridden,
    discount_group_id: customer.discount_group_id || null,
    discount_group: group || null,
    contract_terms: customer.contract_terms || null,
    notes: customer.notes || null,
    created_at: customer.created_at,
    updated_at: customer.updated_at,
    addresses: [...addrSet],
    jobs,
    activity,
    totals: {
      jobs: agg.jobs,
      open_jobs: agg.open,
      completed_jobs: agg.completed,
      total_revenue: Math.round(agg.revenue),
    },
  };
}

module.exports = {
  CUSTOMER_STATUSES,
  normalizePhone,
  deriveStatus,
  displayNameOf,
  reconcileCustomersForBusiness,
  backfillAllCustomers,
  recomputeCustomerStatus,
  listCustomers,
  getCustomerDetail,
};
