const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendPasswordResetForUser } = require('../services/authService');

// Every admin endpoint requires a logged-in user whose business is the Stream
// admin account (business_id = 1). requireAuth populates req.business; requireAdmin
// then rejects any other tenant with 403.
router.use(requireAuth, requireAdmin);

// Allowed subscription_status values an admin can set.
const SUBSCRIPTION_STATUSES = ['active', 'inactive', 'trialing', 'past_due', 'canceled'];

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
router.patch('/businesses/:id/subscription', (req, res) => {
  try {
    const { status } = req.body || {};
    if (!SUBSCRIPTION_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}` });
    }
    const result = db
      .prepare('UPDATE businesses SET subscription_status = ? WHERE id = ?')
      .run(status, Number(req.params.id));
    if (Number(result.changes) === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
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

module.exports = router;
