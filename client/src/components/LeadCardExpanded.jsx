import { useState } from 'react';
import {
  User, Phone, Mail, MapPin, Car, RefreshCw, DollarSign,
  Calendar, AlertTriangle, Flame, Copy, ChevronDown, ChevronUp,
  FileText, Image
} from 'lucide-react';
import StatusBadge from './StatusBadge';
import ConfidenceMeter from './ConfidenceMeter';
import { api } from '../utils/api';

function EditableField({ label, value, confidence, fieldKey, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');

  const handleBlur = () => {
    setEditing(false);
    if (draft !== (value || '')) onSave(fieldKey, draft || null);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
        <ConfidenceMeter value={confidence} />
      </div>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={e => e.key === 'Enter' && handleBlur()}
          className="text-sm border border-accent rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-sm text-left text-content hover:text-accent hover:bg-brand/10 px-1 py-0.5 rounded transition-colors min-h-[26px]"
        >
          {value || <span className="text-muted italic">—</span>}
        </button>
      )}
    </div>
  );
}

function Section({ title, icon: Icon, children }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
        <Icon size={15} className="text-muted" />
        <h3 className="text-sm font-semibold text-content">{title}</h3>
      </div>
      <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">{children}</div>
    </div>
  );
}

export default function LeadCardExpanded({ lead: initialLead, onUpdate }) {
  const [lead, setLead] = useState(initialLead);
  const [saving, setSaving] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  const save = async (field, value) => {
    setSaving(true);
    try {
      const updated = await api.updateLead(lead.id, { [field]: value });
      setLead(updated);
      onUpdate?.(updated);
    } catch (e) {
      console.error('Save error:', e);
    } finally {
      setSaving(false);
    }
  };

  const field = (label, valueKey, confKey) => (
    <EditableField
      label={label}
      value={lead[valueKey]}
      confidence={lead[confKey]}
      fieldKey={valueKey}
      onSave={save}
    />
  );

  const objections = (() => {
    try { return JSON.parse(lead.objections || '[]'); } catch { return []; }
  })();
  const notes = (() => {
    try { return JSON.parse(lead.additional_notes || '[]'); } catch { return []; }
  })();

  return (
    <div className="space-y-4">
      {/* Flags */}
      {(lead.flag_urgent === 1 || lead.flag_needs_manager === 1 || lead.flag_duplicate_suspect === 1) && (
        <div className="space-y-2">
          {lead.flag_urgent === 1 && (
            <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 text-danger px-4 py-2.5 rounded-lg text-sm font-medium">
              <Flame size={15} /> Urgent Lead — Immediate Follow-Up Required
              {lead.flag_reason && <span className="font-normal text-danger">— {lead.flag_reason}</span>}
            </div>
          )}
          {lead.flag_needs_manager === 1 && (
            <div className="flex items-center gap-2 bg-warning/10 border border-warning/30 text-warning px-4 py-2.5 rounded-lg text-sm font-medium">
              <AlertTriangle size={15} /> Needs Manager Attention
            </div>
          )}
          {lead.flag_duplicate_suspect === 1 && (
            <div className="flex items-center gap-2 bg-brand/10 border border-brand/30 text-brand px-4 py-2.5 rounded-lg text-sm font-medium">
              <Copy size={15} /> Possible Duplicate Lead
            </div>
          )}
        </div>
      )}

      {/* Status + Summary */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted uppercase tracking-wide font-medium mb-1">Status</p>
            <select
              value={lead.status}
              onChange={e => save('status', e.target.value)}
              className="text-sm border border-divider rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {['new', 'contacted', 'appointment_set', 'sold', 'lost'].map(s => (
                <option key={s} value={s}>
                  {s === 'appointment_set' ? 'Appointment Set' : s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <StatusBadge status={lead.status} size="lg" />
        </div>

        {lead.call_summary && (
          <div>
            <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">AI Summary</p>
            <p className="text-sm text-content leading-relaxed bg-brand/10 px-3 py-2 rounded-lg">
              {lead.call_summary}
            </p>
          </div>
        )}
      </div>

      {/* Customer */}
      <Section title="Customer Information" icon={User}>
        {field('First Name', 'customer_first_name', 'customer_first_name_confidence')}
        {field('Last Name', 'customer_last_name', 'customer_last_name_confidence')}
        {field('Phone', 'phone', 'phone_confidence')}
        {field('Email', 'email', 'email_confidence')}
        <div className="col-span-2">
          {field('Address', 'address', 'address_confidence')}
        </div>
      </Section>

      {/* Vehicle of Interest */}
      <Section title="Vehicle of Interest" icon={Car}>
        {field('Year', 'voi_year', 'voi_year_confidence')}
        {field('Make', 'voi_make', 'voi_make_confidence')}
        {field('Model', 'voi_model', 'voi_model_confidence')}
        {field('Trim', 'voi_trim', 'voi_trim_confidence')}
        {field('Color', 'voi_color', 'voi_color_confidence')}
        {field('New / Used', 'voi_new_or_used', 'voi_new_or_used_confidence')}
        {field('Stock #', 'voi_stock_number', 'voi_stock_number_confidence')}
        {field('VIN', 'voi_vin', 'voi_vin_confidence')}
      </Section>

      {/* Trade-In */}
      <Section title="Trade-In" icon={RefreshCw}>
        {field('Year', 'trade_year', 'trade_year_confidence')}
        {field('Make', 'trade_make', 'trade_make_confidence')}
        {field('Model', 'trade_model', 'trade_model_confidence')}
        {field('Trim', 'trade_trim', 'trade_trim_confidence')}
        {field('Color', 'trade_color', 'trade_color_confidence')}
        {field('Mileage', 'trade_mileage', 'trade_mileage_confidence')}
        {field('Payoff', 'trade_payoff', 'trade_payoff_confidence')}
        {field('Owned / Leased', 'trade_owned_or_leased', 'trade_owned_or_leased_confidence')}
        <div className="col-span-2">
          {field('Condition', 'trade_condition', 'trade_condition_confidence')}
        </div>
      </Section>

      {/* Deal Details */}
      <Section title="Deal & Finance" icon={DollarSign}>
        {field('Monthly Budget', 'budget_monthly', 'budget_monthly_confidence')}
        {field('Total Budget', 'budget_total', 'budget_total_confidence')}
        {field('Down Payment', 'down_payment', 'down_payment_confidence')}
        {field('Financing', 'financing_interest', 'financing_interest_confidence')}
        {field('Credit Concerns', 'credit_concerns', 'credit_concerns_confidence')}
        {field('Co-Buyer', 'co_buyer', 'co_buyer_confidence')}
      </Section>

      {/* Appointment & Intent */}
      <Section title="Appointment & Intent" icon={Calendar}>
        <div>
          <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Appt Set</p>
          <span className={`text-sm font-medium ${lead.appointment_set ? 'text-success' : 'text-muted'}`}>
            {lead.appointment_set ? 'Yes' : 'No'}
          </span>
        </div>
        {field('Date', 'appointment_date', 'appointment_date_confidence')}
        {field('Time', 'appointment_time', 'appointment_time_confidence')}
        <div>
          <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Intent</p>
          <span className="text-sm text-content capitalize">{lead.customer_intent || '—'}</span>
        </div>
        {field('Visit Type', 'visit_type', 'visit_type_confidence')}
        {field('Lead Source', 'lead_source', 'lead_source_confidence')}
        {field('Salesperson', 'salesperson_name', 'salesperson_name_confidence')}
      </Section>

      {/* Objections + Notes */}
      {(objections.length > 0 || notes.length > 0) && (
        <div className="bg-surface rounded-xl border border-divider shadow-sm p-4 space-y-3">
          {objections.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Objections</p>
              <ul className="space-y-1">
                {objections.map((obj, i) => (
                  <li key={i} className="text-sm text-content flex items-start gap-2">
                    <span className="text-danger mt-0.5">•</span>
                    {typeof obj === 'object' ? obj.objection || JSON.stringify(obj) : obj}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {notes.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Additional Notes</p>
              <ul className="space-y-1">
                {notes.map((note, i) => (
                  <li key={i} className="text-sm text-content flex items-start gap-2">
                    <span className="text-brand mt-0.5">•</span>
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Raw Source */}
      {(lead.raw_transcript || lead.raw_image_path) && (
        <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
          <button
            onClick={() => setRawOpen(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-muted hover:bg-surface-2 transition-colors"
          >
            <div className="flex items-center gap-2">
              {lead.raw_transcript ? <FileText size={14} /> : <Image size={14} />}
              {lead.raw_transcript ? 'View Original Transcript' : 'View Original Up Sheet'}
            </div>
            {rawOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {rawOpen && (
            <div className="px-4 pb-4 border-t border-divider">
              {lead.raw_transcript ? (
                <pre className="text-xs text-muted whitespace-pre-wrap bg-surface-2 rounded-lg p-3 mt-3 max-h-80 overflow-y-auto font-mono leading-relaxed">
                  {lead.raw_transcript}
                </pre>
              ) : (
                <img
                  src={lead.raw_image_path}
                  alt="Up sheet"
                  className="mt-3 max-h-96 rounded-lg border border-divider"
                />
              )}
            </div>
          )}
        </div>
      )}

      {saving && (
        <p className="text-xs text-center text-muted">Saving...</p>
      )}
    </div>
  );
}
