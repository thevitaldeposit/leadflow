import { useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '../utils/api';
import { startCheckout, openBillingPortal } from '../utils/stripe';
import { useAuth } from '../context/AuthContext';

const PRICE_LABEL = '$149/month';

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

const STATUS_LABELS = {
  active: 'Active',
  trialing: 'Free trial',
  past_due: 'Past due',
  canceled: 'Canceled',
  inactive: 'Inactive',
};

export default function BillingPage() {
  const { business } = useAuth();
  const [sub, setSub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getSubscriptionStatus()
      .then((data) => {
        if (active) setSub(data);
      })
      .catch((err) => {
        if (active) setError(err.message || 'Failed to load billing status');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const runAction = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // On success the browser navigates away to Stripe; if it doesn't, clear busy.
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  const status = sub?.status || 'inactive';
  const isActive = status === 'active' || status === 'trialing';
  const isPastDue = status === 'past_due';
  const statusLabel = STATUS_LABELS[status] || status;

  const periodEnd = formatDate(sub?.currentPeriodEnd);
  const trialEnd = formatDate(sub?.trialEnd);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="bg-surface rounded-xl border border-divider shadow-sm p-6">
        <div className="flex items-center gap-2 mb-1">
          <CreditCard size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-content">Billing &amp; Subscription</h2>
        </div>
        <p className="text-xs text-muted mb-6">
          Stream is {PRICE_LABEL}. Manage your subscription and payment method here.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted py-8 justify-center">
            <Loader2 size={16} className="animate-spin" />
            Loading subscription…
          </div>
        ) : (
          <div className="space-y-5">
            {/* Current status */}
            <div className="flex items-center justify-between rounded-lg border border-divider bg-surface-2 px-4 py-3">
              <span className="text-sm font-medium text-muted">Status</span>
              <StatusPill status={status} label={statusLabel} />
            </div>

            {/* Active / trialing details */}
            {isActive && (
              <div className="space-y-2 text-sm">
                {status === 'trialing' && trialEnd && (
                  <DetailRow label="Trial ends" value={trialEnd} />
                )}
                {periodEnd && (
                  <DetailRow
                    label={sub?.cancelAtPeriodEnd ? 'Access until' : 'Next billing date'}
                    value={periodEnd}
                  />
                )}
                {sub?.cancelAtPeriodEnd && (
                  <p className="text-xs text-warning">
                    Your subscription is set to cancel at the end of the current period.
                  </p>
                )}
              </div>
            )}

            {/* Past-due warning */}
            {isPastDue && (
              <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
                <AlertTriangle size={18} className="text-warning flex-shrink-0 mt-0.5" />
                <p className="text-sm text-warning">
                  Your last payment failed. Update your payment method to keep using Stream.
                </p>
              </div>
            )}

            {error && <p className="text-sm text-danger">{error}</p>}

            {/* Actions */}
            <div className="pt-1">
              {isActive ? (
                <button
                  onClick={() => runAction(openBillingPortal)}
                  disabled={busy}
                  className="text-sm font-medium bg-accent text-content rounded-lg px-4 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? 'Opening…' : 'Manage Subscription'}
                </button>
              ) : isPastDue ? (
                <button
                  onClick={() => runAction(openBillingPortal)}
                  disabled={busy}
                  className="text-sm font-medium bg-warning text-background rounded-lg px-4 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? 'Opening…' : 'Update Payment Method'}
                </button>
              ) : (
                <button
                  onClick={() => runAction(startCheckout)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 text-sm font-semibold bg-accent text-content rounded-lg px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? 'Redirecting…' : `Subscribe — ${PRICE_LABEL}`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* What's included */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm p-6">
        <p className="text-sm font-semibold text-content mb-3">What's included</p>
        <ul className="space-y-2">
          {[
            'AI lead capture from every call & voicemail',
            'Automatic booking, scheduling & payment links',
            'Action Queue, opportunities & job pipeline',
            'Unlimited leads',
          ].map((item) => (
            <li key={item} className="flex items-center gap-2 text-sm text-muted">
              <CheckCircle2 size={16} className="text-success flex-shrink-0" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {business?.id === 1 && (
        <p className="text-xs text-muted text-center">
          This is the Stream admin account and always has full access regardless of subscription status.
        </p>
      )}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-content">{value}</span>
    </div>
  );
}

function StatusPill({ status, label }) {
  const styles =
    status === 'active'
      ? 'bg-success/10 text-success'
      : status === 'trialing'
        ? 'bg-brand/10 text-brand'
        : status === 'past_due'
          ? 'bg-warning/10 text-warning'
          : 'bg-surface-2 text-muted';
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}>{label}</span>
  );
}
