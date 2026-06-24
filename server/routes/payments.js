const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const connectService = require('../services/connectService');
const invoiceService = require('../services/invoiceService');
const { applyRefund } = require('./connect');

// ── Payments / Transactions (owner-facing) ─────────────────────────────────────
// The card payments a business has RECEIVED on its OWN Stripe Connect account, plus
// in-app refunds (full or partial). Hard-auth and business-scoped: a connected
// account belongs to exactly one business, so every read/refund here can only touch
// this tenant's money. Stripe is the source of truth — refundable balances and
// fees come straight from Stripe and a refund is validated against a freshly-read
// charge, so we can never over-refund or act on stale figures.
//
// SEPARATE from /api/billing (the $149/mo platform subscription on Stream's own
// account). This path only ever talks to the business's connected account through
// connectService. It is also a clean JSON API so iOS can consume it later.
router.use(requireAuth);

function ensureConfigured(res) {
  if (!connectService.isConfigured()) {
    res.status(503).json({ error: 'Payments are not configured' });
    return false;
  }
  return true;
}

// Card brand/last4 from whichever method the charge used (a plain card, a wallet
// like Apple/Google Pay that still carries the underlying card brand, or a
// card-present tap). Falls back to the payment-method type when there's no card.
function cardInfo(charge) {
  const d = charge.payment_method_details || {};
  const card = d.card || d.card_present || {};
  return {
    brand: card.brand || d.type || null,
    last4: card.last4 || null,
    wallet: card.wallet && card.wallet.type ? card.wallet.type : null,
  };
}

// Refund status of a charge from its cumulative refunded total vs the amount.
function refundStatus(charge) {
  const amount = charge.amount || 0;
  const refunded = charge.amount_refunded || 0;
  if (refunded <= 0) return 'paid';
  if (refunded >= amount) return 'refunded';
  return 'partially_refunded';
}

function centsToDollars(c) {
  return Math.round((Number(c) || 0)) / 100;
}

// A compact, client-friendly row for the transactions list.
function summarizeCharge(charge, invoiceRef) {
  const info = cardInfo(charge);
  return {
    id: charge.id,
    amount: centsToDollars(charge.amount),
    amount_refunded: centsToDollars(charge.amount_refunded),
    currency: (charge.currency || 'usd').toUpperCase(),
    created: charge.created ? new Date(charge.created * 1000).toISOString() : null,
    status: refundStatus(charge),
    card_brand: info.brand,
    card_last4: info.last4,
    wallet: info.wallet,
    customer_name:
      (invoiceRef && (invoiceRef.customer_display_name || invoiceRef.bill_to_name)) ||
      (charge.billing_details && charge.billing_details.name) ||
      null,
    invoice_id: invoiceRef ? invoiceRef.id : null,
    invoice_number: invoiceRef ? invoiceRef.invoice_number : null,
  };
}

// GET /api/payments — the business's received card payments, most recent first.
// Returns { connected, charges_enabled, payments } so the UI can distinguish a
// business that simply hasn't connected Stripe yet from one with no payments.
router.get('/', async (req, res) => {
  if (!ensureConfigured(res)) return;
  try {
    const business = connectService.loadBusiness(req.business.id);
    const accountId = business && business.stripe_connect_account_id;
    if (!accountId) {
      return res.json({ connected: false, charges_enabled: false, payments: [] });
    }

    const charges = await connectService.listConnectedCharges(accountId, { limit: 100 });
    const refs = invoiceService.getInvoiceRefsByPaymentIntent(business.id);
    // Only payments actually received (succeeded + captured). Failed/incomplete
    // attempts aren't money in hand and would just be noise in this view.
    const payments = charges
      .filter((c) => c.status === 'succeeded' && c.paid)
      .map((c) => summarizeCharge(c, c.payment_intent ? refs[c.payment_intent] : null));

    res.json({ connected: true, charges_enabled: !!business.connect_charges_enabled, payments });
  } catch (err) {
    console.error('GET /payments error:', err);
    res.status(500).json({ error: 'Failed to load payments' });
  }
});

// GET /api/payments/:id — one charge with Stripe fee + net, refund history, and the
// linked invoice/customer. :id is a Stripe charge id (ch_…).
router.get('/:id', async (req, res) => {
  if (!ensureConfigured(res)) return;
  try {
    const business = connectService.loadBusiness(req.business.id);
    const accountId = business && business.stripe_connect_account_id;
    if (!accountId) return res.status(404).json({ error: 'No payments account connected' });

    const charge = await connectService.retrieveCharge(accountId, req.params.id);
    if (!charge) return res.status(404).json({ error: 'Payment not found' });

    // Resolve the invoice this charge paid: PaymentIntent metadata first, then the
    // PI id we stored on the invoice when the pay flow started.
    const pi = charge.payment_intent && typeof charge.payment_intent === 'object' ? charge.payment_intent : null;
    const piId = pi ? pi.id : (typeof charge.payment_intent === 'string' ? charge.payment_intent : null);
    let invoice = null;
    const metaInvoiceId = pi && pi.metadata && pi.metadata.invoice_id;
    if (metaInvoiceId) invoice = invoiceService.getInvoice(business.id, metaInvoiceId);
    if (!invoice && piId) invoice = invoiceService.findByPaymentIntent(business.id, piId);

    const bt = charge.balance_transaction && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
    const info = cardInfo(charge);
    const amount = centsToDollars(charge.amount);
    const amountRefunded = centsToDollars(charge.amount_refunded);

    // Per-refund history (best-effort — the status/refundable math below relies on
    // amount_refunded, not this list, so a failure here doesn't break the view).
    let refunds = [];
    try {
      refunds = (await connectService.listChargeRefunds(accountId, charge.id)).map((r) => ({
        id: r.id,
        amount: centsToDollars(r.amount),
        created: r.created ? new Date(r.created * 1000).toISOString() : null,
        status: r.status,
        reason: r.reason || null,
      }));
    } catch (e) {
      console.error('[payments] refund history fetch failed:', e.message);
    }

    res.json({
      id: charge.id,
      amount,
      amount_refunded: amountRefunded,
      refundable_amount: Math.max(0, Math.round((amount - amountRefunded) * 100) / 100),
      currency: (charge.currency || 'usd').toUpperCase(),
      created: charge.created ? new Date(charge.created * 1000).toISOString() : null,
      status: refundStatus(charge),
      card_brand: info.brand,
      card_last4: info.last4,
      wallet: info.wallet,
      // Stripe fee + net, in the settlement currency, straight off the balance
      // transaction (null until the charge settles and the txn is available).
      fee: bt ? centsToDollars(bt.fee) : null,
      net: bt ? centsToDollars(bt.net) : null,
      fee_currency: bt && bt.currency ? bt.currency.toUpperCase() : null,
      customer_name:
        (invoice && invoice.bill_to_name) ||
        (charge.billing_details && charge.billing_details.name) ||
        null,
      invoice: invoice ? { id: invoice.id, invoice_number: invoice.invoice_number } : null,
      receipt_url: charge.receipt_url || null,
      refunds,
    });
  } catch (err) {
    if (err && err.statusCode === 404) return res.status(404).json({ error: 'Payment not found' });
    console.error('GET /payments/:id error:', err);
    res.status(500).json({ error: 'Failed to load payment' });
  }
});

// POST /api/payments/:id/refund — refund a charge on the connected account, full or
// partial. Body: { amount } in dollars (omit/null ⇒ full remaining). We re-read the
// charge and validate against Stripe's live refundable balance before refunding, so
// concurrent/partial refunds can never push the total over the charge amount.
router.post('/:id/refund', async (req, res) => {
  if (!ensureConfigured(res)) return;
  try {
    const business = connectService.loadBusiness(req.business.id);
    const accountId = business && business.stripe_connect_account_id;
    if (!accountId) return res.status(404).json({ error: 'No payments account connected' });

    const charge = await connectService.retrieveCharge(accountId, req.params.id);
    if (!charge) return res.status(404).json({ error: 'Payment not found' });
    if (charge.status !== 'succeeded' || !charge.paid) {
      return res.status(400).json({ error: 'This payment cannot be refunded' });
    }

    const refundableCents = Math.max(0, (charge.amount || 0) - (charge.amount_refunded || 0));
    if (refundableCents <= 0) {
      return res.status(400).json({ error: 'This payment has already been fully refunded' });
    }

    // Resolve the requested amount → cents. Missing/blank/null ⇒ full remaining.
    let amountCents;
    const rawAmount = req.body ? req.body.amount : undefined;
    if (rawAmount === undefined || rawAmount === null || rawAmount === '') {
      amountCents = refundableCents;
    } else {
      const dollars = Number(rawAmount);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        return res.status(400).json({ error: 'Enter a valid refund amount' });
      }
      amountCents = Math.round(dollars * 100);
      if (amountCents > refundableCents) {
        return res.status(400).json({ error: `Refund exceeds the refundable amount ($${(refundableCents / 100).toFixed(2)}).` });
      }
    }

    const refund = await connectService.createRefund(accountId, charge.id, amountCents);

    // Reflect on the linked invoice (refunded / partially-refunded badge, timeline
    // entry, live socket) by REUSING the exact path the Connect webhook uses — it's
    // idempotent, so the later charge.refunded webhook is a no-op. We re-read the
    // charge so the reflection records the new cumulative refunded total.
    let invoice = null;
    try {
      const fresh = await connectService.retrieveCharge(accountId, charge.id);
      invoice = applyRefund(accountId, fresh) || null;
    } catch (e) {
      console.error('[payments] refund reflection failed (refund itself succeeded):', e.message);
    }

    const newRefundedCents = (charge.amount_refunded || 0) + amountCents;
    const fullyRefunded = newRefundedCents >= (charge.amount || 0);
    res.json({
      ok: true,
      refund: { id: refund.id, amount: centsToDollars(refund.amount), status: refund.status },
      status: fullyRefunded ? 'refunded' : 'partially_refunded',
      amount_refunded: newRefundedCents / 100,
      refundable_amount: Math.max(0, (charge.amount || 0) - newRefundedCents) / 100,
      invoice: invoice ? { id: invoice.id, invoice_number: invoice.invoice_number } : null,
    });
  } catch (err) {
    // Surface Stripe's own message (e.g. "charge already refunded") when present.
    const msg = err && err.raw && err.raw.message ? err.raw.message : (err.message || 'Refund failed');
    console.error('POST /payments/:id/refund error:', err);
    res.status(400).json({ error: msg });
  }
});

module.exports = router;
// Pure Stripe-object → API-shape mappers, exposed for unit tests (no network).
module.exports.__test__ = { cardInfo, refundStatus, summarizeCharge, centsToDollars };
