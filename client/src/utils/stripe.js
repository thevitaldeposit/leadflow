import { loadStripe } from '@stripe/stripe-js';
import { api } from './api';

// Stripe publishable keys are designed to be embedded in client-side code, so a
// hardcoded fallback is safe and keeps Checkout working in the production build
// even when VITE_STRIPE_PUBLISHABLE_KEY isn't injected at build time (client/.env
// is gitignored). Local/dev overrides via the env var still take precedence.
const PUBLISHABLE_KEY =
  import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ||
  'pk_live_51TeixSJFKsvbIGLcnr6Jw7s5kLyvSMOMO2EmH07TrJnlKTeusufXfnPyZhfSq9ZRouj4dh1vxZnsawcWim6ds6RO00lAmuT284';

let _stripe;
export function getStripe() {
  if (!_stripe) _stripe = loadStripe(PUBLISHABLE_KEY);
  return _stripe;
}

// Stripe.js bound to a CONNECTED account, for paying an invoice as a direct charge
// (the connected account is the merchant of record). The publishable key is still
// the platform's; the {stripeAccount} option scopes Elements + confirmation to the
// connected account. Memoized per account so re-renders don't reload Stripe.js.
const _connected = {};
export function getConnectedStripe(accountId, publishableKey) {
  if (!accountId) return getStripe();
  if (!_connected[accountId]) {
    _connected[accountId] = loadStripe(publishableKey || PUBLISHABLE_KEY, { stripeAccount: accountId });
  }
  return _connected[accountId];
}

// Create a Checkout Session on the server, then send the browser to Stripe.
// Prefers Stripe.js (uses the publishable key); falls back to the session URL so
// checkout still works if Stripe.js can't load.
export async function startCheckout() {
  const { url, id } = await api.createCheckoutSession();
  try {
    const stripe = await getStripe();
    if (stripe && id) {
      const { error } = await stripe.redirectToCheckout({ sessionId: id });
      if (!error) return;
    }
  } catch {
    /* fall through to the URL redirect below */
  }
  if (url) window.location.href = url;
}

// Open the Stripe Customer Portal (manage payment method / cancel).
export async function openBillingPortal() {
  const { url } = await api.createPortalSession();
  if (url) window.location.href = url;
}
