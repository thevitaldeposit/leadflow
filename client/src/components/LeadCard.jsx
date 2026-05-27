import { useNavigate } from 'react-router-dom';
import { Phone, Mail, Car, Calendar, AlertTriangle, Flame } from 'lucide-react';
import StatusBadge from './StatusBadge';

const INTENT_STYLES = {
  hot: 'bg-red-100 text-red-700',
  warm: 'bg-amber-100 text-amber-700',
  cold: 'bg-blue-100 text-blue-600',
  service: 'bg-purple-100 text-purple-700',
  other: 'bg-gray-100 text-gray-600',
};

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr)) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function LeadCard({ lead }) {
  const navigate = useNavigate();
  const fullName = [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown Customer';
  const voi = [lead.voi_year, lead.voi_make, lead.voi_model].filter(Boolean).join(' ') || '—';
  const intentStyle = INTENT_STYLES[lead.customer_intent] || INTENT_STYLES.other;
  const intent = lead.customer_intent ? lead.customer_intent.charAt(0).toUpperCase() + lead.customer_intent.slice(1) : null;

  return (
    <div
      onClick={() => navigate(`/leads/${lead.id}`)}
      className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 cursor-pointer hover:shadow-md hover:border-gray-200 transition-all"
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900">{fullName}</h3>
            {lead.flag_urgent === 1 && (
              <Flame size={14} className="text-red-500 flex-shrink-0" title="Urgent" />
            )}
            {lead.flag_needs_manager === 1 && (
              <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" title="Needs Manager" />
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">{timeAgo(lead.created_at)}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {intent && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${intentStyle}`}>
              {intent}
            </span>
          )}
          <StatusBadge status={lead.status} />
        </div>
      </div>

      {/* Vehicle */}
      <div className="flex items-center gap-1.5 text-sm text-gray-600 mb-2">
        <Car size={13} className="text-gray-400" />
        <span>{voi}</span>
        {lead.voi_new_or_used && (
          <span className="text-xs text-gray-400">({lead.voi_new_or_used})</span>
        )}
      </div>

      {/* Contact */}
      <div className="flex flex-col gap-1">
        {lead.phone && (
          <div className="flex items-center gap-1.5 text-sm text-gray-500">
            <Phone size={12} className="text-gray-400" />
            <span>{lead.phone}</span>
          </div>
        )}
        {lead.email && (
          <div className="flex items-center gap-1.5 text-sm text-gray-500 truncate">
            <Mail size={12} className="text-gray-400" />
            <span className="truncate">{lead.email}</span>
          </div>
        )}
      </div>

      {/* Appointment */}
      {lead.appointment_set === 1 && (
        <div className="mt-2 pt-2 border-t border-gray-50 flex items-center gap-1.5 text-xs text-green-600 font-medium">
          <Calendar size={12} />
          Appt: {lead.appointment_date} {lead.appointment_time}
        </div>
      )}

      {/* Summary snippet */}
      {lead.call_summary && (
        <p className="mt-2 text-xs text-gray-400 line-clamp-2 leading-relaxed">
          {lead.call_summary}
        </p>
      )}
    </div>
  );
}
