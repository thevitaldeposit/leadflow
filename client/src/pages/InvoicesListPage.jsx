import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ReceiptText, PlusCircle, Search, X, Settings, Check } from 'lucide-react';
import { api } from '../utils/api';
import socket from '../socket';
import { INVOICE_STATUSES, INVOICE_STATUS_STYLES, getInvoiceStatusLabel } from '../utils/verticalConfig';

const FILTERS = [{ value: 'all', label: 'All' }, ...INVOICE_STATUSES];
const money = (n, c = 'USD') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(v); }
  catch { return `$${v.toFixed(2)}`; }
};
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${INVOICE_STATUS_STYLES[status] || INVOICE_STATUS_STYLES.draft}`}>
      {getInvoiceStatusLabel(status)}
    </span>
  );
}

// Pick a customer to start a new invoice for.
function CustomerPicker({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getCustomers(q.trim() ? { search: q.trim() } : {})
      .then((r) => { if (active) setResults(r); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [q]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-24" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-800">New invoice — choose a customer</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>
        <div className="p-4">
          <div className="relative mb-3">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email…" className="w-full text-sm border border-gray-200 rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div className="max-h-72 overflow-y-auto -mx-1">
            {loading ? (
              <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
            ) : results.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">No customers found.</div>
            ) : results.map((c) => (
              <button key={c.id} onClick={() => onPick(c)} className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-gray-50 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">{c.display_name}</p>
                  <p className="text-xs text-gray-400">{[c.company, c.phone].filter(Boolean).join(' · ') || '—'}</p>
                </div>
                <span className="text-xs text-accent">Select →</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Edit the per-business invoice defaults (terms template, due window, tax, numbering).
function DefaultsModal({ onClose }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { api.getInvoiceDefaults().then(setForm).catch(() => setForm({})); }, []);

  const save = async () => {
    setSaving(true);
    try { await api.setInvoiceDefaults(form); onClose(); }
    catch { setSaving(false); }
  };

  const inputCls = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';
  const labelCls = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-16 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-800">Invoice defaults</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>
        {!form ? (
          <div className="py-12 text-center"><div className="animate-spin w-5 h-5 border-2 border-accent border-t-transparent rounded-full mx-auto" /></div>
        ) : (
          <div className="p-5 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div><label className={labelCls}>Number prefix</label><input className={inputCls} value={form.prefix ?? ''} onChange={(e) => set('prefix', e.target.value)} placeholder="INV-" /></div>
              <div><label className={labelCls}>Next number</label><input type="number" className={inputCls} value={form.nextNumber ?? ''} onChange={(e) => set('nextNumber', e.target.value)} /></div>
              <div><label className={labelCls}>Due (days)</label><input type="number" className={inputCls} value={form.dueDays ?? ''} onChange={(e) => set('dueDays', e.target.value)} /></div>
            </div>
            <div className="w-1/3"><label className={labelCls}>Default tax %</label><input type="number" step="any" className={inputCls} value={form.taxRate ?? ''} onChange={(e) => set('taxRate', e.target.value)} /></div>
            <div>
              <label className={labelCls}>Default terms / contract</label>
              <textarea rows={8} className={inputCls + ' resize-y font-mono text-xs leading-relaxed'} value={form.terms ?? ''} onChange={(e) => set('terms', e.target.value)} />
              <p className="text-[11px] text-gray-400 mt-1.5">Prefills every new invoice. A customer's own contract terms override this when set.</p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg">Cancel</button>
              <button onClick={save} disabled={saving} className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg"><Check size={14} /> {saving ? 'Saving…' : 'Save defaults'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function InvoicesListPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('all');
  const [picking, setPicking] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    const params = status !== 'all' ? { status } : {};
    return api.getInvoices(params).then(setInvoices);
  }, [status]);

  useEffect(() => {
    setLoading(true);
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    const refetch = () => loadRef.current().catch(console.error);
    socket.on('invoice_updated', refetch);
    return () => socket.off('invoice_updated', refetch);
  }, []);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ReceiptText size={18} className="text-gray-500" />
          <h1 className="text-lg font-bold text-gray-900">Invoices</h1>
          <span className="text-sm text-gray-400">{invoices.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowDefaults(true)} className="flex items-center gap-1.5 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg"><Settings size={14} /> Defaults</button>
          <button onClick={() => setPicking(true)} className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 px-3 py-1.5 rounded-lg"><PlusCircle size={14} /> New Invoice</button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <button key={f.value} onClick={() => setStatus(f.value)} className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${status === f.value ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48"><div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" /></div>
      ) : invoices.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-10 text-center text-sm text-gray-400">
          {status !== 'all' ? 'No invoices with this status.' : 'No invoices yet. Create one from a customer or with “New Invoice”.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Invoice</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Issued</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-50 cursor-pointer transition-colors" onClick={() => navigate(`/invoices/${inv.id}`)}>
                  <td className="px-5 py-3 font-medium text-gray-900">{inv.invoice_number}</td>
                  <td className="px-4 py-3 text-gray-700">{inv.customer_display_name || inv.bill_to_name || '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                  <td className="px-4 py-3 text-right text-gray-900 font-medium">{money(inv.total, inv.currency)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(inv.issue_date)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(inv.due_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picking && <CustomerPicker onClose={() => setPicking(false)} onPick={(c) => navigate(`/invoices/new?customer_id=${c.id}`)} />}
      {showDefaults && <DefaultsModal onClose={() => setShowDefaults(false)} />}
    </div>
  );
}
