import { useState, useEffect } from 'react';
import {
  User,
  Wrench,
  DollarSign,
  AlertCircle,
  Check,
  X,
  Sparkles,
  Zap,
  Link,
  Send,
  Clock,
} from 'lucide-react';
import { api } from '../../utils/api';
import {
  HOME_SERVICES_STATUSES,
  HOME_SERVICES_OUTCOMES,
  JOB_STATUSES,
  URGENCY_VALUES,
  INTENT_VALUES,
  INTENT_LABELS,
  parseVerticalData,
  getFieldPack,
  getSubVertical,
  getTerminology,
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
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
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
          className="text-sm text-left text-gray-800 hover:text-accent hover:bg-blue-50 px-1 py-0.5 rounded transition-colors min-h-[26px] whitespace-pre-wrap"
        >
          {value || <span className="text-gray-300 italic">—</span>}
        </button>
      )}
    </div>
  );
}

function EditableBool({ label, value, onSave }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave(value === true ? null : true)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            value === true ? 'bg-green-100 text-green-700' : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
          }`}
        >
          <Check size={12} /> Yes
        </button>
        <button
          onClick={() => onSave(value === false ? null : false)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            value === false ? 'bg-red-100 text-red-700' : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
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
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
      <select
        value={value || ''}
        onChange={e => onSave(e.target.value || null)}
        className="text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent bg-white"
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
    <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 bg-gray-50">
      <Icon size={15} className="text-gray-500" />
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      {badge && (
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-gray-500 bg-white border border-gray-200 px-2 py-0.5 rounded-full">
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
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
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
          className="text-sm text-left text-gray-800 hover:text-accent hover:bg-blue-50 px-1 py-0.5 rounded transition-colors min-h-[26px]"
        >
          {formatted
            ? formatted
            : showTBDWhenEmpty
              ? <span className="text-gray-400 italic">TBD</span>
              : <span className="text-gray-300 italic">Not specified</span>
          }
        </button>
      )}
      {unconfirmed && !editing && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 text-xs font-medium w-fit">
            <AlertCircle size={11} />
            Unconfirmed — update before scheduling
          </span>
          <span className="text-xs text-gray-500 px-1">Customer said: &ldquo;{effectiveRaw}&rdquo;</span>
        </div>
      )}
      {showRawNote && !editing && (
        <span className="text-xs text-gray-400 px-1">Customer said: &ldquo;{rawValue}&rdquo;</span>
      )}
    </div>
  );
}

// Render a single field-pack entry as an editable control.
function PackField({ field, vd, saveVertical, customSave }) {
  const value = vd[field.key];
  const onSave = customSave ?? saveVertical(field.key);
  const cls = field.span === 2 ? 'col-span-2' : '';
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
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Follow-Up Date</span>
      <input
        type="datetime-local"
        value={toLocalInput(value)}
        onChange={(e) => onSave(fromLocalInput(e.target.value))}
        className="text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent bg-white"
      />
    </div>
  );
}

const PAYMENT_BASE = 'https://leadflow-production-9c02.up.railway.app';

function PaymentLinkSection({ lead, onUpdate }) {
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState(null);

  const paymentUrl = `${PAYMENT_BASE}/pay/${lead.id}`;
  const isPaid = !!lead.paid_at;

  const handleResend = async () => {
    setResending(true);
    setResendMsg(null);
    try {
      const result = await api.resendPaymentSms(lead.id);
      if (result.sent) {
        onUpdate?.(result.lead);
        setResendMsg('Payment link resent successfully.');
      } else {
        setResendMsg(result.reason === 'no_phone'
          ? 'No phone number on file — add one in Contact section.'
          : result.reason === 'disabled'
            ? 'SMS is disabled in Settings.'
            : result.reason === 'no_credentials'
              ? 'Twilio not configured.'
              : 'Could not send SMS.');
      }
    } catch {
      setResendMsg('Failed to send — check server logs.');
    } finally {
      setResending(false);
    }
  };

  const togglePaid = async () => {
    const paidAt = isPaid ? null : new Date().toISOString();
    try {
      const updated = await api.updateLead(lead.id, { paid_at: paidAt });
      onUpdate?.(updated);
    } catch (e) {
      console.error('Toggle paid error:', e);
    }
  };

  const smsSentDate = lead.payment_sms_sent_at
    ? new Date(lead.payment_sms_sent_at).toLocaleString()
    : null;

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <SectionHeader title="Payment Link" icon={Link} />
      <div className="p-4 space-y-3">
        {/* URL */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Payment URL</p>
          <a
            href={paymentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent hover:underline break-all"
          >
            {paymentUrl}
          </a>
        </div>

        {/* SMS status */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">SMS Status</p>
            {smsSentDate
              ? <p className="text-sm text-gray-700">Sent on {smsSentDate}</p>
              : <p className="text-sm text-gray-400 italic">Not sent yet</p>}
          </div>
          <button
            onClick={handleResend}
            disabled={resending}
            className="flex items-center gap-1.5 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 px-3 py-2 rounded-lg transition-colors"
          >
            <Send size={13} />
            {resending ? 'Sending…' : smsSentDate ? 'Resend Payment Link' : 'Send Payment Link'}
          </button>
        </div>

        {resendMsg && (
          <p className={`text-xs px-2 py-1.5 rounded-lg ${resendMsg.includes('success') ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>
            {resendMsg}
          </p>
        )}

        {/* Payment status toggle */}
        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">Payment Status</p>
            <p className={`text-sm font-semibold ${isPaid ? 'text-green-700' : 'text-amber-600'}`}>
              {isPaid ? `Paid ${new Date(lead.paid_at).toLocaleDateString()}` : 'Unpaid'}
            </p>
          </div>
          <button
            onClick={togglePaid}
            className={`flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg transition-colors ${
              isPaid
                ? 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                : 'text-green-700 bg-green-50 hover:bg-green-100'
            }`}
          >
            {isPaid ? <><X size={13} /> Mark Unpaid</> : <><Check size={13} /> Mark Paid</>}
          </button>
        </div>
      </div>
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
  note_added: '📋',
  voicemail: '🎙️',
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
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <SectionHeader title="Activity Timeline" icon={Clock} />
      <div className="p-4">
        {loading ? (
          <p className="text-sm text-gray-400">Loading activity…</p>
        ) : activity.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No activity recorded yet</p>
        ) : (
          <ol className="relative border-l border-gray-200 ml-3">
            {activity.map(entry => (
              <li key={entry.id} className="mb-5 last:mb-0 ml-6">
                <span className="absolute -left-3 flex items-center justify-center w-6 h-6 bg-white rounded-full ring-4 ring-white text-base leading-none">
                  {ACTIVITY_ICONS[entry.activity_type] || '•'}
                </span>
                <p className="text-sm text-gray-800">{entry.description}</p>
                <time className="text-xs text-gray-400">{formatActivityTime(entry.created_at)}</time>
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

  const SIGNAL_LABELS = {
    price_agreed: 'Price agreed',
    size_confirmed: 'Size confirmed',
    delivery_date_set: 'Delivery date set',
    location_given: 'Location given',
    payment_intent: 'Payment intent',
  };

  return (
    <div className="space-y-4">
      {/* Auto-Booked badge */}
      {isAutoBooked && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          <Zap size={16} className="text-emerald-600 flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-emerald-800">Auto-Booked</p>
            <p className="text-xs text-emerald-600">All 5 booking signals detected — job was automatically confirmed from the call.</p>
          </div>
          {bookingSignals.length > 0 && (
            <div className="ml-auto flex flex-wrap gap-1 justify-end">
              {bookingSignals.map(s => (
                <span key={s} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
                  {SIGNAL_LABELS[s] || s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {!isAutoBooked && bookingConfidence && bookingConfidence !== 'none' && bookingSignals.length > 0 && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <Zap size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">
              Booking signals detected
              <span className="ml-2 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-100 border border-amber-300">
                {bookingConfidence}
              </span>
            </p>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {['price_agreed', 'size_confirmed', 'delivery_date_set', 'location_given', 'payment_intent'].map(s => (
                <span key={s} className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                  bookingSignals.includes(s)
                    ? 'bg-amber-100 text-amber-700 border-amber-300'
                    : 'bg-gray-100 text-gray-400 border-gray-200 line-through'
                }`}>
                  {SIGNAL_LABELS[s]}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Job Status + Outcome + Follow-up controls */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Job Status</p>
            <select
              value={lead.job_status || 'inquiry'}
              onChange={e => applyUpdate({ job_status: e.target.value })}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent w-full bg-white"
            >
              {JOB_STATUSES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Outcome</p>
            <select
              value={lead.outcome || ''}
              onChange={e => applyUpdate({ outcome: e.target.value || null })}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent w-full bg-white"
            >
              <option value="">—</option>
              {HOME_SERVICES_OUTCOMES.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Urgency</p>
            <select
              value={vd.urgency || ''}
              onChange={e => saveVertical('urgency')(e.target.value || null)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent w-full bg-white"
            >
              <option value="">—</option>
              {URGENCY_VALUES.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Intent</p>
            <select
              value={vd.intentLevel || ''}
              onChange={e => saveVertical('intentLevel')(e.target.value || null)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent w-full bg-white"
            >
              <option value="">—</option>
              {INTENT_VALUES.map(i => <option key={i} value={i}>{INTENT_LABELS[i]}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <FollowUpEditor value={vd.followUpDate} onSave={saveVertical('followUpDate')} />
            {vd.followUpReason && (
              <p className="text-xs text-gray-500 mt-1 italic">Reason: {vd.followUpReason}</p>
            )}
          </div>
        </div>
      </div>

      {/* Contact */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
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
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <SectionHeader title="Industry Details" icon={Wrench} badge={pack.label} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          {pack.industryFields.map(field => (
            <PackField
              key={field.key}
              field={{ ...field, label: fieldLabel(field) }}
              vd={vd}
              saveVertical={saveVertical}
              customSave={field.key === 'deliveryDate' ? saveDeliveryDate : undefined}
            />
          ))}
        </div>
      </div>

      {/* Quote / Payment — field pack driven */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <SectionHeader title="Quote / Payment" icon={DollarSign} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          {pack.quoteFields.map(field => (
            <PackField key={field.key} field={field} vd={vd} saveVertical={saveVertical} />
          ))}
        </div>
      </div>

      {/* Payment Link — only shown for booked jobs */}
      {(lead.job_status === 'booked' || lead.payment_sms_sent_at || lead.paid_at) && (
        <PaymentLinkSection lead={lead} onUpdate={(updated) => { setLead(updated); onUpdate?.(updated); }} />
      )}

      {/* Notes */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
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
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <SectionHeader title="AI Summary" icon={Sparkles} />
          <div className="p-4">
            <p className="text-sm text-gray-700 leading-relaxed bg-blue-50 px-3 py-2 rounded-lg">
              {lead.call_summary}
            </p>
          </div>
        </div>
      )}

      {saving && <p className="text-xs text-center text-gray-400">Saving...</p>}
      {/* Transcript / Recording sections live in LeadDetailPage's AudioSection. */}
      {/* Debug hint for sub_vertical, only visible in dev tools. */}
      <span className="sr-only" data-sub-vertical={subVertical} />
    </div>
  );
}
