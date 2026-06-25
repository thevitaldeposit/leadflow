import { useState } from 'react';
import { CalendarClock, ArrowRight, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { CALENDLY_URL } from '../utils/calendly';

// Post-signup nudge shown at the top of the dashboard until the new customer's
// setup call is done. Amber/informational (not alarming). It disappears once
// dismissed (persisted per-business in localStorage) OR once the business's
// onboarding_complete flag flips to true on the server. Valley Binz
// (business_id = 1) never sees it.

const dismissKey = (businessId) => `stream:onboardingBannerDismissed:${businessId}`;

export default function OnboardingBanner() {
  const { business } = useAuth();
  const [dismissed, setDismissed] = useState(() => {
    if (!business) return false;
    try {
      return localStorage.getItem(dismissKey(business.id)) === '1';
    } catch {
      return false;
    }
  });

  if (!business || business.id === 1) return null; // Valley Binz never sees this
  if (business.onboarding_complete) return null; // hidden once the setup call is done
  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(business.id), '1');
    } catch {
      /* ignore — still hide for this session */
    }
    setDismissed(true);
  };

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <CalendarClock size={18} className="text-warning flex-shrink-0" />
        <p className="text-sm text-warning">
          Your advanced booking and extraction features will be activated during your setup call.
        </p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <a
          href={CALENDLY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-warning px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90"
        >
          Schedule Now <ArrowRight size={14} />
        </a>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="p-1.5 text-warning transition-colors hover:text-warning"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
