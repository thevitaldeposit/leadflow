import {
  Sparkles,
  CheckCircle2,
  XCircle,
  Clock,
  Edit3,
} from 'lucide-react';
import HomeServicesStatusBadge from './HomeServicesStatusBadge';
import UrgencyBadge from './UrgencyBadge';
import IntentBadge from './IntentBadge';
import { api } from '../../utils/api';
import { parseVerticalData, getLeadActionState } from '../../utils/verticalConfig';

// Renders the action-first customer header that sticks to the top of <main>
// while the rest of the lead detail content scrolls underneath. Lives at the
// page level (rendered by LeadDetailPage) rather than inside
// HomeServicesLeadDetail so its containing block spans the entire scrolled
// content — otherwise it would un-stick as soon as the user scrolled past
// the lead's section cards but before the audio/transcript sections.
//
// Layout notes:
// - `-mx-6 -mt-6` cancel <main>'s p-6 so the bar reaches the top + side edges
//   of the scroll container, covering content cleanly when stuck.
// - `z-20` sits above section cards (shadow-sm) but below toasts.
// - No `overflow-hidden` here — that's not needed and can interact awkwardly
//   with sticky positioning in some engines.
export default function HomeServicesStickyHeader({ lead, onUpdate }) {
  const vd = parseVerticalData(lead);
  const state = getLeadActionState(lead);

  const displayedName = vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
    || 'Unknown Customer';
  const summary = state.summaryDetail || vd.serviceType || null;

  const applyStatus = async (status) => {
    try {
      const updated = await api.updateLead(lead.id, { status });
      onUpdate?.(updated);
    } catch (err) {
      console.error('Sticky action failed:', err);
    }
  };

  return (
    <div className="sticky top-0 z-20 -mx-6 -mt-6 mb-4 bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-3xl mx-auto px-6 py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-gray-900">{displayedName}</h2>
            {summary && <p className="text-sm text-gray-600 mt-0.5">{summary}</p>}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            <IntentBadge value={state.intent} size="md" />
            <UrgencyBadge value={vd.urgency} size="md" />
            <HomeServicesStatusBadge status={lead.status} size="lg" />
          </div>
        </div>

        {state.recommendation && (
          <div className="mt-3 flex items-start gap-2 text-sm text-gray-700 bg-blue-50 px-3 py-2 rounded-lg">
            <Sparkles size={14} className="text-accent mt-0.5 flex-shrink-0" />
            <span>{state.recommendation}</span>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => applyStatus('booked')}
            className="flex items-center gap-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 px-3 py-2 rounded-lg transition-colors"
          >
            <CheckCircle2 size={14} /> Mark Booked
          </button>
          <button
            onClick={() => applyStatus('lost')}
            className="flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 px-3 py-2 rounded-lg transition-colors"
          >
            <XCircle size={14} /> Mark Lost
          </button>
          <button
            onClick={() => applyStatus('needs_follow_up')}
            className="flex items-center gap-1.5 text-sm font-medium text-amber-800 bg-amber-100 hover:bg-amber-200 px-3 py-2 rounded-lg transition-colors"
          >
            <Clock size={14} /> Set Follow Up
          </button>
          <div className="flex items-center gap-1.5 ml-auto text-xs text-gray-400">
            <Edit3 size={12} />
            <span>Edit fields below</span>
          </div>
        </div>
      </div>
    </div>
  );
}
