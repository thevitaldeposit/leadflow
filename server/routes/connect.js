const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../services/activityLog');
const { emitToBusiness } = require('../socket');
const connectService = require('../services/connectService');
const invoiceService = require('../services/invoiceService');

// ── Stripe Connect (Express) — owner onboarding + Connect webhook ──────────────
// Owner-facing endpoints (authed) let a business connect its own Stripe to accept
// invoice payments. This is SEPARATE from /api/billing (the platform subscription):
// different Stripe objects, different webhook, different signing secret. The
// customer-facing pay action lives in routes/publicInvoices.js (no auth).

// Absolute base URL for Account Link return/refresh targets. Mirrors invoices.js:
// prefers PUBLIC_APP_URL, else derives from the request (trust proxy is on).
function appBaseUrl(req) {
  const env = process.env.PUBLIC_APP_URL;
  if (env) return env.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function ensureConfigured(res) {
  if (!connectService.isConfigured()) {
    res.status(503).json({ error: 'Payments are not configured' });
    return false;
  }
  return true;
}

// GET /api/connect/status — live Connect status for the business (syncs the cached
// flags from Stripe so a freshly-completed or newly-restricted account is accurate).
router.get('/status', requireAuth, async (req, res) => {
  try {
    const business = connectService.loadBusiness(req.business.id);
    const status = await connectService.getStatus(business, { sync: connectService.isConfigured() });
    res.json(status);
  } catch (err) {
    console.error('GET /connect/status error:', err);
    res.status(500).json({ error: 'Failed to load payment status' });
  }
});

// POST /api/connect/onboard — create (or reuse) the Express account and return a
// fresh Stripe-hosted onboarding link. The client redirects the browser to it.
// Used both for first-time setup and to resume/finish an incomplete account.
router.post('/onboard', requireAuth, async (req, res) => {
  if (!ensureConfigured(res)) return;
  try {
    const business = connectService.loadBusiness(req.business.id);
    const base = appBaseUrl(req);
    const { url } = await connectService.createOnboardingLink(business, {
      // refresh_url is hit when the link expires before completion → client asks
      // for a new one. return_url is hit when the user finishes/returns → client
      // re-checks status.
      refreshUrl: `${base}/settings?connect=refresh`,
      returnUrl: `${base}/settings?connect=return`,
    });
    res.json({ url });
  } catch (err) {
    console.error('POST /connect/onboard error:', err);
    res.status(500).json({ error: 'Failed to start payment onboarding' });
  }
});

// ── Connect webhook ────────────────────────────────────────────────────────────
// Mounted in index.js with express.raw() BEFORE express.json() (signature needs
// the raw body), at a DIFFERENT path than the subscription webhook and verified
// with a DIFFERENT secret (STRIPE_CONNECT_WEBHOOK_SECRET).
//
// DASHBOARD: register ONE destination with scope = "Connected accounts" (these are
// v1 snapshot events from connected accounts; v1 connected-account events route to
// this scope — the v2 "thin" account events on the "Your account" scope are NOT
// used here). Events to enable:
//   account.updated               onboarding finished / restricted → enable/disable
//   payment_intent.succeeded      invoice paid
//   payment_intent.payment_failed (optional) log only
//   charge.refunded               (recommended) reflect a refund on the invoice
//   charge.dispute.created        (optional) surface a dispute on the timeline

// Mark an invoice paid from a succeeded PaymentIntent (shared by the webhook and
// the public confirm fallback). Idempotent via invoiceService.recordOnlinePayment.
// Returns the resulting invoice or null when it can't be resolved.
function applyPaidIntent(accountId, paymentIntent) {
  const business = connectService.getBusinessByConnectAccount(accountId);
  if (!business) {
    console.warn('[connect] paid intent for unknown connected account', accountId);
    return null;
  }

  // Prefer the invoice_id we stamped in metadata; fall back to the stored intent id.
  const metaId = paymentIntent.metadata && paymentIntent.metadata.invoice_id;
  let invoice = null;
  if (metaId) invoice = invoiceService.getInvoice(business.id, metaId);
  if (!invoice) invoice = invoiceService.findByPaymentIntent(business.id, paymentIntent.id);
  if (!invoice) {
    console.warn('[connect] paid intent had no matching invoice', paymentIntent.id);
    return null;
  }

  const cents = paymentIntent.amount_received != null ? paymentIntent.amount_received : paymentIntent.amount;
  const result = invoiceService.recordOnlinePayment(business.id, invoice.id, {
    amountPaid: typeof cents === 'number' ? cents / 100 : undefined,
    reference: paymentIntent.id,
    paymentIntentId: paymentIntent.id,
  });
  if (result.error) return null;

  // Only notify on the transition (idempotent: the second caller is a no-op).
  if (!result.alreadyPaid) {
    if (result.invoice.lead_id) {
      logActivity(result.invoice.lead_id, 'invoice_paid', `Invoice ${result.invoice.invoice_number} paid online`);
    }
    emitToBusiness(business.id, 'invoice_updated', { id: result.invoice.id, paid: true });
    console.log(`[connect] invoice ${result.invoice.invoice_number} (business ${business.id}) marked paid via ${paymentIntent.id}`);
  }
  return result.invoice;
}

// Reflect a refund the business issued on its connected account. We move no money
// (the connected account does); we only record the refunded amount so the invoice
// stops reading as plainly "paid". Resolves the invoice from the charge's
// PaymentIntent. Idempotent via invoiceService.recordRefund.
function applyRefund(accountId, charge) {
  const business = connectService.getBusinessByConnectAccount(accountId);
  if (!business) { console.warn('[connect] refund for unknown connected account', accountId); return null; }
  const piId = charge.payment_intent;
  const invoice = piId ? invoiceService.findByPaymentIntent(business.id, piId) : null;
  if (!invoice) { console.warn('[connect] refund had no matching invoice', charge.id); return null; }

  const cents = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
  const result = invoiceService.recordRefund(business.id, invoice.id, { amountRefunded: cents / 100 });
  if (result.error || !result.changed) return result.invoice || null;

  if (result.invoice.lead_id) {
    const label = result.fullyRefunded ? 'refunded' : 'partially refunded';
    logActivity(result.invoice.lead_id, 'invoice_refunded', `Invoice ${result.invoice.invoice_number} ${label} ($${(cents / 100).toFixed(2)})`);
  }
  emitToBusiness(business.id, 'invoice_updated', { id: result.invoice.id, refunded: true });
  console.log(`[connect] invoice ${result.invoice.invoice_number} (business ${business.id}) refunded $${(cents / 100).toFixed(2)} via ${charge.id}`);
  return result.invoice;
}

// Surface a dispute/chargeback on the owner's timeline. VISIBILITY ONLY — for
// direct charges the connected account is the merchant of record and resolves
// disputes in its own Express Dashboard (and bears liability), so Stream changes
// no invoice state.
function applyDispute(accountId, dispute) {
  const business = connectService.getBusinessByConnectAccount(accountId);
  if (!business) { console.warn('[connect] dispute for unknown connected account', accountId); return null; }
  const piId = dispute.payment_intent;
  const invoice = piId ? invoiceService.findByPaymentIntent(business.id, piId) : null;
  if (invoice && invoice.lead_id) {
    const amt = typeof dispute.amount === 'number' ? (dispute.amount / 100).toFixed(2) : '?';
    logActivity(invoice.lead_id, 'invoice_disputed', `Invoice ${invoice.invoice_number} payment disputed ($${amt}) — resolve in your Stripe Express dashboard`);
  }
  if (invoice) emitToBusiness(business.id, 'invoice_updated', { id: invoice.id, disputed: true });
  console.log(`[connect] dispute ${dispute.id} on ${accountId} (invoice ${invoice ? invoice.invoice_number : 'unknown'})`);
  return invoice;
}

function handleConnectWebhook(req, res) {
  if (!connectService.isConfigured()) {
    return res.status(503).send('Payments are not configured');
  }
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[connect] STRIPE_CONNECT_WEBHOOK_SECRET not set — rejecting webhook');
    return res.status(503).send('Connect webhook secret not configured');
  }

  let event;
  try {
    event = connectService.stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('[connect] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // event.account is the connected account the event originated from.
    const accountId = event.account || null;
    switch (event.type) {
      case 'account.updated': {
        connectService.applyAccountUpdate(accountId, event.data.object);
        break;
      }
      case 'payment_intent.succeeded': {
        applyPaidIntent(accountId, event.data.object);
        break;
      }
      case 'payment_intent.payment_failed': {
        // No state change — the invoice simply stays unpaid and the customer can
        // retry. Logged for visibility only.
        const pi = event.data.object;
        console.log(`[connect] payment_intent.payment_failed ${pi.id} on ${accountId}`);
        break;
      }
      case 'charge.refunded': {
        applyRefund(accountId, event.data.object);
        break;
      }
      case 'charge.dispute.created': {
        applyDispute(accountId, event.data.object);
        break;
      }
      default:
        // Acknowledge unhandled types so Stripe stops retrying.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[connect] Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

module.exports = { router, handleConnectWebhook, applyPaidIntent };
