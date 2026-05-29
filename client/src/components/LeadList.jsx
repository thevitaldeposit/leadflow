import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import StatusBadge from './StatusBadge';
import { api } from '../utils/api';

const INTENT_STYLES = {
  hot: 'text-red-600 bg-red-50 px-2 py-0.5 rounded-full font-medium',
  warm: 'text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full font-medium',
  cold: 'text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full font-medium',
};

function SortHeader({ label, sortKey, current, dir, onClick }) {
  const active = current === sortKey;
  return (
    <button
      onClick={() => onClick(sortKey)}
      className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-700 transition-colors"
    >
      {label}
      {active ? (
        dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
      ) : (
        <ChevronDown size={12} className="text-gray-300" />
      )}
    </button>
  );
}

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr)) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function LeadList() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [intentFilter, setIntentFilter] = useState('');
  const [sort, setSort] = useState('created_at');
  const [dir, setDir] = useState('desc');
  const [showDiscarded, setShowDiscarded] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const params = { vertical: 'auto_dealer', sort, order: dir };
      if (statusFilter) params.status = statusFilter;
      if (intentFilter) params.intent = intentFilter;
      if (search) params.search = search;
      if (showDiscarded) params.discarded = 'include';
      setLeads(await api.getLeads(params));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [sort, dir, statusFilter, intentFilter, showDiscarded]);

  const handleSearch = (e) => {
    e.preventDefault();
    load();
  };

  const handleSort = (key) => {
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir('desc'); }
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Delete this lead?')) return;
    await api.deleteLead(id);
    setLeads(l => l.filter(x => x.id !== id));
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
          {['new', 'contacted', 'appointment_set', 'sold', 'lost'].map(s => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>

        <select
          value={intentFilter}
          onChange={e => setIntentFilter(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent text-gray-600"
        >
          <option value="">All Intent</option>
          {['hot', 'warm', 'cold', 'service', 'other'].map(i => (
            <option key={i} value={i}>{i}</option>
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

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3">
                  <SortHeader label="Date" sortKey="created_at" current={sort} dir={dir} onClick={handleSort} />
                </th>
                <th className="text-left px-4 py-3">
                  <SortHeader label="Customer" sortKey="customer_last_name" current={sort} dir={dir} onClick={handleSort} />
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Phone</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Vehicle of Interest</th>
                <th className="text-left px-4 py-3">
                  <SortHeader label="Intent" sortKey="customer_intent" current={sort} dir={dir} onClick={handleSort} />
                </th>
                <th className="text-left px-4 py-3">
                  <SortHeader label="Status" sortKey="status" current={sort} dir={dir} onClick={handleSort} />
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Salesperson</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-sm text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="animate-spin w-4 h-4 border-2 border-accent border-t-transparent rounded-full" />
                      Loading leads...
                    </div>
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-sm text-gray-400">
                    No leads found
                  </td>
                </tr>
              ) : (
                leads.map(lead => {
                  const name = [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown';
                  const voi = [lead.voi_year, lead.voi_make, lead.voi_model].filter(Boolean).join(' ') || '—';
                  return (
                    <tr
                      key={lead.id}
                      onClick={() => navigate(`/leads/${lead.id}`)}
                      className={`border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors ${lead.discarded ? 'opacity-50' : ''}`}
                    >
                      <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{timeAgo(lead.created_at)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-800 whitespace-nowrap">
                        {name}
                        {lead.discarded ? (
                          <span className="ml-2 text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">discarded</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{lead.phone || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{voi}</td>
                      <td className="px-4 py-3">
                        {lead.customer_intent ? (
                          <span className={`text-xs capitalize ${INTENT_STYLES[lead.customer_intent] || 'text-gray-500'}`}>
                            {lead.customer_intent}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={lead.status} />
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">{lead.salesperson_name || '—'}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={e => handleDelete(e, lead.id)}
                          className="p-1.5 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
