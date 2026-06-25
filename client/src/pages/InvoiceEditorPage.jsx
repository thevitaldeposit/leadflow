import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Check, X, ChevronDown } from 'lucide-react';
import { api } from '../utils/api';
import { INVOICE_LINE_TYPES } from '../utils/verticalConfig';

const inputCls = 'w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'block text-xs font-medium text-muted uppercase tracking-wide mb-1';

const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : '$0.00';
};
const num = (v, f = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
};

// One editable line row. Amount is derived (qty × rate) for display; the server
// recomputes it authoritatively on save.
function emptyLine(extra = {}) {
  return { description: '', line_type: 'service', quantity: '1', unit: '', unit_rate: '', service_key: null, ...extra };
}

function Card({ title, children, action }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-divider flex items-center justify-between">
        <h2 className="text-sm font-bold text-content">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function InvoiceEditorPage() {
  const { id } = useParams(); // present in edit mode
  const isEdit = !!id;
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [rates, setRates] = useState([]); // effective pricing rows for "add from rates"
  const [showRates, setShowRates] = useState(false);
  const [customerId, setCustomerId] = useState(null);

  const [form, setForm] = useState({
    issue_date: '', due_date: '', tax_rate: '0',
    bill_to_name: '', bill_to_email: '', bill_to_phone: '', bill_to_address: '',
    notes: '', lead_id: null,
  });
  const [lines, setLines] = useState([emptyLine()]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Load: prefill (create) or the existing invoice (edit).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (isEdit) {
          const inv = await api.getInvoice(id);
          if (!active) return;
          if (inv.status === 'signed' || inv.status === 'paid') {
            setError('This invoice is signed and can no longer be edited.');
            setLoading(false);
            return;
          }
          setCustomerId(inv.customer_id);
          setForm({
            issue_date: inv.issue_date || '', due_date: inv.due_date || '',
            tax_rate: String(inv.tax_rate ?? 0),
            bill_to_name: inv.bill_to_name || '', bill_to_email: inv.bill_to_email || '',
            bill_to_phone: inv.bill_to_phone || '', bill_to_address: inv.bill_to_address || '',
            notes: inv.notes || '', lead_id: inv.lead_id || null,
          });
          setLines(inv.line_items.length ? inv.line_items.map((it) => ({
            description: it.description || '', line_type: it.line_type || 'service',
            quantity: String(it.quantity ?? 1), unit: it.unit || '',
            unit_rate: String(it.unit_rate ?? ''), service_key: it.service_key || null,
          })) : [emptyLine()]);
          // Pricing for the "add from rates" menu.
          try {
            const pricing = await api.getCustomerPricing(inv.customer_id);
            if (active) setRates(pricing.items || []);
          } catch { /* non-fatal */ }
        } else {
          const cid = search.get('customer_id');
          const leadId = search.get('lead_id');
          if (!cid) { setError('No customer selected. Start an invoice from a customer.'); setLoading(false); return; }
          const pf = await api.getInvoicePrefill({ customer_id: cid, ...(leadId ? { lead_id: leadId } : {}) });
          if (!active) return;
          setCustomerId(pf.customer_id);
          setForm({
            issue_date: pf.issue_date || '', due_date: pf.due_date || '',
            tax_rate: String(pf.tax_rate ?? 0),
            bill_to_name: pf.bill_to_name || '', bill_to_email: pf.bill_to_email || '',
            bill_to_phone: pf.bill_to_phone || '', bill_to_address: pf.bill_to_address || '',
            notes: '', lead_id: pf.lead_id || null,
          });
          setRates(pf.available_rates || []);
          const suggested = (pf.suggested_items || []).map((it) => ({
            description: it.description || '', line_type: it.line_type || 'service',
            quantity: String(it.quantity ?? 1), unit: it.unit || '',
            unit_rate: it.unit_rate != null ? String(it.unit_rate) : '', service_key: it.service_key || null,
          }));
          setLines(suggested.length ? suggested : [emptyLine()]);
        }
      } catch (e) {
        if (active) setError(e.message || 'Failed to load');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [id, isEdit, search]);

  const setLine = (i, k, v) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, [k]: v } : l)));
  const addLine = (preset) => setLines((ls) => [...ls, preset || emptyLine()]);
  const removeLine = (i) => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : [emptyLine()]));

  const addFromRate = (rate) => {
    setShowRates(false);
    addLine(emptyLine({
      description: rate.label || rate.service_key,
      unit: rate.unit || '',
      unit_rate: rate.effective_price != null ? String(rate.effective_price) : '',
      service_key: rate.service_key || null,
    }));
  };

  // Live totals (display only; server is authoritative).
  const subtotal = lines.reduce((s, l) => s + num(l.quantity, 0) * num(l.unit_rate, 0), 0);
  const taxAmount = subtotal * (num(form.tax_rate, 0) / 100);
  const total = subtotal + taxAmount;

  const save = async () => {
    setSaving(true); setError(null);
    const payload = {
      ...form,
      tax_rate: num(form.tax_rate, 0),
      line_items: lines
        .filter((l) => l.description.trim() || num(l.unit_rate, 0) !== 0)
        .map((l, i) => ({
          description: l.description.trim(),
          line_type: l.line_type,
          quantity: num(l.quantity, 1),
          unit: l.unit.trim() || null,
          unit_rate: num(l.unit_rate, 0),
          service_key: l.service_key || null,
          sort_order: i,
        })),
    };
    try {
      if (isEdit) {
        await api.updateInvoice(id, payload);
        navigate(`/invoices/${id}`);
      } else {
        const created = await api.createInvoice({ customer_id: customerId, ...payload });
        navigate(`/invoices/${created.id}`);
      }
    } catch (e) {
      setError(e.message || 'Save failed');
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" /></div>;
  }
  if (error && !customerId) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link to="/invoices" className="text-sm text-accent inline-flex items-center gap-1"><ArrowLeft size={14} /> Invoices</Link>
        <div className="bg-surface rounded-xl border border-divider p-10 text-center text-sm text-muted mt-4">{error}</div>
      </div>
    );
  }

  const backLink = isEdit ? `/invoices/${id}` : (customerId ? `/customers/${customerId}` : '/invoices');

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <Link to={backLink} className="text-sm text-accent inline-flex items-center gap-1 hover:underline"><ArrowLeft size={14} /> Back</Link>
      <h1 className="text-xl font-bold text-content">{isEdit ? 'Edit Invoice' : 'New Invoice'}</h1>

      {/* Bill-to + dates */}
      <Card title="Bill To">
        <div className="px-5 py-4 grid grid-cols-2 gap-3">
          <div><label className={labelCls}>Name</label><input className={inputCls} value={form.bill_to_name} onChange={(e) => set('bill_to_name', e.target.value)} /></div>
          <div><label className={labelCls}>Email</label><input className={inputCls} value={form.bill_to_email} onChange={(e) => set('bill_to_email', e.target.value)} placeholder="for email delivery" /></div>
          <div><label className={labelCls}>Phone</label><input className={inputCls} value={form.bill_to_phone} onChange={(e) => set('bill_to_phone', e.target.value)} placeholder="for SMS delivery" /></div>
          <div><label className={labelCls}>Address</label><input className={inputCls} value={form.bill_to_address} onChange={(e) => set('bill_to_address', e.target.value)} /></div>
          <div><label className={labelCls}>Issue Date</label><input type="date" className={inputCls} value={form.issue_date} onChange={(e) => set('issue_date', e.target.value)} /></div>
          <div><label className={labelCls}>Due Date</label><input type="date" className={inputCls} value={form.due_date} onChange={(e) => set('due_date', e.target.value)} /></div>
        </div>
      </Card>

      {/* Line items */}
      <Card
        title="Line Items"
        action={
          <div className="flex items-center gap-2 relative">
            {rates.length > 0 && (
              <div className="relative">
                <button onClick={() => setShowRates((v) => !v)} className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent/80">
                  Add from rates <ChevronDown size={13} />
                </button>
                {showRates && (
                  <div className="absolute right-0 top-6 z-10 w-56 max-h-64 overflow-y-auto bg-surface border border-divider rounded-lg shadow-lg py-1">
                    {rates.map((r) => (
                      <button key={r.service_key} onClick={() => addFromRate(r)} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2 flex justify-between gap-2">
                        <span className="text-content truncate">{r.label}</span>
                        <span className="text-muted">{r.effective_price != null ? money(r.effective_price) : '—'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button onClick={() => addLine()} className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent/80"><Plus size={13} /> Add line</button>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-divider">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-semibold text-muted uppercase tracking-wide">Description</th>
                <th className="text-left px-2 py-2 text-xs font-semibold text-muted uppercase tracking-wide w-28">Type</th>
                <th className="text-right px-2 py-2 text-xs font-semibold text-muted uppercase tracking-wide w-16">Qty</th>
                <th className="text-left px-2 py-2 text-xs font-semibold text-muted uppercase tracking-wide w-20">Unit</th>
                <th className="text-right px-2 py-2 text-xs font-semibold text-muted uppercase tracking-wide w-24">Rate</th>
                <th className="text-right px-2 py-2 text-xs font-semibold text-muted uppercase tracking-wide w-24">Amount</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-4 py-2">
                    <input className="w-full min-w-[10rem] text-sm border border-divider rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent" value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} placeholder="Description" />
                  </td>
                  <td className="px-2 py-2">
                    <select className="w-full text-sm border border-divider rounded px-1.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent" value={l.line_type} onChange={(e) => setLine(i, 'line_type', e.target.value)}>
                      {INVOICE_LINE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" step="any" className="w-full text-sm text-right border border-divider rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent" value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} />
                  </td>
                  <td className="px-2 py-2">
                    <input className="w-full text-sm border border-divider rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent" value={l.unit} onChange={(e) => setLine(i, 'unit', e.target.value)} placeholder="ea" />
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" step="any" className="w-full text-sm text-right border border-divider rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent" value={l.unit_rate} onChange={(e) => setLine(i, 'unit_rate', e.target.value)} placeholder="0.00" />
                  </td>
                  <td className="px-2 py-2 text-right text-content whitespace-nowrap">{money(num(l.quantity, 0) * num(l.unit_rate, 0))}</td>
                  <td className="px-2 py-2 text-center">
                    <button onClick={() => removeLine(i)} className="text-muted hover:text-danger"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="border-t border-divider px-5 py-4">
          <div className="ml-auto w-full max-w-xs space-y-1.5">
            <div className="flex justify-between text-sm text-muted"><span>Subtotal</span><span>{money(subtotal)}</span></div>
            <div className="flex justify-between items-center text-sm text-muted">
              <span className="flex items-center gap-1.5">Tax
                <input type="number" step="any" className="w-16 text-xs text-right border border-divider rounded px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-accent" value={form.tax_rate} onChange={(e) => set('tax_rate', e.target.value)} />%
              </span>
              <span>{money(taxAmount)}</span>
            </div>
            <div className="flex justify-between text-base font-bold text-content pt-2 border-t border-divider"><span>Total</span><span>{money(total)}</span></div>
          </div>
        </div>
      </Card>

      {/* Note to customer */}
      <Card title="Note to Customer (optional)">
        <div className="px-5 py-4">
          <textarea rows={2} className={inputCls + ' resize-y'} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="A short message shown on the invoice…" />
        </div>
      </Card>

      {/* No per-invoice Terms & Contract editor: the agreement the customer reads
          and signs is resolved by business type on the public invoice page (see
          server getEffectiveContractText), so there's nothing to enter per invoice. */}

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex justify-end gap-2 pb-4">
        <button onClick={() => navigate(backLink)} className="flex items-center gap-1.5 text-sm text-muted hover:text-content px-4 py-2 rounded-lg"><X size={14} /> Cancel</button>
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 disabled:opacity-50 px-5 py-2 rounded-lg">
          <Check size={14} /> {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create invoice')}
        </button>
      </div>
    </div>
  );
}
