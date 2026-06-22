const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { getPriceList, getDiscountGroups } = require('../services/pricingService');

// Business-level pricing config: the default/retail price list every customer
// falls back to, and the discount groups (contractor/commercial) customers can
// be assigned to. Per-customer overrides live under /api/customers/:id/pricing.
router.use(requireAuth);

// GET /api/pricing — the default price list + discount groups for this business.
router.get('/', (req, res) => {
  try {
    const businessId = req.business.id;
    res.json({
      items: getPriceList(businessId),
      groups: getDiscountGroups(businessId),
    });
  } catch (err) {
    console.error('GET /pricing error:', err);
    res.status(500).json({ error: 'Failed to retrieve pricing' });
  }
});

// ── Default price-list items ────────────────────────────────────────────────

// POST /api/pricing/items — add a default price for a service/size.
router.post('/items', (req, res) => {
  try {
    const businessId = req.business.id;
    const b = req.body || {};
    const serviceKey = (b.service_key || b.serviceKey || '').toString().trim();
    if (!serviceKey) return res.status(400).json({ error: 'service_key is required' });
    const label = (b.label || '').toString().trim() || serviceKey;
    const unit = (b.unit || '').toString().trim() || null;
    const price = b.unit_price === '' || b.unit_price == null ? null : Number(b.unit_price);
    if (price != null && (Number.isNaN(price) || price < 0)) return res.status(400).json({ error: 'Invalid price' });
    const sortOrder = parseInt(b.sort_order, 10) || 0;

    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO price_list_items (business_id, service_key, label, unit, unit_price, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(businessId, serviceKey, label, unit, price, sortOrder, now, now);
    res.status(201).json(db.prepare('SELECT * FROM price_list_items WHERE id = ?').get(Number(info.lastInsertRowid)));
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A price for this service already exists' });
    }
    console.error('POST /pricing/items error:', err);
    res.status(500).json({ error: 'Failed to create price' });
  }
});

// PUT /api/pricing/items/:id — edit a default price-list item.
router.put('/items/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM price_list_items WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Price item not found' });

    const b = req.body || {};
    const updates = {};
    if (b.service_key !== undefined || b.serviceKey !== undefined) {
      const sk = (b.service_key !== undefined ? b.service_key : b.serviceKey).toString().trim();
      if (!sk) return res.status(400).json({ error: 'service_key cannot be empty' });
      updates.service_key = sk;
    }
    if (b.label !== undefined) updates.label = (b.label || '').toString().trim() || null;
    if (b.unit !== undefined) updates.unit = (b.unit || '').toString().trim() || null;
    if (b.unit_price !== undefined) {
      const price = b.unit_price === '' || b.unit_price == null ? null : Number(b.unit_price);
      if (price != null && (Number.isNaN(price) || price < 0)) return res.status(400).json({ error: 'Invalid price' });
      updates.unit_price = price;
    }
    if (b.sort_order !== undefined) updates.sort_order = parseInt(b.sort_order, 10) || 0;

    if (Object.keys(updates).length === 0) return res.json(existing);
    updates.updated_at = new Date().toISOString();
    const set = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE price_list_items SET ${set} WHERE id = ? AND business_id = ?`)
      .run(...Object.values(updates), req.params.id, businessId);
    res.json(db.prepare('SELECT * FROM price_list_items WHERE id = ?').get(req.params.id));
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A price for this service already exists' });
    }
    console.error('PUT /pricing/items/:id error:', err);
    res.status(500).json({ error: 'Failed to update price' });
  }
});

// DELETE /api/pricing/items/:id
router.delete('/items/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT id FROM price_list_items WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Price item not found' });
    db.prepare('DELETE FROM price_list_items WHERE id = ? AND business_id = ?').run(req.params.id, businessId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /pricing/items/:id error:', err);
    res.status(500).json({ error: 'Failed to delete price' });
  }
});

// ── Discount groups ─────────────────────────────────────────────────────────

// POST /api/pricing/groups
router.post('/groups', (req, res) => {
  try {
    const businessId = req.business.id;
    const b = req.body || {};
    const name = (b.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const pct = b.discount_percent === '' || b.discount_percent == null ? 0 : Number(b.discount_percent);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'discount_percent must be 0–100' });
    const netTerms = (b.default_net_terms || '').toString().trim() || null;

    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO discount_groups (business_id, name, discount_percent, default_net_terms, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(businessId, name, pct, netTerms, (b.notes || '').toString().trim() || null, now, now);
    res.status(201).json(db.prepare('SELECT * FROM discount_groups WHERE id = ?').get(Number(info.lastInsertRowid)));
  } catch (err) {
    console.error('POST /pricing/groups error:', err);
    res.status(500).json({ error: 'Failed to create discount group' });
  }
});

// PUT /api/pricing/groups/:id
router.put('/groups/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM discount_groups WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Discount group not found' });

    const b = req.body || {};
    const updates = {};
    if (b.name !== undefined) {
      const name = (b.name || '').toString().trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      updates.name = name;
    }
    if (b.discount_percent !== undefined) {
      const pct = b.discount_percent === '' || b.discount_percent == null ? 0 : Number(b.discount_percent);
      if (Number.isNaN(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'discount_percent must be 0–100' });
      updates.discount_percent = pct;
    }
    if (b.default_net_terms !== undefined) updates.default_net_terms = (b.default_net_terms || '').toString().trim() || null;
    if (b.notes !== undefined) updates.notes = (b.notes || '').toString().trim() || null;

    if (Object.keys(updates).length === 0) return res.json(existing);
    updates.updated_at = new Date().toISOString();
    const set = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE discount_groups SET ${set} WHERE id = ? AND business_id = ?`)
      .run(...Object.values(updates), req.params.id, businessId);
    res.json(db.prepare('SELECT * FROM discount_groups WHERE id = ?').get(req.params.id));
  } catch (err) {
    console.error('PUT /pricing/groups/:id error:', err);
    res.status(500).json({ error: 'Failed to update discount group' });
  }
});

// DELETE /api/pricing/groups/:id — also unassigns any customers in the group so
// no customer is left pointing at a deleted group.
router.delete('/groups/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT id FROM discount_groups WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Discount group not found' });
    db.prepare('UPDATE customers SET discount_group_id = NULL WHERE discount_group_id = ? AND business_id = ?').run(req.params.id, businessId);
    db.prepare('DELETE FROM discount_groups WHERE id = ? AND business_id = ?').run(req.params.id, businessId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /pricing/groups/:id error:', err);
    res.status(500).json({ error: 'Failed to delete discount group' });
  }
});

module.exports = router;
