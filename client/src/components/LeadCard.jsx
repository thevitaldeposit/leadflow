import { useNavigate } from 'react-router-dom';
import { Phone, Mail, Car, Calendar, AlertTriangle, Flame } from 'lucide-react';
import StatusBadge from './StatusBadge';

const INTENT_STYLES = {
  hot: 'bg-danger/10 text-danger',
  warm: 'bg-warning/10 text-warning',
  cold: 'bg-brand/10 text-brand',
  service: 'bg-brand/10 text-brand',
  other: 'bg-surface-2 text-muted',
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
      className="bg-surface rounded-xl shadow-sm border border-divider p-4 cursor-pointer hover:shadow-md hover:border-divider transition-all"
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-content">{fullName}</h3>
            {lead.flag_urgent === 1 && (
              <Flame size={14} className="text-danger flex-shrink-0" title="Urgent" />
            )}
            {lead.flag_needs_manager === 1 && (
              <AlertTriangle size={14} className="text-warning flex-shrink-0" title="Needs Manager" />
            )}
          </div>
          <p className="text-xs text-muted mt-0.5">{timeAgo(lead.created_at)}</p>
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
      <div className="flex items-center gap-1.5 text-sm text-muted mb-2">
        <Car size={13} className="text-muted" />
        <span>{voi}</span>
        {lead.voi_new_or_used && (
          <span className="text-xs text-muted">({lead.voi_new_or_used})</span>
        )}
      </div>

      {/* Contact */}
      <div className="flex flex-col gap-1">
        {lead.phone && (
          <div className="flex items-center gap-1.5 text-sm text-muted">
            <Phone size={12} className="text-muted" />
            <span>{lead.phone}</span>
          </div>
        )}
        {lead.email && (
          <div className="flex items-center gap-1.5 text-sm text-muted truncate">
            <Mail size={12} className="text-muted" />
            <span className="truncate">{lead.email}</span>
          </div>
        )}
      </div>

      {/* Appointment */}
      {lead.appointment_set === 1 && (
        <div className="mt-2 pt-2 border-t border-divider flex items-center gap-1.5 text-xs text-success font-medium">
          <Calendar size={12} />
          Appt: {lead.appointment_date} {lead.appointment_time}
        </div>
      )}

      {/* Summary snippet */}
      {lead.call_summary && (
        <p className="mt-2 text-xs text-muted line-clamp-2 leading-relaxed">
          {lead.call_summary}
        </p>
      )}
    </div>
  );
}
