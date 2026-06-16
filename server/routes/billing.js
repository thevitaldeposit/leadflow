const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

// Stripe is initialized lazily so the server still boots in environments that
// haven't set STRIPE_SECRET_KEY (e.g. local dev). When the key is absent every
// authed billing endpoint returns 503 instead of crashing at require-time.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// A second Stripe client pinned to a known-good API version, used ONLY by the
// embedded signup payment endpoint below. Creating a subscription and reading
// its first invoice's PaymentIntent client_secret (for Stripe Elements) relies
// on the `latest_invoice.payment_intent` expand path, which exists on
// 2024-06-20 but was reshaped on newer ("Basil"+) API versions. Pinning keeps
// the signup flow stable regardless of the account's default API version,
// without changing the shared `stripe` client used by every other endpoint.
const SIGNUP_API_VERSION = '2024-06-20';
const signupStripe = STRIPE_SECRET_KEY
  ? require('stripe')(STRIPE_SECRET_KEY, { apiVersion: SIGNUP_API_VERSION })
  : null;

const PRICE_ID = process.env.STRIPE_PRICE_ID;
const DASHBOARD_URL = 'https://joinstream.app/dashboard?subscribed=true';
const SIGNUP_URL = 'https://joinstream.app/signup';
const PORTAL_RETURN_URL = 'https://joinstream.app/billing';

// Cancel a business's Stripe subscription so it stops being charged once the
// account is deactivated or deleted. Shared by the admin deactivate flow and the
// admin delete-account endpoint. No-ops cleanly when there is no subscription on
// file (free / 100%-off test accounts) or when Stripe isn't configured, and
// treats an already-gone subscription as a success rather than an error. Returns
// a small { cancelled, reason?, subscriptionId? } summary for logging. Does NOT
// delete the Stripe customer object — only cancels the recurring subscription.
async function cancelSubscriptionForBusiness(business) {
  const subId = business && business.stripe_subscription_id;
  if (!subId) return { cancelled: false, reason: 'none found' };
  if (!stripe) return { cancelled: false, reason: 'Stripe not configured' };
  try {
    await stripe.subscriptions.cancel(subId);
    return { cancelled: true, subscriptionId: subId };
  } catch (err) {
    // A subscription that's already canceled/missing on Stripe's side shouldn't
    // block deactivating or deleting the account.
    if (err && (err.code === 'resource_missing' || err.statusCode === 404)) {
      return { cancelled: false, reason: 'subscription not found in Stripe' };
    }
    throw err;
  }
}

// Guard for the authed endpoints — Stripe must be configured to use them.
function ensureStripe(res) {
  if (!stripe) {
    res.status(503).json({ error: 'Billing is not configured' });
    return false;
  }
  return true;
}

// Load the full businesses row (req.business only carries the public column set,
// which omits the Stripe ids and trial_days we need here).
function loadBusiness(id) {
  return db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
}

// A subscription's billing-period end lives on the subscription in older Stripe
// API versions and on the first subscription item in newer ones (Basil+). Read
// whichever is present so this keeps working across API version bumps.
function subEpoch(sub, field) {
  if (sub[field]) return sub[field];
  const item = sub.items && sub.items.data && sub.items.data[0];
  return item && item[field] ? item[field] : null;
}

function epochToISO(epoch) {
  return epoch ? new Date(epoch * 1000).toISOString() : null;
}

// Build a short, human-readable label for a coupon's discount, e.g. "100% off"
// or "$50.00 off". Shown on the signup payment step when a promo code is applied.
function describeDiscount(coupon) {
  if (!coupon) return 'Discount applied';
  if (coupon.percent_off) {
    return `${coupon.percent_off}% off`;
  }
  if (coupon.amount_off) {
    const amount = (coupon.amount_off / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: (coupon.currency || 'usd').toUpperCase(),
    });
    return `${amount} off`;
  }
  return 'Discount applied';
}

// Ensure the business has a Stripe customer, creating + persisting one on first
// use. Returns the customer id.
async function ensureCustomer(business) {
  if (business.stripe_customer_id) return business.stripe_customer_id;
  const customer = await stripe.customers.create({
    name: business.name || undefined,
    metadata: { business_id: String(business.id) },
  });
  db.prepare('UPDATE businesses SET stripe_customer_id = ? WHERE id = ?').run(customer.id, business.id);
  return customer.id;
}

// POST /api/billing/public/create-subscription — UNAUTHENTICATED. Powers the
// embedded (Stripe Elements) payment step of the multi-step signup form, which
// runs before the account exists. Creates a Stripe customer and an incomplete
// $149/mo subscription, then returns the first invoice's PaymentIntent
// client_secret for the client to confirm with the PaymentElement. The account
// itself is created afterward by POST /api/auth/register, which records the
// returned customer/subscription ids and flips the business to active.
router.post('/public/create-subscription', async (req, res) => {
  if (!signupStripe) {
    return res.status(503).json({ error: 'Billing is not configured' });
  }
  if (!PRICE_ID) {
    return res.status(503).json({ error: 'Billing price is not configured' });
  }
  try {
    const { email, name, businessName, promotionCode } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const customer = await signupStripe.customers.create({
      email: String(email).trim().toLowerCase(),
      name: name ? String(name) : undefined,
      metadata: {
        business_name: businessName ? String(businessName) : '',
        source: 'signup',
      },
    });

    const subParams = {
      customer: customer.id,
      items: [{ price: PRICE_ID, quantity: 1 }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    };
    // Optional promo: the client sends a validated promotion code id (promo_…),
    // resolved from the customer-facing code by POST /validate-promo.
    if (promotionCode) {
      subParams.promotion_code = String(promotionCode);
    }

    const subscription = await signupStripe.subscriptions.create(subParams);

    const invoice = subscription.latest_invoice;
    const clientSecret =
      invoice && invoice.payment_intent && invoice.payment_intent.client_secret;

    if (!clientSecret) {
      // A 100%-off promo zeroes the first invoice, so Stripe collects nothing and
      // never creates a PaymentIntent. Tell the client to skip the card step and
      // finish signup directly rather than erroring out.
      if (invoice && invoice.amount_due === 0) {
        return res.json({
          noPaymentRequired: true,
          customerId: customer.id,
          subscriptionId: subscription.id,
        });
      }
      console.error('[stripe] No PaymentIntent client_secret on signup subscription', subscription.id);
      return res.status(500).json({ error: 'Could not initialize payment' });
    }

    res.json({ clientSecret, customerId: customer.id, subscriptionId: subscription.id });
  } catch (err) {
    console.error('POST /billing/public/create-subscription error:', err);
    res.status(500).json({ error: 'Failed to start subscription' });
  }
});

// POST /api/billing/validate-promo — UNAUTHENTICATED. Validates a customer-facing
// promo code during signup (before the account exists). Resolves the code to its
// Stripe promotion code id and a human-readable discount label so the payment
// step can confirm validity, show the discount, and pass the id back to
// /public/create-subscription to actually apply it.
router.post('/validate-promo', async (req, res) => {
  if (!signupStripe) {
    return res.status(503).json({ error: 'Billing is not configured' });
  }
  try {
    const { code } = req.body || {};
    const trimmed = code ? String(code).trim() : '';
    if (!trimmed) {
      return res.status(400).json({ error: 'code is required' });
    }

    // Stripe matches the customer-facing code case-sensitively; restricting to
    // active codes means expired/archived ones correctly read as invalid.
    const { data } = await signupStripe.promotionCodes.list({
      code: trimmed,
      active: true,
      limit: 1,
    });
    const promo = data && data[0];
    if (!promo) {
      return res.json({ valid: false });
    }

    res.json({
      valid: true,
      promotionCode: promo.id,
      discount: describeDiscount(promo.coupon),
    });
  } catch (err) {
    console.error('POST /billing/validate-promo error:', err);
    res.status(500).json({ error: 'Failed to validate promo code' });
  }
});

// POST /api/billing/create-checkout-session — start a $149/mo subscription
// checkout for the authenticated business. Stores the Stripe customer id on the
// business and, when the business has a trial_days set, applies it as a trial.
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  if (!ensureStripe(res)) return;
  try {
    if (!PRICE_ID) {
      return res.status(503).json({ error: 'Billing price is not configured' });
    }
    const business = loadBusiness(req.business.id);
    const customerId = await ensureCustomer(business);

    const params = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: DASHBOARD_URL,
      cancel_url: SIGNUP_URL,
      // Correlate the eventual webhook back to this business.
      client_reference_id: String(business.id),
      subscription_data: { metadata: { business_id: String(business.id) } },
    };

    // Optional free trial for beta customers — admin sets businesses.trial_days.
    const trialDays = Number(business.trial_days);
    if (Number.isInteger(trialDays) && trialDays > 0) {
      params.subscription_data.trial_period_days = trialDays;
    }

    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('POST /billing/create-checkout-session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/billing/create-portal-session — open the Stripe Customer Portal so
// the user can change payment method or cancel. Requires an existing customer.
router.post('/create-portal-session', requireAuth, async (req, res) => {
  if (!ensureStripe(res)) return;
  try {
    const business = loadBusiness(req.business.id);
    if (!business.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer on file. Subscribe first.' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: business.stripe_customer_id,
      return_url: PORTAL_RETURN_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('POST /billing/create-portal-session error:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// GET /api/billing/subscription-status — the live subscription status for the
// authenticated business. Reads Stripe directly (not just the cached column) so
// the Billing page reflects the latest state, and syncs the cached status back.
router.get('/subscription-status', requireAuth, async (req, res) => {
  if (!ensureStripe(res)) return;
  try {
    const business = loadBusiness(req.business.id);
    if (!business.stripe_subscription_id) {
      return res.json({
        status: business.subscription_status || 'inactive',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        trialEnd: null,
      });
    }

    const sub = await stripe.subscriptions.retrieve(business.stripe_subscription_id);

    // Keep the cached column in step with Stripe so the soft-gate banner is accurate.
    if (sub.status && sub.status !== business.subscription_status) {
      db.prepare('UPDATE businesses SET subscription_status = ? WHERE id = ?').run(sub.status, business.id);
    }

    res.json({
      status: sub.status,
      currentPeriodEnd: epochToISO(subEpoch(sub, 'current_period_end')),
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      trialEnd: epochToISO(sub.trial_end),
    });
  } catch (err) {
    console.error('GET /billing/subscription-status error:', err);
    res.status(500).json({ error: 'Failed to retrieve subscription status' });
  }
});

// ── Stripe webhook ──────────────────────────────────────────────────────────
// Mounted in index.js with express.raw() BEFORE express.json(), because Stripe
// signature verification needs the exact raw request body. This handler is
// intentionally NOT behind requireAuth — Stripe authenticates via the signature.

// Apply a status to whichever business owns the given Stripe customer.
function setStatusByCustomer(customerId, status, extra = {}) {
  if (!customerId) return;
  const sets = ['subscription_status = ?'];
  const values = [status];
  if (extra.subscriptionId !== undefined) {
    sets.push('stripe_subscription_id = ?');
    values.push(extra.subscriptionId);
  }
  values.push(customerId);
  db.prepare(`UPDATE businesses SET ${sets.join(', ')} WHERE stripe_customer_id = ?`).run(...values);
}

function handleStripeWebhook(req, res) {
  if (!stripe) {
    return res.status(503).send('Billing is not configured');
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET not set — rejecting webhook');
    return res.status(503).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const businessId = session.client_reference_id;
        if (businessId) {
          db.prepare(`
            UPDATE businesses
            SET subscription_status = 'active',
                stripe_customer_id = COALESCE(stripe_customer_id, ?),
                stripe_subscription_id = ?
            WHERE id = ?
          `).run(session.customer || null, session.subscription || null, businessId);
        } else {
          // Fall back to matching by the customer id we stored at checkout time.
          setStatusByCustomer(session.customer, 'active', { subscriptionId: session.subscription || null });
        }
        console.log(`[stripe] checkout.session.completed → business ${businessId || `customer ${session.customer}`} active`);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        setStatusByCustomer(sub.customer, sub.status, { subscriptionId: sub.id });
        console.log(`[stripe] customer.subscription.updated → ${sub.customer} ${sub.status}`);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        setStatusByCustomer(sub.customer, 'canceled');
        console.log(`[stripe] customer.subscription.deleted → ${sub.customer} canceled`);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        setStatusByCustomer(invoice.customer, 'past_due');
        console.log(`[stripe] invoice.payment_failed → ${invoice.customer} past_due`);
        break;
      }
      default:
        // Unhandled event types are acknowledged so Stripe stops retrying them.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

module.exports = { router, handleStripeWebhook, cancelSubscriptionForBusiness };
