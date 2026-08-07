import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Check, X, ChevronDown, Send, AlertTriangle, Info } from 'lucide-react';
import { api } from '../utils/api';
import { INVOICE_LINE_TYPES } from '../utils/verticalConfig';
import { isValidEmail } from '../utils/email';

// A call-driven draft line whose description prefix is load-bearing: 'Swap replacement'
// is what the dump-ticket double-bill dedup (swapAlreadyBilled) matches, and 'Rental
// extension' is what the paid-extension pickup-date hook matches. In review mode we keep
// those prefixes locked so the owner can retune the price but never break either match.
const LOCKED_DESC_PREFIX = /^(Swap replacement|Rental extension)/i;

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
// The day before a YYYY-MM-DD date (UTC-anchored) — the latest a swap can be delivered and
// still leave ≥1 rental day, used to cap the swap-delivery-date picker at pickup − 1.
const isoMinus1 = (iso) => {
  if (!iso) return undefined;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
  // Review mode: opened from the Action Queue's Review action on a call-driven draft.
  // `review` carries the booked lead id whose vd.pendingInvoiceReview points at this draft.
  const reviewLeadId = search.get('review');
  const reviewMode = isEdit && !!reviewLeadId;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [reviewInfo, setReviewInfo] = useState(null); // { extensionWarning, extensionNeedsRate, swapReview }
  const [reviewBusy, setReviewBusy] = useState(false);
  const [swapDate, setSwapDate] = useState(''); // owner-editable swap delivery date (review mode)
  const [swapBusy, setSwapBusy] = useState(false);
  const [extDays, setExtDays] = useState('0'); // owner-editable extension extra-days (review mode)
  const [extBusy, setExtBusy] = useState(false);
  const [rates, setRates] = useState([]); // effective pricing rows for "add from rates"
  const [showRates, setShowRates] = useState(false);
  const [feeItems, setFeeItems] = useState([]); // delivery fee + surcharge items to add as lines
  const [showFees, setShowFees] = useState(false);
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
            // In review mode, lock the swap/extension description prefix (see LOCKED_DESC_PREFIX).
            _descLocked: reviewMode && LOCKED_DESC_PREFIX.test(it.description || ''),
          })) : [emptyLine()]);
          // Pricing for the "add from rates" menu.
          try {
            const pricing = await api.getCustomerPricing(inv.customer_id);
            if (active) setRates(pricing.items || []);
          } catch { /* non-fatal */ }
          // Review mode: pull the server-computed extension inventory warning + needs-rate note.
          if (reviewMode) {
            try {
              const ri = await api.getInvoiceReview(reviewLeadId);
              if (active) {
                setReviewInfo(ri);
                // Seed the swap-delivery-date input from the server (stored date, else today).
                if (ri?.swapReview?.swapDeliveryDate) setSwapDate(ri.swapReview.swapDeliveryDate);
                // Seed the extension extra-days input (the extension line's current quantity, 0 if none).
                if (ri?.extensionReview) setExtDays(String(ri.extensionReview.extraDays ?? 0));
              }
            } catch { /* non-fatal — the banner just won't show the warning */ }
          }
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
        // Business-wide add-able fee/surcharge lines: an enabled flat delivery fee +
        // surcharge special items. Mileage is intentionally excluded (no distance math).
        try {
          const pr = await api.getPricing();
          if (active) {
            const fees = (pr.fees || [])
              .filter((f) => f.enabled && f.fee_type === 'delivery' && f.amount != null && Number(f.amount) > 0)
              .map((f) => ({ label: f.label || 'Delivery Fee', amount: Number(f.amount) }));
            const specials = (pr.special_items || [])
              .filter((s) => s.kind === 'surcharge' && s.charge_amount != null && Number(s.charge_amount) > 0)
              .map((s) => ({ label: s.name, amount: Number(s.charge_amount) }));
            setFeeItems([...fees, ...specials]);
          }
        } catch { /* non-fatal — fee menu just won't show */ }
      } catch (e) {
        if (active) setError(e.message || 'Failed to load');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [id, isEdit, search, reviewMode, reviewLeadId]);

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

  // Add a delivery fee or surcharge item as a 'fee' line.
  const addFeeItem = (f) => {
    setShowFees(false);
    addLine(emptyLine({
      description: f.label,
      line_type: 'fee',
      unit_rate: f.amount != null ? String(f.amount) : '',
    }));
  };

  // Approve & Send emails the invoice to this address, so a missing/malformed one
  // makes that action impossible — never a silent no-op. Saving a draft is unaffected.
  const canEmailInvoice = isValidEmail(form.bill_to_email);

  // Live totals (display only; server is authoritative).
  const subtotal = lines.reduce((s, l) => s + num(l.quantity, 0) * num(l.unit_rate, 0), 0);
  const taxAmount = subtotal * (num(form.tax_rate, 0) / 100);
  const total = subtotal + taxAmount;

  const buildPayload = () => ({
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
  });

  const save = async () => {
    setSaving(true); setError(null);
    try {
      if (isEdit) {
        await api.updateInvoice(id, buildPayload());
        navigate(`/invoices/${id}`);
      } else {
        const created = await api.createInvoice({ customer_id: customerId, ...buildPayload() });
        navigate(`/invoices/${created.id}`);
      }
    } catch (e) {
      setError(e.message || 'Save failed');
      setSaving(false);
    }
  };

  // Review mode — Approve & Send: persist edits, then deliver via the SAME send endpoint
  // every invoice uses (markSent + email/SMS of the /invoice/:token link), then clear the
  // pending-review marker so the Action Queue item drops. The customer signs + pays on the
  // normal public invoice page — no net-new customer-side code.
  const approveAndSend = async () => {
    // Approve & Send DELIVERS this invoice by email — with no address it would mark
    // the invoice sent and deliver nothing, so block it here (and the server refuses
    // it too via requireEmail). The Bill To email field above is the fix.
    if (!canEmailInvoice) {
      setError('Add an email address (Bill To, above) to send this invoice.');
      return;
    }
    setSaving(true); setError(null);
    try {
      await api.updateInvoice(id, buildPayload());
      const res = await api.sendInvoice(id, 'both', { requireEmail: true });
      try { await api.resolveInvoiceReview(reviewLeadId, 'sent'); } catch { /* marker clear is best-effort */ }
      // The address was valid but delivery still failed (provider error). The invoice
      // IS sent server-side, so don't pretend otherwise — but stay here and say the
      // email didn't land, rather than navigating away as if the customer has it.
      if (res?.delivery?.email && !res.delivery.email.sent) {
        setError(`Invoice saved and marked sent, but the email could not be delivered${res.delivery.email.error ? `: ${res.delivery.email.error}` : ''}. Open the invoice to copy the link.`);
        setSaving(false);
        return;
      }
      navigate(`/invoices/${id}`);
    } catch (e) {
      setError(e.message || 'Send failed');
      setSaving(false);
    }
  };

  // Review mode — Discard: drop a misclassified draft without sending. Clears the marker
  // and deletes the inert draft server-side, then returns to the dashboard.
  const discardDraft = async () => {
    if (!confirm('Discard this draft invoice? It will not be sent to the customer.')) return;
    setReviewBusy(true); setError(null);
    try {
      await api.resolveInvoiceReview(reviewLeadId, 'discard');
      navigate('/');
    } catch (e) {
      setError(e.message || 'Discard failed');
      setReviewBusy(false);
    }
  };

  // Review mode — the owner set/changed the swap's delivery date. The server recomputes the
  // swap line's remaining days + price (pickup date stays fixed) and rewrites that one line;
  // we patch it into the editor locally so any other in-progress edits are preserved. The
  // recomputed price is a starting point — the owner can still hand-adjust the rate below.
  const recomputeSwap = async (date) => {
    if (!date) return;
    setSwapBusy(true); setError(null);
    try {
      const r = await api.recomputeSwapDate(reviewLeadId, date);
      setLines((ls) => ls.map((l) => (/^Swap replacement/i.test(l.description || '')
        ? { ...l, description: r.description, unit_rate: String(r.amount) }
        : l)));
      setReviewInfo((ri) => (ri ? { ...ri, swapReview: { ...ri.swapReview, swapDeliveryDate: r.swapDeliveryDate, days: r.days } } : ri));
      setSwapDate(r.swapDeliveryDate);
    } catch (e) {
      setError(e.message || 'Could not recompute the swap price');
    } finally {
      setSwapBusy(false);
    }
  };

  // Review mode — the owner set/changed the extension's EXTRA DAYS. The server reprices the
  // extension line (extraDays × the size's day rate) and rewrites only that line; we patch it
  // into the editor locally so other in-progress edits are preserved. Setting days > 0 adds the
  // line (or updates it in place), 0 removes it, and a size with no day rate returns needsRate
  // (no priced line). Recomputes on blur / Enter — a free-typed number shouldn't reprice on every
  // keystroke. The recomputed rate is a starting point; the owner can still hand-adjust it below.
  const EXT_RE = /^Rental extension/i;
  const recomputeExtension = async (raw) => {
    const n = Math.max(0, Math.round(Number(raw)) || 0);
    setExtBusy(true); setError(null);
    try {
      const r = await api.recomputeExtensionDays(reviewLeadId, n);
      setLines((ls) => {
        if (r.removed || r.needsRate) {
          // No priced line: drop the extension line, keeping at least one editable row.
          const next = ls.filter((l) => !EXT_RE.test(l.description || ''));
          return next.length ? next : [emptyLine()];
        }
        // Priced: update the existing extension line in place, or append a new (locked) one.
        // quantity = extra days, unit_rate = per-day rate (amount = qty × rate).
        const patched = {
          description: r.description, line_type: 'service',
          quantity: String(r.extraDays), unit: 'day',
          unit_rate: String(r.dayRate), service_key: null, _descLocked: true,
        };
        if (ls.some((l) => EXT_RE.test(l.description || ''))) {
          return ls.map((l) => (EXT_RE.test(l.description || '') ? { ...l, ...patched } : l));
        }
        return [...ls, patched];
      });
      setReviewInfo((ri) => (ri ? {
        ...ri,
        extensionWarning: r.extensionWarning || null,
        // The control's own inline helper reports needs-rate for manual edits; the top note is
        // the call-derived one. Only CLEAR it once the extension is priceable/removed (mirrors
        // the server deleting vd.extensionNeedsRate); never re-phrase it as "customer asked".
        extensionReview: ri.extensionReview ? { ...ri.extensionReview, extraDays: n, needsRate: !!r.needsRate } : ri.extensionReview,
        extensionNeedsRate: r.needsRate ? ri.extensionNeedsRate : null,
      } : ri));
      setExtDays(String(n));
    } catch (e) {
      setError(e.message || 'Could not recompute the extension price');
    } finally {
      setExtBusy(false);
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
      <h1 className="text-xl font-bold text-content">{reviewMode ? 'Review Draft Invoice' : isEdit ? 'Edit Invoice' : 'New Invoice'}</h1>

      {reviewMode && (
        <div className="bg-brand/5 border border-brand/30 rounded-xl px-5 py-4 space-y-2.5">
          <p className="text-sm font-semibold text-content">
            {reviewInfo?.pendingInvoiceReview?.source === 'manual'
              ? 'Drafted from a manual swap request — review, then approve & send.'
              : 'Drafted from a customer call — review, then approve & send.'}
          </p>
          <p className="text-xs text-muted">
            This swap / extension invoice was drafted automatically and has <span className="font-semibold">not</span> been sent.
            Adjust the price or lines if needed, then <span className="font-semibold">Approve &amp; Send</span> to deliver it for
            signature + payment — or Discard to drop it. The job's pickup date stays fixed (change it via Edit Job Details).
          </p>
          {reviewInfo?.extensionWarning && (
            <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-lg px-3 py-2.5">
              <AlertTriangle size={16} className="text-warning flex-shrink-0 mt-0.5" />
              <p className="text-xs text-warning font-medium">{reviewInfo.extensionWarning.message}</p>
            </div>
          )}
          {reviewInfo?.extensionNeedsRate && (
            <div className="flex items-start gap-2 bg-surface-2 border border-divider rounded-lg px-3 py-2.5">
              <Info size={16} className="text-muted flex-shrink-0 mt-0.5" />
              <p className="text-xs text-muted">
                The customer also asked to extend {reviewInfo.extensionNeedsRate.extraDays} more day(s), but{' '}
                {reviewInfo.extensionNeedsRate.size} has no day rate set — add one on the Pricing page to bill the extension.
              </p>
            </div>
          )}
          {reviewInfo?.swapReview && (
            <div className="flex flex-wrap items-center gap-2 bg-surface-2 border border-divider rounded-lg px-3 py-2.5">
              <label className="text-xs font-semibold text-content">Swap delivery date</label>
              <input
                type="date"
                value={swapDate}
                max={isoMinus1(reviewInfo.swapReview.pickupDate)}
                disabled={swapBusy}
                onChange={(e) => { setSwapDate(e.target.value); recomputeSwap(e.target.value); }}
                className="text-sm border border-divider rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
              <span className="text-xs text-muted">
                {reviewInfo.swapReview.days != null
                  ? `${reviewInfo.swapReview.days} day${reviewInfo.swapReview.days === 1 ? '' : 's'} left — pickup stays ${reviewInfo.swapReview.pickupDate}`
                  : `pickup ${reviewInfo.swapReview.pickupDate}`}
                {swapBusy ? ' · updating…' : ''}
              </span>
            </div>
          )}
          {reviewInfo?.extensionReview && (
            <div className="flex flex-wrap items-center gap-2 bg-surface-2 border border-divider rounded-lg px-3 py-2.5">
              <label className="text-xs font-semibold text-content">Extra days (extension)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={extDays}
                disabled={extBusy}
                onChange={(e) => setExtDays(e.target.value)}
                onBlur={(e) => recomputeExtension(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); recomputeExtension(e.target.value); } }}
                className="w-20 text-sm border border-divider rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
              <span className="text-xs text-muted">
                {reviewInfo.extensionReview.needsRate
                  ? `No day rate set for ${reviewInfo.extensionReview.size} — add one on the Pricing page to bill this`
                  : reviewInfo.extensionReview.dayRate != null
                    ? `${money(reviewInfo.extensionReview.dayRate)}/day — pickup advances by this many days when paid`
                    : 'pickup advances by this many days when paid'}
                {extBusy ? ' · updating…' : ''}
              </span>
            </div>
          )}
        </div>
      )}

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
            {feeItems.length > 0 && (
              <div className="relative">
                <button onClick={() => setShowFees((v) => !v)} className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent/80">
                  Add fee / item <ChevronDown size={13} />
                </button>
                {showFees && (
                  <div className="absolute right-0 top-6 z-10 w-56 max-h-64 overflow-y-auto bg-surface border border-divider rounded-lg shadow-lg py-1">
                    {feeItems.map((f, i) => (
                      <button key={i} onClick={() => addFeeItem(f)} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2 flex justify-between gap-2">
                        <span className="text-content truncate">{f.label}</span>
                        <span className="text-muted">{f.amount != null ? money(f.amount) : '—'}</span>
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
                    <input
                      className={`w-full min-w-[10rem] text-sm border border-divider rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent ${l._descLocked ? 'bg-surface-2 text-muted cursor-not-allowed' : ''}`}
                      value={l.description}
                      onChange={(e) => setLine(i, 'description', e.target.value)}
                      readOnly={!!l._descLocked}
                      title={l._descLocked ? 'This label is used to track the swap/extension — edit the price instead. Delete the line to remove it.' : undefined}
                      placeholder="Description"
                    />
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

      {reviewMode ? (
        <>
          {/* Approve & Send has nowhere to deliver to — say so where the button is,
              instead of letting it "send" to no one. Discard / Save draft still work. */}
          {!canEmailInvoice && (
            <div className="flex items-start gap-2.5 bg-warning/5 border border-warning/30 rounded-xl px-4 py-3 mb-3">
              <AlertTriangle size={16} className="text-warning flex-shrink-0 mt-0.5" />
              <p className="text-sm text-content">
                {form.bill_to_email.trim()
                  ? `"${form.bill_to_email.trim()}" isn't a valid email address, so this invoice can't be sent.`
                  : 'Add an email address in Bill To above to send this invoice.'}
              </p>
            </div>
          )}
          <div className="flex items-center gap-2 pb-4">
            <button onClick={discardDraft} disabled={saving || reviewBusy} className="flex items-center gap-1.5 text-sm font-medium text-muted hover:text-danger disabled:opacity-50 px-3 py-2 rounded-lg"><Trash2 size={14} /> Discard draft</button>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={save} disabled={saving || reviewBusy} className="flex items-center gap-1.5 text-sm font-medium text-content bg-surface-2 hover:bg-surface-2 disabled:opacity-50 px-4 py-2 rounded-lg"><Check size={14} /> Save draft</button>
              <button onClick={approveAndSend} disabled={saving || reviewBusy || !canEmailInvoice} className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2 rounded-lg">
                <Send size={14} /> {saving ? 'Sending…' : 'Approve & Send'}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="flex justify-end gap-2 pb-4">
          <button onClick={() => navigate(backLink)} className="flex items-center gap-1.5 text-sm text-muted hover:text-content px-4 py-2 rounded-lg"><X size={14} /> Cancel</button>
          <button onClick={save} disabled={saving} className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 disabled:opacity-50 px-5 py-2 rounded-lg">
            <Check size={14} /> {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create invoice')}
          </button>
        </div>
      )}
    </div>
  );
}
