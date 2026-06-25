import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, CreditCard, ReceiptText, RotateCcw, CheckCircle2, ExternalLink } from 'lucide-react';
import { api } from '../utils/api';

const money = (n, c = 'USD') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(v); }
  catch { return `$${v.toFixed(2)}`; }
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const BRAND_LABELS = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover',
  diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay', link: 'Link',
};
const brandLabel = (b) => (b ? (BRAND_LABELS[b.toLowerCase()] || (b.charAt(0).toUpperCase() + b.slice(1))) : 'Card');

const STATUS = {
  paid: { label: 'Paid', cls: 'bg-success/10 text-success border-success/30' },
  partially_refunded: { label: 'Partially refunded', cls: 'bg-warning/10 text-warning border-warning/30' },
  refunded: { label: 'Refunded', cls: 'bg-surface-2 text-muted border-divider' },
};

function Card({ title, children }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      {title && <div className="px-5 py-3.5 border-b border-divider"><h2 className="text-sm font-bold text-content">{title}</h2></div>}
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-content font-medium text-right">{children}</span>
    </div>
  );
}

export default function PaymentDetailPage() {
  const { id } = useParams();
  const [pay, setPay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Refund UI state
  const [refundOpen, setRefundOpen] = useState(false);
  const [mode, setMode] = useState('full'); // 'full' | 'partial'
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);

  const load = useCallback(() => api.getPayment(id).then(setPay), [id]);
  useEffect(() => {
    setLoading(true);
    load().catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  const submitRefund = async () => {
    const refundable = Number(pay.refundable_amount) || 0;
    let amount; // dollars, or undefined for full
    if (mode === 'partial') {
      amount = Number(partial);
      if (!Number.isFinite(amount) || amount <= 0) { setFlash({ type: 'err', msg: 'Enter a valid refund amount.' }); return; }
      if (amount > refundable + 1e-9) { setFlash({ type: 'err', msg: `Amount exceeds the refundable balance (${money(refundable, pay.currency)}).` }); return; }
    }
    const amountLabel = mode === 'partial' ? money(amount, pay.currency) : money(refundable, pay.currency);
    if (!confirm(`Refund ${amountLabel} to the customer? This cannot be undone.`)) return;

    setBusy(true); setFlash(null);
    try {
      const res = await api.refundPayment(id, mode === 'partial' ? { amount } : {});
      setFlash({ type: 'ok', msg: `Refunded ${money(res.refund?.amount ?? amount ?? refundable, pay.currency)}.` });
      setRefundOpen(false);
      setPartial('');
      setMode('full');
      await load();
    } catch (e) {
      setFlash({ type: 'err', msg: e.message || 'Refund failed' });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" /></div>;
  if (error || !pay) {
    return (
      <div className="max-w-2xl mx-auto">
        <Link to="/payments" className="text-sm text-accent inline-flex items-center gap-1"><ArrowLeft size={14} /> Payments</Link>
        <div className="bg-surface rounded-xl border border-divider p-10 text-center text-sm text-muted mt-4">{error || 'Payment not found'}</div>
      </div>
    );
  }

  const status = STATUS[pay.status] || STATUS.paid;
  const refundable = Number(pay.refundable_amount) || 0;
  const canRefund = refundable > 0 && pay.status !== 'refunded';

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <Link to="/payments" className="text-sm text-accent inline-flex items-center gap-1 hover:underline"><ArrowLeft size={14} /> Payments</Link>

      {/* Header */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm px-5 py-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-surface-2 flex items-center justify-center flex-shrink-0">
              <CreditCard size={20} className="text-muted" />
            </div>
            <div>
              <p className="text-2xl font-extrabold text-content leading-tight">{money(pay.amount, pay.currency)}</p>
              <p className="text-sm text-muted">{brandLabel(pay.card_brand)}{pay.card_last4 ? ` •••• ${pay.card_last4}` : ''}{pay.wallet ? ` · ${pay.wallet.replace('_', ' ')}` : ''}</p>
            </div>
          </div>
          <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full border ${status.cls}`}>{status.label}</span>
        </div>
        {Number(pay.amount_refunded) > 0 && (
          <p className="text-sm text-warning mt-3">{money(pay.amount_refunded, pay.currency)} refunded · {money(refundable, pay.currency)} refundable</p>
        )}
        {flash && (
          <p className={`text-sm mt-3 ${flash.type === 'ok' ? 'text-success' : 'text-danger'}`}>{flash.msg}</p>
        )}
      </div>

      {/* Details */}
      <Card title="Details">
        <div className="divide-y divide-divider">
          <Row label="Customer">{pay.customer_name || '—'}</Row>
          <Row label="Card">{brandLabel(pay.card_brand)}{pay.card_last4 ? ` •••• ${pay.card_last4}` : ''}</Row>
          <Row label="Date">{fmtDateTime(pay.created)}</Row>
          <Row label="Amount">{money(pay.amount, pay.currency)}</Row>
          <Row label="Stripe fee">{pay.fee != null ? `−${money(pay.fee, pay.fee_currency || pay.currency)}` : 'Pending'}</Row>
          <Row label="Net">{pay.net != null ? money(pay.net, pay.fee_currency || pay.currency) : 'Pending'}</Row>
          {Number(pay.amount_refunded) > 0 && <Row label="Refunded">{money(pay.amount_refunded, pay.currency)}</Row>}
          <Row label="Invoice">
            {pay.invoice ? (
              <Link to={`/invoices/${pay.invoice.id}`} className="text-accent hover:underline inline-flex items-center gap-1">
                <ReceiptText size={13} /> {pay.invoice.invoice_number}
              </Link>
            ) : '—'}
          </Row>
        </div>
      </Card>

      {/* Refund history */}
      {Array.isArray(pay.refunds) && pay.refunds.length > 0 && (
        <Card title="Refunds">
          <ul className="divide-y divide-divider">
            {pay.refunds.map((r) => (
              <li key={r.id} className="px-5 py-3 flex items-center gap-3 text-sm">
                <RotateCcw size={15} className="text-warning flex-shrink-0" />
                <span className="text-content flex-1">{money(r.amount, pay.currency)} refunded{r.status && r.status !== 'succeeded' ? ` (${r.status})` : ''}</span>
                <span className="text-xs text-muted">{fmtDateTime(r.created)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Refund action */}
      <Card title="Refund">
        <div className="px-5 py-4">
          {pay.status === 'refunded' ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <CheckCircle2 size={16} className="text-muted" /> This payment has been fully refunded.
            </div>
          ) : !refundOpen ? (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm text-muted">{money(refundable, pay.currency)} available to refund.</p>
              <button
                onClick={() => { setRefundOpen(true); setFlash(null); }}
                disabled={!canRefund}
                className="flex items-center gap-1.5 text-sm font-medium text-danger bg-danger/10 hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 rounded-lg"
              >
                <RotateCcw size={14} /> Refund
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm text-content">
                  <input type="radio" name="refundMode" checked={mode === 'full'} onChange={() => setMode('full')} className="accent-accent" />
                  Full refund <span className="text-muted">({money(refundable, pay.currency)})</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-content">
                  <input type="radio" name="refundMode" checked={mode === 'partial'} onChange={() => setMode('partial')} className="accent-accent" />
                  Partial refund
                </label>
              </div>

              {mode === 'partial' && (
                <div>
                  <div className="relative w-40">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm">$</span>
                    <input
                      type="number" min="0" step="0.01" max={refundable} autoFocus
                      value={partial}
                      onChange={(e) => setPartial(e.target.value)}
                      placeholder="0.00"
                      className="w-full text-sm border border-divider rounded-lg pl-6 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                  <p className="text-[11px] text-muted mt-1">Max {money(refundable, pay.currency)}</p>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button onClick={submitRefund} disabled={busy} className="flex items-center gap-1.5 text-sm font-medium text-content bg-danger hover:bg-danger/90 disabled:opacity-50 px-4 py-2 rounded-lg">
                  <RotateCcw size={14} /> {busy ? 'Refunding…' : 'Issue refund'}
                </button>
                <button onClick={() => { setRefundOpen(false); setPartial(''); setMode('full'); setFlash(null); }} disabled={busy} className="text-sm text-muted hover:text-content px-3 py-2 rounded-lg">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {pay.receipt_url && (
        <a href={pay.receipt_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent">
          <ExternalLink size={14} /> View Stripe receipt
        </a>
      )}
    </div>
  );
}
