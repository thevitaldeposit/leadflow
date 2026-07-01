import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import socket from '../socket';
import { getLeadActionState, parseVerticalData, JOB_STATUS_STYLES, getJobStatusLabel, JOB_STATUS, LEGACY_STATUS, OPERATIONAL_JOB_STATUSES, TERMINAL_JOB_STATUSES } from '../utils/verticalConfig';
import IntentBadge from '../components/home_services/IntentBadge';
import UrgencyBadge from '../components/home_services/UrgencyBadge';

const MODE_CONFIG = {
  action_queue: {
    title: 'Action Queue',
    emptyMsg: 'No actions needed right now — inbox is clear.',
    filter: (enriched, now) => {
      const endOfTomorrow = new Date(now);
      endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
      endOfTomorrow.setHours(23, 59, 59, 999);
      return enriched.filter(e =>
        e.state.isOpportunity && e.state.isActive && !e.state.isDead && (
          (e.state.followUpDate && e.state.followUpDate <= endOfTomorrow) ||
          e.state.stale ||
          (e.state.intent === 'high' && !e.state.jobStatus)
        )
      ).sort((a, b) => b.state.priority - a.state.priority);
    },
  },
  opportunities: {
    title: 'All Opportunities',
    emptyMsg: 'No open opportunities.',
    filter: (enriched) =>
      enriched.filter(e => e.state.isOpportunity && e.state.isActive)
        .sort((a, b) => b.state.priority - a.state.priority),
  },
  booked: {
    title: 'Booked Jobs',
    emptyMsg: 'No booked jobs.',
    filter: (enriched) =>
      enriched.filter(e => e.state.isOperational)
        .sort((a, b) => {
          const da = a.lead.delivery_date || '';
          const db2 = b.lead.delivery_date || '';
          return da < db2 ? -1 : da > db2 ? 1 : 0;
        }),
  },
  schedule: {
    title: 'Schedule',
    emptyMsg: 'No deliveries or pickups scheduled.',
    filter: (enriched) =>
      enriched.filter(e => {
        const vd = e.vd;
        return (e.lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate || vd.pickupDate);
      }).sort((a, b) => {
        const da = a.lead.delivery_date || a.vd.deliveryDateISO || a.vd.deliveryDate || '';
        const db2 = b.lead.delivery_date || b.vd.deliveryDateISO || b.vd.deliveryDate || '';
        return da < db2 ? -1 : da > db2 ? 1 : 0;
      }),
  },
  completed: {
    title: 'Completed',
    emptyMsg: 'No completed jobs yet.',
    filter: (enriched) =>
      enriched.filter(e => e.lead.job_status === JOB_STATUS.COMPLETED || e.lead.status === LEGACY_STATUS.SPAM || e.lead.status === LEGACY_STATUS.LOST || e.lead.job_status === JOB_STATUS.LOST)
        .sort((a, b) => new Date(b.lead.updated_at) - new Date(a.lead.updated_at)),
  },
};

function getLeadName(lead) {
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    return vd.customerName || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown';
  } catch {
    return [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown';
  }
}

function getLeadService(lead) {
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    if (lead.sub_vertical === 'dumpster_rental') {
      return [vd.dumpsterSize, vd.debrisType].filter(Boolean).join(' · ') || 'Dumpster Rental';
    }
    return vd.serviceType || vd.equipmentType || 'Home Services';
  } catch {
    return 'Home Services';
  }
}

export default function FilteredLeadsPage({ mode }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const config = MODE_CONFIG[mode];

  const load = useCallback(() => {
    return api.getLeads({ vertical: 'home_services', sort: 'created_at', order: 'desc' }).then(setLeads);
  }, []);

  useEffect(() => {
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  // Keep this page live the same way the dashboard's Action Queue stays live:
  // a new lead (or an updated one) is merged into local state immediately so it
  // flows through this mode's filter without a manual page refresh. The actual
  // toast notification fires from Layout; this just mirrors its real-time data.
  useEffect(() => {
    const handleNewLead = (lead) => {
      if (lead.vertical !== 'home_services') return;
      setLeads(prev => prev.some(l => l.id === lead.id) ? prev : [lead, ...prev]);
    };
    const handleLeadUpdated = (lead) => {
      if (lead.vertical !== 'home_services') return;
      setLeads(prev => prev.map(l => l.id === lead.id ? lead : l));
    };
    const handleReconnect = () => { loadRef.current().catch(console.error); };
    socket.on('new_lead', handleNewLead);
    socket.on('lead_updated', handleLeadUpdated);
    socket.io.on('reconnect', handleReconnect);
    return () => {
      socket.off('new_lead', handleNewLead);
      socket.off('lead_updated', handleLeadUpdated);
      socket.io.off('reconnect', handleReconnect);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const now = new Date();
  const enriched = leads.map(l => ({ lead: l, state: getLeadActionState(l, now), vd: parseVerticalData(l) }));
  const filtered = config.filter(enriched, now);

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-content">{config.title}</h1>
        <span className="text-sm text-muted">{filtered.length} record{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-surface rounded-xl border border-divider shadow-sm p-10 text-center text-sm text-muted">
          {config.emptyMsg}
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-divider">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Service</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Intent</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">AI Recommendation</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {filtered.map(({ lead, state, vd }) => {
                const jobStatus = lead.job_status || 'inquiry';
                const statusStyle = JOB_STATUS_STYLES[jobStatus] || 'bg-surface-2 text-muted';
                const deliveryDate = lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate || null;
                return (
                  <tr
                    key={lead.id}
                    className="hover:bg-surface-2 cursor-pointer transition-colors"
                    onClick={() => navigate(`/leads/${lead.id}`)}
                  >
                    <td className="px-5 py-3">
                      <p className="font-medium text-content">{getLeadName(lead)}</p>
                      {lead.phone && <p className="text-xs text-muted">{lead.phone}</p>}
                    </td>
                    <td className="px-4 py-3 text-muted">{getLeadService(lead)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${statusStyle}`}>
                        {getJobStatusLabel(jobStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <IntentBadge value={state.intent} size="sm" />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted max-w-[220px] truncate">{state.recommendation || '—'}</td>
                    <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">
                      {deliveryDate || new Date(lead.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
