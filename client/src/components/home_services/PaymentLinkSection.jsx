import { useState } from 'react';
import { Link, Send, X, Check } from 'lucide-react';
import { api } from '../../utils/api';

const PAYMENT_BASE = 'https://leadflow-production-9c02.up.railway.app';

// Reusable Payment Link + Mark Paid block. Renders the /pay/:id link, the
// Send/Resend payment-SMS button (api.resendPaymentSms), and the Paid/Unpaid
// toggle (api.updateLead with paid_at). Shared by the lead-detail page AND the
// customer profile's Open Job card — both pass the BOOKED lead plus an onUpdate
// callback. Strictly reuses existing endpoints; it never re-runs extraction or
// booking. onUpdate receives the server's updated lead (toggle) / { lead } (SMS).
export default function PaymentLinkSection({ lead, onUpdate }) {
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState(null);

  const paymentUrl = `${PAYMENT_BASE}/pay/${lead.id}`;
  const isPaid = !!lead.paid_at;

  const handleResend = async () => {
    setResending(true);
    setResendMsg(null);
    try {
      const result = await api.resendPaymentSms(lead.id);
      if (result.sent) {
        onUpdate?.(result.lead);
        setResendMsg('Payment link resent successfully.');
      } else {
        setResendMsg(result.reason === 'no_phone'
          ? 'No phone number on file — add one in Contact section.'
          : result.reason === 'disabled'
            ? 'SMS is disabled in Settings.'
            : result.reason === 'no_credentials'
              ? 'Twilio not configured.'
              : 'Could not send SMS.');
      }
    } catch {
      setResendMsg('Failed to send — check server logs.');
    } finally {
      setResending(false);
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

  const smsSentDate = lead.payment_sms_sent_at
    ? new Date(lead.payment_sms_sent_at).toLocaleString()
    : null;

  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
        <Link size={15} className="text-muted" />
        <h3 className="text-sm font-semibold text-content">Payment Link</h3>
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
        </div>

        {/* SMS status */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">SMS Status</p>
            {smsSentDate
              ? <p className="text-sm text-content">Sent on {smsSentDate}</p>
              : <p className="text-sm text-muted italic">Not sent yet</p>}
          </div>
          <button
            onClick={handleResend}
            disabled={resending}
            className="flex items-center gap-1.5 text-sm font-medium text-brand bg-brand/10 hover:bg-brand/10 disabled:opacity-50 px-3 py-2 rounded-lg transition-colors"
          >
            <Send size={13} />
            {resending ? 'Sending…' : smsSentDate ? 'Resend Payment Link' : 'Send Payment Link'}
          </button>
        </div>

        {resendMsg && (
          <p className={`text-xs px-2 py-1.5 rounded-lg ${resendMsg.includes('success') ? 'text-success bg-success/10' : 'text-danger bg-danger/10'}`}>
            {resendMsg}
          </p>
        )}

        {/* Payment status toggle */}
        <div className="flex items-center justify-between pt-2 border-t border-divider">
          <div>
            <p className="text-xs font-medium text-muted uppercase tracking-wide mb-0.5">Payment Status</p>
            <p className={`text-sm font-semibold ${isPaid ? 'text-success' : 'text-warning'}`}>
              {isPaid ? `Paid ${new Date(lead.paid_at).toLocaleDateString()}` : 'Unpaid'}
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
