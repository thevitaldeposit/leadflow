const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  listDumpSites,
  getDumpSite,
  createDumpSite,
  updateDumpSite,
  retireDumpSite,
} = require('../services/dumpSiteService');

// Dump sites — the landfills / transfer stations the business hauls to. Owner-managed
// reference data behind the guided pickup flow's "where are you taking it?" step.
// Every route is scoped to the authenticated business.
router.use(requireAuth);

function fail(res, err, fallback) {
  if (err && err.status === 400) return res.status(400).json({ error: err.message });
  console.error(`${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

// GET /api/dump-sites — active sites; ?include_retired=1 also returns retired ones.
router.get('/', (req, res) => {
  try {
    const includeRetired = req.query.include_retired === '1' || req.query.include_retired === 'true';
    res.json({ sites: listDumpSites(req.business.id, { includeRetired }) });
  } catch (err) {
    fail(res, err, 'Failed to retrieve dump sites');
  }
});

// POST /api/dump-sites — add a site. Body: { name, address?, notes? }
router.post('/', (req, res) => {
  try {
    res.status(201).json(createDumpSite(req.business.id, req.body || {}));
  } catch (err) {
    fail(res, err, 'Failed to create dump site');
  }
});

// PUT /api/dump-sites/:id — edit name / address / notes / sort order; `active`
// un-retires. Partial: absent fields are left alone.
router.put('/:id', (req, res) => {
  try {
    const updated = updateDumpSite(req.business.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Dump site not found' });
    res.json(updated);
  } catch (err) {
    fail(res, err, 'Failed to update dump site');
  }
});

// DELETE /api/dump-sites/:id — retire (soft delete; the row stays so an older
// dump ticket that names this site still reads correctly).
router.delete('/:id', (req, res) => {
  try {
    if (!getDumpSite(req.business.id, req.params.id)) {
      return res.status(404).json({ error: 'Dump site not found' });
    }
    res.json({ success: true, site: retireDumpSite(req.business.id, req.params.id) });
  } catch (err) {
    fail(res, err, 'Failed to retire dump site');
  }
});

module.exports = router;
