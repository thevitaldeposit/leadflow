import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, Edit2, Trash2, Send, Link as LinkIcon, ExternalLink, CheckCircle2,
  DollarSign, Mail, MessageSquare, Eye, PenLine,
} from 'lucide-react';
import { api } from '../utils/api';
import { INVOICE_STATUS_STYLES, getInvoiceStatusLabel } from '../utils/verticalConfig';

const money = (n, c = 'USD') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(v); }
  catch { return `$${v.toFixed(2)}`; }
};
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Card({ title, children, action }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      {title && (
        <div className="px-5 py-3.5 border-b border-divider flex items-center justify-between">
          <h2 className="text-sm font-bold text-content">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => api.getInvoice(id).then(setInvoice), [id]);
  useEffect(() => {
    setLoading(true);
    load().catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  const publicLink = invoice ? `${window.location.origin}/invoice/${invoice.public_token}` : '';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked */ }
  };

  const send = async (channel) => {
    setBusy(true); setFlash(null);
    try {
      const res = await api.sendInvoice(id, channel);
      const parts = [];
      if (res.delivery.email) parts.push(res.delivery.email.sent ? 'email sent' : `email failed (${res.delivery.email.error || 'no address'})`);
      if (res.delivery.sms) parts.push(res.delivery.sms.sent ? 'SMS sent' : `SMS not sent (${res.delivery.sms.reason || 'error'})`);
      setFlash({ type: res.sentAnything ? 'ok' : 'warn', msg: parts.length ? parts.join(' · ') : 'Marked as sent (no contact on file — copy the link to share).' });
      await load();
    } catch (e) {
      setFlash({ type: 'err', msg: e.message || 'Send failed' });
    } finally { setBusy(false); }
  };

  const markPaid = async () => {
    if (!confirm('Record this invoice as paid? (Manual record — no payment is processed.)')) return;
    setBusy(true);
    try { await api.markInvoicePaid(id, { method: 'manual' }); await load(); }
    catch (e) { setFlash({ type: 'err', msg: e.message }); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm('Delete this invoice? This cannot be undone.')) return;
    try { await api.deleteInvoice(id); navigate('/invoices'); }
    catch (e) { setFlash({ type: 'err', msg: e.message }); }
  };

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" /></div>;
  if (error || !invoice) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link to="/invoices" className="text-sm text-accent inline-flex items-center gap-1"><ArrowLeft size={14} /> Invoices</Link>
        <div className="bg-surface rounded-xl border border-divider p-10 text-center text-sm text-muted mt-4">{error || 'Invoice not found'}</div>
      </div>
    );
  }

  const inv = invoice;
  const locked = inv.status === 'signed' || inv.status === 'paid';
  const isVoid = inv.status === 'void';
  const statusStyle = INVOICE_STATUS_STYLES[inv.status] || INVOICE_STATUS_STYLES.draft;
  const hasEmail = !!inv.bill_to_email;
  const hasPhone = !!inv.bill_to_phone;

  const timeline = [
    inv.sent_at && { icon: Send, label: 'Sent', at: inv.sent_at },
    inv.viewed_at && { icon: Eye, label: 'Viewed by customer', at: inv.viewed_at },
    inv.signed_at && { icon: PenLine, label: `Signed by ${inv.signer_name}`, at: inv.signed_at },
    inv.paid_at && { icon: DollarSign, label: inv.payment_method === 'stripe' ? 'Paid online' : 'Marked paid', at: inv.paid_at },
    inv.refunded_at && { icon: DollarSign, label: `Refunded${Number(inv.amount_refunded) ? ` ${money(inv.amount_refunded, inv.currency)}` : ''}`, at: inv.refunded_at },
  ].filter(Boolean);

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <Link to="/invoices" className="text-sm text-accent inline-flex items-center gap-1 hover:underline"><ArrowLeft size={14} /> Invoices</Link>

      {/* Header */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm px-5 py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold text-content">{inv.invoice_number}</h1>
              <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${statusStyle}`}>{getInvoiceStatusLabel(inv.status)}</span>
              {Number(inv.amount_refunded) > 0 && (
                <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border bg-warning/10 text-warning border-warning/30">Refunded</span>
              )}
            </div>
            <p className="text-sm text-muted mt-1">
              {inv.customer_id ? <Link to={`/customers/${inv.customer_id}`} className="text-accent hover:underline">{inv.bill_to_name || 'Customer'}</Link> : (inv.bill_to_name || '—')}
              {' · '}Issued {fmtDate(inv.issue_date)}{inv.due_date ? ` · Due ${fmtDate(inv.due_date)}` : ''}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-extrabold text-content">{money(inv.total, inv.currency)}</p>
            <p className="text-[11px] text-muted">Total</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 mt-4">
          {!locked && !isVoid && (
            <Link to={`/invoices/${inv.id}/edit`} className="flex items-center gap-1.5 text-sm font-medium text-content bg-surface-2 hover:bg-surface-2 px-3 py-2 rounded-lg"><Edit2 size={14} /> Edit</Link>
          )}
          {!isVoid && (
            <>
              <button onClick={() => send('both')} disabled={busy} className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 disabled:opacity-50 px-3 py-2 rounded-lg">
                <Send size={14} /> {inv.sent_at ? 'Resend' : 'Send'}
              </button>
              <button onClick={copyLink} className="flex items-center gap-1.5 text-sm font-medium text-content bg-surface-2 hover:bg-surface-2 px-3 py-2 rounded-lg">
                <LinkIcon size={14} /> {copied ? 'Copied!' : 'Copy link'}
              </button>
              <a href={publicLink} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm font-medium text-content bg-surface-2 hover:bg-surface-2 px-3 py-2 rounded-lg"><ExternalLink size={14} /> Preview</a>
            </>
          )}
          {inv.status !== 'paid' && !isVoid && (
            <button onClick={markPaid} disabled={busy} className="flex items-center gap-1.5 text-sm font-medium text-success bg-success/10 hover:bg-success/10 disabled:opacity-50 px-3 py-2 rounded-lg"><CheckCircle2 size={14} /> Mark paid</button>
          )}
          {!locked && (
            <button onClick={remove} className="flex items-center gap-1.5 text-sm font-medium text-muted hover:text-danger px-3 py-2 rounded-lg ml-auto"><Trash2 size={14} /> Delete</button>
          )}
        </div>

        {/* Send channel hints + flash */}
        {!isVoid && (
          <div className="flex items-center gap-3 mt-3 text-xs text-muted">
            <span className="flex items-center gap-1"><Mail size={12} /> {hasEmail ? inv.bill_to_email : 'no email'}</span>
            <span className="flex items-center gap-1"><MessageSquare size={12} /> {hasPhone ? inv.bill_to_phone : 'no phone'}</span>
          </div>
        )}
        {flash && (
          <p className={`text-sm mt-3 ${flash.type === 'ok' ? 'text-success' : flash.type === 'warn' ? 'text-warning' : 'text-danger'}`}>{flash.msg}</p>
        )}
      </div>

      {locked && (
        <div className="bg-brand/10 border border-brand/30 rounded-xl px-5 py-3 text-sm text-brand">
          This invoice is {inv.status} and locked as a record. To change it, create a new invoice.
        </div>
      )}

      {/* Line items */}
      <Card title="Line Items">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 border-b border-divider">
            <tr>
              <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Description</th>
              <th className="text-right px-3 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Qty</th>
              <th className="text-right px-3 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Rate</th>
              <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divider">
            {inv.line_items.map((it) => (
              <tr key={it.id}>
                <td className="px-5 py-3 text-content align-top">
                  <span>{it.title || it.description}</span>
                  {it.line_type && it.line_type !== 'service' && <span className="ml-2 text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded bg-surface-2 text-muted">{it.line_type}</span>}
                  {it.detail ? <div className="text-muted text-xs mt-0.5">{it.detail}</div> : null}
                </td>
                <td className="px-3 py-3 text-right text-muted align-top">{it.quantity}</td>
                <td className="px-3 py-3 text-right text-muted align-top">{money(it.unit_rate, inv.currency)}</td>
                <td className="px-5 py-3 text-right text-content font-medium align-top">{money(it.amount, inv.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-divider px-5 py-4">
          <div className="ml-auto w-full max-w-xs space-y-1.5">
            <div className="flex justify-between text-sm text-muted"><span>Subtotal</span><span>{money(inv.subtotal, inv.currency)}</span></div>
            {inv.tax_amount > 0 && <div className="flex justify-between text-sm text-muted"><span>Tax ({inv.tax_rate}%)</span><span>{money(inv.tax_amount, inv.currency)}</span></div>}
            <div className="flex justify-between text-base font-bold text-content pt-2 border-t border-divider"><span>Total</span><span>{money(inv.total, inv.currency)}</span></div>
          </div>
        </div>
      </Card>

      {inv.notes && (
        <Card title="Note to Customer"><div className="px-5 py-4 text-sm text-content whitespace-pre-wrap">{inv.notes}</div></Card>
      )}

      {/* No inline Terms & Contract here: the agreement the customer reads + signs
          is resolved by business type and shown on the public invoice page — use
          "Preview" above to see exactly what the customer sees. */}

      {/* Signature evidence */}
      {inv.signed_at && (
        <Card title="Signature (dispute evidence)">
          <div className="px-5 py-4">
            {inv.signature_type === 'drawn' && inv.signature_data?.startsWith('data:image') ? (
              <img src={inv.signature_data} alt="Signature" className="h-20 border border-divider rounded-lg bg-surface" />
            ) : (
              <span className="text-3xl text-content" style={{ fontFamily: '"Brush Script MT","Segoe Script",cursive' }}>{inv.signature_data}</span>
            )}
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 mt-4 text-sm">
              <div><span className="text-muted">Signed by</span> <span className="text-content font-medium">{inv.signer_name}</span></div>
              <div><span className="text-muted">When</span> <span className="text-content">{fmtDateTime(inv.signed_at)}</span></div>
              <div><span className="text-muted">Method</span> <span className="text-content capitalize">{inv.signature_type}</span></div>
              {inv.signer_ip && <div><span className="text-muted">IP</span> <span className="text-content">{inv.signer_ip}</span></div>}
            </div>
          </div>
        </Card>
      )}

      {/* Activity timeline */}
      {timeline.length > 0 && (
        <Card title="History">
          <ul className="divide-y divide-divider">
            {timeline.map((t, i) => {
              const Icon = t.icon;
              return (
                <li key={i} className="px-5 py-3 flex items-center gap-3">
                  <Icon size={15} className="text-muted flex-shrink-0" />
                  <span className="text-sm text-content flex-1">{t.label}</span>
                  <span className="text-xs text-muted">{fmtDateTime(t.at)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Online payment is live on the public invoice link (Stripe Connect); the
          customer pays there. Payment status is reflected by the status pill, the
          Refunded badge, and the History timeline above — no placeholder needed. */}
    </div>
  );
}
