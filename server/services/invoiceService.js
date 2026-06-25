const crypto = require('crypto');
const db = require('../db/database');
const { resolveEffectivePricing } = require('./pricingService');
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

// ── Reads ─────────────────────────────────────────────────────────────────────
function getCustomerRow(businessId, customerId) {
  if (!customerId) return null;
  return db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(customerId, businessId);
}

// Full invoice (with line items) scoped to a business, or null.
function getInvoice(businessId, id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!inv) return null;
  inv.line_items = getLineItems(inv.id);
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

// Suggest starter line items for a job, generically. If a linked lead names a
// dumpster size, match it to the customer's effective price list; otherwise fall
// back to a single line from the quoted price / estimated revenue. Never
// dumpster-only — any vertical gets the generic fallback.
function suggestItemsFromLead(lead, pricingItems) {
  if (!lead) return [];
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }

  const findRate = (needle) => {
    if (!needle) return null;
    const n = String(needle).toLowerCase();
    return pricingItems.find(
      (p) => (p.service_key && p.service_key.toLowerCase() === n) ||
             (p.label && p.label.toLowerCase().includes(n))
    ) || null;
  };

  const size = vd.dumpsterSize || null;
  if (size) {
    const m = findRate(size);
    return [{
      description: `${size} Dumpster Rental`,
      service_key: m ? m.service_key : null,
      line_type: 'service',
      quantity: 1,
      unit: m ? m.unit : null,
      unit_rate: m && m.effective_price != null ? m.effective_price : leadRevenueGuess(lead, vd),
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
    suggested_items: suggestItemsFromLead(lead, pricing.items || []),
    available_rates: pricing.items || [],
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
    line_items: (invoice.line_items || []).map((it) => ({
      description: it.description,
      line_type: it.line_type,
      quantity: it.quantity,
      unit: it.unit,
      unit_rate: it.unit_rate,
      amount: it.amount,
    })),
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
  requiresSignature,
  toPublic,
  getBusinessBranding,
};
