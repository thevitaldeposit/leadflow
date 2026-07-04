import { useState, useEffect } from 'react';
import {
  User,
  Wrench,
  DollarSign,
  AlertCircle,
  Check,
  X,
  Sparkles,
  Clock,
} from 'lucide-react';
import { api } from '../../utils/api';
import BookingSignalsPanel from './BookingSignalsPanel';
import {
  HOME_SERVICES_STATUSES,
  HOME_SERVICES_OUTCOMES,
  JOB_STATUSES,
  JOB_STATUS,
  URGENCY_VALUES,
  INTENT_VALUES,
  INTENT_LABELS,
  parseVerticalData,
  getFieldPack,
  getSubVertical,
  getTerminology,
  formatTime12,
} from '../../utils/verticalConfig';

function EditableText({ label, value, onSave, multiline = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');

  const commit = () => {
    setEditing(false);
    if (draft !== (value || '')) onSave(draft || null);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      {editing ? (
        multiline ? (
          <textarea
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            rows={3}
            className="text-sm border border-accent rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
          />
        ) : (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => e.key === 'Enter' && commit()}
            className="text-sm border border-accent rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
          />
        )
      ) : (
        <button
          onClick={() => { setDraft(value || ''); setEditing(true); }}
          className="text-sm text-left text-content hover:text-accent hover:bg-brand/10 px-1 py-0.5 rounded transition-colors min-h-[26px] whitespace-pre-wrap"
        >
          {value || <span className="text-muted italic">—</span>}
        </button>
      )}
    </div>
  );
}

function EditableBool({ label, value, onSave }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave(value === true ? null : true)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            value === true ? 'bg-success/10 text-success' : 'bg-surface-2 text-muted hover:bg-surface-2'
          }`}
        >
          <Check size={12} /> Yes
        </button>
        <button
          onClick={() => onSave(value === false ? null : false)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            value === false ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-muted hover:bg-surface-2'
          }`}
        >
          <X size={12} /> No
        </button>
      </div>
    </div>
  );
}

function EditableEnum({ label, value, options, onSave }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      <select
        value={value || ''}
        onChange={e => onSave(e.target.value || null)}
        className="text-sm border border-divider rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent bg-surface"
      >
        <option value="">—</option>
        {options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

function SectionHeader({ title, icon: Icon, badge }) {
  return (
    <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
      <Icon size={15} className="text-muted" />
      <h3 className="text-sm font-semibold text-content">{title}</h3>
      {badge && (
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-muted bg-surface border border-divider px-2 py-0.5 rounded-full">
          {badge}
        </span>
      )}
    </div>
  );
}

function clientParseRentalDays(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (s.includes('week')) return Math.round(num * 7);
  if (s.includes('month')) return Math.round(num * 30);
  return Math.round(num);
}

function clientCalcPickup(deliveryISO, rentalDuration) {
  if (!deliveryISO || !rentalDuration) return null;
  const days = clientParseRentalDays(rentalDuration);
  if (!days) return null;
  const d = new Date(deliveryISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatISODate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function DateField({ label, value, rawValue, onSave, showTBDWhenEmpty = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');

  // A confirmed date is a valid ISO YYYY-MM-DD string.
  const isISO = value && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const formatted = isISO ? formatISODate(value) : null;

  // The customer's original phrase: either the explicit rawValue field, or the
  // non-ISO value itself (handles old leads where the ambiguous string landed in value).
  const effectiveRaw = rawValue || (!isISO && value ? value : null);

  // Unconfirmed: we have something the customer said but no resolved ISO date.
  const unconfirmed = !isISO && !!effectiveRaw;

  // Show a subtle "Customer said" note only when the date resolved cleanly and the
  // raw phrase differs from the ISO value (e.g. "Monday" → "2026-06-02").
  const showRawNote = !unconfirmed && rawValue && isISO && rawValue.trim() !== value.trim();

  const commit = () => {
    setEditing(false);
    if (draft !== (value || '')) onSave(draft || null);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      {editing ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => e.key === 'Enter' && commit()}
          className="text-sm border border-accent rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="YYYY-MM-DD"
        />
      ) : (
        <button
          onClick={() => { setDraft(isISO ? value : ''); setEditing(true); }}
          className="text-sm text-left text-content hover:text-accent hover:bg-brand/10 px-1 py-0.5 rounded transition-colors min-h-[26px]"
        >
          {formatted
            ? formatted
            : showTBDWhenEmpty
              ? <span className="text-muted italic">TBD</span>
              : <span className="text-muted italic">Not specified</span>
          }
        </button>
      )}
      {unconfirmed && !editing && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          <span className="inline-flex items-center gap-1 bg-warning/10 text-warning border border-warning/30 rounded px-1.5 py-0.5 text-xs font-medium w-fit">
            <AlertCircle size={11} />
            Unconfirmed — update before scheduling
          </span>
          <span className="text-xs text-muted px-1">Customer said: &ldquo;{effectiveRaw}&rdquo;</span>
        </div>
      )}
      {showRawNote && !editing && (
        <span className="text-xs text-muted px-1">Customer said: &ldquo;{rawValue}&rdquo;</span>
      )}
    </div>
  );
}

// Inline time-of-day editor. Reads/writes "HH:MM" 24-hour strings (the format
// stored on the flat scheduled_time column) but displays the 12-hour form.
// Shows a "No specific time" placeholder when unset, matching DateField's UX.
function TimeField({ label, value, onSave }) {
  const [editing, setEditing] = useState(false);
  const formatted = formatTime12(value);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      {editing ? (
        <input
          autoFocus
          type="time"
          value={value || ''}
          onChange={e => onSave(e.target.value || null)}
          onBlur={() => setEditing(false)}
          className="text-sm border border-accent rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-sm text-left text-content hover:text-accent hover:bg-brand/10 px-1 py-0.5 rounded transition-colors min-h-[26px]"
        >
          {formatted || <span className="text-muted italic">No specific time</span>}
        </button>
      )}
    </div>
  );
}

// Render a single field-pack entry as an editable control.
function PackField({ field, vd, lead, saveVertical, saveCommon, customSave }) {
  const value = vd[field.key];
  const onSave = customSave ?? saveVertical(field.key);
  const cls = field.span === 2 ? 'col-span-2' : '';
  if (field.type === 'time') {
    // `time` fields live on a flat lead column (field.flatKey), not vertical_data.
    return (
      <div className={cls}>
        <TimeField label={field.label} value={lead?.[field.flatKey]} onSave={saveCommon(field.flatKey)} />
      </div>
    );
  }
  if (field.type === 'bool') {
    return <div className={cls}><EditableBool label={field.label} value={value} onSave={onSave} /></div>;
  }
  if (field.type === 'enum') {
    return <div className={cls}><EditableEnum label={field.label} value={value} options={field.options || []} onSave={onSave} /></div>;
  }
  if (field.type === 'date') {
    const rawValue = field.rawKey ? vd[field.rawKey] : null;
    return (
      <div className={cls}>
        <DateField
          label={field.label}
          value={value}
          rawValue={rawValue}
          onSave={onSave}
          showTBDWhenEmpty={field.showTBDWhenEmpty}
        />
      </div>
    );
  }
  return (
    <div className={cls}>
      <EditableText label={field.label} value={value} onSave={onSave} multiline={field.type === 'multiline'} />
    </div>
  );
}

// Convert ISO timestamp to local "YYYY-MM-DDTHH:mm" for datetime-local input.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function FollowUpEditor({ value, onSave }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted uppercase tracking-wide">Follow-Up Date</span>
      <input
        type="datetime-local"
        value={toLocalInput(value)}
        onChange={(e) => onSave(fromLocalInput(e.target.value))}
        className="text-sm border border-divider rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent bg-surface"
      />
    </div>
  );
}

// Emoji per activity type for the timeline. inbound/outbound calls share the
// phone glyph; status changes and notes share the clipboard.
const ACTIVITY_ICONS = {
  inbound_call: '📞',
  outbound_call: '📞',
  sms_sent: '💬',
  status_change: '📋',
  job_updated: '✏️',
  reschedule_requested: '🔄',
  note_added: '📋',
  voicemail: '🎙️',
  missed_call: '📵',
};

// SQLite's CURRENT_TIMESTAMP emits "YYYY-MM-DD HH:MM:SS" in UTC with no zone;
// normalize to ISO UTC so the browser doesn't misread it as local time. ISO
// strings (payment SMS timestamps) pass through untouched.
function formatActivityTime(ts) {
  if (!ts) return '';
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)
    ? `${ts.replace(' ', 'T')}Z`
    : ts;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return '';
  const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${datePart} at ${timePart}`;
}

// Chronological log of every touchpoint for a lead, newest first. Fetched from
// GET /api/leads/:id/activity on mount.
function ActivityTimeline({ leadId }) {
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getLeadActivity(leadId)
      .then(rows => { if (active) setActivity(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (active) setActivity([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [leadId]);

  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <SectionHeader title="Activity Timeline" icon={Clock} />
      <div className="p-4">
        {loading ? (
          <p className="text-sm text-muted">Loading activity…</p>
        ) : activity.length === 0 ? (
          <p className="text-sm text-muted italic">No activity recorded yet</p>
        ) : (
          <ol className="relative border-l border-divider ml-3">
            {activity.map(entry => (
              <li key={entry.id} className="mb-5 last:mb-0 ml-6">
                <span className="absolute -left-3 flex items-center justify-center w-6 h-6 bg-surface rounded-full ring-4 ring-content text-base leading-none">
                  {ACTIVITY_ICONS[entry.activity_type] || '•'}
                </span>
                <p className="text-sm text-content">{entry.description}</p>
                <time className="text-xs text-muted">{formatActivityTime(entry.created_at)}</time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// Body of the Home Services lead detail page — everything *below* the sticky
// customer header (rendered separately by LeadDetailPage). Keeps responsibility
// narrow: editable form fields and source data.
export default function HomeServicesLeadDetail({ lead: initialLead, onUpdate }) {
  const [lead, setLead] = useState(initialLead);
  const [saving, setSaving] = useState(false);
  const vd = parseVerticalData(lead);
  const subVertical = getSubVertical(lead);
  const pack = getFieldPack(lead);
  const t = getTerminology(lead.vertical, subVertical);

  // Vertical-aware labels for the date fields — DB keys stay deliveryDate/pickupDate.
  const fieldLabel = (field) => {
    if (field.key === 'deliveryDate') return t.startDate;
    if (field.key === 'pickupDate') return t.endDate;
    if (field.key === 'scheduledTime') return t.startTime;
    return field.label;
  };

  const applyUpdate = async (body) => {
    setSaving(true);
    try {
      const updated = await api.updateLead(lead.id, body);
      setLead(updated);
      onUpdate?.(updated);
      return updated;
    } catch (e) {
      console.error('Save error:', e);
    } finally {
      setSaving(false);
    }
  };

  const saveCommon = (field) => (value) => applyUpdate({ [field]: value });
  // Partial-merge into vertical_data — server preserves all other keys, so the
  // transcript, AI summary, and untouched fields are never overwritten.
  const saveVertical = (field) => (value) => applyUpdate({ vertical_data: { [field]: value } });

  // When delivery date is saved, also auto-calculate and persist pickup date
  // if rental duration is known — saves the dispatcher a manual step.
  const saveDeliveryDate = (deliveryISO) => {
    const vdNow = parseVerticalData(lead);
    const body = {
      delivery_date: deliveryISO || null,
      vertical_data: { deliveryDate: deliveryISO || null, deliveryDateISO: deliveryISO || null },
    };
    if (deliveryISO && vdNow.rentalDuration) {
      const pickup = clientCalcPickup(deliveryISO, vdNow.rentalDuration);
      if (pickup) {
        body.pickup_date = pickup;
        body.vertical_data.pickupDate = pickup;
      }
    }
    return applyUpdate(body);
  };

  // Save Customer Name to vertical_data.customerName AND split into flat
  // first/last columns so search-by-name continues to work.
  const saveCustomerName = (fullName) => {
    const trimmed = (fullName || '').trim();
    const parts = trimmed ? trimmed.split(/\s+/) : [];
    const first = parts[0] || null;
    const last = parts.length > 1 ? parts.slice(1).join(' ') : null;
    return applyUpdate({
      vertical_data: { customerName: trimmed || null },
      customer_first_name: first,
      customer_last_name: last,
    });
  };

  const displayedCustomerName = vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ');

  const isAutoBooked = lead.auto_booked === 1;
  const bookingSignals = vd.bookingSignalsDetected || [];
  const bookingConfidence = vd.bookingConfidence || null;

  return (
    <div className="space-y-4">
      {/* Booking signals (display-only; shared with the customer profile) */}
      <BookingSignalsPanel
        autoBooked={isAutoBooked}
        bookingSignals={bookingSignals}
        bookingConfidence={bookingConfidence}
      />

      {/* Job Status + Outcome + Follow-up controls */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted uppercase tracking-wide font-medium mb-1">Job Status</p>
            <select
              value={lead.job_status || 'inquiry'}
              onChange={e => applyUpdate({ job_status: e.target.value })}
              className="text-sm border border-divider rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent w-full bg-surface"
            >
              {JOB_STATUSES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs text-muted uppercase tracking-wide font-medium mb-1">Outcome</p>
            <select
              value={lead.outcome || ''}
              onChange={e => applyUpdate({ outcome: e.target.value || null })}
              className="text-sm border border-divider rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent w-full bg-surface"
            >
              <option value="">—</option>
              {HOME_SERVICES_OUTCOMES.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs text-muted uppercase tracking-wide font-medium mb-1">Urgency</p>
            <select
              value={vd.urgency || ''}
              onChange={e => saveVertical('urgency')(e.target.value || null)}
              className="text-sm border border-divider rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent w-full bg-surface"
            >
              <option value="">—</option>
              {URGENCY_VALUES.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <p className="text-xs text-muted uppercase tracking-wide font-medium mb-1">Intent</p>
            <select
              value={vd.intentLevel || ''}
              onChange={e => saveVertical('intentLevel')(e.target.value || null)}
              className="text-sm border border-divider rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent w-full bg-surface"
            >
              <option value="">—</option>
              {INTENT_VALUES.map(i => <option key={i} value={i}>{INTENT_LABELS[i]}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <FollowUpEditor value={vd.followUpDate} onSave={saveVertical('followUpDate')} />
            {vd.followUpReason && (
              <p className="text-xs text-muted mt-1 italic">Reason: {vd.followUpReason}</p>
            )}
          </div>
        </div>
      </div>

      {/* Contact */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
        <SectionHeader title="Contact" icon={User} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          <div className="col-span-2">
            <EditableText label="Customer Name" value={displayedCustomerName} onSave={saveCustomerName} />
          </div>
          <EditableText label="Phone" value={lead.phone} onSave={saveCommon('phone')} />
          <EditableText label="Email" value={lead.email} onSave={saveCommon('email')} />
        </div>
      </div>

      {/* Industry Details — field pack driven */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
        <SectionHeader title="Industry Details" icon={Wrench} badge={pack.label} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          {pack.industryFields.map(field => (
            <PackField
              key={field.key}
              field={{ ...field, label: fieldLabel(field) }}
              vd={vd}
              lead={lead}
              saveVertical={saveVertical}
              saveCommon={saveCommon}
              customSave={field.key === 'deliveryDate' ? saveDeliveryDate : undefined}
            />
          ))}
        </div>
      </div>

      {/* Quote / Payment — field pack driven */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
        <SectionHeader title="Quote / Payment" icon={DollarSign} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          {pack.quoteFields.map(field => (
            <PackField key={field.key} field={field} vd={vd} saveVertical={saveVertical} />
          ))}
        </div>
      </div>

      {/* Notes */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
        <SectionHeader title="Notes" icon={AlertCircle} />
        <div className="p-4">
          <EditableText label="Internal Notes" value={vd.notes} onSave={saveVertical('notes')} multiline />
        </div>
      </div>

      {/* Activity Timeline — chronological touchpoint log, newest first */}
      <ActivityTimeline leadId={lead.id} />

      {/* AI Summary — confidence score replaced by inline follow-up flags on the
          server side, so this section just shows the augmented summary. */}
      {lead.call_summary && (
        <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
          <SectionHeader title="AI Summary" icon={Sparkles} />
          <div className="p-4">
            <p className="text-sm text-content leading-relaxed bg-brand/10 px-3 py-2 rounded-lg">
              {lead.call_summary}
            </p>
          </div>
        </div>
      )}

      {saving && <p className="text-xs text-center text-muted">Saving...</p>}
      {/* Transcript / Recording sections live in LeadDetailPage's AudioSection. */}
      {/* Debug hint for sub_vertical, only visible in dev tools. */}
      <span className="sr-only" data-sub-vertical={subVertical} />
    </div>
  );
}
