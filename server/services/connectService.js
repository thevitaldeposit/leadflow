const db = require('../db/database');

// ── Stripe Connect (Express) — per-business customer payments ──────────────────
// This module is the ISOLATED Connect layer. It is deliberately kept separate from
// the $149/mo platform subscription billing in routes/billing.js:
//   • Subscriptions = direct charges on Stream's OWN Stripe account (the platform).
//   • Connect (here) = each business onboards its OWN Express connected account and
//     the end customer pays an invoice directly on that account (a "direct charge").
// They share only the API key, not code or webhooks. We instantiate a dedicated
// Stripe client (same STRIPE_SECRET_KEY, no new key) so this path can never be
// entangled with the subscription client or its pinned signup API version.
//
// Charge model (matches the platform's dashboard settings, do not change):
//   Express · sellers collect payments directly · Stripe-hosted onboarding ·
//   NO platform application fee · Stripe/seller handle liability + disputes.
// Because the platform's controller defaults are configured in the Dashboard,
// creating an account with `type: 'express'` inherits them — we don't override.
//
// API VERSION: pinned to a known-good version (same as billing's signup client)
// so our outbound calls return STABLE shapes regardless of the account's evolving
// default version (Connect/Accounts is mid-migration to v2). We deliberately use
// the v1 Accounts/PaymentIntent API + v1 (snapshot) webhook events — v1 events for
// connected accounts route to the "Connected accounts" webhook scope and carry the
// full object in `event.data.object`, which this module's handlers read. (The v2
// "thin" account events route to the "Your account" scope and are NOT used here.)
const CONNECT_API_VERSION = '2024-06-20';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET_KEY
  ? require('stripe')(STRIPE_SECRET_KEY, { apiVersion: CONNECT_API_VERSION })
  : null;

// Publishable key for the client. The web client already ships a hardcoded
// publishable key (client/src/utils/stripe.js), so this is optional — returned
// only so a future iOS/native client can read it from the API. Null → client uses
// its own key.
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || null;

// Platform application fee, in basis points (1% = 100 bps) of the invoice total.
// ZEROED HOOK: the platform takes no application fee today (sellers collect
// directly). To start taking a fee later, set CONNECT_APPLICATION_FEE_BPS in the
// environment (e.g. 100 for 1%); it is wired through createInvoicePaymentIntent
// below and applied only when > 0. NOTE: if you instead manage fees via Stripe's
// Dashboard "platform pricing" tool, leave this at 0 so it doesn't override that.
const CONNECT_APPLICATION_FEE_BPS = Number(process.env.CONNECT_APPLICATION_FEE_BPS || 0);
function computeApplicationFee(amountCents) {
  if (!Number.isFinite(CONNECT_APPLICATION_FEE_BPS) || CONNECT_APPLICATION_FEE_BPS <= 0) return 0;
  return Math.round((amountCents * CONNECT_APPLICATION_FEE_BPS) / 10000);
}

// Stripe enforces a per-currency minimum charge (~$0.50 for USD). Pay below this
// is rejected before we ever call Stripe.
const MIN_CHARGE_CENTS = 50;
// PaymentIntent states in which an existing intent can still be paid — used to
// safely reuse an intent when a customer reopens the pay flow instead of leaking a
// new one every reload.
const REUSABLE_PI_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
]);

function isConfigured() {
  return !!stripe;
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

// Load the full businesses row (the auth middleware's req.business carries only a
// public column subset that omits the Connect ids/flags we need here).
function loadBusiness(id) {
  return db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
}
function getBusinessByConnectAccount(accountId) {
  if (!accountId) return null;
  return db.prepare('SELECT * FROM businesses WHERE stripe_connect_account_id = ?').get(accountId);
}

// Collapse a Stripe Account object into the status the UI cares about.
//   ready       → charges_enabled: can accept payments now
//   restricted  → onboarding submitted but Stripe needs more / disabled the account
//   pending     → submitted, Stripe still verifying (no action needed)
//   incomplete  → account exists but onboarding wasn't finished (needs action)
function summarizeAccount(account) {
  const chargesEnabled = !!account.charges_enabled;
  const detailsSubmitted = !!account.details_submitted;
  const payoutsEnabled = !!account.payouts_enabled;
  const req = account.requirements || {};
  const disabledReason = req.disabled_reason || null;
  const pastDue = Array.isArray(req.past_due) ? req.past_due.length : 0;
  const currentlyDue = Array.isArray(req.currently_due) ? req.currently_due.length : 0;

  let status;
  if (chargesEnabled) status = 'ready';
  else if (!detailsSubmitted) status = 'incomplete';
  else if (pastDue > 0 || disabledReason) status = 'restricted';
  else status = 'pending';

  return { status, chargesEnabled, detailsSubmitted, payoutsEnabled, disabledReason, currentlyDue, pastDue };
}

// Persist the cached Connect flags onto the business so reads are cheap and the
// public invoice page can gate payment without a Stripe round-trip.
function persistAccountFlags(businessId, summary, accountId) {
  db.prepare(`
    UPDATE businesses
    SET stripe_connect_account_id = COALESCE(?, stripe_connect_account_id),
        connect_charges_enabled = ?,
        connect_details_submitted = ?,
        connect_payouts_enabled = ?
    WHERE id = ?
  `).run(
    accountId || null,
    summary.chargesEnabled ? 1 : 0,
    summary.detailsSubmitted ? 1 : 0,
    summary.payoutsEnabled ? 1 : 0,
    businessId
  );
}

// Shape the cached columns into the same status object summarizeAccount returns,
// for the no-Stripe-call fallback. Can't know 'restricted' from the cache (we
// don't store requirements), so a not-yet-ready submitted account reads 'pending'.
function statusFromCache(business) {
  const chargesEnabled = !!business.connect_charges_enabled;
  const detailsSubmitted = !!business.connect_details_submitted;
  const payoutsEnabled = !!business.connect_payouts_enabled;
  let status;
  if (chargesEnabled) status = 'ready';
  else if (detailsSubmitted) status = 'pending';
  else status = 'incomplete';
  return { status, chargesEnabled, detailsSubmitted, payoutsEnabled, disabledReason: null, currentlyDue: 0, pastDue: 0 };
}

// The Connect status for a business. When `sync` and Stripe is configured and an
// account exists, retrieves the live Account (and refreshes the cache) so the UI
// reflects reality including a freshly-completed or newly-restricted account;
// falls back to the cached flags on any Stripe error.
async function getStatus(business, { sync = false } = {}) {
  const accountId = business.stripe_connect_account_id || null;
  if (!accountId) {
    return { connected: false, status: 'not_connected', accountId: null, chargesEnabled: false, detailsSubmitted: false, payoutsEnabled: false, disabledReason: null };
  }

  if (sync && stripe) {
    try {
      const account = await stripe.accounts.retrieve(accountId);
      const summary = summarizeAccount(account);
      persistAccountFlags(business.id, summary, accountId);
      return { connected: true, accountId, ...summary };
    } catch (err) {
      console.error('[connect] getStatus live retrieve failed, using cache:', err.message);
    }
  }

  return { connected: true, accountId, ...statusFromCache(business) };
}

// Read the owner's email to prefill Express onboarding (best-effort — onboarding
// collects it anyway). Wrapped because the users schema can vary by deploy.
function ownerEmailFor(businessId) {
  try {
    const row = db.prepare('SELECT email FROM users WHERE business_id = ? AND email IS NOT NULL ORDER BY id ASC LIMIT 1').get(businessId);
    return row && row.email ? row.email : undefined;
  } catch {
    return undefined;
  }
}

// Ensure the business has an Express connected account, creating + persisting one
// on first use. Returns the connected account id (acct_…).
async function createOrGetAccount(business) {
  if (business.stripe_connect_account_id) return business.stripe_connect_account_id;
  const account = await stripe.accounts.create({
    // `type: 'express'` inherits the platform's Dashboard-configured controller
    // defaults (Stripe-hosted onboarding, direct charges, fee/liability settings).
    type: 'express',
    email: ownerEmailFor(business.id),
    business_profile: business.name ? { name: business.name } : undefined,
    metadata: { business_id: String(business.id) },
  });
  db.prepare('UPDATE businesses SET stripe_connect_account_id = ? WHERE id = ?').run(account.id, business.id);
  return account.id;
}

// Create a single-use, short-lived Account Link for Stripe-hosted Express
// onboarding. refresh_url is hit if the link expires/needs regenerating;
// return_url is hit when the user finishes (or backs out of) onboarding.
async function createOnboardingLink(business, { refreshUrl, returnUrl }) {
  const accountId = await createOrGetAccount(business);
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return { url: link.url, accountId };
}

// Retrieve a PaymentIntent that lives on a connected account (direct charge).
function retrievePaymentIntent(accountId, paymentIntentId) {
  return stripe.paymentIntents.retrieve(paymentIntentId, { stripeAccount: accountId });
}

// Create (or safely reuse) a PaymentIntent for the invoice's OUTSTANDING balance
// as a DIRECT CHARGE on the business's connected account. The connected account is
// the merchant of record; card data never touches our server (the client collects
// it with Stripe Elements). Returns the data the client needs to mount the
// PaymentElement against the connected account.
//   Reuse: if the invoice already has an open intent for the same amount/currency,
//   return it instead of orphaning a new one on every reload.
async function createInvoicePaymentIntent(invoice, business) {
  const accountId = business.stripe_connect_account_id;
  if (!accountId || !business.connect_charges_enabled) {
    const e = new Error('This business is not set up to accept online payments yet.');
    e.code = 'payments_not_enabled';
    throw e;
  }
  if (invoice.status === 'paid' || invoice.paid_at) {
    return { alreadyPaid: true };
  }

  const currency = String(invoice.currency || 'USD').toLowerCase();
  const outstanding = round2(Number(invoice.total || 0) - Number(invoice.amount_paid || 0));
  const amountCents = Math.round(outstanding * 100);
  if (amountCents < MIN_CHARGE_CENTS) {
    const e = new Error('This invoice has no balance due.');
    e.code = 'nothing_due';
    throw e;
  }

  // Reuse an existing, still-payable intent for the same amount/currency.
  if (invoice.stripe_payment_intent_id) {
    try {
      const existing = await retrievePaymentIntent(accountId, invoice.stripe_payment_intent_id);
      if (existing && existing.status === 'succeeded') {
        return { alreadyPaid: true };
      }
      if (existing && REUSABLE_PI_STATUSES.has(existing.status) && existing.amount === amountCents && existing.currency === currency) {
        return {
          clientSecret: existing.client_secret,
          paymentIntentId: existing.id,
          connectedAccountId: accountId,
          publishableKey: PUBLISHABLE_KEY,
          amount: amountCents,
          currency,
        };
      }
      // Stale (canceled / amount changed) — let it go and create a fresh one.
    } catch (err) {
      console.error('[connect] reuse retrieve failed, creating new intent:', err.message);
    }
  }

  const params = {
    amount: amountCents,
    currency,
    automatic_payment_methods: { enabled: true },
    description: invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : 'Invoice payment',
    // Correlate the eventual webhook / confirm back to this exact invoice + tenant.
    metadata: {
      invoice_id: String(invoice.id),
      business_id: String(business.id),
      invoice_number: invoice.invoice_number || '',
    },
  };
  const fee = computeApplicationFee(amountCents);
  if (fee > 0) params.application_fee_amount = fee; // omitted by default → no platform fee

  const pi = await stripe.paymentIntents.create(params, { stripeAccount: accountId });
  return {
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    connectedAccountId: accountId,
    publishableKey: PUBLISHABLE_KEY,
    amount: amountCents,
    currency,
  };
}

// ── Transactions & refunds (owner-facing Payments view) ────────────────────────
// All reads/writes here target the business's connected account (direct charges),
// so they are inherently business-scoped: a connected account belongs to exactly
// one business. Stripe is the SOURCE OF TRUTH for amounts, fees, and the refundable
// balance — a refund is always validated against a freshly-read charge, never a
// cached figure. The money moves on the connected account's balance (it is the
// merchant of record); the platform takes no leg in any of this.

// Recent charges on a connected account, most recent first. Card brand/last4 and
// the cumulative refunded total live on each charge; fee/net (the balance
// transaction) are fetched per-charge in retrieveCharge to keep this list cheap.
async function listConnectedCharges(accountId, { limit = 100 } = {}) {
  const res = await stripe.charges.list({ limit }, { stripeAccount: accountId });
  return Array.isArray(res.data) ? res.data : [];
}

// One charge with the balance transaction (Stripe fee + net) and its PaymentIntent
// (whose metadata correlates back to the invoice) expanded, on the connected acct.
async function retrieveCharge(accountId, chargeId) {
  return stripe.charges.retrieve(
    chargeId,
    { expand: ['balance_transaction', 'payment_intent'] },
    { stripeAccount: accountId }
  );
}

// The refunds already issued against a charge (most recent first), on the connected
// account. Listed separately rather than relying on charge.refunds, whose default
// inclusion on the charge object varies by API version.
async function listChargeRefunds(accountId, chargeId, { limit = 100 } = {}) {
  const res = await stripe.refunds.list({ charge: chargeId, limit }, { stripeAccount: accountId });
  return Array.isArray(res.data) ? res.data : [];
}

// Issue a refund against a charge on the connected account. Full refund when
// amountCents is omitted/null; partial for a positive amount. The connected account
// is the merchant of record, so the money leaves ITS balance — no platform leg.
async function createRefund(accountId, chargeId, amountCents) {
  const params = { charge: chargeId };
  if (Number.isFinite(amountCents) && amountCents > 0) params.amount = Math.round(amountCents);
  return stripe.refunds.create(params, { stripeAccount: accountId });
}

// Webhook handler helper: refresh a business's cached Connect flags from an
// account.updated event payload, keyed by the connected account id.
function applyAccountUpdate(accountId, account) {
  const business = getBusinessByConnectAccount(accountId);
  if (!business) {
    console.warn('[connect] account.updated for unknown connected account', accountId);
    return null;
  }
  const summary = summarizeAccount(account);
  persistAccountFlags(business.id, summary, accountId);
  return { business, summary };
}

module.exports = {
  CONNECT_API_VERSION,
  isConfigured,
  loadBusiness,
  getBusinessByConnectAccount,
  getStatus,
  createOrGetAccount,
  createOnboardingLink,
  createInvoicePaymentIntent,
  retrievePaymentIntent,
  listConnectedCharges,
  retrieveCharge,
  listChargeRefunds,
  createRefund,
  applyAccountUpdate,
  summarizeAccount,
  // exposed for tests / callers that want the raw client
  stripe,
};
