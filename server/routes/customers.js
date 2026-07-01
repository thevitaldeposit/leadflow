const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const {
  CUSTOMER_STATUSES,
  normalizePhone,
  reconcileCustomersForBusiness,
  recomputeCustomerStatus,
  listCustomers,
  getCustomerDetail,
  displayNameOf,
  leadIsCompleted,
  leadIsBooked,
  paidInvoiceContextForCustomer,
} = require('../services/customerService');
const { resolveEffectivePricing } = require('../services/pricingService');
const { logActivity } = require('../services/activityLog');
const { advanceDueDeliveries } = require('../services/jobLifecycle');
const { JOB_STATUS, CLOSED_LOST_STATUSES } = require('../config/jobStatus');

// Customers is a web-dashboard (and, later, authenticated iOS) surface. Unlike
// the shared /api/leads routes, it must never fall back to the default business,
// so it uses the hard auth guard rather than attachBusiness.
router.use(requireAuth);

// GET /api/customers — list with rollup aggregates. Reconciles first so any
// leads inserted by the call pipeline since the last read are attached.
router.get('/', (req, res) => {
  try {
    const businessId = req.business.id;
    reconcileCustomersForBusiness(businessId);
    // Forward-advance any booked jobs whose delivery date has arrived (booked →
    // active_rental) before rendering — reconcile-on-read, non-destructive.
    advanceDueDeliveries(businessId);
    const { status, search } = req.query;
    res.json(listCustomers(businessId, { status, search }));
  } catch (err) {
    console.error('GET /customers error:', err);
    res.status(500).json({ error: 'Failed to retrieve customers' });
  }
});

// GET /api/customers/:id — full profile: contact, addresses, job history,
// activity timeline, totals, and resolved per-client pricing.
router.get('/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    reconcileCustomersForBusiness(businessId);
    advanceDueDeliveries(businessId);
    const detail = getCustomerDetail(businessId, req.params.id);
    if (!detail) return res.status(404).json({ error: 'Customer not found' });

    const customerRow = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?')
      .get(req.params.id, businessId);
    detail.pricing = resolveEffectivePricing(businessId, customerRow);
    res.json(detail);
  } catch (err) {
    console.error('GET /customers/:id error:', err);
    res.status(500).json({ error: 'Failed to retrieve customer' });
  }
});

// POST /api/customers — manually create a customer record (not tied to a call).
router.post('/', (req, res) => {
  try {
    const businessId = req.business.id;
    const b = req.body || {};
    const str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

    const firstName = str(b.firstName || b.first_name);
    const lastName = str(b.lastName || b.last_name);
    const company = str(b.company);
    const phone = str(b.phone);
    const email = str(b.email);
    const address = str(b.address);
    const displayName = str(b.displayName || b.display_name) || [firstName, lastName].filter(Boolean).join(' ') || company;

    if (!firstName && !company && !phone) {
      return res.status(400).json({ error: 'A name, company, or phone is required' });
    }

    const np = normalizePhone(phone);
    if (np) {
      const existing = db.prepare('SELECT id FROM customers WHERE business_id = ? AND normalized_phone = ?').get(businessId, np);
      if (existing) {
        return res.status(409).json({ error: 'A customer with this phone already exists', existingId: existing.id });
      }
    }

    const now = new Date().toISOString();
    const status = CUSTOMER_STATUSES.includes(b.status) ? b.status : 'lead';
    const overridden = CUSTOMER_STATUSES.includes(b.status) ? 1 : 0;
    const info = db.prepare(`
      INSERT INTO customers
        (business_id, first_name, last_name, display_name, company, phone, normalized_phone, email, address, status, status_overridden, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      businessId, firstName || null, lastName || null, displayName || null, company || null,
      phone || null, np, email || null, address || null, status, overridden, str(b.notes) || null, now, now
    );

    const created = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json(created);
  } catch (err) {
    console.error('POST /customers error:', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// PUT /api/customers/:id — edit profile, contract terms, discount group, notes,
// and lifecycle status. Setting `status` pins it (status_overridden); setting
// status to 'auto' releases it back to the derived value.
router.put('/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const b = req.body || {};
    const updates = {};
    const map = {
      first_name: 'first_name', firstName: 'first_name',
      last_name: 'last_name', lastName: 'last_name',
      display_name: 'display_name', displayName: 'display_name',
      company: 'company', email: 'email', address: 'address',
      notes: 'notes', contract_terms: 'contract_terms', contractTerms: 'contract_terms',
    };
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) updates[col] = b[key] === '' ? null : b[key];
    }

    // Phone change must keep the dedupe key in sync.
    if (b.phone !== undefined) {
      const phone = b.phone === '' ? null : String(b.phone).trim();
      updates.phone = phone;
      updates.normalized_phone = normalizePhone(phone);
    }

    // Discount group: validate it belongs to this business, or clear it.
    if (b.discount_group_id !== undefined || b.discountGroupId !== undefined) {
      const raw = b.discount_group_id !== undefined ? b.discount_group_id : b.discountGroupId;
      if (raw == null || raw === '' || raw === 0) {
        updates.discount_group_id = null;
      } else {
        const grp = db.prepare('SELECT id FROM discount_groups WHERE id = ? AND business_id = ?').get(raw, businessId);
        if (!grp) return res.status(400).json({ error: 'Invalid discount group' });
        updates.discount_group_id = grp.id;
      }
    }

    // Status: 'auto' releases the manual override and recomputes from jobs.
    let recompute = false;
    if (b.status !== undefined) {
      if (b.status === 'auto') {
        updates.status_overridden = 0;
        recompute = true;
      } else if (CUSTOMER_STATUSES.includes(b.status)) {
        updates.status = b.status;
        updates.status_overridden = 1;
      } else {
        return res.status(400).json({ error: 'Invalid status' });
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const set = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE customers SET ${set} WHERE id = ? AND business_id = ?`)
        .run(...Object.values(updates), req.params.id, businessId);
    }
    if (recompute) recomputeCustomerStatus(Number(req.params.id));

    const updated = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    res.json(updated);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Another customer already has this phone number' });
    }
    console.error('PUT /customers/:id error:', err);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// DELETE /api/customers/:id — remove the customer record. Its leads/calls are
// preserved (leads.customer_id is set to NULL by the FK) and will re-link on the
// next reconcile, so call history is never lost.
router.delete('/:id', (req, res) => {
  try {
    const businessId = req.business.id;
    const existing = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Customer not found' });
    db.prepare('DELETE FROM customers WHERE id = ? AND business_id = ?').run(req.params.id, businessId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /customers/:id error:', err);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// POST /api/customers/:id/engagements/close — manually close an Active Inquiry
// (Mark Lost / Close). Marks the engagement's still-open calls terminal ('lost')
// so the inquiry leaves the Action Queue and shows as closed in the profile. This
// is the ONLY way an inquiry closes — nothing auto-closes one. Booked/completed
// calls are never touched (Jobs complete automatically on payment + pickup), and
// it changes no booking signals or auto-book state.
router.post('/:id/engagements/close', (req, res) => {
  try {
    const businessId = req.business.id;
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?')
      .get(req.params.id, businessId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const ids = Array.isArray(req.body?.lead_ids) ? req.body.lead_ids : [];
    if (!ids.length) return res.status(400).json({ error: 'lead_ids is required' });
    const reason = req.body?.reason === 'closed' ? 'closed' : 'lost';
    const note = reason === 'closed' ? 'Inquiry closed by owner' : 'Inquiry marked lost';

    const now = new Date().toISOString();
    // Same paid-via-invoice context the profile uses, so a call completed by a paid
    // invoice (not just leads.paid_at) is recognized as completed and never closed.
    const paidCtx = paidInvoiceContextForCustomer(businessId, customer.id);
    let closed = 0;
    for (const rawId of ids) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND customer_id = ? AND business_id = ?')
        .get(rawId, customer.id, businessId);
      // Only close still-open inquiry calls; never a booked/completed/already-terminal one.
      if (!lead || leadIsCompleted(lead, paidCtx) || leadIsBooked(lead)) continue;
      if (CLOSED_LOST_STATUSES.has(lead.job_status)) continue;
      // Record which action closed it ('lost' vs 'closed') on the call's
      // vertical_data (additive merge — never wipes other fields) so the profile's
      // Past-inquiries list can label it correctly. Does not change booking state.
      let vd = {};
      try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
      vd.closeReason = reason;
      db.prepare('UPDATE leads SET job_status = ?, vertical_data = ?, updated_at = ? WHERE id = ?')
        .run(JOB_STATUS.LOST, JSON.stringify(vd), now, lead.id);
      logActivity(lead.id, 'status_change', note);
      closed++;
    }

    recomputeCustomerStatus(customer.id);
    reconcileCustomersForBusiness(businessId);
    const detail = getCustomerDetail(businessId, customer.id);
    res.json({ closed, customer: detail });
  } catch (err) {
    console.error('POST /customers/:id/engagements/close error:', err);
    res.status(500).json({ error: 'Failed to close engagement' });
  }
});

// POST /api/customers/:id/notes — add a discrete, timestamped note against the
// customer (e.g. recap of an outbound callback). The note is returned and also
// surfaces in the profile's Activity Feed (getCustomerDetail merges it as a
// note_added entry). Touches nothing in the call/extraction/booking pipeline.
router.post('/:id/notes', (req, res) => {
  try {
    const businessId = req.business.id;
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?')
      .get(req.params.id, businessId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const body = (req.body?.body || req.body?.note || '').toString().trim();
    if (!body) return res.status(400).json({ error: 'Note text is required' });

    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO customer_notes (business_id, customer_id, body, created_at) VALUES (?, ?, ?, ?)'
    ).run(businessId, customer.id, body, now);
    // Touch the customer so list ordering (last activity) reflects the note.
    db.prepare('UPDATE customers SET updated_at = ? WHERE id = ?').run(now, customer.id);

    const note = db.prepare('SELECT id, body, created_at FROM customer_notes WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    res.status(201).json({ success: true, note });
  } catch (err) {
    console.error('POST /customers/:id/notes error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// PUT /api/customers/:id/notes/:noteId — edit a discrete note's text. Scoped by
// business_id (and customer_id) so a business can only edit its own notes. The
// edit reflects in the Activity Feed automatically: getCustomerDetail derives the
// note_added entry from this row at read time, so there's no stored copy to sync.
// created_at is left untouched — editing text doesn't change when the note was made.
router.put('/:id/notes/:noteId', (req, res) => {
  try {
    const businessId = req.business.id;
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?')
      .get(req.params.id, businessId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const body = (req.body?.body || req.body?.note || '').toString().trim();
    if (!body) return res.status(400).json({ error: 'Note text is required' });

    const existing = db.prepare('SELECT id FROM customer_notes WHERE id = ? AND customer_id = ? AND business_id = ?')
      .get(req.params.noteId, customer.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Note not found' });

    const now = new Date().toISOString();
    db.prepare('UPDATE customer_notes SET body = ? WHERE id = ? AND customer_id = ? AND business_id = ?')
      .run(body, existing.id, customer.id, businessId);
    // Touch the customer so list ordering (last activity) reflects the edit.
    db.prepare('UPDATE customers SET updated_at = ? WHERE id = ?').run(now, customer.id);

    const note = db.prepare('SELECT id, body, created_at FROM customer_notes WHERE id = ?').get(existing.id);
    res.json({ success: true, note });
  } catch (err) {
    console.error('PUT /customers/:id/notes/:noteId error:', err);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

// DELETE /api/customers/:id/notes/:noteId — delete a discrete note. Scoped by
// business_id (and customer_id) so a business can only delete its own notes.
// Because the Activity Feed derives note_added entries from this table at read
// time, removing the row also removes its feed entry — notes never write to
// activity_log, so there's no orphaned timeline row to clean up.
router.delete('/:id/notes/:noteId', (req, res) => {
  try {
    const businessId = req.business.id;
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?')
      .get(req.params.id, businessId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const existing = db.prepare('SELECT id FROM customer_notes WHERE id = ? AND customer_id = ? AND business_id = ?')
      .get(req.params.noteId, customer.id, businessId);
    if (!existing) return res.status(404).json({ error: 'Note not found' });

    db.prepare('DELETE FROM customer_notes WHERE id = ? AND customer_id = ? AND business_id = ?')
      .run(existing.id, customer.id, businessId);
    // Touch the customer so list ordering (last activity) reflects the removal.
    db.prepare('UPDATE customers SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), customer.id);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /customers/:id/notes/:noteId error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// GET /api/customers/:id/pricing — resolved effective pricing for this customer.
router.get('/:id/pricing', (req, res) => {
  try {
    const businessId = req.business.id;
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(resolveEffectivePricing(businessId, customer));
  } catch (err) {
    console.error('GET /customers/:id/pricing error:', err);
    res.status(500).json({ error: 'Failed to retrieve pricing' });
  }
});

// PUT /api/customers/:id/pricing — upsert a per-customer rate override for one
// service. A null/blank custom_price removes the override (falls back to the
// group/default price).
router.put('/:id/pricing', (req, res) => {
  try {
    const businessId = req.business.id;
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND business_id = ?').get(req.params.id, businessId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const b = req.body || {};
    const serviceKey = (b.service_key || b.serviceKey || '').toString().trim();
    if (!serviceKey) return res.status(400).json({ error: 'service_key is required' });

    const raw = b.custom_price !== undefined ? b.custom_price : b.customPrice;
    const now = new Date().toISOString();

    if (raw === null || raw === '' || raw === undefined) {
      db.prepare('DELETE FROM customer_pricing WHERE customer_id = ? AND service_key = ?').run(customer.id, serviceKey);
    } else {
      const price = Number(raw);
      if (Number.isNaN(price) || price < 0) return res.status(400).json({ error: 'Invalid price' });
      const label = (b.label || '').toString().trim() || null;
      const unit = (b.unit || '').toString().trim() || null;
      const existing = db.prepare('SELECT id FROM customer_pricing WHERE customer_id = ? AND service_key = ?').get(customer.id, serviceKey);
      if (existing) {
        db.prepare('UPDATE customer_pricing SET custom_price = ?, label = ?, unit = ?, updated_at = ? WHERE id = ?')
          .run(price, label, unit, now, existing.id);
      } else {
        db.prepare('INSERT INTO customer_pricing (business_id, customer_id, service_key, label, unit, custom_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(businessId, customer.id, serviceKey, label, unit, price, now, now);
      }
    }

    const full = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id);
    res.json(resolveEffectivePricing(businessId, full));
  } catch (err) {
    console.error('PUT /customers/:id/pricing error:', err);
    res.status(500).json({ error: 'Failed to update pricing' });
  }
});

module.exports = router;
