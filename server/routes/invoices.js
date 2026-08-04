const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../services/activityLog');
const { emitToBusiness } = require('../socket');
const { sendInvoiceEmail, isValidEmail } = require('../services/emailService');
const { sendInvoiceSms } = require('../services/smsService');
const invoiceService = require('../services/invoiceService');
const jobLifecycle = require('../services/jobLifecycle');

// Owner-facing invoice management. Like /api/customers, this is a hard-auth
// dashboard surface (and, later, authenticated iOS) — it must never fall back to
// the default business, so requireAuth guards every route. The customer-facing,
// tokenized side lives in routes/publicInvoices.js (no auth).
router.use(requireAuth);

// Build the public app origin for a shareable invoice link. Prefers an explicit
// PUBLIC_APP_URL override, else derives it from the request (trust proxy is on,
// so req.protocol respects X-Forwarded-Proto behind Railway/Cloudflare). Both the
// joinstream.app and Railway hosts serve the SPA, so either resolves the link.
function appBaseUrl(req) {
  const env = process.env.PUBLIC_APP_URL;
  if (env) return env.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
function publicLink(req, token) {
  return `${appBaseUrl(req)}/invoice/${token}`;
}

// GET /api/invoices — list (optional ?customer_id, ?lead_id, ?status filters).
router.get('/', (req, res) => {
  try {
    const { customer_id, lead_id, status } = req.query;
    res.json(invoiceService.listInvoices(req.business.id, { customer_id, lead_id, status }));
  } catch (err) {
    console.error('GET /invoices error:', err);
    res.status(500).json({ error: 'Failed to retrieve invoices' });
  }
});

// GET /api/invoices/defaults — the business invoice defaults (terms, due window,
// tax, numbering). Registered before /:id so "defaults" isn't read as an id.
router.get('/defaults', (req, res) => {
  try {
    res.json(invoiceService.getDefaults(req.business.id));
  } catch (err) {
    console.error('GET /invoices/defaults error:', err);
    res.status(500).json({ error: 'Failed to retrieve invoice defaults' });
  }
});

// PUT /api/invoices/defaults — edit the per-business default terms template etc.
router.put('/defaults', (req, res) => {
  try {
    res.json(invoiceService.setDefaults(req.business.id, req.body || {}));
  } catch (err) {
    console.error('PUT /invoices/defaults error:', err);
    res.status(500).json({ error: 'Failed to save invoice defaults' });
  }
});

// GET /api/invoices/prefill?customer_id=&lead_id= — everything the New Invoice
// form needs prefilled from the customer + per-client pricing (+ optional job).
router.get('/prefill', (req, res) => {
  try {
    const { customer_id, lead_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
    const data = invoiceService.prefill(req.business.id, customer_id, lead_id || null);
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    console.error('GET /invoices/prefill error:', err);
    res.status(500).json({ error: 'Failed to build invoice prefill' });
  }
});

// POST /api/invoices — create a draft invoice for a customer (+ optional job).
router.post('/', (req, res) => {
  try {
    const invoice = invoiceService.createInvoice(req.business.id, req.body || {});
    if (invoice.lead_id) logActivity(invoice.lead_id, 'invoice_created', `Invoice ${invoice.invoice_number} created`);
    emitToBusiness(req.business.id, 'invoice_updated', { id: invoice.id });
    res.status(201).json(invoice);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('POST /invoices error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// GET /api/invoices/:id — full invoice with line items.
router.get('/:id', (req, res) => {
  try {
    const invoice = invoiceService.getInvoice(req.business.id, req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(invoice);
  } catch (err) {
    console.error('GET /invoices/:id error:', err);
    res.status(500).json({ error: 'Failed to retrieve invoice' });
  }
});

// PUT /api/invoices/:id — edit header + (optionally) replace line items. Blocked
// once the invoice is signed/paid (locked as signature evidence).
router.put('/:id', (req, res) => {
  try {
    const result = invoiceService.updateInvoice(req.business.id, req.params.id, req.body || {});
    if (result.error === 'not_found') return res.status(404).json({ error: 'Invoice not found' });
    if (result.error === 'locked') return res.status(409).json({ error: 'A signed or paid invoice cannot be edited' });
    emitToBusiness(req.business.id, 'invoice_updated', { id: Number(req.params.id) });
    res.json(result.invoice);
  } catch (err) {
    console.error('PUT /invoices/:id error:', err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// DELETE /api/invoices/:id — remove a draft/sent invoice. A signed/paid invoice
// is preserved as evidence and returns 409.
router.delete('/:id', (req, res) => {
  try {
    const result = invoiceService.deleteInvoice(req.business.id, req.params.id);
    if (result.error === 'not_found') return res.status(404).json({ error: 'Invoice not found' });
    if (result.error === 'locked') return res.status(409).json({ error: 'A signed or paid invoice cannot be deleted' });
    emitToBusiness(req.business.id, 'invoice_updated', { id: Number(req.params.id), deleted: true });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /invoices/:id error:', err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// POST /api/invoices/:id/send — deliver the public link via email and/or SMS, and
// mark the invoice sent. Body: { channel: 'email' | 'sms' | 'both' } (default both),
// { requireEmail } to hard-fail instead of delivering nothing (see the guard below).
router.post('/:id/send', async (req, res) => {
  try {
    const invoice = invoiceService.getInvoice(req.business.id, req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const channel = (req.body && req.body.channel) || 'both';
    const hasEmail = isValidEmail(invoice.bill_to_email);

    // Email-send guard. A caller that is EMAILING this invoice — an email-only send,
    // or one that asked us to (requireEmail: the review screen's Approve & Send) —
    // must not be told it went out when there's no address to send to. Refuse before
    // markSent, so the invoice isn't stamped sent and the timeline never claims a
    // delivery that didn't happen. A plain 'both' send is unchanged: it still
    // delivers by whatever channel it can and reports honestly per channel.
    const requireEmail = (req.body && req.body.requireEmail === true) || channel === 'email';
    if (requireEmail && !hasEmail) {
      return res.status(400).json({
        error: 'Add an email address to send this invoice.',
        code: 'email_required',
      });
    }

    const link = publicLink(req, invoice.public_token);
    const delivery = { email: null, sms: null };

    if ((channel === 'email' || channel === 'both') && hasEmail) {
      try {
        await sendInvoiceEmail({
          to: invoice.bill_to_email,
          businessName: req.business.name,
          customerName: invoice.bill_to_name,
          invoiceNumber: invoice.invoice_number,
          total: invoice.total,
          link,
        });
        delivery.email = { sent: true, to: invoice.bill_to_email };
      } catch (e) {
        delivery.email = { sent: false, error: e.message };
      }
    } else if ((channel === 'email' || channel === 'both') && invoice.bill_to_email) {
      // An address is on file but isn't a deliverable one — say so instead of
      // reporting the same "no address" as a blank field.
      delivery.email = { sent: false, error: 'invalid email address' };
    }

    if ((channel === 'sms' || channel === 'both') && invoice.bill_to_phone) {
      const r = await sendInvoiceSms(invoice, link);
      delivery.sms = r;
    }

    const sentAnything = !!((delivery.email && delivery.email.sent) || (delivery.sms && delivery.sms.sent));
    const updated = invoiceService.markSent(req.business.id, invoice.id);
    if (invoice.lead_id) {
      const via = [delivery.email?.sent && 'email', delivery.sms?.sent && 'SMS'].filter(Boolean).join(' + ');
      logActivity(invoice.lead_id, 'invoice_sent', `Invoice ${invoice.invoice_number} sent${via ? ` via ${via}` : ''}`);
    }
    emitToBusiness(req.business.id, 'invoice_updated', { id: invoice.id });

    res.json({ invoice: updated, delivery, link, sentAnything });
  } catch (err) {
    console.error('POST /invoices/:id/send error:', err);
    res.status(500).json({ error: 'Failed to send invoice' });
  }
});

// POST /api/invoices/:id/mark-paid — owner-side manual payment record. This is
// the PLACEHOLDER for the future payment task — it records bookkeeping only and
// does NOT process a payment. Body: { method, reference } (both optional).
router.post('/:id/mark-paid', (req, res) => {
  try {
    const result = invoiceService.markPaid(req.business.id, req.params.id, req.body || {});
    if (result.error === 'not_found') return res.status(404).json({ error: 'Invoice not found' });
    if (result.invoice.lead_id) logActivity(result.invoice.lead_id, 'invoice_paid', `Invoice ${result.invoice.invoice_number} marked paid`);
    // Recompute the job's payment axis + auto-advance its lifecycle (pending_payment →
    // booked and reserve+schedule; awaiting_final_payment → completed once fully paid).
    try { jobLifecycle.advanceForInvoice(req.business.id, result.invoice); } catch (e) { console.error('[invoices] advanceForInvoice error:', e.message); }
    emitToBusiness(req.business.id, 'invoice_updated', { id: Number(req.params.id) });
    res.json(result.invoice);
  } catch (err) {
    console.error('POST /invoices/:id/mark-paid error:', err);
    res.status(500).json({ error: 'Failed to mark invoice paid' });
  }
});

module.exports = router;
