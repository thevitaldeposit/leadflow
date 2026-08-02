const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getFleetBySize } = require('../services/inventoryService');
const {
  ASSET_STATUSES,
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  retireAsset,
} = require('../services/assetService');
const { yardUnits } = require('../services/assignmentService');

// Fleet registry (pickup rework, Phase 2a): the owner's individual dumpsters.
// Every route is scoped to the authenticated business.
router.use(requireAuth);

function fail(res, err, fallback) {
  if (err && err.status === 400) return res.status(400).json({ error: err.message });
  if (err && String(err.message).includes('UNIQUE')) {
    return res.status(409).json({ error: 'A unit with this number already exists' });
  }
  console.error(`${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

// GET /api/assets — the fleet plus the per-size rollup that drives availability.
// ?include_retired=1 also returns units retired from the fleet.
router.get('/', (req, res) => {
  try {
    const businessId = req.business.id;
    const includeRetired = req.query.include_retired === '1' || req.query.include_retired === 'true';
    res.json({
      assets: listAssets(businessId, { includeRetired }),
      bySize: getFleetBySize(businessId),
      statuses: ASSET_STATUSES,
    });
  } catch (err) {
    fail(res, err, 'Failed to retrieve fleet');
  }
});

// GET /api/assets/yard — the YARD QUEUE (Phase 2c): units picked up but not yet
// weighed, each carrying the job its weight belongs to. Several cans collected on a
// Saturday get weighed over the following days from here, and each ticket lands on
// its own customer. Declared before the /:id routes so 'yard' is never read as an id.
router.get('/yard', (req, res) => {
  try {
    res.json({ units: yardUnits(req.business.id) });
  } catch (err) {
    fail(res, err, 'Failed to retrieve the yard queue');
  }
});

// POST /api/assets — register a dumpster
router.post('/', (req, res) => {
  try {
    res.status(201).json(createAsset(req.business.id, req.body || {}));
  } catch (err) {
    fail(res, err, 'Failed to create asset');
  }
});

// PUT /api/assets/:id — edit label, size, status, notes; `active` un-retires
router.put('/:id', (req, res) => {
  try {
    const updated = updateAsset(req.business.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Asset not found' });
    res.json(updated);
  } catch (err) {
    fail(res, err, 'Failed to update asset');
  }
});

// DELETE /api/assets/:id — retire (soft delete; the row stays for history)
router.delete('/:id', (req, res) => {
  try {
    if (!getAsset(req.business.id, req.params.id)) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    res.json({ success: true, asset: retireAsset(req.business.id, req.params.id) });
  } catch (err) {
    fail(res, err, 'Failed to retire asset');
  }
});

module.exports = router;
