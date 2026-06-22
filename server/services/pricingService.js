const db = require('../db/database');

// ── Per-client pricing ────────────────────────────────────────────────────────
// Three layers, all business_id-scoped:
//   price_list_items  — the business's default/retail price list (the fallback).
//   discount_groups   — named contractor/commercial groups with a percent off.
//   customer_pricing  — per-customer rate overrides that beat everything.
// resolveEffectivePricing() merges them for one customer so quotes/invoices (not
// built here) can later read a single effective number per service.

function round2(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(Number(n) * 100) / 100;
}

function getPriceList(businessId) {
  return db.prepare(
    'SELECT * FROM price_list_items WHERE business_id = ? ORDER BY sort_order ASC, service_key ASC'
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
  getDiscountGroups,
  getCustomerPricing,
  resolveEffectivePricing,
  round2,
};
