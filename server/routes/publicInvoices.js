const express = require('express');
const router = express.Router();
const { logActivity } = require('../services/activityLog');
const { emitToBusiness } = require('../socket');
const invoiceService = require('../services/invoiceService');

// PUBLIC, tokenized invoice surface — opened by the customer from an email/SMS
// link with NO login. The token (public_token) is the only credential; it is
// unguessable (24 random bytes) and scopes access to exactly one invoice. This
// router is intentionally NOT behind requireAuth/attachBusiness. It returns a
// sanitized view of the invoice (internal evidence like IP/User-Agent is never
// echoed back) and accepts the e-signature.

// GET /api/public/invoices/:token — the public invoice view (line items, terms,
// balance, branding). Records first-view time for the owner.
router.get('/:token', (req, res) => {
  try {
    const invoice = invoiceService.getInvoiceByToken(req.params.token);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    invoiceService.recordView(req.params.token);
    const branding = invoiceService.getBusinessBranding(invoice.business_id);
    res.json(invoiceService.toPublic(invoice, branding));
  } catch (err) {
    console.error('GET /public/invoices/:token error:', err);
    res.status(500).json({ error: 'Failed to load invoice' });
  }
});

// POST /api/public/invoices/:token/sign — capture the customer's e-signature.
// Body: { signerName, signatureData, signatureType: 'typed' | 'drawn' }.
// Stores the signature + full name + timestamp + IP + User-Agent as dispute
// evidence, snapshots the exact terms signed, and flips status to 'signed'.
router.post('/:token/sign', (req, res) => {
  try {
    const b = req.body || {};
    const result = invoiceService.signInvoice(req.params.token, {
      signerName: b.signerName || b.signer_name,
      signatureData: b.signatureData || b.signature_data,
      signatureType: b.signatureType || b.signature_type,
      // trust proxy is enabled in index.js, so req.ip is the real client IP.
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (result.error === 'not_found') return res.status(404).json({ error: 'Invoice not found' });
    if (result.error === 'already_signed') return res.status(409).json({ error: 'This invoice has already been signed' });
    if (result.error === 'void') return res.status(409).json({ error: 'This invoice is no longer active' });
    if (result.error === 'name_required') return res.status(400).json({ error: 'Please enter your full name' });
    if (result.error === 'signature_required') return res.status(400).json({ error: 'A signature is required' });
    if (result.error === 'signature_too_large') return res.status(413).json({ error: 'Signature image is too large' });

    const signed = result.invoice;
    // Notify the owner (timeline entry on the linked job + live dashboard event).
    if (signed.lead_id) logActivity(signed.lead_id, 'invoice_signed', `Invoice ${signed.invoice_number} signed by ${signed.signer_name}`);
    emitToBusiness(signed.business_id, 'invoice_updated', { id: signed.id, signed: true });

    const branding = invoiceService.getBusinessBranding(signed.business_id);
    res.json(invoiceService.toPublic(signed, branding));
  } catch (err) {
    console.error('POST /public/invoices/:token/sign error:', err);
    res.status(500).json({ error: 'Failed to record signature' });
  }
});

module.exports = router;
