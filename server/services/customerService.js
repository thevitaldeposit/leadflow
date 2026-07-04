const db = require('../db/database');
const {
  JOB_STATUS,
  CONFIRMED_JOB_STATUS_SET,
  CLOSED_LOST_STATUSES,
  LEGACY_STATUS,
  ENGAGEMENT_STATUS,
} = require('../config/jobStatus');

// ── Customers: the person-level layer over the per-call `leads` table ──────────
// `leads` remains the per-call/per-inquiry record the Twilio pipeline inserts
// (untouched). This service groups those leads into one durable customer record
// per person per business — deduped by normalized phone — and keeps each lead
// linked via leads.customer_id WITHOUT changing any INSERT path. New
// pipeline-inserted leads are linked lazily by reconcileCustomersForBusiness(),
// which the customers routes call before every list/detail read.

// Job-status GROUP membership comes from the canonical module (server/config/jobStatus):
//   CONFIRMED_JOB_STATUS_SET = a real, committed job (deal closed/paid, in fulfillment),
//     EXCLUDING completed ('completed' is handled separately so it can drive the
//     repeat-customer ladder) and the unpaid pending_payment stage. Includes the
//     post-return billing stage awaiting_final_payment and legacy picked_up.
//   CLOSED_LOST_STATUSES  = {lost, spam} — applied below to job_status AND the legacy
//     leads.status column (both vocabularies share those two values).

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
    if (js === JOB_STATUS.COMPLETED) { completed++; continue; }
    if (CONFIRMED_JOB_STATUS_SET.has(js) || legacy === LEGACY_STATUS.BOOKED) { active++; continue; }
    if (CLOSED_LOST_STATUSES.has(js) || CLOSED_LOST_STATUSES.has(legacy)) continue;
    // pending_payment = booking initiated but unpaid (a live, hot deal, not yet a job);
    // ranks with opportunities on the customer ladder.
    if (js === JOB_STATUS.OPPORTUNITY || js === JOB_STATUS.PENDING_PAYMENT) { opp++; continue; }
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
    job_status: lead.job_status || JOB_STATUS.INQUIRY,
    status: lead.status || LEGACY_STATUS.NEW,
    call_type: lead.call_type || null,
    vertical: lead.vertical || null,
    sub_vertical: lead.sub_vertical || null,
    service: leadServiceSummary(lead),
    address: lead.address || vd.deliveryAddress || vd.propertyAddress || null,
    delivery_date: lead.delivery_date || null,
    pickup_date: lead.pickup_date || null,
    estimated_revenue: leadRevenue(lead),
    paid_at: lead.paid_at || null,
    // PAYMENT axis (independent of job_status): 'unpaid' | 'partial' | 'paid'.
    payment_status: lead.payment_status || 'unpaid',
    // Dumpsters currently out for the job (swap-safe lifecycle); null until active_rental.
    units_out: lead.units_out == null ? null : lead.units_out,
    // Lightweight call-intelligence so the profile can render the booking-signals
    // panel (most recent call) and per-row hints without a second round-trip. The
    // heavy bits (recording, transcript, full summary) are lazy-loaded per call
    // via GET /leads/:id. Read-only — surfacing these never re-evaluates booking.
    auto_booked: lead.auto_booked === 1,
    booking_signals: Array.isArray(vd.bookingSignalsDetected) ? vd.bookingSignalsDetected : [],
    booking_confidence: vd.bookingConfidence || null,
    intent_level: vd.intentLevel || null,
    urgency: vd.urgency || null,
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
    if (js === JOB_STATUS.COMPLETED) completed++;
    else if (!CLOSED_LOST_STATUSES.has(js) && !CLOSED_LOST_STATUSES.has(l.status)) open++;
    revenue += leadRevenue(l);
    const ts = l.updated_at || l.created_at;
    if (ts && (!lastActivityAt || ts > lastActivityAt)) lastActivityAt = ts;
    const job = toJob(l);
    if (job.address) addresses.add(job.address.trim());
  }
  return { jobs, completed, open, revenue, lastActivityAt, addresses: [...addresses] };
}

// ── Engagements: the inquiry → job → completed lifecycle over a customer's calls ─
// A customer's calls (leads) are grouped into ENGAGEMENTS — one ongoing piece of
// business. This is a READ-TIME derivation (same philosophy as reconcile): it
// never touches the call/transcription/extraction pipeline, the booking-signal
// computation, or auto-book. The codified rule:
//   • A new call attaches to the customer's currently-OPEN engagement (an Active
//     Inquiry, or a booked-but-not-completed Job) and refreshes its details
//     (latest call wins). If every prior engagement is closed/completed, the call
//     opens a NEW Active Inquiry. By construction there is at most one open
//     engagement per customer at a time.
//   • An engagement is a Job once any of its calls is booked, and Completed once a
//     call is paid AND its pickup date has passed. Inquiries close only manually
//     (Close / Mark Lost); nothing auto-closes an Active Inquiry.
const STALE_INQUIRY_DAYS = 14;
const STALE_INQUIRY_MS = STALE_INQUIRY_DAYS * 24 * 60 * 60 * 1000;

// Status badge labels (used on Jobs-tab rows and the Past-inquiries list). The
// active engagement's section HEADER is computed client-side ("Open Job" for a
// booked engagement, "Active Inquiry" for an open inquiry) — these labels drive
// badges only, so a booked job's badge reads "Booked".
const ENGAGEMENT_LABELS = {
  [ENGAGEMENT_STATUS.INQUIRY]: 'Active Inquiry',
  [ENGAGEMENT_STATUS.BOOKED]: 'Booked',
  [ENGAGEMENT_STATUS.COMPLETED]: 'Completed',
  [ENGAGEMENT_STATUS.LOST]: 'Closed',
};

function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "The pickup date has passed" — strictly before today (local). pickup_date is a
// plain YYYY-MM-DD, so a lexical compare is timezone-safe.
function pickupHasPassed(pickupDate) {
  if (!pickupDate) return false;
  const s = String(pickupDate).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s < localTodayStr();
}

// Parse a SQLite timestamp (naive "YYYY-MM-DD HH:MM:SS" is UTC) to ms.
function tsToMs(ts) {
  if (!ts) return null;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  const ms = new Date(s).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Paid invoices count toward completion even though the payment is recorded on the
// invoice (invoices.paid_at), not the lead (leads.paid_at). Build a per-customer
// "paid context" once: the set of lead ids a paid invoice is attached to, plus a
// flag for any paid invoice with no specific lead (a customer-level payment that
// applies to the customer's job). "Paid" = invoice marked paid (status 'paid' OR
// paid_at set). Invoices created from the profile carry only customer_id (lead_id
// null), so the customer-level flag is the common path; an explicit lead_id stays
// precise to that call's engagement. Read-only — this never writes a lead, changes
// booking signals, or books anything; it only feeds the completion check below.
function paidInvoiceContextForCustomer(businessId, customerId) {
  const ctx = { leadIds: new Set(), hasUnlinked: false };
  if (!businessId || !customerId) return ctx;
  try {
    const rows = db.prepare(`
      SELECT lead_id FROM invoices
      WHERE business_id = ? AND customer_id = ?
        AND (status = 'paid' OR paid_at IS NOT NULL)
    `).all(businessId, customerId);
    for (const r of rows) {
      if (r.lead_id) ctx.leadIds.add(r.lead_id);
      else ctx.hasUnlinked = true;
    }
  } catch { /* invoices table absent / not migrated — treat as no payments */ }
  return ctx;
}

// Per-call lifecycle predicates used to derive an engagement's status. These read
// stored fields only — they never re-evaluate booking signals or auto-book.
// Completion is trusted from the (payment-gated) job_status column ALONE. A job reaches
// 'completed' only through the lifecycle engine — the last unit's dump ticket returns it
// (fully paid → completed, else awaiting_final_payment). A passed pickup date NEVER
// auto-completes on read: a paid job past its pickup date stays an Open Job
// (active_rental) until its weight is recorded, and the dump ticket — not the date —
// drives progression (see jobLifecycle.recordDumpTicket). `paidCtx` is still passed by
// callers but no longer consulted here (completion no longer depends on payment/date).
function leadIsCompleted(lead) {
  return (lead.job_status || '') === JOB_STATUS.COMPLETED;
}
function leadIsBooked(lead) {
  return CONFIRMED_JOB_STATUS_SET.has(lead.job_status) || lead.status === LEGACY_STATUS.BOOKED;
}
function leadIsClosedLost(lead) {
  return CLOSED_LOST_STATUSES.has(lead.job_status);
}

// Engagement status from its calls (chronological asc; the last is newest = the
// representative whose details the engagement shows). Most-advanced state wins for
// completed/booked; a manually-closed (lost) newest call closes an Active Inquiry.
function engagementStatusOf(leadsAsc, paidCtx) {
  if (leadsAsc.some((l) => leadIsCompleted(l, paidCtx))) return ENGAGEMENT_STATUS.COMPLETED;
  if (leadsAsc.some(leadIsBooked)) return ENGAGEMENT_STATUS.BOOKED;
  if (leadIsClosedLost(leadsAsc[leadsAsc.length - 1])) return ENGAGEMENT_STATUS.LOST;
  return ENGAGEMENT_STATUS.INQUIRY;
}
function engagementIsOpen(status) {
  return status === ENGAGEMENT_STATUS.INQUIRY || status === ENGAGEMENT_STATUS.BOOKED;
}

// "Has booking signals" = the booking-signal detector already recorded at least one
// signal on this call. We CONSUME its stored output (vertical_data.bookingSignalsDetected
// — keys like "price_agreed"/"size_confirmed", set to [] for voicemails/non-booking
// calls) and never recompute it. An actually booked/auto-booked lead also counts: it
// is itself a new job and must never be absorbed into a prior one. A call with no
// signals is a follow-up (swap-out, billing, status check) that belongs to the job it
// follows — not a new inquiry.
function leadHasBookingSignals(lead) {
  if (leadIsBooked(lead)) return true;
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  return Array.isArray(vd.bookingSignalsDetected) && vd.bookingSignalsDetected.length > 0;
}

// A manually-created entry (owner walk-in / text / email, or the profile "Create Job")
// is a deliberate NEW inquiry/job — never a follow-up call — so it always starts its
// own engagement and is never absorbed into a prior booked/completed job as call
// history. Twilio-captured follow-up calls (a non-'manual' source) keep the
// attach-on-read behavior in buildEngagements.
function isManualLead(lead) {
  return (lead.source || '') === 'manual';
}

// The most-recent real JOB (a booked or completed engagement) in the walk so far —
// the job a no-booking-signal follow-up call logically belongs to. Closed inquiries
// (lost) are skipped: a follow-up revives a real job, never a lost inquiry.
function mostRecentJobEngagement(engagements) {
  for (let i = engagements.length - 1; i >= 0; i--) {
    if (engagements[i].status === ENGAGEMENT_STATUS.BOOKED || engagements[i].status === ENGAGEMENT_STATUS.COMPLETED) {
      return engagements[i];
    }
  }
  return null;
}

// Fold a customer's (non-discarded) calls into engagements. Walking oldest → newest,
// each call joins the open engagement if one exists, else starts a new one; an
// engagement stops absorbing calls the instant it becomes closed (completed/lost).
//
// EXCEPTION — attach-on-read: once the open job has closed, a follow-up call that
// carries NO booking signals attaches to that most-recent booked/completed job as
// call history instead of spawning a phantom Active Inquiry. So a post-booking
// swap-out, or a post-pickup billing/status call, stays part of the job it belongs
// to even after the job completed and ejected it from the open slot. The job's
// status/schedule/completion/totals are untouched — its schedule is sourced from the
// booked lead in shapeEngagement, never from the absorbed follow-up. A call WITH
// booking signals (or an actually-booked lead) still starts a NEW engagement, so a
// genuinely new inquiry/job is never swallowed or merged into an old one. Purely
// read-time, like the rest of this module; nothing is written.
function buildEngagements(activeLeads, paidCtx) {
  const asc = [...activeLeads].sort(
    (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || (a.id - b.id)
  );
  const engagements = [];
  let open = null;
  for (const lead of asc) {
    if (!open) {
      // No open engagement. A follow-up CALL with no booking signals rejoins the
      // most-recent job (if any) rather than opening a new Active Inquiry. The job
      // stays closed (we never set `open`); the call is recorded as history only.
      // A manual entry is exempt — it's an explicit new inquiry/job, so it always
      // opens its own engagement (e.g. profile "Create Job" for a repeat customer
      // whose only prior engagement is a completed job).
      if (!leadHasBookingSignals(lead) && !isManualLead(lead)) {
        const job = mostRecentJobEngagement(engagements);
        if (job) { job.leads.push(lead); continue; }
      }
      open = { leads: [] };
      engagements.push(open);
    }
    open.leads.push(lead);
    open.status = engagementStatusOf(open.leads, paidCtx);
    if (!engagementIsOpen(open.status)) open = null;
  }
  return engagements;
}

// Shape one engagement for the customer profile. An inquiry's display details come
// from the newest call (latest call wins); a booked/completed JOB instead sources its
// schedule, size, price and payment fields from the booked lead — never recomputed,
// and never from a later follow-up call absorbed into the job (a swap-out / billing
// call must not blank or alter the job's details). Industry fields are read straight
// from stored vertical_data.
function shapeEngagement(eng) {
  const leadsAsc = eng.leads;
  const rep = leadsAsc[leadsAsc.length - 1];
  const status = eng.status;
  let vd = {};
  try { vd = rep.vertical_data ? JSON.parse(rep.vertical_data) : {}; } catch { vd = {}; }

  // The job's defining call: the booked lead (carries the live delivery/pickup/time/
  // size/duration, the quoted price, paid_at and payment-SMS state). Resolved for a
  // booked OR completed engagement — for completed too, because no-booking-signal
  // follow-up calls are now absorbed into the job's call history and would otherwise
  // become the newest call (rep) and blank the job's schedule/price. Null for an
  // inquiry, which keeps reflecting the latest call. Read-only — never writes.
  let jobLead = null;
  if (status === ENGAGEMENT_STATUS.BOOKED || status === ENGAGEMENT_STATUS.COMPLETED) {
    const rev = [...leadsAsc].reverse();
    jobLead = rev.find(leadIsBooked)
      || rev.find((l) => (l.job_status || '') === JOB_STATUS.COMPLETED)
      || rev.find((l) => !!l.paid_at)
      || rep;
  }
  let jobVd = vd;
  if (jobLead && jobLead !== rep) {
    try { jobVd = jobLead.vertical_data ? JSON.parse(jobLead.vertical_data) : {}; } catch { jobVd = {}; }
  }
  const isEmpty = (v) => v == null || v === '';
  // Prefer the job lead's non-empty value for a flat column / a vertical_data field
  // (delivery/pickup/time, dumpsterSize/debrisType/rentalDuration); fall back to the
  // representative. A no-op for inquiries (jobLead null) and for a single-call job
  // (jobLead === rep), so existing inquiries and jobs are unchanged.
  const jobCol = (col) => (jobLead && !isEmpty(jobLead[col])) ? jobLead[col] : rep[col];
  const jobVdField = (key) => (jobLead && !isEmpty(jobVd[key])) ? jobVd[key] : vd[key];
  // The lead representing the job for non-schedule display too (service summary,
  // address, revenue, paid_at, auto_booked) so an absorbed follow-up never blanks
  // them or drops the job's revenue from totals. rep for an inquiry.
  const detailLead = jobLead || rep;
  const detailVd = (jobLead && jobLead !== rep) ? jobVd : vd;

  let lastActivityAt = null;
  for (const l of leadsAsc) {
    const ts = l.updated_at || l.created_at;
    if (ts && (!lastActivityAt || ts > lastActivityAt)) lastActivityAt = ts;
  }
  // Stale is a display-only flag: an Active Inquiry with no new call/update for
  // two weeks. It never closes, books, or otherwise changes the engagement.
  const lastMs = tsToMs(lastActivityAt);
  const stale = status === ENGAGEMENT_STATUS.INQUIRY && lastMs != null
    ? (Date.now() - lastMs) >= STALE_INQUIRY_MS
    : false;

  return {
    id: leadsAsc[0].id,                       // engagement anchored to its first call
    representative_lead_id: rep.id,           // newest call → drives the details
    lead_ids: leadsAsc.map((l) => l.id),
    status,
    label: ENGAGEMENT_LABELS[status] || 'Active Inquiry',
    is_open: engagementIsOpen(status),
    stale,
    // For a manually-closed inquiry, which action closed it ('lost' | 'closed') —
    // persisted on the call's vertical_data by the close route. Drives the
    // Past-inquiries label; null for open/booked/completed. Defaults to 'lost'
    // (the generic terminal state) for older closes that predate this field.
    close_reason: status === ENGAGEMENT_STATUS.LOST ? (vd.closeReason || 'lost') : null,
    service: leadServiceSummary(detailLead),
    address: detailLead.address || detailVd.deliveryAddress || detailVd.propertyAddress || null,
    delivery_date: jobCol('delivery_date') || null,
    pickup_date: jobCol('pickup_date') || null,
    scheduled_time: jobCol('scheduled_time') || null,
    estimated_revenue: leadRevenue(detailLead),
    paid_at: detailLead.paid_at || null,
    auto_booked: detailLead.auto_booked === 1,
    // Payable call for the Open Job card's Mark Paid / payment-link actions — the
    // booked lead (not the newest call). paid_at / payment_sms_sent_at come from it.
    booked_lead_id: jobLead ? jobLead.id : null,
    booked_paid_at: jobLead ? (jobLead.paid_at || null) : null,
    booked_payment_sms_sent_at: jobLead ? (jobLead.payment_sms_sent_at || null) : null,
    booked_payment_link_emailed_at: jobLead ? (jobLead.payment_link_emailed_at || null) : null,
    // The fine job_status STAGE — the operational axis shown alongside the payment
    // axis. From the booked lead for a job, else the representative call (so a
    // pending_payment inquiry surfaces its stage + payment controls before it books).
    job_stage: (jobLead ? jobLead.job_status : rep.job_status) || null,
    booking_signals: Array.isArray(vd.bookingSignalsDetected) ? vd.bookingSignalsDetected : [],
    booking_confidence: vd.bookingConfidence || null,
    intent_level: vd.intentLevel || null,
    urgency: vd.urgency || null,
    follow_up_date: vd.followUpDate || rep.follow_up_date || null,
    // Industry-relevant fields (display stored values; not recomputed). Size /
    // debris / duration are job-sourced (jobVdField) so a booked or completed job
    // shows the booked lead's values, not a later empty follow-up call's.
    dumpster_size: jobVdField('dumpsterSize') || null,
    debris_type: jobVdField('debrisType') || null,
    rental_duration: jobVdField('rentalDuration') || null,
    vertical: rep.vertical || null,
    sub_vertical: rep.sub_vertical || null,
    calls: leadsAsc.slice().reverse().map(toJob),   // newest-first call list
    created_at: leadsAsc[0].created_at,
    updated_at: rep.updated_at || rep.created_at,
    last_activity_at: lastActivityAt,
  };
}

// Engagements for a customer's active leads, newest engagement first, with the
// single open engagement (if any) flagged is_active so the UI expands it.
function engagementsForLeads(activeLeads, paidCtx) {
  const shaped = buildEngagements(activeLeads, paidCtx).map(shapeEngagement);
  shaped.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || (b.id - a.id));
  let activeMarked = false;
  for (const e of shaped) {
    e.is_active = !activeMarked && e.is_open;
    if (e.is_active) activeMarked = true;
  }
  return shaped;
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

  // Refresh the PAYMENT axis for this customer's confirmed/pending job leads at read
  // time (reconcile-on-read) so completion-gating + the two-axis display reflect the
  // latest invoice state. jobLifecycle is required lazily to avoid a load-time cycle
  // (it depends on this module); it mutates each lead row (payment_status / paid_at)
  // in place, so the fresh values feed aggregate/jobs/engagements below.
  try {
    const { recomputeLeadPaymentStatus } = require('./jobLifecycle');
    for (const l of activeLeads) {
      if (CONFIRMED_JOB_STATUS_SET.has(l.job_status) || l.job_status === JOB_STATUS.PENDING_PAYMENT || l.paid_at) {
        recomputeLeadPaymentStatus(businessId, l);
      }
    }
  } catch { /* jobLifecycle unavailable — fall back to stored columns */ }

  const agg = aggregateLeads(activeLeads);
  const jobs = activeLeads.map(toJob);
  // Engagements: the customer's calls grouped into inquiry→job→completed records.
  // A job completes on full payment + pickup-passed; payment may live on the lead
  // (leads.paid_at / payment_status) or on a paid invoice for this customer (paidCtx).
  const paidCtx = paidInvoiceContextForCustomer(businessId, customer.id);
  const engagements = engagementsForLeads(activeLeads, paidCtx);

  // Attach the derived PAYMENT axis + swap-safe unit count to each engagement (the
  // job's "all invoices settled" rollup — leads.paid_at may live on the booked lead).
  try {
    const { paymentStatusFromInvoices } = require('./jobLifecycle');
    for (const e of engagements) {
      const bookedLead = e.booked_lead_id ? activeLeads.find((l) => l.id === e.booked_lead_id) : null;
      e.payment_status = paymentStatusFromInvoices(businessId, {
        leadIds: e.lead_ids,
        customerId: customer.id,
        leadPaidAt: (bookedLead && bookedLead.paid_at) || e.paid_at || null,
      });
      e.units_out = bookedLead && bookedLead.units_out != null ? bookedLead.units_out : null;
      let bvd = {};
      try { bvd = bookedLead && bookedLead.vertical_data ? JSON.parse(bookedLead.vertical_data) : {}; } catch { bvd = {}; }
      e.dump_tickets = Array.isArray(bvd.dumpTickets) ? bvd.dumpTickets : [];
      e.overage_needs_rate = !!bvd.overageNeedsRate;
    }
  } catch { /* jobLifecycle unavailable — engagements omit the payment axis */ }

  // Addresses: the customer's primary plus every distinct job address.
  const addrSet = new Set();
  if (customer.address) addrSet.add(customer.address.trim());
  for (const a of agg.addresses) addrSet.add(a);

  // Top-of-profile address resolution — a COMPUTED display only. Never written back
  // to customers.address (a job's address must never clobber the stored default) and
  // never persisted. Mirrors the status / status_overridden pattern:
  //   • address_overridden = 1 → owner PINNED: show the stored customers.address,
  //     which jobs never change (a stable billing/contact address for a contractor).
  //   • else → AUTO: follow the ACTIVE (open) engagement's reconciled address so the
  //     top reflects the current job + any customer delivery-address correction; then
  //     fall back to the most recent job's address; then the stored default.
  // engagements is newest-first, so .find() yields the most recent match.
  const activeEng = engagements.find((e) => e.is_active) || null;
  const recentJobEng = engagements.find(
    (e) => e.status === ENGAGEMENT_STATUS.BOOKED || e.status === ENGAGEMENT_STATUS.COMPLETED
  ) || null;
  const displayAddress = customer.address_overridden
    ? (customer.address || null)
    : ((activeEng && activeEng.address)
      || (recentJobEng && recentJobEng.address)
      || customer.address
      || null);

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

  // Customer-level notes: their own list for the Notes section, and merged into
  // the activity feed as note_added entries (lead_id null) so adding a note shows
  // up in the timeline. Read-only here — purely a join over an additive table.
  let notesList = [];
  try {
    notesList = db.prepare(
      'SELECT id, body, created_at FROM customer_notes WHERE customer_id = ? AND business_id = ? ORDER BY created_at DESC, id DESC'
    ).all(customer.id, businessId);
  } catch { notesList = []; /* table absent / not migrated */ }
  if (notesList.length) {
    const noteActivity = notesList.map((n) => ({
      id: `note-${n.id}`,
      lead_id: null,
      activity_type: 'note_added',
      description: n.body,
      created_at: n.created_at,
    }));
    activity = [...activity, ...noteActivity].sort(
      (a, b) => String(b.created_at).localeCompare(String(a.created_at))
    );
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
    address: customer.address,                          // stored default / pinnable value
    address_overridden: !!customer.address_overridden,  // true → owner pinned (jobs never change it)
    display_address: displayAddress,                    // resolved top address (Auto follows the active job)
    status: customer.status || 'lead',
    status_overridden: !!customer.status_overridden,
    discount_group_id: customer.discount_group_id || null,
    discount_group: group || null,
    contract_terms: customer.contract_terms || null,
    notes: customer.notes || null,
    created_at: customer.created_at,
    updated_at: customer.updated_at,
    addresses: [...addrSet],
    jobs,            // legacy per-call list (kept for back-compat)
    engagements,     // grouped inquiry→job→completed lifecycle records
    activity,
    notes_list: notesList,   // discrete customer notes (newest first)
    // Totals reflect engagements (one ongoing piece of business), so repeat calls
    // about the same inquiry count once and revenue isn't double-counted.
    totals: {
      // "Total Jobs" = engagements that became real jobs (booked or completed).
      // An open, never-booked Active Inquiry is NOT a job, so it doesn't count.
      jobs: engagements.filter((e) => e.status === ENGAGEMENT_STATUS.BOOKED || e.status === ENGAGEMENT_STATUS.COMPLETED).length,
      open_jobs: engagements.filter((e) => e.is_open).length,
      completed_jobs: engagements.filter((e) => e.status === ENGAGEMENT_STATUS.COMPLETED).length,
      total_revenue: Math.round(engagements.reduce((s, e) => s + (e.estimated_revenue || 0), 0)),
    },
  };
}

module.exports = {
  CUSTOMER_STATUSES,
  normalizePhone,
  deriveStatus,
  displayNameOf,
  findOrCreateCustomerForLead,
  reconcileCustomersForBusiness,
  backfillAllCustomers,
  recomputeCustomerStatus,
  listCustomers,
  getCustomerDetail,
  engagementsForLeads,
  paidInvoiceContextForCustomer,
  leadIsCompleted,
  leadIsBooked,
  leadIsClosedLost,
};
