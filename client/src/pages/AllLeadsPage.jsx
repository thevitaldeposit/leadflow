import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr)) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

const VERTICAL_LABELS = {
  auto_dealer: 'Auto',
  home_services: 'Home Services',
};

export default function AllLeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/leads/all')
      .then(r => r.json())
      .then(data => { setLeads(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  if (loading) {
    return <div className="p-6 text-gray-400 text-sm">Loading all leads…</div>;
  }

  if (error) {
    return <div className="p-6 text-red-500 text-sm">Error: {error}</div>;
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-lg font-semibold text-gray-800">All Leads</h2>
        <span className="text-sm text-gray-400">{leads.length} records — no filtering applied</span>
      </div>

      {leads.length === 0 ? (
        <div className="text-gray-400 text-sm">No leads in database.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['ID', 'Name', 'Phone', 'Vertical', 'Status', 'Job Status', 'Discarded', 'Created'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {leads.map(lead => {
                const name = [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || '—';
                const vertLabel = VERTICAL_LABELS[lead.vertical] || lead.vertical || 'auto_dealer';
                return (
                  <tr
                    key={lead.id}
                    className={`cursor-pointer hover:bg-gray-50 transition-colors ${lead.discarded ? 'opacity-40' : ''}`}
                    onClick={() => navigate(`/leads/${lead.id}`)}
                  >
                    <td className="px-4 py-2.5 text-gray-400 font-mono text-xs">{lead.id}</td>
                    <td className="px-4 py-2.5 font-medium text-gray-800 whitespace-nowrap">{name}</td>
                    <td className="px-4 py-2.5 text-gray-600">{lead.phone || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{vertLabel}</td>
                    <td className="px-4 py-2.5 text-gray-600">{lead.status || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-600">{lead.job_status || '—'}</td>
                    <td className="px-4 py-2.5">
                      {lead.discarded ? (
                        <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">discarded</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">
                      {timeAgo(lead.created_at)}
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
