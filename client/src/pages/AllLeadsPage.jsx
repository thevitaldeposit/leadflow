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
      .then(data => {
        // Discarded calls and missed calls are never leads — they must never
        // appear in All Leads, so filter them out of the raw debug feed.
        const visible = (Array.isArray(data) ? data : [])
          .filter(l => !l.discarded && l.call_type !== 'missed_call');
        setLeads(visible);
        setLoading(false);
      })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  if (loading) {
    return <div className="p-6 text-muted text-sm">Loading all leads…</div>;
  }

  if (error) {
    return <div className="p-6 text-danger text-sm">Error: {error}</div>;
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-lg font-semibold text-content">All Leads</h2>
        <span className="text-sm text-muted">{leads.length} record{leads.length !== 1 ? 's' : ''}</span>
      </div>

      {leads.length === 0 ? (
        <div className="text-muted text-sm">No leads in database.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-divider">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-divider">
              <tr>
                {['ID', 'Name', 'Phone', 'Vertical', 'Status', 'Job Status', 'Created'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {leads.map(lead => {
                const name = [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || '—';
                const vertLabel = VERTICAL_LABELS[lead.vertical] || lead.vertical || 'auto_dealer';
                return (
                  <tr
                    key={lead.id}
                    className="cursor-pointer hover:bg-surface-2 transition-colors"
                    onClick={() => navigate(`/leads/${lead.id}`)}
                  >
                    <td className="px-4 py-2.5 text-muted font-mono text-xs">{lead.id}</td>
                    <td className="px-4 py-2.5 font-medium text-content whitespace-nowrap">{name}</td>
                    <td className="px-4 py-2.5 text-muted">{lead.phone || '—'}</td>
                    <td className="px-4 py-2.5 text-muted text-xs">{vertLabel}</td>
                    <td className="px-4 py-2.5 text-muted">{lead.status || '—'}</td>
                    <td className="px-4 py-2.5 text-muted">{lead.job_status || '—'}</td>
                    <td className="px-4 py-2.5 text-muted text-xs whitespace-nowrap">
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
