const express = require('express');
const router = express.Router();
const { logActivity } = require('../services/activityLog');
const { emitToBusiness } = require('../socket');
const invoiceService = require('../services/invoiceService');
const connectService = require('../services/connectService');
const { applyPaidIntent } = require('./connect');

// PUBLIC, tokenized invoice surface — opened by the customer from an email/SMS
// link with NO login. The token (public_token) is the only credential; it is
// unguessable (24 random bytes) and scopes access to exactly one invoice. This
// router is intentionally NOT behind requireAuth/attachBusiness. It returns a
// sanitized view of the invoice (internal evidence like IP/User-Agent is never
// echoed back), accepts the e-signature, and (when the business has Stripe Connect
// payments enabled) collects a card payment as a direct charge on that business's
// connected account.

// Whether this invoice can be paid online right now: the business finished Connect
// onboarding (charges enabled) AND the invoice still owes a balance and isn't void.
// Returns the shape invoiceService.toPublic expects.
function paymentStateFor(invoice) {
  if (!invoice || invoice.status === 'paid' || invoice.paid_at || invoice.status === 'void') {
    return { enabled: false };
  }
  const outstanding = Number(invoice.total || 0) - Number(invoice.amount_paid || 0);
  if (outstanding < 0.5) return { enabled: false };

  const business = connectService.loadBusiness(invoice.business_id);
  if (!business || !connectService.isConfigured() || !business.connect_charges_enabled || !business.stripe_connect_account_id) {
    return { enabled: false };
  }
  return {
    enabled: true,
    connectedAccountId: business.stripe_connect_account_id,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
  };
}

// Build the sanitized public payload (branding + payment state) for an invoice row.
function publicView(invoice) {
  const branding = invoiceService.getBusinessBranding(invoice.business_id);
  return invoiceService.toPublic(invoice, branding, paymentStateFor(invoice));
}

// GET /api/public/invoices/:token — the public invoice view (line items, terms,
// balance, branding, pay-enabled flag). Records first-view time for the owner.
router.get('/:token', (req, res) => {
  try {
    const invoice = invoiceService.getInvoiceByToken(req.params.token);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    invoiceService.recordView(req.params.token);
    res.json(publicView(invoice));
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

    res.json(publicView(signed));
  } catch (err) {
    console.error('POST /public/invoices/:token/sign error:', err);
    res.status(500).json({ error: 'Failed to record signature' });
  }
});

// POST /api/public/invoices/:token/delivery-details — let the CUSTOMER verify and
// correct their OWN delivery address (+ access notes) before signing/paying. The
// token is the only credential (same model as /sign). The service STRICTLY whitelists
// the fields (address + notes only — never size/dates/price/contact/status) and writes
// the corrected address to the LEAD's vertical_data.deliveryAddress, so it goes live to
// the schedule/dispatch immediately. Blocked once the invoice is signed/paid/void.
router.post('/:token/delivery-details', (req, res) => {
  try {
    const b = req.body || {};
    const payload = { deliveryAddress: b.deliveryAddress ?? b.delivery_address };
    // Only touch access notes when the client actually sent the key.
    const notesKeys = ['accessNotes', 'access_notes', 'deliveryNotes', 'delivery_notes'];
    if (notesKeys.some((k) => k in b)) {
      payload.accessNotes = b.accessNotes ?? b.access_notes ?? b.deliveryNotes ?? b.delivery_notes;
    }

    const result = invoiceService.updateDeliveryDetailsByToken(req.params.token, payload);

    if (result.error === 'not_found') return res.status(404).json({ error: 'Invoice not found' });
    if (result.error === 'no_lead') return res.status(409).json({ error: 'This invoice has no delivery details to update.' });
    if (result.error === 'void') return res.status(409).json({ error: 'This invoice is no longer active.' });
    if (result.error === 'locked') return res.status(409).json({ error: 'This invoice has been signed and can no longer be changed. Please contact the business to update your address.' });
    if (result.error === 'address_required') return res.status(400).json({ error: 'Please enter your delivery address.' });
    if (result.error === 'address_too_long') return res.status(400).json({ error: 'That address is too long.' });

    // Notify the owner: a prominent flag (set on the lead by the service) plus a
    // timeline entry on the linked job and a live dashboard refresh. Only an actual
    // address change raises the flag/timeline; a notes-only tweak is logged quietly.
    if (result.changed && result.lead) {
      if (result.addressChanged) {
        const from = result.prevAddress || 'not set';
        logActivity(result.lead.id, 'address_corrected', `Customer corrected the delivery address: ${from} → ${result.nextAddress}`);
      } else if (result.notesChanged) {
        logActivity(result.lead.id, 'job_updated', 'Customer updated delivery access notes.');
      }
      emitToBusiness(result.lead.business_id, 'lead_updated', result.lead);
    }

    res.json(publicView(result.invoice));
  } catch (err) {
    console.error('POST /public/invoices/:token/delivery-details error:', err);
    res.status(500).json({ error: 'Failed to update delivery details' });
  }
});

// POST /api/public/invoices/:token/create-payment-intent — start a card payment.
// Creates (or reuses) a PaymentIntent as a DIRECT CHARGE on the business's
// connected account and returns the client_secret + connected account id so the
// browser can mount Stripe Elements. Card data never touches our server.
router.post('/:token/create-payment-intent', async (req, res) => {
  try {
    const invoice = invoiceService.getInvoiceByToken(req.params.token);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid' || invoice.paid_at) return res.json({ alreadyPaid: true });

    // Gate: an invoice that carries a contract must be signed before any charge can
    // start. This is the real enforcement point — the client also disables the Pay
    // UI until signed, but never trust that alone. A PaymentIntent can only ever be
    // created here, so this single gate also keeps the webhook/confirm paths from
    // ever flipping an unsigned invoice to paid.
    if (invoiceService.requiresSignature(invoice) && !invoice.signed_at) {
      return res.status(409).json({ error: 'Please sign this invoice before paying.' });
    }

    const business = connectService.loadBusiness(invoice.business_id);
    if (!business || !connectService.isConfigured() || !business.connect_charges_enabled) {
      return res.status(409).json({ error: 'This business is not accepting online payments yet.' });
    }

    const result = await connectService.createInvoicePaymentIntent(invoice, business);
    if (result.alreadyPaid) return res.json({ alreadyPaid: true });

    // Remember the intent on the invoice so the webhook / confirm can resolve it.
    invoiceService.attachPaymentIntent(business.id, invoice.id, result.paymentIntentId);
    res.json(result);
  } catch (err) {
    if (err.code === 'payments_not_enabled') return res.status(409).json({ error: err.message });
    if (err.code === 'nothing_due') return res.status(400).json({ error: err.message });
    console.error('POST /public/invoices/:token/create-payment-intent error:', err);
    res.status(500).json({ error: 'Failed to start payment' });
  }
});

// POST /api/public/invoices/:token/confirm-payment — confirm a just-completed
// payment WITHOUT waiting for the async Connect webhook. Retrieves the intent on
// the connected account and, if it succeeded, flips the invoice to paid. Fully
// idempotent with the webhook (whichever lands first wins). This keeps the flow
// working even before STRIPE_CONNECT_WEBHOOK_SECRET is registered. Returns the
// refreshed public invoice. Body: { paymentIntentId } (optional — falls back to
// the intent stored on the invoice).
router.post('/:token/confirm-payment', async (req, res) => {
  try {
    const invoice = invoiceService.getInvoiceByToken(req.params.token);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const business = connectService.loadBusiness(invoice.business_id);
    if (!business) return res.status(404).json({ error: 'Invoice not found' });

    // Already paid → just return current state.
    if (invoice.status === 'paid' || invoice.paid_at) return res.json(publicView(invoice));

    // Defense-in-depth: never reconcile an unsigned invoice to paid. In the normal
    // flow this can't happen (the intent could only have been created post-signature
    // above), but guard the state-flipping endpoint directly too.
    if (invoiceService.requiresSignature(invoice) && !invoice.signed_at) {
      return res.status(409).json({ error: 'Please sign this invoice before paying.' });
    }

    const piId = (req.body && (req.body.paymentIntentId || req.body.payment_intent_id)) || invoice.stripe_payment_intent_id;
    if (!piId || !connectService.isConfigured() || !business.stripe_connect_account_id) {
      return res.status(400).json({ error: 'No payment to confirm.' });
    }

    const pi = await connectService.retrievePaymentIntent(business.stripe_connect_account_id, piId);
    if (pi && pi.status === 'succeeded') {
      applyPaidIntent(business.stripe_connect_account_id, pi);
    }

    const fresh = invoiceService.getInvoiceByToken(req.params.token);
    res.json(publicView(fresh));
  } catch (err) {
    console.error('POST /public/invoices/:token/confirm-payment error:', err);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

module.exports = router;
