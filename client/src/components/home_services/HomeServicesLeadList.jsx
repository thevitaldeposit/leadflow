import { useEffect, useState } from 'react';
import { Search, Wrench } from 'lucide-react';
import { api } from '../../utils/api';
import HomeServicesLeadCard from './HomeServicesLeadCard';
import { HOME_SERVICES_STATUSES } from '../../utils/verticalConfig';

export default function HomeServicesLeadList() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showDiscarded, setShowDiscarded] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = { vertical: 'home_services', sort: 'created_at', order: 'desc' };
      if (statusFilter) params.status = statusFilter;
      if (search) params.search = search;
      if (showDiscarded) params.discarded = 'include';
      setLeads(await api.getLeads(params));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter, showDiscarded]);

  const handleSearch = (e) => {
    e.preventDefault();
    load();
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-center gap-3 flex-wrap">
        <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 min-w-48">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or phone..."
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <button type="submit" className="bg-accent text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-600 transition-colors">
            Search
          </button>
        </form>

        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent text-gray-600"
        >
          <option value="">All Statuses</option>
          {HOME_SERVICES_STATUSES.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showDiscarded}
            onChange={e => setShowDiscarded(e.target.checked)}
            className="rounded border-gray-300 text-accent focus:ring-accent"
          />
          Show discarded
        </label>

        <span className="text-xs text-gray-400 ml-auto">{leads.length} leads</span>
      </div>

      {/* Card grid */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
        </div>
      ) : leads.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center text-gray-400">
          <Wrench size={32} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm">No Home Services leads found.</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {leads.map(lead => <HomeServicesLeadCard key={lead.id} lead={lead} />)}
        </div>
      )}
    </div>
  );
}
