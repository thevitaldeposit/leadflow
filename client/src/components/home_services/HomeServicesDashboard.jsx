import { useEffect, useState, useCallback } from 'react';
import { Wrench, Flame } from 'lucide-react';
import { api } from '../../utils/api';
import HomeServicesLeadCard from './HomeServicesLeadCard';
import socket from '../../socket';
import { HOME_SERVICES_STATUSES, parseVerticalData } from '../../utils/verticalConfig';

function StatTile({ label, value, color = 'bg-gray-100 text-gray-700' }) {
  return (
    <div className={`px-4 py-3 rounded-xl ${color}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs uppercase tracking-wide opacity-80">{label}</p>
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

  useEffect(() => {
    const handleNewLead = (lead) => {
      if (lead.vertical === 'home_services') setLeads(prev => [lead, ...prev]);
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

  // Status counts
  const statusCounts = HOME_SERVICES_STATUSES.reduce((acc, s) => {
    acc[s.value] = leads.filter(l => (l.status || 'new') === s.value).length;
    return acc;
  }, {});

  // ASAP count
  const asapCount = leads.filter(l => parseVerticalData(l).urgency === 'ASAP').length;

  const recent = leads.slice(0, 21);

  return (
    <div className="space-y-6">
      {/* Status strip */}
      <div className="grid grid-cols-6 gap-3">
        <StatTile label="Total" value={leads.length} color="bg-gray-100 text-gray-800" />
        <StatTile label="ASAP" value={asapCount} color="bg-red-100 text-red-700" />
        {HOME_SERVICES_STATUSES.map(s => (
          <StatTile
            key={s.value}
            label={s.label}
            value={statusCounts[s.value] || 0}
            color={
              s.value === 'new' ? 'bg-blue-100 text-blue-700'
              : s.value === 'contacted' ? 'bg-yellow-100 text-yellow-700'
              : s.value === 'quote_sent' ? 'bg-purple-100 text-purple-700'
              : s.value === 'booked' ? 'bg-emerald-100 text-emerald-800'
              : 'bg-gray-100 text-gray-600'
            }
          />
        ))}
      </div>

      {/* Recent leads */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-800">Recent Home Services Leads</h2>
          <span className="text-xs text-gray-400">{recent.length} shown</span>
        </div>
        {recent.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center text-gray-400">
            <Wrench size={32} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm">No Home Services leads yet. Calls captured for this vertical will appear here.</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {recent.map(lead => <HomeServicesLeadCard key={lead.id} lead={lead} />)}
          </div>
        )}
      </div>
    </div>
  );
}
