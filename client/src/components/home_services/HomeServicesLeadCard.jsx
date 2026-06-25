import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, XCircle, Clock, Sparkles } from 'lucide-react';
import IntentBadge from './IntentBadge';
import UrgencyBadge from './UrgencyBadge';
import VoicemailBadge from './VoicemailBadge';
import MissedCallBadge from './MissedCallBadge';
import ManualBadge from './ManualBadge';
import HomeServicesStatusBadge from './HomeServicesStatusBadge';
import { api } from '../../utils/api';
import { parseVerticalData, getLeadActionState } from '../../utils/verticalConfig';

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// One concise action card. Quick actions update the lead in place via the
// onChange callback so the dashboard re-prioritizes without a refetch.
export default function HomeServicesLeadCard({ lead, onChange }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const vd = parseVerticalData(lead);
  const state = getLeadActionState(lead);

  const fullName = vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
    || 'Unknown Customer';

  const subtitle = state.summaryDetail || vd.serviceType || '—';

  // Quick actions — stop propagation so the row click doesn't navigate.
  const act = (e, fn) => async () => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const updated = await fn();
      onChange?.(updated);
    } catch (err) {
      console.error('Quick action failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const markBooked = (e) => act(e, () => api.updateLead(lead.id, { status: 'booked' }))();
  const markLost = (e) => act(e, () => api.updateLead(lead.id, { status: 'lost' }))();
  const setFollowUp = (e) => act(e, () => api.updateLead(lead.id, { status: 'needs_follow_up' }))();

  return (
    <div
      onClick={() => navigate(`/leads/${lead.id}`)}
      className="bg-surface rounded-xl shadow-sm border border-divider p-4 cursor-pointer hover:shadow-md hover:border-divider transition-all flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-content truncate">{fullName}</h3>
          <p className="text-sm text-muted truncate">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end flex-shrink-0">
          {lead.call_type === 'voicemail' && <VoicemailBadge />}
          {lead.call_type === 'missed_call' && <MissedCallBadge />}
          {lead.source === 'manual' && <ManualBadge />}
          <IntentBadge value={state.intent} />
          <UrgencyBadge value={vd.urgency} />
        </div>
      </div>

      <div className="flex items-start gap-1.5 text-xs text-muted leading-relaxed">
        <Sparkles size={12} className="text-accent mt-0.5 flex-shrink-0" />
        <span className="line-clamp-2">{state.recommendation}</span>
      </div>

      <div className="flex items-center justify-between text-xs text-muted">
        <div className="flex items-center gap-1.5">
          <Clock size={11} />
          <span>{timeAgo(lead.created_at)}</span>
        </div>
        <HomeServicesStatusBadge status={lead.status} />
      </div>

      <div className="flex items-center gap-1.5 pt-1 border-t border-divider">
        <button
          onClick={markBooked}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1 text-xs font-medium text-success bg-success/10 hover:bg-success/10 disabled:opacity-50 px-2 py-1.5 rounded-md transition-colors"
        >
          <CheckCircle2 size={12} /> Booked
        </button>
        <button
          onClick={setFollowUp}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1 text-xs font-medium text-warning bg-warning/10 hover:bg-warning/10 disabled:opacity-50 px-2 py-1.5 rounded-md transition-colors"
        >
          <Clock size={12} /> Follow Up
        </button>
        <button
          onClick={markLost}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1 text-xs font-medium text-muted bg-surface-2 hover:bg-surface-2 disabled:opacity-50 px-2 py-1.5 rounded-md transition-colors"
        >
          <XCircle size={12} /> Lost
        </button>
      </div>
    </div>
  );
}
