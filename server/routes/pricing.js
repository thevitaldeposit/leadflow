const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const {
  getPriceList, getDiscountGroups, getPricingFees, getSpecialItems, sanitizePricingConfig,
  resolvePrice, getDeliveryFee,
} = require('../services/pricingService');
const { normalizeSizeKey } = require('../services/sizeKey');

// Business-level pricing config: the default/retail price list every customer
// falls back to, plus per-size pricing_config, business-wide fees, special/restricted
// items, and the discount groups (contractor/commercial) customers can be assigned to.
// Per-customer overrides live under /api/customers/:id/pricing.
router.use(requireAuth);

// Size-shaped service keys are stored canonically ("20 yard" → "20yd") so a size→rate
// join with inventory is reliable. Non-size keys (e.g. "delivery") pass through.
function canonicalizeServiceKey(raw) {
  const s = (raw || '').toString().trim();
  return normalizeSizeKey(s) || s;
}

// GET /api/pricing — the default price list (with per-size config), business fees,
// special items, and discount groups for this business.
router.get('/', (req, res) => {
  try {
    const businessId = req.business.id;
    res.json({
      items: getPriceList(businessId),
      groups: getDiscountGroups(businessId),
      fees: getPricingFees(businessId),
      special_items: getSpecialItems(businessId),
    });
  } catch (err) {
    console.error('GET /pricing error:', err);
    res.status(500).json({ error: 'Failed to retrieve pricing' });
  }
});

// POST /api/pricing/quote — compute a suggested price for a size + rental duration,
// with the full breakdown, so the booking flow can PREFILL an editable price. Applies
// per-customer effective pricing when a customerId is given, and includes an enabled
// flat delivery fee in the suggested total. Never persists anything.
router.post('/quote', (req, res) => {
  try {
    const businessId = req.business.id;
    const b = req.body || {};
    const size = (b.size || b.dumpsterSize || '').toString().trim();
    if (!size) return res.status(400).json({ error: 'size is required' });
    const days = b.days === '' || b.days == null ? 1 : Number(b.days);

    let customer = null;
    const customerId = b.customerId == null ? null : Number(b.customerId);
    if (Number.isFinite(customerId)) {
      customer = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(customerId, businessId) || null;
    }

    const quote = resolvePrice(businessId, { size, days, customer });
    const delivery = getDeliveryFee(businessId);
    const suggestedTotal = quote.priceable
      ? Math.round(((quote.total || 0) + (delivery ? delivery.amount : 0)) * 100) / 100
      : null;

    res.json({ ...quote, delivery_fee: delivery, suggested_total: suggestedTotal });
  } catch (err) {
    console.error('POST /pricing/quote error:', err);
    res.status(500).json({ error: 'Failed to compute quote' });
  }
});

// ── Default price-list items ────────────────────────────────────────────────

// POST /api/pricing/items — add a default price for a service/size.
router.post('/items', (req, res) => {
  try {
    const businessId = req.business.id;
    const b = req.body || {};
    const rawKey = (b.service_key || b.serviceKey || '').toString().trim();
    if (!rawKey) return res.status(400).json({ error: 'service_key is required' });
    const serviceKey = canonicalizeServiceKey(rawKey);
    const label = (b.label || '').toString().trim() || serviceKey;
    const unit = (b.unit || '').toString().trim() || null;
    const price = b.unit_price === '' || b.unit_price == null ? null : Number(b.unit_price);
    if (price != null && (Number.isNaN(price) || price < 0)) return res.status(400).json({ error: 'Invalid price' });
    const sortOrder = parseInt(b.sort_order, 10) || 0;
    const pricingConfig = b.pricing_config !== undefined ? sanitizePricingConfig(b.pricing_config) : null;

    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO price_list_items (business_id, service_key, label, unit, unit_price, pricing_config, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(businessId, serviceKey, label, unit, price, pricingConfig ? JSON.stringify(pricingConfig) : null, sortOrder, now, now);
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
      updates.service_key = canonicalizeServiceKey(sk);
    }
    if (b.label !== undefined) updates.label = (b.label || '').toString().trim() || null;
    if (b.unit !== undefined) updates.unit = (b.unit || '').toString().trim() || null;
    if (b.unit_price !== undefined) {
      const price = b.unit_price === '' || b.unit_price == null ? null : Number(b.unit_price);
      if (price != null && (Number.isNaN(price) || price < 0)) return res.status(400).json({ error: 'Invalid price' });
      updates.unit_price = price;
    }
    if (b.pricing_config !== undefined) {
      const cfg = sanitizePricingConfig(b.pricing_config);
      updates.pricing_config = cfg ? JSON.stringify(cfg) : null;
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

// ── Business-wide fees (delivery, mileage/out-of-area, …) ────────────────────
// Each fee is independently enable/disable-able. `config` JSON carries type-specific
// params, e.g. mileage: { per_mile, threshold_miles }.

function readFeeBody(b) {
  const feeType = (b.fee_type || b.feeType || '').toString().trim();
  const label = (b.label || '').toString().trim() || null;
  const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
  const enabled = b.enabled === undefined ? 1 : (b.enabled ? 1 : 0);
  let config = null;
  if (b.config != null) {
    if (typeof b.config === 'string') {
      try { config = JSON.parse(b.config); } catch { config = null; }
    } else if (typeof b.config === 'object') {
      config = b.config;
    }
  }
  return { feeType, label, amount, enabled, config };
}

// POST /api/pricing/fees
router.post('/fees', (req, res) => {
  try {
    const businessId = req.business.id;
    const { feeType, label, amount, enabled, config } = readFeeBody(req.body || {});
    if (!feeType) return res.status(400).json({ error: 'fee_type is required' });
    if (amount != null && (Number.isNaN(amount) || amount < 0)) return res.status(400).json({ error: 'Invalid amount' });
    const sortOrder = parseInt((req.body || {}).sort_order, 10) || 0;
    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO pricing_fees (business_id, fee_type, label, amount, enabled, config, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(businessId, feeType, label, amount, enabled, config ? JSON.stringify(config) : null, sortOrder, now, now);
    res.status(201).json(db.prepare('SELECT * FROM pricing_fees WHERE id = ?').get(Number(info.lastInsertRowid)));
  } catch (err) {
    console.error('POST /pricing/fees error:', err);
    res.status(500).json({ error: 'Failed to create fee' });
  }
});

// PUT /api/pricing/fees/:id
router.put('/fees/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM pricing_fees WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Fee not found' });

    const b = req.body || {};
    const updates = {};
    if (b.fee_type !== undefined || b.feeType !== undefined) {
      const ft = (b.fee_type !== undefined ? b.fee_type : b.feeType).toString().trim();
      if (!ft) return res.status(400).json({ error: 'fee_type cannot be empty' });
      updates.fee_type = ft;
    }
    if (b.label !== undefined) updates.label = (b.label || '').toString().trim() || null;
    if (b.amount !== undefined) {
      const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
      if (amount != null && (Number.isNaN(amount) || amount < 0)) return res.status(400).json({ error: 'Invalid amount' });
      updates.amount = amount;
    }
    if (b.enabled !== undefined) updates.enabled = b.enabled ? 1 : 0;
    if (b.config !== undefined) {
      let config = null;
      if (b.config != null) {
        if (typeof b.config === 'string') { try { config = JSON.parse(b.config); } catch { config = null; } }
        else if (typeof b.config === 'object') config = b.config;
      }
      updates.config = config ? JSON.stringify(config) : null;
    }
    if (b.sort_order !== undefined) updates.sort_order = parseInt(b.sort_order, 10) || 0;

    if (Object.keys(updates).length === 0) return res.json(existing);
    updates.updated_at = new Date().toISOString();
    const set = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE pricing_fees SET ${set} WHERE id = ? AND business_id = ?`)
      .run(...Object.values(updates), req.params.id, businessId);
    res.json(db.prepare('SELECT * FROM pricing_fees WHERE id = ?').get(req.params.id));
  } catch (err) {
    console.error('PUT /pricing/fees/:id error:', err);
    res.status(500).json({ error: 'Failed to update fee' });
  }
});

// DELETE /api/pricing/fees/:id
router.delete('/fees/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT id FROM pricing_fees WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Fee not found' });
    db.prepare('DELETE FROM pricing_fees WHERE id = ? AND business_id = ?').run(req.params.id, businessId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /pricing/fees/:id error:', err);
    res.status(500).json({ error: 'Failed to delete fee' });
  }
});

// ── Special / restricted items ("Prohibited Items" section) ──────────────────
// kind='prohibited' (not allowed; charge_amount forced null) or 'surcharge' (allowed
// but adds charge_amount, e.g. mattress $40).

function readSpecialItemFields(b) {
  const name = (b.name || '').toString().trim();
  const kind = b.kind === 'prohibited' ? 'prohibited' : 'surcharge';
  // Prohibited items carry no charge; surcharge items require an amount to mean anything.
  const charge = kind === 'prohibited'
    ? null
    : (b.charge_amount === '' || b.charge_amount == null ? null : Number(b.charge_amount));
  return { name, kind, charge };
}

// POST /api/pricing/special-items
router.post('/special-items', (req, res) => {
  try {
    const businessId = req.business.id;
    const { name, kind, charge } = readSpecialItemFields(req.body || {});
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (charge != null && (Number.isNaN(charge) || charge < 0)) return res.status(400).json({ error: 'Invalid charge_amount' });
    const sortOrder = parseInt((req.body || {}).sort_order, 10) || 0;
    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO special_items (business_id, name, kind, charge_amount, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(businessId, name, kind, charge, sortOrder, now, now);
    res.status(201).json(db.prepare('SELECT * FROM special_items WHERE id = ?').get(Number(info.lastInsertRowid)));
  } catch (err) {
    console.error('POST /pricing/special-items error:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// PUT /api/pricing/special-items/:id
router.put('/special-items/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM special_items WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    const b = req.body || {};
    const updates = {};
    if (b.name !== undefined) {
      const name = (b.name || '').toString().trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      updates.name = name;
    }
    // kind + charge move together so a prohibited item can never keep a stale charge.
    if (b.kind !== undefined || b.charge_amount !== undefined) {
      const kind = (b.kind !== undefined ? b.kind : existing.kind) === 'prohibited' ? 'prohibited' : 'surcharge';
      updates.kind = kind;
      if (kind === 'prohibited') {
        updates.charge_amount = null;
      } else if (b.charge_amount !== undefined) {
        const charge = b.charge_amount === '' || b.charge_amount == null ? null : Number(b.charge_amount);
        if (charge != null && (Number.isNaN(charge) || charge < 0)) return res.status(400).json({ error: 'Invalid charge_amount' });
        updates.charge_amount = charge;
      }
    }
    if (b.sort_order !== undefined) updates.sort_order = parseInt(b.sort_order, 10) || 0;

    if (Object.keys(updates).length === 0) return res.json(existing);
    updates.updated_at = new Date().toISOString();
    const set = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE special_items SET ${set} WHERE id = ? AND business_id = ?`)
      .run(...Object.values(updates), req.params.id, businessId);
    res.json(db.prepare('SELECT * FROM special_items WHERE id = ?').get(req.params.id));
  } catch (err) {
    console.error('PUT /pricing/special-items/:id error:', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /api/pricing/special-items/:id
router.delete('/special-items/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT id FROM special_items WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Item not found' });
    db.prepare('DELETE FROM special_items WHERE id = ? AND business_id = ?').run(req.params.id, businessId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /pricing/special-items/:id error:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

module.exports = router;
