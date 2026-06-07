const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getMorningBrief } = require('../services/morningBrief');

// GET /api/dashboard/morning-brief
// Returns the AI-generated COO-style morning briefing for the authenticated
// business: { date, available, bullets }. `available` is false before 6am in
// the business's timezone. The result is cached for the local day so refreshing
// the dashboard doesn't re-call the model.
router.get('/morning-brief', requireAuth, async (req, res) => {
  try {
    const result = await getMorningBrief(req.business.id);
    res.json(result);
  } catch (err) {
    console.error('GET /dashboard/morning-brief error:', err);
    res.status(500).json({ error: 'Failed to generate morning brief' });
  }
});

module.exports = router;
