import { useEffect, useState, useCallback } from 'react';
import { Shield, Radio, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
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
  active: 'bg-green-100 text-green-700 border-green-200',
  trialing: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  past_due: 'bg-red-100 text-red-700 border-red-200',
  canceled: 'bg-red-100 text-red-700 border-red-200',
  inactive: 'bg-red-100 text-red-700 border-red-200',
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
    green: 'text-green-700 border-green-200 hover:bg-green-50',
    blue: 'text-blue-700 border-blue-200 hover:bg-blue-50',
    yellow: 'text-yellow-700 border-yellow-200 hover:bg-yellow-50',
    gray: 'text-gray-600 border-gray-200 hover:bg-gray-50',
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

export default function AdminPage() {
  const [businesses, setBusinesses] = useState([]);
  const [signups, setSignups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // { type: 'success' | 'error', text }
  const [busyKey, setBusyKey] = useState(null); // `${id}:${action}` while a row action runs
  const [trialFor, setTrialFor] = useState(null); // business id whose trial input is open
  const [trialDays, setTrialDays] = useState('14');

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
      <div className="flex items-center gap-2 p-6 text-sm text-gray-400">
        <Loader2 size={16} className="animate-spin" />
        Loading admin data…
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-sm text-red-500">Error: {error}</div>;
  }

  const bookedCount = signups.filter((s) => s.call_booked).length;

  return (
    <div className="space-y-8 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
          <Shield size={18} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Admin</h2>
          <p className="text-sm text-gray-400">Manage Stream customer accounts</p>
        </div>
      </div>

      {/* Action feedback */}
      {notice && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${
            notice.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {notice.text}
        </div>
      )}

      {/* ── Section 1: Businesses ──────────────────────────────────────────── */}
      <section>
        <div className="mb-3">
          <h3 className="text-base font-semibold text-gray-800">All Businesses</h3>
          <p className="text-xs text-gray-400">
            {businesses.length} {businesses.length === 1 ? 'account' : 'accounts'}
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                {BIZ_HEADERS.map((h) => (
                  <th
                    key={h}
                    className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {businesses.map((b) => {
                const status = b.subscription_status || 'inactive';
                const rowBusy = busyKey != null && busyKey.startsWith(`${b.id}:`);
                const ownerName =
                  [b.owner_first_name, b.owner_last_name].filter(Boolean).join(' ') || '—';
                const canActivate = ['inactive', 'canceled', 'past_due'].includes(status);
                const onboarded = !!b.onboarding_complete;
                return (
                  <tr key={b.id} className="align-top transition-colors hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-gray-800">
                      {b.name || '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-gray-700">{ownerName}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-gray-600">
                      {b.owner_email ? (
                        <a href={`mailto:${b.owner_email}`} className="hover:text-blue-600">
                          {b.owner_email}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        {b.industry_type || '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-gray-400">
                      {formatDate(b.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <SubBadge status={status} />
                      {status === 'trialing' && b.trial_end_date && (
                        <span className="ml-2 text-xs text-gray-400">
                          ends {formatDate(b.trial_end_date)}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {onboarded ? (
                        <span className="text-xs font-medium text-green-600">Yes</span>
                      ) : (
                        <span className="text-xs text-gray-400">No</span>
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
                      </div>

                      {/* Inline trial input */}
                      {trialFor === b.id && (
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            type="number"
                            min="1"
                            value={trialDays}
                            onChange={(e) => setTrialDays(e.target.value)}
                            className="w-20 rounded border border-gray-300 px-2 py-1 text-xs focus:border-indigo-400 focus:outline-none"
                            placeholder="Days"
                          />
                          <span className="text-xs text-gray-400">days (starts today)</span>
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
          <Radio size={16} className="text-blue-500" />
          <div>
            <h3 className="text-base font-semibold text-gray-800">Stream Signups</h3>
            <p className="text-xs text-gray-400">
              {signups.length} {signups.length === 1 ? 'prospect' : 'prospects'}
              {signups.length > 0 && ` · ${bookedCount} booked a call`}
            </p>
          </div>
        </div>

        {signups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
            No signups yet. New prospects from the Stream landing page will appear here.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  {SIGNUP_HEADERS.map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {signups.map((s) => (
                  <tr key={s.id} className="transition-colors hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-gray-800">
                      {s.first_name || '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-gray-700">
                      {s.business_name || '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        {s.business_type || '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-gray-600">
                      {s.email ? (
                        <a href={`mailto:${s.email}`} className="hover:text-blue-600">
                          {s.email}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-gray-600">
                      {s.phone ? (
                        <a href={`tel:${s.phone}`} className="hover:text-blue-600">
                          {s.phone}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-gray-400">
                      {formatDate(s.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {s.call_booked ? (
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                          Booked
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
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
