const db = require('../db/database');
const { normalizeSize, getFleetBySize } = require('./inventoryService');

// ── Asset registry (pickup rework, Phase 2a) ─────────────────────────────────
//
// One row per physical dumpster. This is the source of truth for "how many do I
// own" — availability counts these rows (see inventoryService.getFleetBySize).
// `inventory_pool` is kept alongside as the per-size registry (row id + notes)
// and is mirrored from the fleet so anything still reading its counts stays
// correct; nothing reads `inventory_pool.quantity` for availability any more.
//
// Phase 2b will link assets to jobs through the `assignments` table. Nothing
// here touches assignments, dump tickets, swap markers, or units_out.

// available   ready to go out
// out         currently on a job
// at_yard     back at the yard, not yet re-marked available
// out_of_service  down for maintenance — the ONLY status that reduces availability
const ASSET_STATUSES = ['available', 'out', 'at_yard', 'out_of_service'];

function normalizeStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return ASSET_STATUSES.includes(s) ? s : null;
}

// Mirror the fleet counts for one size back onto its inventory_pool row so the
// legacy pool readers (the boot JSON backup, the admin export) never drift.
// Matches the pool row by normalized size so adding a "20 yd" unit updates the
// existing "20 yard" pool row instead of creating a second one.
function syncPoolFromAssets(businessId, size) {
  const target = normalizeSize(size);
  const pools = db.prepare('SELECT id, size FROM inventory_pool WHERE business_id = ?').all(businessId);
  const match = pools.find(p =>
    target !== null
      ? normalizeSize(p.size) === target
      : String(p.size || '').trim().toLowerCase() === String(size || '').trim().toLowerCase()
  );

  const counts = getFleetBySize(businessId).find(g =>
    target !== null
      ? normalizeSize(g.size) === target
      : String(g.size || '').trim().toLowerCase() === String(size || '').trim().toLowerCase()
  ) || { quantity: 0, units_in_service: 0 };

  const now = new Date().toISOString();
  if (match) {
    db.prepare('UPDATE inventory_pool SET quantity = ?, units_in_service = ?, updated_at = ? WHERE id = ?')
      .run(counts.quantity, counts.units_in_service, now, match.id);
  } else {
    db.prepare(
      'INSERT INTO inventory_pool (size, quantity, units_in_service, business_id, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(String(size).trim(), counts.quantity, counts.units_in_service, businessId, now);
  }
}

// The whole fleet, newest sizes grouped naturally by sorting on size then label.
// Retired units are excluded unless `includeRetired` is set.
function listAssets(businessId, { includeRetired = false } = {}) {
  const rows = includeRetired
    ? db.prepare('SELECT * FROM assets WHERE business_id = ?').all(businessId)
    : db.prepare('SELECT * FROM assets WHERE business_id = ? AND active = 1').all(businessId);

  rows.sort((a, b) => {
    const sizeDiff = (normalizeSize(a.size) || 999) - (normalizeSize(b.size) || 999);
    if (sizeDiff !== 0) return sizeDiff;
    return String(a.label).localeCompare(String(b.label), undefined, { numeric: true });
  });
  return rows;
}

function getAsset(businessId, id) {
  return db.prepare('SELECT * FROM assets WHERE id = ? AND business_id = ?').get(id, businessId) || null;
}

function createAsset(businessId, { size, label, status, notes }) {
  const cleanSize = String(size || '').trim();
  const cleanLabel = String(label || '').trim();
  if (!cleanSize) throw Object.assign(new Error('size is required'), { status: 400 });
  if (!cleanLabel) throw Object.assign(new Error('label is required'), { status: 400 });

  const cleanStatus = status === undefined ? 'available' : normalizeStatus(status);
  if (!cleanStatus) throw Object.assign(new Error(`status must be one of: ${ASSET_STATUSES.join(', ')}`), { status: 400 });

  const info = db.prepare(
    'INSERT INTO assets (business_id, size, label, status, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(businessId, cleanSize, cleanLabel, cleanStatus, notes ? String(notes) : null);

  syncPoolFromAssets(businessId, cleanSize);
  return getAsset(businessId, Number(info.lastInsertRowid));
}

function updateAsset(businessId, id, patch) {
  const existing = getAsset(businessId, id);
  if (!existing) return null;

  const updates = {};
  if (patch.size !== undefined) {
    const cleanSize = String(patch.size).trim();
    if (!cleanSize) throw Object.assign(new Error('size cannot be empty'), { status: 400 });
    updates.size = cleanSize;
  }
  if (patch.label !== undefined) {
    const cleanLabel = String(patch.label).trim();
    if (!cleanLabel) throw Object.assign(new Error('label cannot be empty'), { status: 400 });
    updates.label = cleanLabel;
  }
  if (patch.status !== undefined) {
    const cleanStatus = normalizeStatus(patch.status);
    if (!cleanStatus) throw Object.assign(new Error(`status must be one of: ${ASSET_STATUSES.join(', ')}`), { status: 400 });
    updates.status = cleanStatus;
  }
  if (patch.notes !== undefined) updates.notes = patch.notes ? String(patch.notes) : null;
  if (patch.active !== undefined) updates.active = patch.active ? 1 : 0;

  if (Object.keys(updates).length === 0) return existing;

  updates.updated_at = new Date().toISOString();
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE assets SET ${setClauses} WHERE id = ? AND business_id = ?`)
    .run(...Object.values(updates), id, businessId);

  // A size change moves the unit between two per-size counts, so sync both.
  syncPoolFromAssets(businessId, existing.size);
  if (updates.size && updates.size !== existing.size) syncPoolFromAssets(businessId, updates.size);

  return getAsset(businessId, id);
}

// Retiring is a soft delete: the row stays for history (and so the Phase 2a
// seed-guard can never re-fire), but it drops out of the fleet count.
function retireAsset(businessId, id) {
  return updateAsset(businessId, id, { active: 0 });
}

module.exports = {
  ASSET_STATUSES,
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  retireAsset,
  syncPoolFromAssets,
};
