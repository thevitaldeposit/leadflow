const db = require('../db/database');
const { normalizeSizeKey } = require('./sizeKey');

// ── Per-client pricing ────────────────────────────────────────────────────────
// Three layers, all business_id-scoped:
//   price_list_items  — the business's default/retail price list (the fallback).
//   discount_groups   — named contractor/commercial groups with a percent off.
//   customer_pricing  — per-customer rate overrides that beat everything.
// resolveEffectivePricing() merges them for one customer so quotes/invoices (not
// built here) can later read a single effective number per service.
//
// Each price row also carries a per-SIZE `pricing_config` JSON blob (tiers/flat,
// weight allowance, overage rate, day rate, swap) plus two business-wide tables —
// pricing_fees and special_items. This module stores/edits/reads that config; it is
// NOT wired into booking/invoice/overage computation (that's Prompt B).

function round2(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(Number(n) * 100) / 100;
}

// A non-negative money/quantity number, or null for blank/invalid input.
function nonNegNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

// Validate + normalize a per-size pricing_config into a clean, storable object.
// Every field is independently settable, so any combination is valid; unknown or
// malformed fields are dropped rather than trusted. Returns null when nothing usable
// was provided (so the row falls back to its flat unit_price).
function sanitizePricingConfig(raw) {
  if (raw == null) return null;
  let cfg = raw;
  if (typeof raw === 'string') {
    try { cfg = JSON.parse(raw); } catch { return null; }
  }
  if (typeof cfg !== 'object' || Array.isArray(cfg)) return null;

  const style = cfg.pricing_style === 'flat' ? 'flat'
    : cfg.pricing_style === 'tiered' ? 'tiered'
    : null;

  const tiers = Array.isArray(cfg.tiers)
    ? cfg.tiers.map((t) => ({
        label: (t && t.label != null ? String(t.label) : '').trim() || null,
        days: t && t.days !== '' && t.days != null && Number.isFinite(Number(t.days)) ? Math.max(0, Math.round(Number(t.days))) : null,
        rate: nonNegNum(t && t.rate),
      })).filter((t) => t.label || t.days != null || t.rate != null)
    : [];

  const dr = (cfg.day_rate && typeof cfg.day_rate === 'object') ? cfg.day_rate : {};
  const day_rate = { enabled: !!dr.enabled, rate: nonNegNum(dr.rate) };

  const sw = (cfg.swap && typeof cfg.swap === 'object') ? cfg.swap : {};
  const swapMode = ['same_as_rate', 'custom', 'off'].includes(sw.mode) ? sw.mode : 'same_as_rate';
  const swap = { mode: swapMode, custom_price: swapMode === 'custom' ? nonNegNum(sw.custom_price) : null };

  return {
    pricing_style: style,
    flat_rate: nonNegNum(cfg.flat_rate),
    tiers,
    weight_allowance_tons: nonNegNum(cfg.weight_allowance_tons),
    overage_rate_per_ton: nonNegNum(cfg.overage_rate_per_ton),
    day_rate,
    swap,
  };
}

// Parse the stored pricing_config JSON into an object for API responses.
function parsePriceRow(row) {
  if (!row) return row;
  let cfg = null;
  if (row.pricing_config) {
    try { cfg = JSON.parse(row.pricing_config); } catch { cfg = null; }
  }
  return { ...row, pricing_config: cfg };
}

function getPriceList(businessId) {
  return db.prepare(
    'SELECT * FROM price_list_items WHERE business_id = ? ORDER BY sort_order ASC, service_key ASC'
  ).all(businessId).map(parsePriceRow);
}

// Resolve the price row for a requested dumpster size via the ONE canonical size key
// shared with inventory ("20 yard" ↔ "20yd"). Available for Prompt B's computed
// booking; nothing wires it into booking/invoices/overage yet.
function getPriceRowForSize(businessId, size) {
  const key = normalizeSizeKey(size);
  if (!key) return null;
  return getPriceList(businessId).find((r) => normalizeSizeKey(r.service_key) === key) || null;
}

// ── Business-wide fees + special/restricted items ───────────────────────────────
function parseFeeRow(row) {
  if (!row) return row;
  let config = null;
  if (row.config) { try { config = JSON.parse(row.config); } catch { config = null; } }
  return { ...row, enabled: !!row.enabled, config };
}

function getPricingFees(businessId) {
  return db.prepare(
    'SELECT * FROM pricing_fees WHERE business_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(businessId).map(parseFeeRow);
}

function getSpecialItems(businessId) {
  return db.prepare(
    'SELECT * FROM special_items WHERE business_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(businessId);
}

function getDiscountGroups(businessId) {
  return db.prepare(
    'SELECT * FROM discount_groups WHERE business_id = ? ORDER BY name ASC'
  ).all(businessId);
}

function getCustomerPricing(businessId, customerId) {
  return db.prepare(
    'SELECT * FROM customer_pricing WHERE business_id = ? AND customer_id = ? ORDER BY service_key ASC'
  ).all(businessId, customerId);
}

// Compute the effective price for every service for one customer:
//   custom override  →  default minus the customer's group discount  →  default.
// Returns one row per service_key (union of the default list and any
// override-only keys), each tagged with where its price came from.
function resolveEffectivePricing(businessId, customer) {
  const defaults = getPriceList(businessId);
  const overrides = getCustomerPricing(businessId, customer.id);
  const overrideByKey = new Map(overrides.map((o) => [o.service_key, o]));

  const group = customer.discount_group_id
    ? db.prepare('SELECT * FROM discount_groups WHERE id = ? AND business_id = ?')
        .get(customer.discount_group_id, businessId)
    : null;
  const pct = group ? Number(group.discount_percent) || 0 : 0;

  const keys = new Set(defaults.map((d) => d.service_key));
  for (const o of overrides) keys.add(o.service_key);

  const items = [...keys].map((key) => {
    const def = defaults.find((d) => d.service_key === key) || null;
    const ovr = overrideByKey.get(key) || null;
    const base = def && def.unit_price != null ? Number(def.unit_price) : null;
    const groupPrice = base != null && pct ? round2(base * (1 - pct / 100)) : base;

    let effective, source;
    if (ovr && ovr.custom_price != null) {
      effective = round2(ovr.custom_price);
      source = 'custom';
    } else if (group && pct && base != null) {
      effective = groupPrice;
      source = 'group';
    } else {
      effective = base;
      source = 'default';
    }

    return {
      service_key: key,
      label: (ovr && ovr.label) || (def && def.label) || key,
      unit: (ovr && ovr.unit) || (def && def.unit) || null,
      default_price: base,
      custom_price: ovr && ovr.custom_price != null ? round2(ovr.custom_price) : null,
      effective_price: effective,
      source,
    };
  });

  items.sort((a, b) => String(a.label).localeCompare(String(b.label)));

  return {
    items,
    group: group || null,
    discount_percent: pct,
    contract_terms: customer.contract_terms || null,
  };
}

module.exports = {
  getPriceList,
  getPriceRowForSize,
  getDiscountGroups,
  getCustomerPricing,
  getPricingFees,
  getSpecialItems,
  resolveEffectivePricing,
  sanitizePricingConfig,
  round2,
};
