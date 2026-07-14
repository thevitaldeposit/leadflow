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
// ── The pricing resolver (single source of truth for computing money) ───────────
// Booking, invoicing, and weight-overage all share these so a business's configured
// pricing_config (tiered/flat, weight allowance, overage rate, day rate, swap) + its
// fees actually compute dollars. All pure math lives in computeBaseFromConfig (no I/O)
// so it is unit-testable without a DB; the DB-reading wrappers below join a size to
// its price row via the ONE canonical size key and layer per-customer pricing on top.

// Whole rental days, min 1 (a same-day/1-day rental still bills the smallest tier).
function normDays(days) {
  const d = Math.round(Number(days));
  return Number.isFinite(d) && d >= 1 ? d : 1;
}

// Pure: the LIST base rental price for a size's pricing_config over `days`.
//   • flat  → the flat rate (or the row's flat unit_price fallback), duration-independent.
//   • tiered→ round the duration UP to the nearest defined tier by day count
//             (1 day → smallest tier; > largest tier → largest tier + extra-day charges).
//   • extra days beyond the matched tier add (extra_days × day_rate.rate) ONLY when
//     day_rate.enabled; otherwise the tier price stands.
// Returns a breakdown; `priceable:false` when nothing yields a number (so callers can
// leave a manual price untouched rather than charging $0). No I/O — safe to unit test.
function computeBaseFromConfig(cfg, days, fallbackUnitPrice = null) {
  const d = normDays(days);
  const fb = fallbackUnitPrice != null && Number.isFinite(Number(fallbackUnitPrice)) ? round2(fallbackUnitPrice) : null;
  const style = cfg && (cfg.pricing_style === 'flat' || cfg.pricing_style === 'tiered') ? cfg.pricing_style : null;
  const blank = (s) => ({ priceable: false, style: s, listBase: null, tierLabel: null, tierDays: null, extraDays: 0, extraDayRate: null, extraDayCharge: 0 });

  // Flat, or no explicit style but a flat_rate / unit_price is available.
  if (style === 'flat' || !style) {
    const flat = cfg && cfg.flat_rate != null ? round2(cfg.flat_rate) : fb;
    if (flat == null) return blank(style || 'flat');
    // Surface the size's configured day rate for flat pricing too (mirrors the tiered
    // branch below) so an EXTENSION can be priced off a flat-priced size. The flat base
    // is duration-independent, so extraDays stays 0 and no extra-day charge is added to
    // the base here — extension pricing multiplies this rate by the requested extra days.
    const dr = cfg && cfg.day_rate && typeof cfg.day_rate === 'object' ? cfg.day_rate : {};
    const extraDayRate = dr.enabled && dr.rate != null ? round2(dr.rate) : null;
    return { priceable: true, style: style || 'flat', listBase: flat, tierLabel: null, tierDays: null, extraDays: 0, extraDayRate, extraDayCharge: 0 };
  }

  // Tiered — sort the usable tiers ascending by day count and round the duration up.
  const tiers = (Array.isArray(cfg.tiers) ? cfg.tiers : [])
    .filter((t) => t && t.days != null && t.rate != null)
    .map((t) => ({ label: t.label || null, days: Math.max(0, Math.round(Number(t.days))), rate: round2(t.rate) }))
    .sort((a, b) => a.days - b.days);
  if (!tiers.length) {
    const flat = cfg.flat_rate != null ? round2(cfg.flat_rate) : fb;   // tiered but unconfigured → flat fallback, never $0
    if (flat == null) return blank('tiered');
    return { priceable: true, style: 'tiered', listBase: flat, tierLabel: null, tierDays: null, extraDays: 0, extraDayRate: null, extraDayCharge: 0 };
  }

  let matched = tiers.find((t) => d <= t.days);
  let extraDays = 0;
  if (!matched) { matched = tiers[tiers.length - 1]; extraDays = d - matched.days; }   // beyond the largest tier

  const dr = cfg.day_rate && typeof cfg.day_rate === 'object' ? cfg.day_rate : {};
  const extraDayRate = dr.enabled && dr.rate != null ? round2(dr.rate) : null;
  const extraDayCharge = extraDays > 0 && extraDayRate != null ? round2(extraDays * extraDayRate) : 0;

  return { priceable: true, style: 'tiered', listBase: matched.rate, tierLabel: matched.label, tierDays: matched.days, extraDays, extraDayRate, extraDayCharge };
}

// The per-customer pricing layer for one size: a custom override for this size beats a
// group discount beats the plain list price (mirrors resolveEffectivePricing's order).
// customer_pricing.service_key isn't force-canonicalized, so match by the canonical
// size key too, not just an exact string.
function resolveSizeDiscount(businessId, customer, serviceKey) {
  const out = { percent: 0, customPrice: null, source: 'list' };
  if (!customer || !serviceKey) return out;
  const wantKey = normalizeSizeKey(serviceKey) || serviceKey;
  try {
    const rows = getCustomerPricing(businessId, customer.id);
    const ovr = rows.find((r) => r.service_key === serviceKey || normalizeSizeKey(r.service_key) === wantKey);
    if (ovr && ovr.custom_price != null) { out.customPrice = round2(ovr.custom_price); out.source = 'custom'; return out; }
  } catch { /* customer_pricing absent — no override */ }
  if (customer.discount_group_id) {
    try {
      const g = db.prepare('SELECT discount_percent FROM discount_groups WHERE id = ? AND business_id = ?')
        .get(customer.discount_group_id, businessId);
      if (g && Number(g.discount_percent) > 0) { out.percent = Number(g.discount_percent); out.source = 'group'; }
    } catch { /* group missing — no discount */ }
  }
  return out;
}

// Resolve the price for a booked/quoted size over a rental duration, with the full
// breakdown (list base, extra-day charge, applied discount, total). `customer` is
// optional — pass it so a discount-group / override customer gets their rate.
function resolvePrice(businessId, { size, days = 1, customer = null } = {}) {
  const row = getPriceRowForSize(businessId, size);
  const cfg = row ? row.pricing_config : null;
  const fallbackUnit = row && row.unit_price != null ? Number(row.unit_price) : null;
  const serviceKey = row ? row.service_key : (normalizeSizeKey(size) || null);

  const b = computeBaseFromConfig(cfg, days, fallbackUnit);
  const disc = resolveSizeDiscount(businessId, customer, serviceKey);

  let base = b.listBase;
  let appliedDiscount = 0;
  let source = 'list';
  if (b.priceable) {
    if (disc.customPrice != null) {
      base = disc.customPrice; source = 'custom';
    } else if (disc.percent) {
      base = round2(b.listBase * (1 - disc.percent / 100));
      appliedDiscount = round2(b.listBase - base);
      source = 'group';
    }
  }
  const total = b.priceable ? round2((base || 0) + b.extraDayCharge) : null;

  return {
    size: size || null,
    size_key: serviceKey,
    days: normDays(days),
    priceable: b.priceable,
    style: b.style,
    tier_label: b.tierLabel,
    tier_days: b.tierDays,
    list_base: b.listBase,
    base,
    extra_days: b.extraDays,
    extra_day_rate: b.extraDayRate,
    extra_day_charge: b.extraDayCharge,
    discount_percent: disc.percent || 0,
    applied_discount: appliedDiscount,
    discount_source: source,
    total,
  };
}

// The per-size weight allowance + overage rate off the price row's pricing_config —
// what the weight/overage flow bills against (replacing the old always-null settings).
function getSizeWeightConfig(businessId, size) {
  const row = getPriceRowForSize(businessId, size);
  const cfg = row ? row.pricing_config : null;
  return {
    allowanceTons: cfg && cfg.weight_allowance_tons != null ? Number(cfg.weight_allowance_tons) : null,
    ratePerTon: cfg && cfg.overage_rate_per_ton != null ? Number(cfg.overage_rate_per_ton) : null,
  };
}

// The size's swap pricing for a replacement unit dropped over the swap window (days).
// same_as_rate → the normal tier/flat resolver for that window; custom → the custom
// price; off → no separate swap charge (null). Honors per-customer discounting for the
// same_as_rate path. Returns { amount, mode } or null when there's nothing to charge.
function resolveSwapPrice(businessId, { size, days = 1, customer = null } = {}) {
  const row = getPriceRowForSize(businessId, size);
  const cfg = row ? row.pricing_config : null;
  const swap = cfg && cfg.swap && typeof cfg.swap === 'object' ? cfg.swap : { mode: 'same_as_rate', custom_price: null };
  const mode = ['same_as_rate', 'custom', 'off'].includes(swap.mode) ? swap.mode : 'same_as_rate';
  if (mode === 'off') return { amount: null, mode };
  if (mode === 'custom') {
    return { amount: swap.custom_price != null ? round2(swap.custom_price) : null, mode };
  }
  const q = resolvePrice(businessId, { size, days, customer });   // same_as_rate → normal resolver over the swap window
  return { amount: q.priceable ? q.total : null, mode, breakdown: q };
}

// Price a rental EXTENSION — keeping the unit ADDITIONAL days — as (extraDays × the size's
// configured day rate). The day rate is read via computeBaseFromConfig, now wired for BOTH
// flat and tiered sizes, so any size that carries a day_rate can be priced. The per-customer
// discount is deliberately NOT applied here: extra days bill at the FULL day rate (the owner
// can adjust the amount in the review step). Returns { needsRate:false, amount, dayRate,
// extraDays, size, size_key } when priceable, or { needsRate:true, amount:null, ... } when
// the size has no day_rate configured — a DELIBERATE block (do NOT invent a price), mirroring
// how the weight-overage path surfaces a "needs rate" prompt instead of charging a wrong number.
function resolveExtensionPrice(businessId, { size, extraDays = 1 } = {}) {
  const row = getPriceRowForSize(businessId, size);
  const cfg = row ? row.pricing_config : null;
  const fallbackUnit = row && row.unit_price != null ? Number(row.unit_price) : null;
  const serviceKey = row ? row.service_key : (normalizeSizeKey(size) || null);
  const n = Math.max(1, Math.round(Number(extraDays)) || 1);
  const dayRate = computeBaseFromConfig(cfg, 1, fallbackUnit).extraDayRate;   // reads day_rate for flat + tiered
  if (dayRate == null || dayRate <= 0) {
    return { needsRate: true, amount: null, dayRate: null, extraDays: n, size: size || null, size_key: serviceKey };
  }
  return { needsRate: false, amount: round2(n * dayRate), dayRate, extraDays: n, size: size || null, size_key: serviceKey };
}

// The single enabled flat DELIVERY fee (or null). Mileage/out-of-area fees are
// deliberately excluded — distance math isn't built, so they never enter computation.
function getDeliveryFee(businessId) {
  try {
    const f = getPricingFees(businessId).find(
      (x) => x.enabled && x.fee_type === 'delivery' && x.amount != null && Number(x.amount) > 0
    );
    return f ? { label: f.label || 'Delivery Fee', amount: round2(f.amount), fee_type: 'delivery' } : null;
  } catch { return null; }
}

// Enabled surcharge special items (kind='surcharge' with a charge), as add-able
// invoice-line presets. Prohibited items carry no charge and are omitted here.
function getSurchargeItems(businessId) {
  try {
    return getSpecialItems(businessId)
      .filter((s) => s.kind === 'surcharge' && s.charge_amount != null && Number(s.charge_amount) > 0)
      .map((s) => ({ id: s.id, name: s.name, charge_amount: round2(s.charge_amount) }));
  } catch { return []; }
}

// Rental duration (whole days) for a lead: prefer the delivery→pickup span, else the
// stored rentalDuration text ("7 days"), else 1. Shared by booking + invoice prefill.
function rentalDaysFromLead(lead) {
  let vd = {};
  try { vd = lead && lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  const dd = lead && (lead.delivery_date || vd.deliveryDate || vd.deliveryDateISO);
  const pd = lead && (lead.pickup_date || vd.pickupDate);
  if (dd && pd) {
    const a = new Date(`${String(dd).slice(0, 10)}T00:00:00Z`);
    const b = new Date(`${String(pd).slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
      const days = Math.round((b.getTime() - a.getTime()) / 86400000);
      if (days >= 1) return days;
    }
  }
  if (vd.rentalDuration) { const m = String(vd.rentalDuration).match(/\d+/); if (m) return Math.max(1, parseInt(m[0], 10)); }
  return 1;
}

function sizeFromLead(lead) {
  let vd = {};
  try { vd = lead && lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  return vd.dumpsterSize || null;
}

// The suggested booking amount (base rental for the size+duration, + an enabled flat
// delivery fee), used to PREFILL an editable price on manual booking and auto-book.
// Returns null when the size isn't priceable, so callers keep the owner's/model's
// number instead of overwriting it with $0.
function suggestedBookingRevenue(businessId, lead, customer = null) {
  const size = sizeFromLead(lead);
  if (!size) return null;
  const q = resolvePrice(businessId, { size, days: rentalDaysFromLead(lead), customer });
  if (!q.priceable || q.total == null) return null;
  const delivery = getDeliveryFee(businessId);
  return round2(q.total + (delivery ? delivery.amount : 0));
}

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
  // Pricing resolver (shared by booking, invoicing, overage, swaps).
  computeBaseFromConfig,
  resolveSizeDiscount,
  resolvePrice,
  getSizeWeightConfig,
  resolveSwapPrice,
  resolveExtensionPrice,
  getDeliveryFee,
  getSurchargeItems,
  rentalDaysFromLead,
  sizeFromLead,
  suggestedBookingRevenue,
};
