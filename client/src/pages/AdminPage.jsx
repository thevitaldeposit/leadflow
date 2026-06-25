import { useEffect, useState, useCallback } from 'react';
import { Shield, Radio, Loader2, CheckCircle2, AlertCircle, Trash2, X } from 'lucide-react';
import { api } from '../utils/api';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Subscription badge palette: green = active, yellow = trialing, red = anything
// that blocks the dashboard (past_due / canceled / inactive).
const SUB_STYLES = {
  active: 'bg-success/10 text-success border-success/30',
  trialing: 'bg-warning/10 text-warning border-warning/30',
  past_due: 'bg-danger/10 text-danger border-danger/30',
  canceled: 'bg-danger/10 text-danger border-danger/30',
  inactive: 'bg-danger/10 text-danger border-danger/30',
};

const SUB_LABELS = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past due',
  canceled: 'Canceled',
  inactive: 'Inactive',
};

const BIZ_HEADERS = [
  'Business',
  'Owner',
  'Email',
  'Industry',
  'Signed Up',
  'Subscription',
  'Onboarded',
  'Actions',
];

const SIGNUP_HEADERS = ['Name', 'Business', 'Type', 'Email', 'Phone', 'Signed Up', 'Call Booked'];

function SubBadge({ status }) {
  const style = SUB_STYLES[status] || SUB_STYLES.inactive;
  const label = SUB_LABELS[status] || status || 'Unknown';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}

// Compact text button used for the per-row actions.
function ActionButton({ onClick, disabled, color = 'gray', children }) {
  const colors = {
    green: 'text-success border-success/30 hover:bg-success/10',
    blue: 'text-brand border-brand/30 hover:bg-brand/10',
    yellow: 'text-warning border-warning/30 hover:bg-warning/10',
    gray: 'text-muted border-divider hover:bg-surface-2',
    red: 'text-danger border-danger/30 hover:bg-danger/10',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${colors[color]}`}
    >
      {children}
    </button>
  );
}

// Confirmation modal for the destructive Delete Account action. The delete
// button stays disabled until the admin types the exact business name (or the
// word DELETE as a fallback for unnamed accounts), making an accidental
// permanent delete effectively impossible.
function DeleteAccountModal({ business, busy, onCancel, onConfirm }) {
  const [confirmText, setConfirmText] = useState('');
  const expected = (business.name || '').trim();
  // Accept the business name when it has one; always accept DELETE as a fallback.
  const ready = confirmText.trim() === 'DELETE' || (expected && confirmText.trim() === expected);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-surface shadow-xl">
        <div className="flex items-start justify-between border-b border-divider px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-danger/10 text-danger">
              <Trash2 size={16} />
            </div>
            <h3 className="text-base font-semibold text-content">Delete account</h3>
          </div>
          <button onClick={onCancel} disabled={busy} className="text-muted hover:text-muted disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm text-muted">
          <p>
            You're about to permanently delete{' '}
            <span className="font-semibold text-content">{business.name || 'this account'}</span>
            {business.owner_email ? ` (${business.owner_email})` : ''}.
          </p>
          <p>
            This <span className="font-semibold text-danger">cannot be undone</span>. It cancels
            the account's Stripe subscription and removes all of its data — leads, calls, timeline,
            inventory, settings — along with its login. No other account is affected.
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">
              Type{' '}
              <span className="font-mono font-semibold text-content">
                {expected || 'DELETE'}
              </span>{' '}
              to confirm
            </label>
            <input
              type="text"
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={busy}
              className="w-full rounded border border-divider px-3 py-2 text-sm focus:border-danger focus:outline-none disabled:bg-surface-2"
              placeholder={expected || 'DELETE'}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-divider px-5 py-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-divider px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!ready || busy}
            className="inline-flex items-center gap-1.5 rounded bg-danger px-3 py-1.5 text-sm font-medium text-content hover:bg-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [businesses, setBusinesses] = useState([]);
  const [signups, setSignups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // { type: 'success' | 'error', text }
  const [busyKey, setBusyKey] = useState(null); // `${id}:${action}` while a row action runs
  const [trialFor, setTrialFor] = useState(null); // business id whose trial input is open
  const [trialDays, setTrialDays] = useState('14');
  const [deleteTarget, setDeleteTarget] = useState(null); // business pending deletion (opens modal)
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [biz, sign] = await Promise.all([api.getAdminBusinesses(), api.getSignups()]);
      setBusinesses(Array.isArray(biz) ? biz : []);
      setSignups(Array.isArray(sign) ? sign : []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reloadBusinesses = useCallback(async () => {
    const biz = await api.getAdminBusinesses();
    setBusinesses(Array.isArray(biz) ? biz : []);
  }, []);

  const flash = (type, text) => {
    setNotice({ type, text });
    setTimeout(() => setNotice(null), 4000);
  };

  // Run a mutating row action, refresh the table, and surface success/failure.
  const runAction = async (id, action, fn, successText) => {
    setBusyKey(`${id}:${action}`);
    try {
      await fn();
      await reloadBusinesses();
      if (successText) flash('success', successText);
    } catch (err) {
      flash('error', err.message || 'Action failed');
    } finally {
      setBusyKey(null);
    }
  };

  // Permanently delete the account in deleteTarget. The endpoint is transactional,
  // so on failure nothing was removed — surface the error and keep the row.
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await api.deleteBusiness(deleteTarget.id);
      setDeleteTarget(null);
      await reloadBusinesses();
      const stripeNote = result.stripeSubscriptionCancelled
        ? 'Stripe subscription cancelled'
        : 'no Stripe subscription';
      flash('success', `${result.businessName || 'Account'} deleted (${stripeNote})`);
    } catch (err) {
      flash('error', err.message || 'Delete failed — nothing was removed');
    } finally {
      setDeleting(false);
    }
  };

  const submitTrial = async (id) => {
    const days = parseInt(trialDays, 10);
    if (!Number.isInteger(days) || days <= 0) {
      flash('error', 'Enter a valid number of trial days');
      return;
    }
    await runAction(id, 'trial', () => api.setBusinessTrial(id, days), `Trial set — ${days} days`);
    setTrialFor(null);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading admin data…
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-sm text-danger">Error: {error}</div>;
  }

  const bookedCount = signups.filter((s) => s.call_booked).length;

  return (
    <div className="space-y-8 p-6">
      {deleteTarget && (
        <DeleteAccountModal
          business={deleteTarget}
          busy={deleting}
          onCancel={() => !deleting && setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <Shield size={18} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-content">Admin</h2>
          <p className="text-sm text-muted">Manage Stream customer accounts</p>
        </div>
      </div>

      {/* Action feedback */}
      {notice && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${
            notice.type === 'success'
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-danger/30 bg-danger/10 text-danger'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {notice.text}
        </div>
      )}

      {/* ── Section 1: Businesses ──────────────────────────────────────────── */}
      <section>
        <div className="mb-3">
          <h3 className="text-base font-semibold text-content">All Businesses</h3>
          <p className="text-xs text-muted">
            {businesses.length} {businesses.length === 1 ? 'account' : 'accounts'}
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-divider">
          <table className="w-full text-sm">
            <thead className="border-b border-divider bg-surface-2">
              <tr>
                {BIZ_HEADERS.map((h) => (
                  <th
                    key={h}
                    className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {businesses.map((b) => {
                const status = b.subscription_status || 'inactive';
                const rowBusy = busyKey != null && busyKey.startsWith(`${b.id}:`);
                const ownerName =
                  [b.owner_first_name, b.owner_last_name].filter(Boolean).join(' ') || '—';
                const canActivate = ['inactive', 'canceled', 'past_due'].includes(status);
                const onboarded = !!b.onboarding_complete;
                return (
                  <tr key={b.id} className="align-top transition-colors hover:bg-surface-2">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-content">
                      {b.name || '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-content">{ownerName}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {b.owner_email ? (
                        <a href={`mailto:${b.owner_email}`} className="hover:text-brand">
                          {b.owner_email}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                        {b.industry_type || '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted">
                      {formatDate(b.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <SubBadge status={status} />
                      {status === 'trialing' && b.trial_end_date && (
                        <span className="ml-2 text-xs text-muted">
                          ends {formatDate(b.trial_end_date)}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {onboarded ? (
                        <span className="text-xs font-medium text-success">Yes</span>
                      ) : (
                        <span className="text-xs text-muted">No</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {canActivate && (
                          <ActionButton
                            color="green"
                            disabled={rowBusy}
                            onClick={() =>
                              runAction(
                                b.id,
                                'activate',
                                () => api.setBusinessSubscription(b.id, 'active'),
                                `${b.name || 'Business'} activated`
                              )
                            }
                          >
                            {busyKey === `${b.id}:activate` ? 'Activating…' : 'Activate'}
                          </ActionButton>
                        )}
                        {status === 'active' && (
                          <ActionButton
                            color="gray"
                            disabled={rowBusy}
                            onClick={() =>
                              runAction(
                                b.id,
                                'deactivate',
                                () => api.setBusinessSubscription(b.id, 'inactive'),
                                `${b.name || 'Business'} deactivated`
                              )
                            }
                          >
                            {busyKey === `${b.id}:deactivate` ? 'Deactivating…' : 'Deactivate'}
                          </ActionButton>
                        )}
                        <ActionButton
                          color="yellow"
                          disabled={rowBusy}
                          onClick={() =>
                            setTrialFor((cur) => (cur === b.id ? null : b.id))
                          }
                        >
                          Set Trial
                        </ActionButton>
                        {!onboarded && (
                          <ActionButton
                            color="blue"
                            disabled={rowBusy}
                            onClick={() =>
                              runAction(
                                b.id,
                                'onboard',
                                () => api.markBusinessOnboarded(b.id),
                                `${b.name || 'Business'} marked onboarded`
                              )
                            }
                          >
                            {busyKey === `${b.id}:onboard` ? 'Saving…' : 'Mark Onboarded'}
                          </ActionButton>
                        )}
                        <ActionButton
                          color="gray"
                          disabled={rowBusy}
                          onClick={() =>
                            runAction(
                              b.id,
                              'reset',
                              () => api.resetBusinessPassword(b.id),
                              'Password reset email sent'
                            )
                          }
                        >
                          {busyKey === `${b.id}:reset` ? 'Sending…' : 'Reset Password'}
                        </ActionButton>
                        {b.id !== 1 && (
                          <ActionButton
                            color="red"
                            disabled={rowBusy}
                            onClick={() => setDeleteTarget(b)}
                          >
                            Delete Account
                          </ActionButton>
                        )}
                      </div>

                      {/* Inline trial input */}
                      {trialFor === b.id && (
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            type="number"
                            min="1"
                            value={trialDays}
                            onChange={(e) => setTrialDays(e.target.value)}
                            className="w-20 rounded border border-divider px-2 py-1 text-xs focus:border-brand focus:outline-none"
                            placeholder="Days"
                          />
                          <span className="text-xs text-muted">days (starts today)</span>
                          <ActionButton
                            color="green"
                            disabled={rowBusy}
                            onClick={() => submitTrial(b.id)}
                          >
                            {busyKey === `${b.id}:trial` ? 'Saving…' : 'Save'}
                          </ActionButton>
                          <ActionButton color="gray" onClick={() => setTrialFor(null)}>
                            Cancel
                          </ActionButton>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Section 2: Stream Signups ──────────────────────────────────────── */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Radio size={16} className="text-brand" />
          <div>
            <h3 className="text-base font-semibold text-content">Stream Signups</h3>
            <p className="text-xs text-muted">
              {signups.length} {signups.length === 1 ? 'prospect' : 'prospects'}
              {signups.length > 0 && ` · ${bookedCount} booked a call`}
            </p>
          </div>
        </div>

        {signups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-divider py-12 text-center text-sm text-muted">
            No signups yet. New prospects from the Stream landing page will appear here.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-divider">
            <table className="w-full text-sm">
              <thead className="border-b border-divider bg-surface-2">
                <tr>
                  {SIGNUP_HEADERS.map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {signups.map((s) => (
                  <tr key={s.id} className="transition-colors hover:bg-surface-2">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-content">
                      {s.first_name || '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-content">
                      {s.business_name || '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                        {s.business_type || '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {s.email ? (
                        <a href={`mailto:${s.email}`} className="hover:text-brand">
                          {s.email}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {s.phone ? (
                        <a href={`tel:${s.phone}`} className="hover:text-brand">
                          {s.phone}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted">
                      {formatDate(s.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {s.call_booked ? (
                        <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                          Booked
                        </span>
                      ) : (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                          Not yet
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
