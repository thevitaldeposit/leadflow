import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, XCircle, Clock, Sparkles } from 'lucide-react';
import IntentBadge from './IntentBadge';
import UrgencyBadge from './UrgencyBadge';
import VoicemailBadge from './VoicemailBadge';
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
      className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 cursor-pointer hover:shadow-md hover:border-gray-200 transition-all flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 truncate">{fullName}</h3>
          <p className="text-sm text-gray-600 truncate">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end flex-shrink-0">
          {lead.call_type === 'voicemail' && <VoicemailBadge />}
          {lead.source === 'manual' && <ManualBadge />}
          <IntentBadge value={state.intent} />
          <UrgencyBadge value={vd.urgency} />
        </div>
      </div>

      <div className="flex items-start gap-1.5 text-xs text-gray-600 leading-relaxed">
        <Sparkles size={12} className="text-accent mt-0.5 flex-shrink-0" />
        <span className="line-clamp-2">{state.recommendation}</span>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-400">
        <div className="flex items-center gap-1.5">
          <Clock size={11} />
          <span>{timeAgo(lead.created_at)}</span>
        </div>
        <HomeServicesStatusBadge status={lead.status} />
      </div>

      <div className="flex items-center gap-1.5 pt-1 border-t border-gray-100">
        <button
          onClick={markBooked}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 px-2 py-1.5 rounded-md transition-colors"
        >
          <CheckCircle2 size={12} /> Booked
        </button>
        <button
          onClick={setFollowUp}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 px-2 py-1.5 rounded-md transition-colors"
        >
          <Clock size={12} /> Follow Up
        </button>
        <button
          onClick={markLost}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 disabled:opacity-50 px-2 py-1.5 rounded-md transition-colors"
        >
          <XCircle size={12} /> Lost
        </button>
      </div>
    </div>
  );
}
