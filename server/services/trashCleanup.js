// Daily job that permanently PURGES soft-deleted ("binned") customers and leads
// once they've sat in the 30-day recoverable Trash. Runs at 3:00 AM server time via
// setTimeout — the SAME self-rescheduling pattern as recordingCleanup.js, offset one
// hour from the 2 AM recording job so the two never collide.
//
// The Trash lifecycle (see services/customerService.softDeleteCustomer): deleting a
// customer stamps customers.deleted_at and bins its active leads (discarded = 1 +
// leads.trashed_at). This job is the far end of that lifecycle — after 30 days the
// records are physically removed. Age is measured from the BIN timestamp
// (deleted_at / trashed_at), never created_at.
//
// Money is never touched. Invoices hang off invoices, and their FKs to customers/leads
// are ON DELETE SET NULL — so purging a customer or lead only nulls the invoice's link
// and leaves the invoice (and every Stripe/payment record) intact.

const db = require('../db/database');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function runCleanup() {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  // 1) Customers binned more than 30 days ago. Deleting the customer cascades its
  //    customer_pricing + customer_notes (FK ON DELETE CASCADE). Its leads FK is
  //    ON DELETE SET NULL, so we delete the customer's leads EXPLICITLY first (their
  //    activity_log cascades) — otherwise they'd linger as discarded, customer-less
  //    orphans. Invoices survive with lead_id/customer_id nulled.
  const agedCustomers = db.prepare(
    'SELECT id, business_id FROM customers WHERE deleted_at IS NOT NULL AND deleted_at < ?'
  ).all(cutoff);

  let customersPurged = 0;
  let customerLeadsPurged = 0;
  for (const c of agedCustomers) {
    try {
      const leadDel = db.prepare('DELETE FROM leads WHERE customer_id = ? AND business_id = ?')
        .run(c.id, c.business_id);
      db.prepare('DELETE FROM customers WHERE id = ? AND business_id = ?').run(c.id, c.business_id);
      customersPurged++;
      customerLeadsPurged += Number(leadDel.changes);
    } catch (err) {
      console.error(`[trash-cleanup] Failed to purge customer ${c.id}:`, err.message);
    }
  }

  // 2) Any remaining leads binned more than 30 days ago whose customer wasn't purged
  //    in step 1 (defensive — normally a binned lead's customer is binned too and is
  //    handled above). activity_log cascades; invoices' lead_id sets null. No overlap
  //    with step 1, which already removed the purged customers' leads.
  let strayLeadsPurged = 0;
  try {
    const leadDel = db.prepare(
      'DELETE FROM leads WHERE trashed_at IS NOT NULL AND trashed_at < ?'
    ).run(cutoff);
    strayLeadsPurged = Number(leadDel.changes);
  } catch (err) {
    console.error('[trash-cleanup] Failed to purge aged trashed leads:', err.message);
  }

  const totalLeads = customerLeadsPurged + strayLeadsPurged;
  if (customersPurged || totalLeads) {
    console.log(`[trash-cleanup] Purged ${customersPurged} customer(s) and ${totalLeads} lead(s) older than 30 days`);
  } else {
    console.log('[trash-cleanup] Nothing eligible for purge');
  }
}

function scheduleNext3am() {
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);

  const delay = next3am - now;
  const timer = setTimeout(() => {
    try {
      runCleanup();
    } catch (err) {
      console.error('[trash-cleanup] Unexpected error:', err);
    }
    scheduleNext3am();
  }, delay);
  timer.unref();

  const h = Math.floor(delay / 3600000);
  const m = Math.floor((delay % 3600000) / 60000);
  console.log(`[trash-cleanup] Next run in ${h}h ${m}m (${next3am.toLocaleString()})`);
}

function start() {
  scheduleNext3am();
}

module.exports = { start, runCleanup };
