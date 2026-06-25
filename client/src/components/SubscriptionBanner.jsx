import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { startCheckout } from '../utils/stripe';

// Soft access gate shown at the top of the dashboard when a business has no
// active subscription. Non-blocking — it nudges, it doesn't lock anyone out.
// Valley Binz (business_id = 1) always bypasses this.
export default function SubscriptionBanner() {
  const { business } = useAuth();
  const [busy, setBusy] = useState(false);

  if (!business || business.id === 1) return null;

  const status = business.subscription_status;
  const needsSubscription = status === 'inactive' || status === 'canceled' || !status;
  if (!needsSubscription) return null;

  const subscribe = async () => {
    setBusy(true);
    try {
      await startCheckout();
    } catch {
      // Navigation away on success; reset so the button is usable again on failure.
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <AlertCircle size={18} className="text-warning flex-shrink-0" />
        <p className="text-sm text-warning">
          Your subscription is inactive. Subscribe to continue using Stream.
        </p>
      </div>
      <button
        onClick={subscribe}
        disabled={busy}
        className="text-sm font-semibold bg-warning text-background rounded-lg px-4 py-2 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
      >
        {busy ? 'Redirecting…' : 'Subscribe'}
      </button>
    </div>
  );
}
