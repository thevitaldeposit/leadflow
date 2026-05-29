import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Wrench, AlertTriangle, TrendingUp, Clock, CheckCircle2, DollarSign } from 'lucide-react';
import { api } from '../../utils/api';
import HomeServicesLeadCard from './HomeServicesLeadCard';
import socket from '../../socket';
import { getLeadActionState } from '../../utils/verticalConfig';
import { playChime } from '../../utils/chime';

function SummaryTile({ icon: Icon, label, value, color = 'bg-gray-50 text-gray-700', warn = false }) {
  return (
    <div className={`px-4 py-3 rounded-xl border ${warn ? 'border-red-200' : 'border-gray-100'} ${color} flex items-center gap-3`}>
      <Icon size={18} className="opacity-70" />
      <div>
        <p className="text-xl font-bold leading-tight">{value}</p>
        <p className="text-xs opacity-80 leading-tight">{label}</p>
      </div>
    </div>
  );
}

function formatCurrency(amount) {
  if (amount == null || Number.isNaN(amount)) return '$0';
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}k`;
  return `$${Math.round(amount).toLocaleString()}`;
}

function EmptyState({ message }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center text-gray-400">
      <Wrench size={28} className="mx-auto mb-2 text-gray-300" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

export default function HomeServicesDashboard() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    return api.getLeads({ vertical: 'home_services', sort: 'created_at', order: 'desc' })
      .then(setLeads);
  }, []);

  useEffect(() => {
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  // Real-time updates. Three concerns this hook handles:
  //   1. Insert the new lead — dedup by id so a re-emit on reconnect can't
  //      duplicate cards. The useMemo over `leads` re-derives Today's
  //      Priorities / Summary / All Active, so no extra state plumbing.
  //   2. Audible chime — Layout.jsx also pushes a toast that plays the same
  //      chime, but the dashboard owns its own fallback so the operator hears
  //      something even if the toast is suppressed (browser focus, etc.).
  //   3. Refetch on reconnect — events fired while the socket was down would
  //      otherwise be lost. We refetch the full list on every reconnect so
  //      the dashboard self-heals.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    const handleNewLead = (lead) => {
      if (lead.vertical !== 'home_services') return;
      setLeads(prev => {
        if (prev.some(l => l.id === lead.id)) return prev;
        return [lead, ...prev];
      });
      playChime();
    };

    const handleReconnect = () => {
      loadRef.current().catch(console.error);
    };

    socket.on('new_lead', handleNewLead);
    socket.io.on('reconnect', handleReconnect);
    return () => {
      socket.off('new_lead', handleNewLead);
      socket.io.off('reconnect', handleReconnect);
    };
  }, []);

  // Optimistic update from quick actions on lead cards.
  const handleLeadChange = useCallback((updated) => {
    setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
  }, []);

  // Enrich each lead with action state, then compute the dashboard sections.
  // Memoized so card quick-actions re-derive priorities instantly.
  const { priorities, active, summary } = useMemo(() => {
    const enriched = leads.map(l => ({ lead: l, state: getLeadActionState(l) }));

    const activeEnriched = enriched.filter(e => e.state.isActive);
    const priorityEnriched = activeEnriched
      .filter(e => ['follow_up_due', 'high_intent_new', 'stale', 'waiting'].includes(e.state.bucket))
      .sort((a, b) => b.state.priority - a.state.priority);

    const allActiveSorted = [...activeEnriched].sort((a, b) => b.state.priority - a.state.priority);

    const followUpsToday = activeEnriched.filter(e => e.state.followUpDueToday).length;
    const highIntent = activeEnriched.filter(e => e.state.intent === 'high').length;
    const staleCount = activeEnriched.filter(e => e.state.stale).length;
    const booked = leads.filter(l => l.status === 'booked').length;
    const pipelineValue = activeEnriched.reduce(
      (sum, e) => sum + (e.state.estimatedRevenue || 0),
      0,
    );

    return {
      priorities: priorityEnriched,
      active: allActiveSorted,
      summary: { followUpsToday, highIntent, staleCount, booked, pipelineValue },
    };
  }, [leads]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const topPriority = priorities[0];
  const topName = topPriority && (
    parseLeadName(topPriority.lead) || 'this lead'
  );
  const motivator = priorities.length === 0
    ? 'Inbox is clear. Nice work — keep an eye out for new calls.'
    : `You have ${priorities.length} lead${priorities.length === 1 ? '' : 's'} that could move today. Start with ${topName}.`;

  return (
    <div className="space-y-6">
      {/* SECTION 1: Today's Priorities — the most important section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Today's Priorities</h2>
            <p className="text-xs text-gray-500 mt-0.5">{motivator}</p>
          </div>
          <span className="text-xs text-gray-400">{priorities.length} action{priorities.length === 1 ? '' : 's'}</span>
        </div>
        {priorities.length === 0 ? (
          <EmptyState message="No urgent actions. New leads and follow-ups will appear here automatically." />
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {priorities.map(({ lead }) => (
              <HomeServicesLeadCard key={lead.id} lead={lead} onChange={handleLeadChange} />
            ))}
          </div>
        )}
      </section>

      {/* SECTION 2: Today's Summary */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Today's Summary</h2>
        <div className="grid grid-cols-5 gap-3">
          <SummaryTile
            icon={Clock}
            label="Follow-Ups Due Today"
            value={summary.followUpsToday}
            color="bg-amber-50 text-amber-800"
          />
          <SummaryTile
            icon={TrendingUp}
            label="High Intent Leads"
            value={summary.highIntent}
            color="bg-emerald-50 text-emerald-800"
          />
          <SummaryTile
            icon={AlertTriangle}
            label="Stale Leads"
            value={summary.staleCount}
            color={summary.staleCount > 0 ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'}
            warn={summary.staleCount > 0}
          />
          <SummaryTile
            icon={CheckCircle2}
            label="Booked Jobs"
            value={summary.booked}
            color="bg-emerald-50 text-emerald-800"
          />
          <SummaryTile
            icon={DollarSign}
            label="Pipeline Value"
            value={formatCurrency(summary.pipelineValue)}
            color="bg-blue-50 text-blue-800"
          />
        </div>
      </section>

      {/* SECTION 3: All Active Leads — same card format as priorities */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">All Active Leads</h2>
          <span className="text-xs text-gray-400">{active.length} active</span>
        </div>
        {active.length === 0 ? (
          <EmptyState message="No active leads. Calls captured for this vertical will appear here." />
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {active.map(({ lead }) => (
              <HomeServicesLeadCard key={lead.id} lead={lead} onChange={handleLeadChange} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function parseLeadName(lead) {
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    return vd.customerName
      || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
      || null;
  } catch {
    return [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || null;
  }
}
