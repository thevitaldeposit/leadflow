import { useState } from 'react';
import { Link, Send, X, Check } from 'lucide-react';
import { api } from '../../utils/api';
import { PAYMENT_STATUS_STYLES, getPaymentStatusLabel } from '../../utils/verticalConfig';

const PAYMENT_BASE = 'https://leadflow-production-9c02.up.railway.app';

// Reusable Payment Link + Mark Paid block. Renders the /pay/:id link, the
// Send/Resend payment-link EMAIL button (api.emailPaymentLink — the approved channel
// while SMS/A2P is pending), and the Paid/Unpaid toggle (api.updateLead with paid_at).
// Shared by the lead-detail page AND the customer profile's Open Job card — both pass
// the BOOKED lead plus an onUpdate callback. When a derived `paymentStatus`
// ('unpaid'|'partial'|'paid') is passed, it renders the two-axis badge (job status is
// shown separately) so a partially-paid multi-invoice job reads correctly. Strictly
// reuses existing endpoints; it never re-runs extraction or booking. onUpdate receives
// the server's updated lead (toggle) / { lead } (email).
export default function PaymentLinkSection({ lead, onUpdate, paymentStatus }) {
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState(null);

  const paymentUrl = `${PAYMENT_BASE}/pay/${lead.id}`;
  const isPaid = !!lead.paid_at || paymentStatus === 'paid';

  const handleSend = async () => {
    setSending(true);
    setSendMsg(null);
    try {
      const result = await api.emailPaymentLink(lead.id);
      if (result.sent) {
        onUpdate?.(result.lead);
        setSendMsg('Payment link emailed successfully.');
      } else {
        setSendMsg(result.reason === 'no_email'
          ? 'No email on file — add one in the Contact section.'
          : result.reason === 'no_email_provider'
            ? 'Email is not configured (RESEND_API_KEY).'
            : 'Could not send the email.');
      }
    } catch {
      setSendMsg('Failed to send — check server logs.');
    } finally {
      setSending(false);
    }
  };

  const togglePaid = async () => {
    const paidAt = isPaid ? null : new Date().toISOString();
    try {
      const updated = await api.updateLead(lead.id, { paid_at: paidAt });
      onUpdate?.(updated);
    } catch (e) {
      console.error('Toggle paid error:', e);
    }
  };

  const emailedDate = lead.payment_link_emailed_at
    ? new Date(lead.payment_link_emailed_at).toLocaleString()
    : null;

  // Prefer the derived axis (all-invoices-settled rollup) when available; else paid_at.
  // 'partial' means some — but not all — of the job's invoices are settled.
  const axis = paymentStatus || (isPaid ? 'paid' : 'unpaid');

  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
        <Link size={15} className="text-muted" />
        <h3 className="text-sm font-semibold text-content">Payment Link</h3>
        <span className={`ml-auto text-[11px] font-medium px-2 py-0.5 rounded-md border ${PAYMENT_STATUS_STYLES[axis] || PAYMENT_STATUS_STYLES.unpaid}`}>
          {getPaymentStatusLabel(axis)}
        </span>
      </div>
      <div className="p-4 space-y-3">
        {/* URL */}
        <div>
          <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Payment URL</p>
          <a
            href={paymentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent hover:underline break-all"
          >
            {paymentUrl}
          </a>
          <p className="text-[11px] text-muted mt-1">Payment reserves the dumpster — nothing is held until the customer pays.</p>
        </div>

        {/* Email status */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Email Status</p>
            {emailedDate
              ? <p className="text-sm text-content">Emailed on {emailedDate}</p>
              : <p className="text-sm text-muted italic">Not sent yet</p>}
          </div>
          <button
            onClick={handleSend}
            disabled={sending}
            className="flex items-center gap-1.5 text-sm font-medium text-brand bg-brand/10 hover:bg-brand/10 disabled:opacity-50 px-3 py-2 rounded-lg transition-colors"
          >
            <Send size={13} />
            {sending ? 'Sending…' : emailedDate ? 'Resend Payment Link' : 'Email Payment Link'}
          </button>
        </div>

        {sendMsg && (
          <p className={`text-xs px-2 py-1.5 rounded-lg ${sendMsg.includes('success') ? 'text-success bg-success/10' : 'text-danger bg-danger/10'}`}>
            {sendMsg}
          </p>
        )}

        {/* Payment status toggle (manual bookkeeping — records paid_at) */}
        <div className="flex items-center justify-between pt-2 border-t border-divider">
          <div>
            <p className="text-xs font-medium text-muted uppercase tracking-wide mb-0.5">Payment Status</p>
            <p className={`text-sm font-semibold ${isPaid ? 'text-success' : 'text-warning'}`}>
              {axis === 'partial' ? 'Partially Paid' : isPaid ? `Paid${lead.paid_at ? ` ${new Date(lead.paid_at).toLocaleDateString()}` : ''}` : 'Unpaid'}
            </p>
          </div>
          <button
            onClick={togglePaid}
            className={`flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg transition-colors ${
              isPaid
                ? 'text-muted bg-surface-2 hover:bg-surface-2'
                : 'text-success bg-success/10 hover:bg-success/10'
            }`}
          >
            {isPaid ? <><X size={13} /> Mark Unpaid</> : <><Check size={13} /> Mark Paid</>}
          </button>
        </div>
      </div>
    </div>
  );
}
