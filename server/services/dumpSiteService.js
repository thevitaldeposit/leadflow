const db = require('../db/database');

// ── Dump sites ────────────────────────────────────────────────────────────────
//
// The landfills / transfer stations a business hauls to. Reference data for the
// guided pickup flow and nothing more: the driver picks the site they're driving
// to and taps "Get directions", which opens the maps app against the stored
// address string. There is deliberately NO geocoding and NO distance math — this
// never touches the mileage fee, the weight allowance, or the overage price.
//
// Retiring a site is a soft delete (active = 0) so a site named on an old dump
// ticket still resolves.

function nowIso() { return new Date().toISOString(); }

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    address: row.address || null,
    notes: row.notes || null,
    active: row.active === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Active sites first in the owner's chosen order, then by name. `includeRetired`
// is the management screen's "show retired" toggle; the pickup flow never asks
// for retired sites.
function listDumpSites(businessId, { includeRetired = false } = {}) {
  const rows = db.prepare(`
    SELECT * FROM dump_sites
    WHERE business_id = ? ${includeRetired ? '' : 'AND active = 1'}
    ORDER BY active DESC, sort_order ASC, name COLLATE NOCASE ASC
  `).all(businessId);
  return rows.map(shape);
}

function getDumpSite(businessId, id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return shape(db.prepare('SELECT * FROM dump_sites WHERE id = ? AND business_id = ?').get(n, businessId));
}

function createDumpSite(businessId, { name, address = null, notes = null, sortOrder = null } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw fail('A site name is required');

  // New sites land at the end of the owner's ordering unless one is given. The
  // null check matters: Number(null) is 0, which IS finite, so testing only for
  // finiteness would pin every new site to position 0.
  const order = sortOrder != null && sortOrder !== '' && Number.isFinite(Number(sortOrder))
    ? Math.round(Number(sortOrder))
    : (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM dump_sites WHERE business_id = ?').get(businessId).m + 1);

  const at = nowIso();
  const info = db.prepare(`
    INSERT INTO dump_sites (business_id, name, address, notes, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    businessId,
    cleanName,
    address ? String(address).trim() : null,
    notes ? String(notes).trim() : null,
    order,
    at,
    at
  );
  return getDumpSite(businessId, Number(info.lastInsertRowid));
}

// Partial update — only the fields actually present in the patch are written, so
// an edit screen that sends just a name can't blank the address.
function updateDumpSite(businessId, id, patch = {}) {
  const existing = getDumpSite(businessId, id);
  if (!existing) return null;

  const sets = [];
  const vals = [];
  if (patch.name !== undefined) {
    const cleanName = String(patch.name || '').trim();
    if (!cleanName) throw fail('A site name is required');
    sets.push('name = ?'); vals.push(cleanName);
  }
  if (patch.address !== undefined) {
    sets.push('address = ?'); vals.push(patch.address ? String(patch.address).trim() : null);
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?'); vals.push(patch.notes ? String(patch.notes).trim() : null);
  }
  if (patch.active !== undefined) {
    sets.push('active = ?'); vals.push(patch.active ? 1 : 0);
  }
  if (patch.sortOrder !== undefined && Number.isFinite(Number(patch.sortOrder))) {
    sets.push('sort_order = ?'); vals.push(Math.round(Number(patch.sortOrder)));
  }
  if (sets.length === 0) return existing;

  sets.push('updated_at = ?'); vals.push(nowIso());
  db.prepare(`UPDATE dump_sites SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`)
    .run(...vals, Number(id), businessId);
  return getDumpSite(businessId, id);
}

// Soft delete: the row stays so an older dump ticket that names this site still
// reads correctly, and the owner can un-retire it.
function retireDumpSite(businessId, id) {
  return updateDumpSite(businessId, id, { active: false });
}

module.exports = {
  listDumpSites,
  getDumpSite,
  createDumpSite,
  updateDumpSite,
  retireDumpSite,
};
