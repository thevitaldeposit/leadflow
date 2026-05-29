import { useEffect, useState, useCallback } from 'react';
import { Users, Calendar, TrendingUp, Flame, Thermometer, Snowflake, BarChart2 } from 'lucide-react';
import { api } from '../utils/api';
import LeadCard from './LeadCard';
import socket from '../socket';

function StatCard({ label, value, sub, icon: Icon, color }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value ?? '—'}</p>
        <p className="text-sm text-gray-500">{label}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function IntentPill({ intent, count }) {
  const styles = {
    hot: { bg: 'bg-red-100', text: 'text-red-700', icon: Flame },
    warm: { bg: 'bg-amber-100', text: 'text-amber-700', icon: Thermometer },
    cold: { bg: 'bg-blue-100', text: 'text-blue-600', icon: Snowflake },
  };
  const s = styles[intent] || { bg: 'bg-gray-100', text: 'text-gray-600', icon: BarChart2 };
  const Icon = s.icon;
  return (
    <div className={`flex items-center gap-2 px-4 py-3 rounded-xl ${s.bg}`}>
      <Icon size={16} className={s.text} />
      <span className={`font-semibold text-lg ${s.text}`}>{count}</span>
      <span className={`text-sm capitalize ${s.text}`}>{intent}</span>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    return Promise.all([
      api.getDashboardStats(),
      api.getLeads({ vertical: 'auto_dealer', sort: 'created_at', order: 'desc' }),
    ]).then(([s, l]) => {
      setStats(s);
      setLeads(l.slice(0, 20));
    });
  }, []);

  useEffect(() => {
    loadData()
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [loadData]);

  // Auto-refresh when a new lead arrives via WebSocket
  useEffect(() => {
    const handleNewLead = (lead) => {
      // Only show leads belonging to this tab's vertical
      if (lead.vertical && lead.vertical !== 'auto_dealer') return;
      // Prepend to leads list and trim to 20
      setLeads(prev => [lead, ...prev].slice(0, 20));
      // Refresh stats
      api.getDashboardStats().then(setStats).catch(console.error);
    };

    socket.on('new_lead', handleNewLead);
    return () => socket.off('new_lead', handleNewLead);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const intentMap = Object.fromEntries((stats?.byIntent || []).map(r => [r.customer_intent, r.count]));
  const statusMap = Object.fromEntries((stats?.byStatus || []).map(r => [r.status, r.count]));

  return (
    <div className="space-y-6">
      {/* Stat cards row */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Leads Today" value={stats?.totals?.today} icon={Users} color="bg-accent" />
        <StatCard label="Leads This Week" value={stats?.totals?.week} icon={TrendingUp} color="bg-indigo-500" />
        <StatCard label="Leads This Month" value={stats?.totals?.month} icon={BarChart2} color="bg-violet-500" />
        <StatCard
          label="Appointments Set"
          value={stats?.appointments?.week}
          sub="this week"
          icon={Calendar}
          color="bg-green-500"
        />
      </div>

      {/* Intent + status row */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">Lead Intent</p>
          <div className="flex gap-3">
            <IntentPill intent="hot" count={intentMap.hot || 0} />
            <IntentPill intent="warm" count={intentMap.warm || 0} />
            <IntentPill intent="cold" count={intentMap.cold || 0} />
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">Pipeline Status</p>
          <div className="flex flex-wrap gap-2">
            {['new', 'contacted', 'appointment_set', 'sold', 'lost'].map(s => (
              <div key={s} className="text-center px-3 py-2 bg-gray-50 rounded-lg">
                <p className="text-lg font-bold text-gray-800">{statusMap[s] || 0}</p>
                <p className="text-xs text-gray-500 capitalize">{s.replace('_', ' ')}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent leads */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-800">Recent Leads</h2>
          <span className="text-xs text-gray-400">{leads.length} shown</span>
        </div>
        {leads.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center text-gray-400">
            <Users size={32} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm">No leads yet. Submit a transcript or up sheet to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {leads.map(lead => <LeadCard key={lead.id} lead={lead} />)}
          </div>
        )}
      </div>
    </div>
  );
}
