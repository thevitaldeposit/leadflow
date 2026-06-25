import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Wallet, CreditCard, ChevronRight, ExternalLink } from 'lucide-react';
import { api } from '../utils/api';
import socket from '../socket';

const money = (n, c = 'USD') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(v); }
  catch { return `$${v.toFixed(2)}`; }
};

const BRAND_LABELS = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover',
  diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay', link: 'Link',
};
const brandLabel = (b) => (b ? (BRAND_LABELS[b.toLowerCase()] || (b.charAt(0).toUpperCase() + b.slice(1))) : 'Card');

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

const STATUS_BADGE = {
  partially_refunded: { label: 'Partially refunded', cls: 'bg-warning/10 text-warning border-warning/30' },
  refunded: { label: 'Refunded', cls: 'bg-surface-2 text-muted border-divider' },
};

// Group payments (already newest-first) into local-day buckets with friendly labels.
function groupPayments(payments) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const groups = [];
  const index = {};
  for (const p of payments) {
    const d = p.created ? new Date(p.created) : null;
    let key, label;
    if (!d || Number.isNaN(d.getTime())) {
      key = 'unknown';
      label = 'Unknown date';
    } else {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
      const diffDays = Math.round((startOfToday - day) / 86400000);
      const md = day.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      if (diffDays === 0) label = `Today, ${md}`;
      else if (diffDays === 1) label = `Yesterday, ${md}`;
      else if (diffDays > 1 && diffDays < 7) label = `${day.toLocaleDateString('en-US', { weekday: 'long' })}, ${md}`;
      else label = day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
    }
    if (!index[key]) { index[key] = { key, label, items: [], total: 0 }; groups.push(index[key]); }
    index[key].items.push(p);
    // Day subtotal = net received (amount minus what's been refunded back).
    index[key].total += (Number(p.amount) || 0) - (Number(p.amount_refunded) || 0);
  }
  return groups;
}

export default function PaymentsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.getPayments().then(setData), []);
  useEffect(() => {
    setLoading(true);
    load().catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  // A refund issued here (or a payment landing) emits invoice_updated — refetch so
  // the list stays in sync without a manual reload.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    const refetch = () => loadRef.current().catch(() => {});
    socket.on('invoice_updated', refetch);
    return () => socket.off('invoice_updated', refetch);
  }, []);

  const payments = data?.payments || [];
  const groups = groupPayments(payments);

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Wallet size={18} className="text-muted" />
        <h1 className="text-lg font-bold text-content">Payments</h1>
        {!loading && <span className="text-sm text-muted">{payments.length}</span>}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48"><div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" /></div>
      ) : error ? (
        <div className="bg-surface rounded-xl border border-divider shadow-sm p-10 text-center text-sm text-danger">{error}</div>
      ) : data && !data.connected ? (
        <div className="bg-surface rounded-xl border border-divider shadow-sm p-10 text-center">
          <CreditCard size={28} className="text-muted mx-auto mb-3" />
          <p className="text-sm font-medium text-content">Set up online payments to see transactions</p>
          <p className="text-sm text-muted mt-1 mb-4">Connect your Stripe account to accept card payments on invoices and manage refunds here.</p>
          <Link to="/settings" className="inline-flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 px-4 py-2 rounded-lg">
            <ExternalLink size={14} /> Go to Settings
          </Link>
        </div>
      ) : payments.length === 0 ? (
        <div className="bg-surface rounded-xl border border-divider shadow-sm p-10 text-center text-sm text-muted">
          No payments yet. Card payments your customers make on invoices will appear here.
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="flex items-center justify-between px-1 mb-1.5">
                <h2 className="text-xs font-bold text-muted uppercase tracking-wide">{g.label}</h2>
                <span className="text-xs text-muted">{money(g.total)}</span>
              </div>
              <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden divide-y divide-divider">
                {g.items.map((p) => {
                  const badge = STATUS_BADGE[p.status];
                  return (
                    <button
                      key={p.id}
                      onClick={() => navigate(`/payments/${p.id}`)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors text-left"
                    >
                      <div className="w-9 h-9 rounded-lg bg-surface-2 flex items-center justify-center flex-shrink-0">
                        <CreditCard size={16} className="text-muted" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-content truncate">
                            {p.customer_name || brandLabel(p.card_brand)}
                          </p>
                          {badge && (
                            <span className={`inline-flex items-center text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                          )}
                        </div>
                        <p className="text-xs text-muted truncate">
                          {brandLabel(p.card_brand)}{p.card_last4 ? ` •••• ${p.card_last4}` : ''}{p.invoice_number ? ` · ${p.invoice_number}` : ''}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-content">{money(p.amount, p.currency)}</p>
                        <p className="text-xs text-muted">{fmtTime(p.created)}</p>
                      </div>
                      <ChevronRight size={16} className="text-muted flex-shrink-0" />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
