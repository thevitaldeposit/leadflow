const crypto = require('crypto');
const db = require('../db/database');
const {
  resolveEffectivePricing, resolvePrice, rentalDaysFromLead, sizeFromLead,
  getDeliveryFee, getSurchargeItems, getSizeWeightConfig,
} = require('./pricingService');
const { normalizeSizeKey } = require('./sizeKey');
const { displayNameOf } = require('./customerService');
const { GENERIC_TERMS, businessTypeKey, resolveDefaultContract } = require('./contractTemplates');

// ── Invoices ──────────────────────────────────────────────────────────────────
// Generic invoice + contract + e-signature layer over customers/leads. Everything
// here is business_id-scoped. Line items are generic (description/qty/unit/rate);
// vertical-specific concepts live only in line_type + description, never schema.
// Default rates are read from the per-client pricing layer at draft time and
// copied onto the invoice so an issued invoice is a fixed snapshot.

// The business-agnostic fallback terms block, used when an invoice has no
// customized terms and the business type has no dedicated contract. The richer,
// business-type-specific default contract (e.g. the full dumpster-rental
// agreement) is resolved at display/sign time in getEffectiveContractText, keyed
// off the business's type — see services/contractTemplates.js. Businesses can
// still override per-invoice (the editor's terms field) or set a business default
// (invoiceTerms), both of which take precedence over the type contract.
const DEFAULT_TERMS = GENERIC_TERMS;

const DEFAULTS = { dueDays: 14, taxRate: 0, prefix: 'INV-', startNumber: 1001 };

// Statuses an invoice moves through. 'paid' is reachable today only via a manual
// record-keeping action — online payment collection is a separate, later task.
const INVOICE_STATUSES = ['draft', 'sent', 'signed', 'paid', 'void'];
// Once signed or paid the invoice is locked: it's now dispute evidence, so its
// terms and line items must not change out from under the captured signature.
const LOCKED_STATUSES = new Set(['signed', 'paid']);

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
function num(v, fallback = 0) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function nowIso() {
  return new Date().toISOString();
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
// Add whole days to a YYYY-MM-DD string in UTC so the date never drifts by a zone.
function addDays(dateStr, days) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.round(days || 0));
  return d.toISOString().slice(0, 10);
}

// ── Per-business settings helpers (reuse the settings table) ──────────────────
function readSetting(businessId, key) {
  const row = db
    .prepare('SELECT value FROM settings WHERE business_id = ? AND key = ?')
    .get(businessId, key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function writeSetting(businessId, key, value) {
  db.prepare(
    'INSERT OR REPLACE INTO settings (key, value, updated_at, business_id) VALUES (?, ?, ?, ?)'
  ).run(key, JSON.stringify(value), nowIso(), businessId);
}

// The business's invoice defaults (terms template, due window, tax, numbering).
function getDefaults(businessId) {
  const terms = readSetting(businessId, 'invoiceTerms');
  const dueDays = readSetting(businessId, 'invoiceDueDays');
  const taxRate = readSetting(businessId, 'invoiceTaxRate');
  const prefix = readSetting(businessId, 'invoicePrefix');
  const nextNumber = readSetting(businessId, 'invoiceNextNumber');
  return {
    terms: terms != null && terms !== '' ? terms : DEFAULT_TERMS,
    dueDays: num(dueDays, DEFAULTS.dueDays),
    taxRate: num(taxRate, DEFAULTS.taxRate),
    prefix: prefix != null ? String(prefix) : DEFAULTS.prefix,
    nextNumber: num(nextNumber, DEFAULTS.startNumber) || DEFAULTS.startNumber,
  };
}

function setDefaults(businessId, body = {}) {
  if (body.terms !== undefined) writeSetting(businessId, 'invoiceTerms', String(body.terms || ''));
  if (body.dueDays !== undefined) writeSetting(businessId, 'invoiceDueDays', Math.max(0, Math.round(num(body.dueDays, DEFAULTS.dueDays))));
  if (body.taxRate !== undefined) {
    const t = num(body.taxRate, 0);
    writeSetting(businessId, 'invoiceTaxRate', Math.min(100, Math.max(0, t)));
  }
  if (body.prefix !== undefined) writeSetting(businessId, 'invoicePrefix', String(body.prefix || ''));
  if (body.nextNumber !== undefined) {
    const n = Math.max(1, Math.round(num(body.nextNumber, DEFAULTS.startNumber)));
    writeSetting(businessId, 'invoiceNextNumber', n);
  }
  return getDefaults(businessId);
}

// Read the next invoice number without consuming it (for prefill previews).
function peekNumber(businessId) {
  const { prefix, nextNumber } = getDefaults(businessId);
  return `${prefix}${nextNumber}`;
}
// Allocate the next invoice number and advance the per-business counter.
function consumeNumber(businessId) {
  const { prefix, nextNumber } = getDefaults(businessId);
  writeSetting(businessId, 'invoiceNextNumber', nextNumber + 1);
  return `${prefix}${nextNumber}`;
}

// A URL-safe, unguessable token for the public link. Loops on the (vanishingly
// unlikely) chance of a collision so the UNIQUE index never throws.
function generateToken() {
  for (let i = 0; i < 5; i++) {
    const t = crypto.randomBytes(24).toString('hex');
    const hit = db.prepare('SELECT 1 FROM invoices WHERE public_token = ?').get(t);
    if (!hit) return t;
  }
  return crypto.randomBytes(32).toString('hex');
}

// ── Line items ────────────────────────────────────────────────────────────────
// Normalize an arbitrary client-supplied line into the stored shape, computing
// amount server-side (qty × rate) so the client can never set a bogus amount.
// Returns null for a fully blank row so empty editor lines are dropped.
function normalizeLineItem(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const description = String(raw.description ?? '').trim();
  const quantity = num(raw.quantity, 1);
  const unitRate = num(raw.unit_rate ?? raw.unitRate, 0);
  const amount = round2(quantity * unitRate);
  // Drop blank rows (no description and nothing billed).
  if (!description && amount === 0) return null;
  return {
    description: description || 'Item',
    service_key: (raw.service_key ?? raw.serviceKey) ? String(raw.service_key ?? raw.serviceKey) : null,
    line_type: String(raw.line_type ?? raw.lineType ?? 'service') || 'service',
    quantity,
    unit: raw.unit ? String(raw.unit) : null,
    unit_rate: round2(unitRate),
    amount,
    sort_order: Number.isFinite(Number(raw.sort_order ?? raw.sortOrder)) ? Number(raw.sort_order ?? raw.sortOrder) : index,
  };
}

function normalizeLineItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((r, i) => normalizeLineItem(r, i)).filter(Boolean);
}

// Totals are always recomputed from the stored line items + tax rate, never
// trusted from the client. Subtotal sums every line (discounts are negative
// lines); tax applies to the subtotal.
function computeTotals(items, taxRate) {
  const subtotal = round2(items.reduce((s, it) => s + num(it.amount, 0), 0));
  const rate = num(taxRate, 0);
  const taxAmount = round2(subtotal * (rate / 100));
  const total = round2(subtotal + taxAmount);
  return { subtotal, taxAmount, total };
}

function getLineItems(invoiceId) {
  return db
    .prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order ASC, id ASC')
    .all(invoiceId);
}

// Replace every line item on an invoice in one shot (the editor saves the whole
// table at once). Caller is responsible for recomputing + persisting totals.
function replaceLineItems(invoiceId, businessId, items) {
  db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?').run(invoiceId);
  const insert = db.prepare(`
    INSERT INTO invoice_line_items
      (invoice_id, business_id, description, service_key, line_type, quantity, unit, unit_rate, amount, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const at = nowIso();
  items.forEach((it, i) => {
    insert.run(
      invoiceId, businessId, it.description, it.service_key, it.line_type,
      it.quantity, it.unit, it.unit_rate, it.amount, it.sort_order ?? i, at
    );
  });
}

function persistTotals(invoiceId, totals, taxRate) {
  db.prepare(
    'UPDATE invoices SET subtotal = ?, tax_rate = ?, tax_amount = ?, total = ?, updated_at = ? WHERE id = ?'
  ).run(totals.subtotal, num(taxRate, 0), totals.taxAmount, totals.total, nowIso(), invoiceId);
}

// ── Line-item display formatting (title + detail) ───────────────────────────────
// Computed line items (weight overage, swap replacement) are stored with a compact,
// machine-built description. For DISPLAY we present a clean TITLE (size first) plus a
// plain-language DETAIL line, modeled on a standard invoice line. This is PURELY
// cosmetic: it never changes quantity/unit_rate/amount — only how the description
// reads. It parses our OWN generated format and falls back to the raw description if
// the text doesn't match (e.g. an owner-edited line), so nothing is ever mangled.
function prettySize(s) {
  const str = String(s || '').trim();
  const m = str.match(/^(\d+)\s*(?:yd|yard|yards|cubic\s*yards?|cy)\b/i);
  if (m) return `${m[1]} Yard`;
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function describeLineItem(item) {
  const desc = String((item && item.description) || '').trim();
  const type = item && item.line_type;

  // Weight overage: "Weight overage — 1.5 ton(s) over 1 included (20 yard)".
  //   → title "20 Yard – Weight Overage", detail "1.5 tons over 1 ton weight allowance."
  if (type === 'overage' && /weight overage/i.test(desc)) {
    const allowanceM = desc.match(/over\s+([\d.]+)\s+included/i);
    if (allowanceM) {
      const sizeM = desc.match(/\(([^)]+)\)\s*$/);
      const size = sizeM ? prettySize(sizeM[1]) : null;
      const overTons = item.quantity != null ? item.quantity : null;
      return {
        title: size ? `${size} – Weight Overage` : 'Weight Overage',
        detail: overTons != null ? `${overTons} tons over ${allowanceM[1]} ton weight allowance.` : null,
      };
    }
  }

  // Swap replacement: "Swap replacement — 20 yard (6 days)".
  //   → title "20 Yard – Swap Replacement", detail "6 day replacement rental."
  if (/^swap replacement/i.test(desc)) {
    const sizeM = desc.match(/—\s*(.+?)\s*\(/);
    const daysM = desc.match(/\((\d+)\s*days?\)/i);
    const size = sizeM ? prettySize(sizeM[1].trim()) : null;
    return {
      title: size ? `${size} – Swap Replacement` : 'Swap Replacement',
      detail: daysM ? `${daysM[1]} day replacement rental.` : null,
    };
  }

  // Everything else reads fine already — show it as the title, no secondary line.
  return { title: desc, detail: null };
}

// Attach title/detail to each line item for display, preserving all stored fields.
function withDisplay(items) {
  return (items || []).map((it) => ({ ...it, ...describeLineItem(it) }));
}

// ── Reads ─────────────────────────────────────────────────────────────────────
function getCustomerRow(businessId, customerId) {
  if (!customerId) return null;
  return db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(customerId, businessId);
}

// Full invoice (with line items) scoped to a business, or null.
function getInvoice(businessId, id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!inv) return null;
  inv.line_items = withDisplay(getLineItems(inv.id));
  return inv;
}

// Lightweight list rows for the owner's invoices table.
function listInvoices(businessId, { customer_id, lead_id, status } = {}) {
  let sql = `
    SELECT i.id, i.invoice_number, i.status, i.currency, i.total, i.amount_paid,
           i.issue_date, i.due_date, i.customer_id, i.lead_id, i.bill_to_name,
           i.sent_at, i.viewed_at, i.signed_at, i.paid_at, i.created_at,
           c.display_name AS customer_display_name
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.business_id = ?
      -- Don't surface a binned (soft-deleted) customer's invoices. Customer-less
      -- invoices (customer_id NULL) and active-customer invoices still show; the
      -- underlying Stripe/payment record is never altered — it's just not listed here.
      AND (i.customer_id IS NULL OR c.deleted_at IS NULL)
  `;
  const params = [businessId];
  if (customer_id) { sql += ' AND i.customer_id = ?'; params.push(customer_id); }
  if (lead_id) { sql += ' AND i.lead_id = ?'; params.push(lead_id); }
  if (status && INVOICE_STATUSES.includes(status)) { sql += ' AND i.status = ?'; params.push(status); }
  sql += ' ORDER BY i.created_at DESC, i.id DESC';
  return db.prepare(sql).all(...params);
}

// Best-effort revenue guess off a lead, mirroring customerService.leadRevenue.
function leadRevenueGuess(lead, vd) {
  if (lead && typeof lead.estimated_revenue === 'number' && !Number.isNaN(lead.estimated_revenue)) {
    return lead.estimated_revenue;
  }
  if (vd && typeof vd.estimatedRevenue === 'number') return vd.estimatedRevenue;
  if (vd && vd.quotedPrice) {
    const nums = String(vd.quotedPrice).match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length === 1) return Number(nums[0]);
    if (nums && nums.length >= 2) return (Number(nums[0]) + Number(nums[1])) / 2;
  }
  return 0;
}

// Suggest starter line items for a job. For a dumpster job (a linked lead naming a
// size) the base rental is priced by the CONFIGURED pricing model (tier/flat for the
// rental duration, with the customer's discount/override applied), extra days beyond
// the matched tier become their own line, and an enabled flat delivery fee is added —
// so the invoice reflects real computed charges, not a guessed number. Falls back to a
// single line from the quoted price / estimated revenue for a non-priceable size or a
// non-dumpster vertical, so every vertical still gets a sensible prefill.
function suggestItemsFromLead(businessId, lead, customer, pricingItems) {
  if (!lead) return [];
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }

  const size = sizeFromLead(lead);
  if (size) {
    const q = resolvePrice(businessId, { size, days: rentalDaysFromLead(lead), customer });
    if (q.priceable && q.base != null) {
      const items = [{
        description: `${size} Dumpster Rental${q.tier_label ? ` — ${q.tier_label}` : ''}${q.discount_source === 'group' && q.discount_percent ? ` (${q.discount_percent}% off)` : ''}`,
        service_key: q.size_key,
        line_type: 'service',
        quantity: 1,
        unit: null,
        unit_rate: q.base,
      }];
      if (q.extra_days > 0 && q.extra_day_charge > 0) {
        items.push({
          description: `Extra rental days (${q.extra_days} × $${q.extra_day_rate})`,
          service_key: null,
          line_type: 'service',
          quantity: q.extra_days,
          unit: 'day',
          unit_rate: q.extra_day_rate,
        });
      }
      const delivery = getDeliveryFee(businessId);
      if (delivery) {
        items.push({ description: delivery.label, service_key: null, line_type: 'fee', quantity: 1, unit: null, unit_rate: delivery.amount });
      }
      return items;
    }
    // Size not priceable via config — fall back to the quoted/estimated number.
    return [{
      description: `${size} Dumpster Rental`,
      service_key: q.size_key || null,
      line_type: 'service',
      quantity: 1,
      unit: null,
      unit_rate: leadRevenueGuess(lead, vd),
    }];
  }

  const rev = leadRevenueGuess(lead, vd);
  if (rev) {
    const label = vd.serviceType || vd.equipmentType || 'Service';
    return [{ description: label, service_key: null, line_type: 'service', quantity: 1, unit: null, unit_rate: rev }];
  }
  return [];
}

// Everything the "New Invoice" form needs prefilled from the customer + pricing
// layer (+ an optional job). Does NOT consume an invoice number.
function prefill(businessId, customerId, leadId) {
  const customer = getCustomerRow(businessId, customerId);
  if (!customer) return null;
  const defaults = getDefaults(businessId);
  const pricing = resolveEffectivePricing(businessId, customer);

  let lead = null;
  if (leadId) {
    lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(leadId, businessId);
  }

  // Add-able presets beyond the size rate list: an enabled flat delivery fee and any
  // surcharge special items (mattress, etc.). Mileage is intentionally excluded (no
  // distance math), so it never appears as an add-able fee.
  const delivery = getDeliveryFee(businessId);
  const availableFees = delivery
    ? [{ label: delivery.label, amount: delivery.amount, line_type: 'fee', fee_type: 'delivery' }]
    : [];
  const availableSpecialItems = getSurchargeItems(businessId)
    .map((s) => ({ name: s.name, amount: s.charge_amount, line_type: 'fee' }));

  const issue = today();
  return {
    customer_id: customer.id,
    lead_id: lead ? lead.id : null,
    invoice_number: peekNumber(businessId),
    issue_date: issue,
    due_date: addDays(issue, defaults.dueDays),
    currency: 'USD',
    tax_rate: defaults.taxRate,
    terms: (customer.contract_terms && customer.contract_terms.trim()) || defaults.terms,
    bill_to_name: displayNameOf(customer),
    bill_to_email: customer.email || '',
    bill_to_phone: customer.phone || '',
    bill_to_address: customer.address || '',
    suggested_items: suggestItemsFromLead(businessId, lead, customer, pricing.items || []),
    available_rates: pricing.items || [],
    available_fees: availableFees,
    available_special_items: availableSpecialItems,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────
function createInvoice(businessId, body = {}) {
  const customer = getCustomerRow(businessId, body.customer_id ?? body.customerId);
  if (!customer) {
    const e = new Error('A valid customer is required');
    e.status = 400;
    throw e;
  }
  const defaults = getDefaults(businessId);

  let leadId = body.lead_id ?? body.leadId ?? null;
  if (leadId) {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND business_id = ?').get(leadId, businessId);
    if (!lead) leadId = null; // ignore a job that isn't ours
  }

  const issue = body.issue_date || today();
  const dueDate = body.due_date !== undefined ? (body.due_date || null) : addDays(issue, defaults.dueDays);
  const invoiceNumber = (body.invoice_number && String(body.invoice_number).trim()) || consumeNumber(businessId);
  const taxRate = body.tax_rate !== undefined ? num(body.tax_rate, defaults.taxRate) : defaults.taxRate;
  // Per-invoice contract text was removed from the editor. The contract a customer
  // reads + signs is resolved by business type at display/sign time
  // (getEffectiveContractText), so we no longer seed the per-invoice `terms` column
  // from the customer/business default — leaving it null lets the type-based
  // contract be the sole source. The column is kept (no migration) and an explicit
  // `body.terms` is still honored as the future "build your contract" seam.
  const terms = body.terms !== undefined ? String(body.terms || '') : null;

  const items = normalizeLineItems(body.line_items ?? body.lineItems ?? body.items);
  const totals = computeTotals(items, taxRate);
  const token = generateToken();
  const at = nowIso();

  const info = db.prepare(`
    INSERT INTO invoices (
      business_id, customer_id, lead_id, invoice_number, status, public_token,
      issue_date, due_date, currency, subtotal, tax_rate, tax_amount, total,
      notes, terms, bill_to_name, bill_to_email, bill_to_phone, bill_to_address,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    businessId, customer.id, leadId, invoiceNumber, token,
    issue, dueDate, body.currency || 'USD',
    totals.subtotal, taxRate, totals.taxAmount, totals.total,
    body.notes ? String(body.notes) : null, terms,
    body.bill_to_name !== undefined ? body.bill_to_name : displayNameOf(customer),
    body.bill_to_email !== undefined ? body.bill_to_email : (customer.email || null),
    body.bill_to_phone !== undefined ? body.bill_to_phone : (customer.phone || null),
    body.bill_to_address !== undefined ? body.bill_to_address : (customer.address || null),
    at, at
  );

  const invoiceId = Number(info.lastInsertRowid);
  if (items.length) replaceLineItems(invoiceId, businessId, items);
  return getInvoice(businessId, invoiceId);
}

function updateInvoice(businessId, id, body = {}) {
  const existing = db.prepare('SELECT * FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!existing) return { error: 'not_found' };
  if (LOCKED_STATUSES.has(existing.status)) return { error: 'locked' };

  const updates = {};
  const setField = (col, val) => { updates[col] = val === '' ? null : val; };
  if (body.issue_date !== undefined) setField('issue_date', body.issue_date);
  if (body.due_date !== undefined) setField('due_date', body.due_date);
  if (body.currency !== undefined) updates.currency = body.currency || 'USD';
  if (body.notes !== undefined) setField('notes', body.notes);
  if (body.terms !== undefined) updates.terms = String(body.terms || '');
  if (body.invoice_number !== undefined && String(body.invoice_number).trim()) updates.invoice_number = String(body.invoice_number).trim();
  if (body.bill_to_name !== undefined) setField('bill_to_name', body.bill_to_name);
  if (body.bill_to_email !== undefined) setField('bill_to_email', body.bill_to_email);
  if (body.bill_to_phone !== undefined) setField('bill_to_phone', body.bill_to_phone);
  if (body.bill_to_address !== undefined) setField('bill_to_address', body.bill_to_address);
  if (body.lead_id !== undefined) {
    let leadId = body.lead_id || null;
    if (leadId) {
      const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND business_id = ?').get(leadId, businessId);
      leadId = lead ? lead.id : null;
    }
    updates.lead_id = leadId;
  }
  if (body.status !== undefined && INVOICE_STATUSES.includes(body.status) && !LOCKED_STATUSES.has(body.status)) {
    updates.status = body.status;
  }

  const taxRate = body.tax_rate !== undefined ? num(body.tax_rate, existing.tax_rate) : existing.tax_rate;
  const replacingItems = body.line_items !== undefined || body.lineItems !== undefined || body.items !== undefined;

  if (Object.keys(updates).length) {
    updates.updated_at = nowIso();
    const set = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE invoices SET ${set} WHERE id = ? AND business_id = ?`)
      .run(...Object.values(updates), id, businessId);
  }

  if (replacingItems) {
    const items = normalizeLineItems(body.line_items ?? body.lineItems ?? body.items);
    replaceLineItems(id, businessId, items);
    persistTotals(id, computeTotals(items, taxRate), taxRate);
  } else if (body.tax_rate !== undefined) {
    // Tax changed but items didn't — recompute from the stored lines.
    const items = getLineItems(id);
    persistTotals(id, computeTotals(items, taxRate), taxRate);
  }

  return { invoice: getInvoice(businessId, id) };
}

function deleteInvoice(businessId, id) {
  const existing = db.prepare('SELECT status FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!existing) return { error: 'not_found' };
  // A signed/paid invoice is dispute evidence — never silently destroy it.
  if (LOCKED_STATUSES.has(existing.status)) return { error: 'locked' };
  db.prepare('DELETE FROM invoices WHERE id = ? AND business_id = ?').run(id, businessId);
  return { ok: true };
}

// Flip a draft invoice to 'sent' and stamp sent_at. Re-sending an already-sent or
// signed invoice keeps its status (never downgrades) but refreshes sent_at.
function markSent(businessId, id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!inv) return null;
  const at = nowIso();
  const status = inv.status === 'draft' ? 'sent' : inv.status;
  db.prepare('UPDATE invoices SET status = ?, sent_at = ?, updated_at = ? WHERE id = ?').run(status, at, at, id);
  return getInvoice(businessId, id);
}

// Record a manual payment. Online payment collection is a SEPARATE later task —
// this is owner-side bookkeeping only (the placeholder integration point).
function markPaid(businessId, id, body = {}) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!inv) return { error: 'not_found' };
  const at = nowIso();
  db.prepare(`
    UPDATE invoices
    SET status = 'paid', paid_at = ?, amount_paid = ?, payment_method = ?, payment_reference = ?, updated_at = ?
    WHERE id = ?
  `).run(at, inv.total, String(body.method || 'manual'), body.reference ? String(body.reference) : null, at, id);
  return { invoice: getInvoice(businessId, id) };
}

// ── Online payment (Stripe Connect direct charge) ───────────────────────────────
// These are the real integration points behind the public Pay action. Card data
// never reaches us — Stripe Elements collects it and the charge lands on the
// business's connected account (see services/connectService.js). We only correlate
// the PaymentIntent to the invoice and flip it to paid when payment succeeds.

// Remember which PaymentIntent is collecting this invoice, so the Connect webhook
// (and the confirm fallback) can find this exact invoice from the intent.
function attachPaymentIntent(businessId, id, paymentIntentId) {
  db.prepare('UPDATE invoices SET stripe_payment_intent_id = ?, updated_at = ? WHERE id = ? AND business_id = ?')
    .run(paymentIntentId, nowIso(), id, businessId);
}

// Look an invoice up by its PaymentIntent id within a tenant (defense-in-depth:
// the webhook already resolves the tenant from the connected account id).
function findByPaymentIntent(businessId, paymentIntentId) {
  if (!paymentIntentId) return null;
  return db.prepare('SELECT * FROM invoices WHERE stripe_payment_intent_id = ? AND business_id = ?')
    .get(paymentIntentId, businessId);
}

// Map a business's invoices by the Stripe PaymentIntent that collected them, so the
// owner-facing Payments view can link each Stripe charge back to its invoice +
// customer in one query instead of a Stripe round-trip per row. Keyed by PI id.
function getInvoiceRefsByPaymentIntent(businessId) {
  const rows = db.prepare(`
    SELECT i.id, i.invoice_number, i.stripe_payment_intent_id, i.bill_to_name,
           i.total, i.currency, i.customer_id, c.display_name AS customer_display_name
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.business_id = ? AND i.stripe_payment_intent_id IS NOT NULL
      -- Drop refs for a binned customer's invoices so the Payments view stops
      -- surfacing the binned customer's name/invoice link. The Stripe charge itself
      -- is untouched and still lists — it just falls back to Stripe's billing name.
      AND (i.customer_id IS NULL OR c.deleted_at IS NULL)
  `).all(businessId);
  const map = {};
  for (const r of rows) map[r.stripe_payment_intent_id] = r;
  return map;
}

// Flip an invoice to paid from a successful online payment. IDEMPOTENT — both the
// webhook and the client-side confirm fallback can call this; whichever lands
// first wins and the second is a no-op. Returns { invoice, alreadyPaid }.
function recordOnlinePayment(businessId, id, { amountPaid, reference, paymentIntentId } = {}) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!inv) return { error: 'not_found' };
  if (inv.status === 'paid' || inv.paid_at) {
    return { invoice: getInvoice(businessId, id), alreadyPaid: true };
  }
  const at = nowIso();
  const paid = amountPaid != null ? round2(amountPaid) : inv.total;
  db.prepare(`
    UPDATE invoices
    SET status = 'paid', paid_at = ?, amount_paid = ?, payment_method = 'stripe',
        payment_reference = ?,
        stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
        updated_at = ?
    WHERE id = ?
  `).run(at, paid, reference ? String(reference) : (paymentIntentId || null), paymentIntentId || null, at, id);
  return { invoice: getInvoice(businessId, id), alreadyPaid: false };
}

// Reflect a refund the business issued on its connected account (via the
// charge.refunded webhook). We don't move money — the connected account does — we
// only record the refunded amount so the invoice stops reading as simply "paid".
// `amountRefunded` is the CUMULATIVE refunded total (cents → dollars done by the
// caller). Idempotent: only advances when the refunded total grows.
function recordRefund(businessId, id, { amountRefunded } = {}) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!inv) return { error: 'not_found' };
  const amt = round2(amountRefunded != null ? amountRefunded : (inv.amount_paid || inv.total));
  if ((inv.amount_refunded || 0) >= amt && inv.refunded_at) {
    return { invoice: getInvoice(businessId, id), changed: false };
  }
  const at = nowIso();
  db.prepare(
    'UPDATE invoices SET amount_refunded = ?, refunded_at = COALESCE(refunded_at, ?), updated_at = ? WHERE id = ?'
  ).run(amt, at, at, id);
  const fullyRefunded = amt >= round2(inv.amount_paid || inv.total);
  return { invoice: getInvoice(businessId, id), changed: true, fullyRefunded };
}

// ── Public (tokenized, no auth) ────────────────────────────────────────────────
function getInvoiceByToken(token) {
  if (!token) return null;
  const inv = db.prepare('SELECT * FROM invoices WHERE public_token = ?').get(token);
  if (!inv) return null;
  inv.line_items = getLineItems(inv.id);
  return inv;
}

// Stamp first-view time for the owner's visibility. Never changes status.
function recordView(token) {
  const inv = db.prepare('SELECT id, viewed_at FROM invoices WHERE public_token = ?').get(token);
  if (inv && !inv.viewed_at) {
    db.prepare('UPDATE invoices SET viewed_at = ? WHERE id = ?').run(nowIso(), inv.id);
  }
}

// Capture the customer's signature. Stores the drawn data URL OR typed name,
// their full name, an immutable snapshot of the terms they agreed to, and the
// timestamp + IP + User-Agent as dispute evidence. Rejects if already signed.
function signInvoice(token, { signerName, signatureData, signatureType, ip, userAgent } = {}) {
  const inv = db.prepare('SELECT * FROM invoices WHERE public_token = ?').get(token);
  if (!inv) return { error: 'not_found' };
  if (inv.signed_at) return { error: 'already_signed' };
  if (inv.status === 'void') return { error: 'void' };

  const name = String(signerName || '').trim();
  const data = String(signatureData || '').trim();
  if (!name) return { error: 'name_required' };
  if (!data) return { error: 'signature_required' };
  const type = signatureType === 'drawn' ? 'drawn' : 'typed';
  // Guard against an oversized canvas data URL blowing up the row.
  if (data.length > 2_000_000) return { error: 'signature_too_large' };

  const at = nowIso();
  // Snapshot the exact contract the customer was shown (resolved by business type),
  // not the raw terms column — so signed_terms is faithful dispute evidence.
  const signedTerms = getEffectiveContractText(inv) || null;
  db.prepare(`
    UPDATE invoices
    SET status = 'signed', signed_at = ?, signer_name = ?, signature_type = ?,
        signature_data = ?, signed_terms = ?, signer_ip = ?, signer_user_agent = ?, updated_at = ?
    WHERE id = ?
  `).run(at, name, type, data, signedTerms, ip || null, userAgent ? String(userAgent).slice(0, 500) : null, at, inv.id);

  return { invoice: getInvoiceByToken(token) };
}

// Let the CUSTOMER verify + correct their OWN delivery address (and access notes)
// from the tokenized public page, BEFORE signing/paying. Authorized exactly like
// signInvoice — the unguessable public_token resolves to one invoice, and that's the
// only credential. STRICT WHITELIST: only the delivery address and access notes can
// change here. Size, dates, price, contact, business, status — none are reachable.
//
// The corrected address is written to the LEAD's vertical_data.deliveryAddress (the
// field the schedule/dispatch/driver views actually read), so the fix goes LIVE to
// the business immediately — not just to the invoice's billing snapshot. The invoice's
// bill_to_address is kept in step so no page/PDF shows a stale copy. A prominent
// "customer corrected the address" flag is stamped on the lead for the owner; the
// caller (route) logs the timeline entry + emits the live dashboard event.
//
// deliveryAddress feeds nothing computational (no geocode/mileage/zone pricing exists),
// so this can never change what the customer owes or reserve/overbook a unit — which is
// exactly why only these fields are editable and size/dates/price stay locked.
function updateDeliveryDetailsByToken(token, { deliveryAddress, accessNotes } = {}) {
  const inv = db.prepare('SELECT * FROM invoices WHERE public_token = ?').get(token);
  if (!inv) return { error: 'not_found' };
  if (inv.status === 'void') return { error: 'void' };
  // Once signed or paid the invoice is locked (dispute evidence / booking committed).
  if (inv.signed_at || inv.paid_at || LOCKED_STATUSES.has(inv.status)) return { error: 'locked' };
  if (!inv.lead_id) return { error: 'no_lead' };

  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(inv.lead_id, inv.business_id);
  if (!lead) return { error: 'no_lead' };

  const nextAddress = deliveryAddress != null ? String(deliveryAddress).trim() : '';
  if (!nextAddress) return { error: 'address_required' };
  if (nextAddress.length > 500) return { error: 'address_too_long' };
  const hasNotes = accessNotes !== undefined;
  const nextNotes = hasNotes ? String(accessNotes || '').trim().slice(0, 1000) : undefined;

  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  const prevAddress = vd.deliveryAddress || null;
  const prevNotes = vd.accessNotes || null;
  const addressChanged = (prevAddress || '') !== nextAddress;
  const notesChanged = hasNotes && (prevNotes || '') !== (nextNotes || '');

  // No-op save (customer confirmed without changing anything) — don't flag/log it.
  if (!addressChanged && !notesChanged) {
    return { invoice: getInvoiceByToken(token), lead, changed: false, addressChanged: false, notesChanged: false, prevAddress, nextAddress };
  }

  // Whitelisted partial merge: only deliveryAddress (+ optional accessNotes) and the
  // correction flag change. Every other vertical_data key — size, dates, transcript,
  // booking signals — is preserved untouched.
  const merged = { ...vd, deliveryAddress: nextAddress };
  if (hasNotes) merged.accessNotes = nextNotes || null;
  if (addressChanged) {
    merged.addressCorrectedByCustomer = true;
    merged.addressCorrectedAt = nowIso();
    if (prevAddress) merged.addressBeforeCorrection = prevAddress;
  }

  const at = nowIso();
  db.prepare('UPDATE leads SET vertical_data = ?, updated_at = ? WHERE id = ? AND business_id = ?')
    .run(JSON.stringify(merged), at, lead.id, inv.business_id);
  // Keep the invoice's billing snapshot consistent so no box/PDF shows the old address.
  db.prepare('UPDATE invoices SET bill_to_address = ?, updated_at = ? WHERE id = ? AND business_id = ?')
    .run(nextAddress, at, inv.id, inv.business_id);

  const freshLead = db.prepare('SELECT * FROM leads WHERE id = ? AND business_id = ?').get(lead.id, inv.business_id);
  return { invoice: getInvoiceByToken(token), lead: freshLead, changed: true, addressChanged, notesChanged, prevAddress, nextAddress };
}

// The normalized contract-type key for a business: its signup industry_type, or —
// for an env-configured anchor business that predates the signup flow and has no
// industry_type (e.g. Valley Binz) — the LEADFLOW default vertical env vars. A real
// signup industry is never overridden by the global env.
function businessContractTypeKey(businessId) {
  const biz = db.prepare('SELECT industry_type FROM businesses WHERE id = ?').get(businessId);
  const key = businessTypeKey(biz && biz.industry_type);
  if (key) return key;
  return businessTypeKey(process.env.LEADFLOW_DEFAULT_SUB_VERTICAL)
    || businessTypeKey(process.env.LEADFLOW_DEFAULT_VERTICAL)
    || 'generic';
}

// Resolve the contract text the customer actually SEES on the public page and
// SIGNS (snapshotted into signed_terms). Resolution order:
//   1. Terms customized for this invoice — anything the owner set that isn't the
//      generic auto-default (a per-invoice edit, or a saved business default).
//   2. The default contract for this business's type (e.g. the full dumpster-
//      rental agreement) — see services/contractTemplates.js.
// This is the single seam a future per-business "build your contract" Settings
// feature hooks into: store the business's contract and prefer it in step 2.
function getEffectiveContractText(invoice) {
  if (!invoice) return GENERIC_TERMS;
  const stored = (invoice.terms || '').trim();
  if (stored && stored !== GENERIC_TERMS.trim()) return invoice.terms;
  return resolveDefaultContract(businessContractTypeKey(invoice.business_id));
}

// Whether this invoice must be SIGNED before it can be paid. Paying is the act of
// authorizing a contract, so any invoice that presents terms requires the
// customer's signature first. Every invoice today resolves to a contract
// (getEffectiveContractText falls back to the business-type / generic terms), so
// this is effectively always true — the seam exists so a hypothetical
// contract-less invoice could skip the gate and keep the pay-immediately flow.
// Used both to expose `signature_required` on the public payload and to enforce
// the gate server-side in routes/publicInvoices.js.
function requiresSignature(invoice) {
  if (!invoice) return false;
  return !!(getEffectiveContractText(invoice) || '').trim();
}

// The dumpster size this invoice is for, used to disclose the size-specific weight
// allowance on the public page. Prefers a size-shaped service_key on the base rental
// line (which carries the canonical key), then any size-shaped line item, then the
// linked lead's requested size. Returns the size string/key or null (non-dumpster or
// unlinked invoice — no size to disclose against).
function invoiceDumpsterSize(invoice) {
  const items = invoice.line_items || [];
  const sized = (it) => it && it.service_key && normalizeSizeKey(it.service_key);
  const rental = items.find((it) => it.line_type === 'rental' && sized(it));
  if (rental) return rental.service_key;
  const anySized = items.find(sized);
  if (anySized) return anySized.service_key;
  if (invoice.lead_id) {
    try {
      const lead = db.prepare('SELECT vertical_data FROM leads WHERE id = ? AND business_id = ?')
        .get(invoice.lead_id, invoice.business_id);
      const size = lead ? sizeFromLead(lead) : null;
      if (size) return size;
    } catch { /* leads unavailable — no size */ }
  }
  return null;
}

// The weight-allowance disclosure for this invoice's size, pulled LIVE from the
// size's pricing_config — the SAME allowance + per-ton overage rate the Pricing page
// edits and the weight-overage flow bills against, so it's correct per business and
// updates when the business changes its fees. Returns null (note hidden) unless BOTH
// the allowance and the rate are configured to a positive value — a business that
// hasn't set overage pricing shows no note rather than a blank/$0 sentence.
function weightAllowanceFor(invoice) {
  const size = invoiceDumpsterSize(invoice);
  if (!size) return null;
  let cfg;
  try { cfg = getSizeWeightConfig(invoice.business_id, size); } catch { return null; }
  const allowance = Number(cfg && cfg.allowanceTons);
  const rate = Number(cfg && cfg.ratePerTon);
  if (!(allowance > 0) || !(rate > 0)) return null;
  return { allowance_tons: allowance, rate_per_ton: rate };
}

// The booking's DELIVERY details for the public page's "verify your details" step.
// Sourced from the LINKED LEAD — deliveryAddress is read straight off the lead's
// vertical_data (the SAME field the schedule/dispatch/driver views read), NOT the
// invoice's bill_to_address billing snapshot. delivery_date and size are display-only.
// Returns null for an unlinked invoice or a lead with nothing to show. `editable`
// mirrors the write endpoint's rule: correctable only before the invoice locks.
function deliveryDetailsFor(invoice) {
  if (!invoice || !invoice.lead_id) return null;
  let lead;
  try {
    lead = db.prepare('SELECT delivery_date, vertical_data FROM leads WHERE id = ? AND business_id = ?')
      .get(invoice.lead_id, invoice.business_id);
  } catch { return null; }
  if (!lead) return null;
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  const address = vd.deliveryAddress || null;
  const deliveryDate = lead.delivery_date || vd.deliveryDate || vd.deliveryDateISO || null;
  const size = vd.dumpsterSize || null;
  const notes = vd.accessNotes || null;
  if (!address && !deliveryDate && !size && !notes) return null;
  return {
    address,
    delivery_date: deliveryDate,
    size,
    notes,
    // Editable only before the invoice locks (unsigned + unpaid + not void). The
    // write endpoint enforces the same rule — this is for the UI, not the boundary.
    editable: !invoice.signed_at && !invoice.paid_at && invoice.status !== 'void',
  };
}

// Shape an invoice for the PUBLIC page — strips internal evidence (IP/UA) and
// scoping fields. `payment` is the business's online-payment state, resolved by
// the caller from the Connect layer: { enabled, connectedAccountId, publishableKey }.
function toPublic(invoice, business, payment = {}) {
  if (!invoice) return null;
  return {
    invoice_number: invoice.invoice_number,
    status: invoice.status,
    currency: invoice.currency || 'USD',
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    subtotal: invoice.subtotal,
    tax_rate: invoice.tax_rate,
    tax_amount: invoice.tax_amount,
    total: invoice.total,
    amount_paid: invoice.amount_paid,
    notes: invoice.notes,
    // The full contract the customer reads + signs, resolved by business type
    // (falls back to any per-invoice/business override). NOT necessarily the raw
    // stored terms column — see getEffectiveContractText.
    terms: getEffectiveContractText(invoice),
    bill_to_name: invoice.bill_to_name,
    bill_to_email: invoice.bill_to_email,
    bill_to_phone: invoice.bill_to_phone,
    bill_to_address: invoice.bill_to_address,
    // Size-specific weight-allowance disclosure (allowance tons + per-ton overage
    // rate) pulled live from this size's pricing_config, or null to hide the note
    // when the business hasn't configured overage pricing for the size.
    weight_allowance: weightAllowanceFor(invoice),
    // The booking's delivery details (address/date/size/notes) read LIVE from the
    // linked lead, so the customer can verify — and correct their address — before
    // paying. null for an unlinked invoice. See deliveryDetailsFor.
    delivery: deliveryDetailsFor(invoice),
    line_items: (invoice.line_items || []).map((it) => {
      const d = describeLineItem(it);
      return {
        description: it.description,
        // Display-only split: clean title (size first) + plain-language detail line.
        // Amounts/qty/rate are untouched — see describeLineItem.
        title: d.title,
        detail: d.detail,
        line_type: it.line_type,
        quantity: it.quantity,
        unit: it.unit,
        unit_rate: it.unit_rate,
        amount: it.amount,
      };
    }),
    // Whether the customer must sign before the Pay action unlocks. Drives the
    // client-side gate; the same rule is enforced server-side on the charge
    // endpoint so the UI is never the only guard.
    signature_required: requiresSignature(invoice),
    signed_at: invoice.signed_at,
    signer_name: invoice.signer_name,
    signature_type: invoice.signature_type,
    signature_data: invoice.signature_data,
    paid_at: invoice.paid_at,
    amount_refunded: invoice.amount_refunded || 0,
    refunded_at: invoice.refunded_at || null,
    business: {
      name: business?.name || 'Our Business',
      phone: business?.phone || null,
      email: business?.email || null,
    },
    // Online payment (Stripe Connect direct charge). Enabled only when the
    // business has finished Connect onboarding and the invoice still owes a
    // balance. The connected account id is safe to expose — the client needs it
    // to initialize Stripe.js for a direct charge (Stripe-Account header).
    payment_enabled: !!payment.enabled,
    connect_account_id: payment.enabled ? (payment.connectedAccountId || null) : null,
    publishable_key: payment.enabled ? (payment.publishableKey || null) : null,
  };
}

// Branding for the public page header. Prefers the per-business settings the
// payment page already uses (businessName/Phone/Email); falls back to the
// businesses table name so the customer never sees a generic placeholder.
function getBusinessBranding(businessId) {
  const branding = {
    name: readSetting(businessId, 'businessName') || null,
    phone: readSetting(businessId, 'businessPhone') || null,
    email: readSetting(businessId, 'businessEmail') || null,
  };
  if (!branding.name) {
    const biz = db.prepare('SELECT name FROM businesses WHERE id = ?').get(businessId);
    if (biz && biz.name) branding.name = biz.name;
  }
  return branding;
}

module.exports = {
  DEFAULT_TERMS,
  INVOICE_STATUSES,
  getDefaults,
  setDefaults,
  prefill,
  suggestItemsFromLead,
  describeLineItem,
  getInvoice,
  listInvoices,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  markSent,
  markPaid,
  attachPaymentIntent,
  findByPaymentIntent,
  getInvoiceRefsByPaymentIntent,
  recordOnlinePayment,
  recordRefund,
  getInvoiceByToken,
  recordView,
  signInvoice,
  updateDeliveryDetailsByToken,
  requiresSignature,
  toPublic,
  getBusinessBranding,
};
