import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, PlusCircle, Search, X, Check } from 'lucide-react';
import { api } from '../utils/api';
import socket from '../socket';
import { CUSTOMER_STATUSES, CUSTOMER_STATUS_STYLES, getCustomerStatusLabel } from '../utils/verticalConfig';

// One unified, status-filterable list of every customer (one row per person).
// Replaces the old All Opportunities / Booked / Completed / All Leads views,
// which were just different filters over the same lead data.
const FILTERS = [{ value: 'all', label: 'All' }, ...CUSTOMER_STATUSES];

function StatusBadge({ status }) {
  const style = CUSTOMER_STATUS_STYLES[status] || CUSTOMER_STATUS_STYLES.lead;
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${style}`}>
      {getCustomerStatusLabel(status)}
    </span>
  );
}

function NewCustomerForm({ onSave, onCancel }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', company: '', phone: '', email: '', address: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.firstName.trim() && !form.company.trim() && !form.phone.trim()) {
      setError('Enter a name, company, or phone'); return;
    }
    setSaving(true); setError(null);
    try { await onSave(form); }
    catch (err) {
      setError(err.message || 'Save failed');
      setSaving(false);
    }
  };

  const input = 'w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';
  const label = 'block text-xs font-medium text-muted uppercase tracking-wide mb-1';

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>First Name</label><input className={input} value={form.firstName} onChange={e => set('firstName', e.target.value)} /></div>
        <div><label className={label}>Last Name</label><input className={input} value={form.lastName} onChange={e => set('lastName', e.target.value)} /></div>
        <div><label className={label}>Company</label><input className={input} value={form.company} onChange={e => set('company', e.target.value)} placeholder="Optional" /></div>
        <div><label className={label}>Phone</label><input className={input} value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
        <div><label className={label}>Email</label><input className={input} value={form.email} onChange={e => set('email', e.target.value)} /></div>
        <div><label className={label}>Address</label><input className={input} value={form.address} onChange={e => set('address', e.target.value)} /></div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className="flex items-center gap-1.5 text-sm text-muted hover:text-content px-3 py-2 rounded-lg"><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg"><Check size={14} /> {saving ? 'Saving…' : 'Create'}</button>
      </div>
    </form>
  );
}

function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function CustomersListPage() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    const params = {};
    if (status !== 'all') params.status = status;
    if (search.trim()) params.search = search.trim();
    return api.getCustomers(params).then(setCustomers);
  }, [status, search]);

  useEffect(() => {
    setLoading(true);
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  // Keep the list fresh when the call pipeline captures a new lead (it gets
  // reconciled into a customer on the next fetch).
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    const refetch = () => loadRef.current().catch(console.error);
    socket.on('new_lead', refetch);
    socket.on('lead_updated', refetch);
    return () => { socket.off('new_lead', refetch); socket.off('lead_updated', refetch); };
  }, []);

  const handleAdd = async (form) => {
    const created = await api.createCustomer(form);
    setShowAdd(false);
    navigate(`/customers/${created.id}`);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header + search + add */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Users size={18} className="text-muted" />
          <h1 className="text-lg font-bold text-content">Customers</h1>
          <span className="text-sm text-muted">{customers.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, phone, email…"
              className="text-sm border border-divider rounded-lg pl-8 pr-3 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          {!showAdd && (
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 px-3 py-1.5 rounded-lg">
              <PlusCircle size={14} /> New Customer
            </button>
          )}
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setStatus(f.value)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
              status === f.value
                ? 'bg-well text-content border-divider'
                : 'bg-surface text-muted border-divider hover:border-divider'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {showAdd && (
        <div className="bg-surface rounded-xl border border-divider shadow-sm p-5">
          <p className="text-xs font-semibold text-muted mb-3">New Customer</p>
          <NewCustomerForm onSave={handleAdd} onCancel={() => setShowAdd(false)} />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
        </div>
      ) : customers.length === 0 ? (
        <div className="bg-surface rounded-xl border border-divider shadow-sm p-10 text-center text-sm text-muted">
          {search || status !== 'all' ? 'No customers match this filter.' : 'No customers yet — they appear here as calls come in.'}
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-divider">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Jobs</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Open</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Revenue</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {customers.map(c => (
                <tr key={c.id} className="hover:bg-surface-2 cursor-pointer transition-colors" onClick={() => navigate(`/customers/${c.id}`)}>
                  <td className="px-5 py-3">
                    <p className="font-medium text-content">{c.display_name}</p>
                    <p className="text-xs text-muted">{[c.company, c.phone].filter(Boolean).join(' · ') || '—'}</p>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                  <td className="px-4 py-3 text-content">{c.jobs}</td>
                  <td className="px-4 py-3 text-muted">{c.open_jobs || 0}</td>
                  <td className="px-4 py-3 text-content">{c.total_revenue ? `$${c.total_revenue.toLocaleString()}` : '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{timeAgo(c.last_activity_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
