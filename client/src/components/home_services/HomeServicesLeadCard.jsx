import { useNavigate } from 'react-router-dom';
import { Phone, Wrench } from 'lucide-react';
import HomeServicesStatusBadge from './HomeServicesStatusBadge';
import UrgencyBadge from './UrgencyBadge';
import { parseVerticalData, getFieldPack } from '../../utils/verticalConfig';

function formatCallTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function HomeServicesLeadCard({ lead }) {
  const navigate = useNavigate();
  const vd = parseVerticalData(lead);
  const pack = getFieldPack(lead);
  // Each field pack nominates the vertical_data key that best summarizes the
  // job at a glance (dumpster size, HVAC service type, etc.). Fall back to the
  // legacy serviceType key so older home_services leads still show something.
  const summary = vd[pack.summaryKey] || vd.serviceType;
  const fullName = vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
    || 'Unknown Customer';

  return (
    <div
      onClick={() => navigate(`/leads/${lead.id}`)}
      className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 cursor-pointer hover:shadow-md hover:border-gray-200 transition-all"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="font-semibold text-gray-900">{fullName}</h3>
          <p className="text-xs text-gray-400 mt-0.5">{formatCallTime(lead.created_at)}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <UrgencyBadge value={vd.urgency} />
          <HomeServicesStatusBadge status={lead.status} />
        </div>
      </div>

      {summary && (
        <div className="flex items-center gap-1.5 text-sm text-gray-700 mb-2">
          <Wrench size={13} className="text-gray-400" />
          <span>{summary}</span>
        </div>
      )}

      {lead.phone && (
        <div className="flex items-center gap-1.5 text-sm text-gray-500">
          <Phone size={12} className="text-gray-400" />
          <span>{lead.phone}</span>
        </div>
      )}

      {lead.call_summary && (
        <p className="mt-2 text-xs text-gray-400 line-clamp-2 leading-relaxed">
          {lead.call_summary}
        </p>
      )}
    </div>
  );
}
