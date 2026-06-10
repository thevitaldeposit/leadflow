import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { AlertTriangle, Lock, Zap } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { startCheckout, openBillingPortal } from '../utils/stripe';

// Valley Binz — the original tenant — is never gated under any circumstance.
const ALWAYS_ALLOWED_BUSINESS_ID = 1;

// Statuses that grant full dashboard access. Anything else hard-blocks.
const ACTIVE_STATUSES = ['active', 'trialing'];

// Hard access gate for protected dashboard routes. Unlike SubscriptionBanner
// (which only nudges), this replaces the entire dashboard with a full-screen
// block page when a business has no usable subscription. Used as a layout route
// element — renders its children/Outlet when access is allowed.
export default function SubscriptionGate({ children }) {
  const { business } = useAuth();
  const [busy, setBusy] = useState(false);

  // Allow through while business is still loading, when it's the always-allowed
  // tenant, or when the subscription status grants access.
  const status = business?.subscription_status;
  const allowed =
    !business ||
    business.id === ALWAYS_ALLOWED_BUSINESS_ID ||
    ACTIVE_STATUSES.includes(status);

  if (allowed) return children || <Outlet />;

  // past_due → payment-failed screen (update card via the Stripe portal).
  // canceled / inactive / anything else → resubscribe screen.
  const isPastDue = status === 'past_due';

  const handleAction = async () => {
    setBusy(true);
    try {
      if (isPastDue) {
        await openBillingPortal();
      } else {
        await startCheckout();
      }
    } catch {
      // Both helpers navigate away on success; reset so the button works again
      // if the redirect failed.
      setBusy(false);
    }
  };

  const content = isPastDue
    ? {
        icon: <AlertTriangle size={28} className="text-amber-500" />,
        heading: 'Payment Failed',
        message:
          "We weren't able to process your last payment. Please update your payment method to continue using Stream.",
        button: busy ? 'Redirecting…' : 'Update Payment Method',
      }
    : {
        icon: <Lock size={28} className="text-gray-400" />,
        heading: 'Subscription Ended',
        message:
          'Your Stream subscription is no longer active. Resubscribe to get back to work.',
        button: busy ? 'Redirecting…' : 'Resubscribe — $149/month',
      };

  return (
    <div className="min-h-screen flex items-center justify-center bg-app-bg p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm p-8 text-center">
        <div className="flex items-center justify-center gap-2 mb-6">
          <Zap size={22} className="text-accent" />
          <span className="font-bold text-lg tracking-tight">Stream</span>
        </div>

        <div className="flex justify-center mb-4">{content.icon}</div>

        <h1 className="text-xl font-semibold text-gray-900">{content.heading}</h1>
        <p className="mt-2 text-sm text-gray-500 leading-relaxed">{content.message}</p>

        <button
          onClick={handleAction}
          disabled={busy}
          className="mt-6 w-full py-2.5 rounded-lg bg-accent text-white font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {content.button}
        </button>

        <a
          href="mailto:support@joinstream.app"
          className="mt-4 inline-block text-sm text-gray-500 hover:text-gray-700"
        >
          Contact Support
        </a>
      </div>
    </div>
  );
}
