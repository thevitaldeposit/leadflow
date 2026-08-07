import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Repeat, Truck } from 'lucide-react';
import { api } from '../../utils/api';

// ── On-demand actions for a rental that's out at the customer ─────────────────
//
// The two things an owner needs mid-rental, neither of which is on a calendar:
//
//   PICK UP NOW  pure navigation into the existing pickup task (/task/:id?type=pickup).
//                No date gates a pickup — the guided sequence (which unit came back →
//                dump site → weight) runs exactly the same ahead of schedule as on the
//                scheduled day. Nothing is written here.
//
//   SWAP OUT     the manual twin of a swap the customer asks for on a call. It posts to
//                POST /leads/:id/swap-request, which is a thin wrapper over the SAME
//                producer the call-intent classifier uses. That drafts the priced swap
//                invoice and raises the Action Queue review item; from there the
//                existing review screen (swap-date recompute, Approve & Send, Mark Paid)
//                and the existing payment hook (arms the pending swap-out, which the
//                next dump ticket consumes) carry it. There is no second billing path —
//                'manual' only changes the wording.
//
// Rendered on the active-rental task screen, the dashboard's Active Rentals row and the
// customer profile's Open Job.
export default function ActiveRentalActions({
  leadId,
  size = null,
  compact = false,
  // The customer profile's Open Job offers only the swap — pickup is work you do
  // from the schedule, and the profile is where the job is administered.
  showPickup = true,
  onSwapped = null,
  className = '',
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const requestSwap = async (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (busy) return;
    if (!window.confirm(
      'Draft a swap for this rental?\n\nThis prices the swap and puts a draft invoice in your Action Queue to review and send — nothing goes to the customer until you approve it.'
    )) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.requestSwap(leadId, size);
      if (onSwapped) onSwapped(res);
      // Land on the draft in review mode — the same screen a call-driven swap opens.
      if (res && res.invoiceId) navigate(`/invoices/${res.invoiceId}/edit?review=${leadId}`);
    } catch (e2) {
      setErr(e2.message || 'Could not draft the swap.');
    } finally {
      setBusy(false);
    }
  };

  const goPickup = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    navigate(`/task/${leadId}?type=pickup`);
  };

  if (compact) {
    const cls = 'inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors disabled:opacity-50';
    return (
      <span className={`inline-flex items-center gap-1.5 ${className}`} onClick={e => e.stopPropagation()}>
        {showPickup && (
          <button onClick={goPickup} className={`${cls} text-brand bg-brand/10 hover:bg-brand/20`}>
            <Truck size={12} /> Pick up now
          </button>
        )}
        <button onClick={requestSwap} disabled={busy} className={`${cls} text-warning bg-warning/10 hover:bg-warning/20`}>
          <Repeat size={12} /> {busy ? 'Drafting…' : 'Swap out'}
        </button>
        {err && <span className="text-[11px] text-danger">{err}</span>}
      </span>
    );
  }

  const cls = 'flex-1 flex items-center justify-center gap-2 text-base font-semibold px-4 py-3.5 rounded-xl transition-colors disabled:opacity-50';
  return (
    <div className={`space-y-2.5 ${className}`}>
      <div className="flex items-center gap-3">
        {showPickup && (
          <button onClick={goPickup} className={`${cls} text-white bg-brand hover:opacity-90`}>
            <Truck size={18} /> Pick up now
          </button>
        )}
        <button onClick={requestSwap} disabled={busy} className={`${cls} text-content bg-surface-2 hover:bg-divider`}>
          <Repeat size={18} /> {busy ? 'Drafting…' : 'Swap out'}
        </button>
      </div>
      <p className="text-sm text-muted">
        Pick up now runs the normal pickup — unit, dump site, weight — ahead of schedule.
        Swap out drafts the priced swap invoice for you to review and send.
      </p>
      {err && <p className="text-sm text-danger">{err}</p>}
    </div>
  );
}
