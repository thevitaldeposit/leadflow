const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendPasswordResetForUser } = require('../services/authService');
const { cancelSubscriptionForBusiness } = require('./billing');

// Every admin endpoint requires a logged-in user whose business is the Stream
// admin account (business_id = 1). requireAuth populates req.business; requireAdmin
// then rejects any other tenant with 403.
router.use(requireAuth, requireAdmin);

// Allowed subscription_status values an admin can set.
const SUBSCRIPTION_STATUSES = ['active', 'inactive', 'trialing', 'past_due', 'canceled'];

// The Stream admin account (Valley Binz). It can never be deleted — losing it
// would orphan the admin panel and the default-tenant fallback.
const PROTECTED_BUSINESS_ID = 1;

// Every table carrying a business_id, in foreign-key-safe delete order (children
// before parents). activity_log references leads(id) ON DELETE CASCADE, so
// deleting leads would clear it too, but it's deleted explicitly first for an
// accurate per-table count. `signups` is intentionally absent — it's top-of-
// funnel marketing data not scoped to any tenant.
const BUSINESS_SCOPED_TABLES = [
  'activity_log',
  'leads',
  'inventory_pool',
  'call_sessions',
  'devices',
  'settings',
  'users',
];

// GET /api/admin/businesses — every tenant with its owner email + billing state.
// owner_email comes from the users table (owner role preferred); the owner's name
// lives on the businesses row (owner_first_name / owner_last_name). A correlated
// subquery for the email avoids row duplication when a business has multiple users.
router.get('/businesses', (req, res) => {
  try {
    const rows = db
      .prepare(`
        SELECT
          b.id,
          b.name,
          b.owner_first_name,
          b.owner_last_name,
          b.industry_type,
          b.subscription_status,
          b.onboarding_complete,
          b.trial_days,
          b.trial_end_date,
          b.created_at,
          (SELECT email FROM users
             WHERE business_id = b.id
             ORDER BY (role = 'owner') DESC, id ASC
             LIMIT 1) AS owner_email
        FROM businesses b
        ORDER BY b.created_at DESC, b.id DESC
      `)
      .all();
    res.json(rows);
  } catch (err) {
    console.error('GET /admin/businesses error:', err);
    res.status(500).json({ error: 'Failed to load businesses' });
  }
});

// PATCH /api/admin/businesses/:id/subscription — set subscription_status.
// Deactivating or cancelling an account also cancels its Stripe subscription so
// the customer is never charged again once they're no longer active.
router.patch('/businesses/:id/subscription', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!SUBSCRIPTION_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}` });
    }
    const id = Number(req.params.id);
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Stop billing when the account is moving to a non-active state. Done before
    // the status update so a Stripe failure leaves the account untouched (no
    // "inactive but still charged" state). No-ops when there's no subscription.
    if (status === 'inactive' || status === 'canceled') {
      try {
        const result = await cancelSubscriptionForBusiness(business);
        console.log(
          `[admin] Deactivate business ${id} — Stripe: ${
            result.cancelled ? `subscription ${result.subscriptionId} cancelled` : result.reason
          }`
        );
      } catch (err) {
        console.error(`PATCH /admin/businesses/${id}/subscription — Stripe cancel failed:`, err.message);
        return res
          .status(502)
          .json({ error: 'Failed to cancel Stripe subscription; status not changed' });
      }
    }

    db.prepare('UPDATE businesses SET subscription_status = ? WHERE id = ?').run(status, id);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /admin/businesses/:id/subscription error:', err);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// PATCH /api/admin/businesses/:id/trial — grant a free trial of trialDays days.
// Sets trial_days, computes trial_end_date (now + trialDays), and flips the
// subscription to 'trialing'.
router.patch('/businesses/:id/trial', (req, res) => {
  try {
    const trialDays = Number(req.body && req.body.trialDays);
    if (!Number.isInteger(trialDays) || trialDays <= 0) {
      return res.status(400).json({ error: 'trialDays must be a positive integer' });
    }
    const trialEndDate = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
    const result = db
      .prepare(`
        UPDATE businesses
        SET trial_days = ?, trial_end_date = ?, subscription_status = 'trialing'
        WHERE id = ?
      `)
      .run(trialDays, trialEndDate, Number(req.params.id));
    if (Number(result.changes) === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
    res.json({ success: true, trialEndDate });
  } catch (err) {
    console.error('PATCH /admin/businesses/:id/trial error:', err);
    res.status(500).json({ error: 'Failed to set trial' });
  }
});

// PATCH /api/admin/businesses/:id/onboarding — mark onboarding complete, which
// hides the new-customer banner on that tenant's dashboard.
router.patch('/businesses/:id/onboarding', (req, res) => {
  try {
    const result = db
      .prepare('UPDATE businesses SET onboarding_complete = 1 WHERE id = ?')
      .run(Number(req.params.id));
    if (Number(result.changes) === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /admin/businesses/:id/onboarding error:', err);
    res.status(500).json({ error: 'Failed to update onboarding' });
  }
});

// POST /api/admin/businesses/:id/reset-password — email the business owner a
// password-reset link (same 1-hour token/link the public forgot-password flow
// issues). Targets the owner-role user, falling back to the earliest user.
router.post('/businesses/:id/reset-password', async (req, res) => {
  try {
    const owner = db
      .prepare(`
        SELECT * FROM users
        WHERE business_id = ?
        ORDER BY (role = 'owner') DESC, id ASC
        LIMIT 1
      `)
      .get(Number(req.params.id));
    if (!owner) {
      return res.status(404).json({ error: 'No owner account found for this business' });
    }
    await sendPasswordResetForUser(owner);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /admin/businesses/:id/reset-password error:', err);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// DELETE /api/admin/businesses/:businessId — permanently delete one account:
// its Stripe subscription, all of its business_id-scoped data, and its
// business + user records. Used to clean up mock/test signups so they leave
// nothing behind and the email is freed for reuse. Only ever touches rows
// carrying the target business_id — no other account's data is affected.
router.delete('/businesses/:businessId', async (req, res) => {
  const businessId = Number(req.params.businessId);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return res.status(400).json({ error: 'Invalid business id' });
  }
  // Hard guard: the Stream admin account can never be deleted.
  if (businessId === PROTECTED_BUSINESS_ID) {
    return res.status(403).json({ error: 'The Stream admin account cannot be deleted' });
  }

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  // Cancel Stripe billing first. Doing it before the DB delete means a Stripe
  // failure aborts the whole operation and nothing is removed. Accounts with no
  // subscription (free / 100%-off) cancel as a clean no-op.
  let stripeResult;
  try {
    stripeResult = await cancelSubscriptionForBusiness(business);
  } catch (err) {
    console.error(`DELETE /admin/businesses/${businessId} — Stripe cancel failed:`, err.message);
    return res
      .status(502)
      .json({ error: 'Failed to cancel Stripe subscription; nothing was deleted' });
  }

  // Delete everything in one transaction so any failure rolls back completely —
  // no half-deleted account. foreign_keys is ON, so the child-before-parent
  // ordering of BUSINESS_SCOPED_TABLES (then the business row) is required.
  const deletedCounts = {};
  try {
    db.exec('BEGIN');
    try {
      for (const table of BUSINESS_SCOPED_TABLES) {
        const r = db.prepare(`DELETE FROM ${table} WHERE business_id = ?`).run(businessId);
        deletedCounts[table] = Number(r.changes);
      }
      const bizResult = db.prepare('DELETE FROM businesses WHERE id = ?').run(businessId);
      deletedCounts.businesses = Number(bizResult.changes);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (err) {
    console.error(`DELETE /admin/businesses/${businessId} error:`, err);
    return res.status(500).json({ error: 'Failed to delete account; no data was removed' });
  }

  const summary = {
    businessId,
    businessName: business.name || null,
    stripeSubscriptionCancelled: stripeResult.cancelled,
    stripeNote: stripeResult.reason || null,
    deletedCounts,
  };
  console.log(`[admin] Deleted business ${businessId} ("${business.name || ''}")`, JSON.stringify(summary));
  res.json({ success: true, ...summary });
});

module.exports = router;
