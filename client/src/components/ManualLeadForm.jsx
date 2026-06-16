import { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { User, Wrench, DollarSign, ClipboardList, CheckCircle2, Save } from 'lucide-react';
import { api } from '../utils/api';
import { getTerminology } from '../utils/verticalConfig';

const DUMPSTER_SIZES = ['10 yard', '15 yard', '20 yard'];
const DEBRIS_TYPES = [
  'Household items',
  'Construction/remodel',
  'Roofing',
  'Yard waste',
  'Mixed/other',
];
const JOB_STATUS_OPTIONS = [
  { value: 'inquiry', label: 'Inquiry' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'booked', label: 'Booked' },
];
const INTENT_OPTIONS = [
  { value: 'cold', label: 'Cold' },
  { value: 'warm', label: 'Warm' },
  { value: 'high', label: 'High Intent' },
];

// Pickup = delivery + duration (whole days). Read-only mirror of the server's
// calcPickupFromDuration so the owner sees the same date that gets saved.
function calcPickup(deliveryISO, days) {
  const n = Number(days);
  if (!deliveryISO || !(n >= 1)) return null;
  const d = new Date(`${deliveryISO}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.round(n));
  return d.toISOString().slice(0, 10);
}

function formatPickup(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function Field({ label, required, children, span2 }) {
  return (
    <div className={`flex flex-col gap-1 ${span2 ? 'sm:col-span-2' : ''}`}>
      <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

const inputCls =
  'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-white';

function SectionCard({ title, icon: Icon, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 bg-gray-50">
        <Icon size={15} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        {children}
      </div>
    </div>
  );
}

export default function ManualLeadForm() {
  const navigate = useNavigate();
  // Navigation state carries an optional phone prefill + missedCallId when this
  // form is opened from a missed call's "Create Lead" action in the Action Queue.
  const navState = useLocation().state || {};
  // The manual form is a Home Services tool (dumpster rental schema). sub_vertical
  // drives the field wording via getTerminology, keeping the door open for other
  // verticals later.
  const vertical = 'home_services';
  const subVertical = 'dumpster_rental';
  const t = getTerminology(vertical, subVertical);

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: navState.phone || '',
    email: '',
    dumpsterSize: '',
    debrisType: '',
    deliveryDate: '',
    rentalDuration: '',
    deliveryAddress: '',
    accessNotes: '',
    price: '',
    paymentStatus: 'not_paid',
    jobStatus: 'inquiry',
    intent: 'warm',
    notes: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const pickupISO = useMemo(
    () => calcPickup(form.deliveryDate, form.rentalDuration),
    [form.deliveryDate, form.rentalDuration]
  );

  const hasJobDetail = !!(
    form.dumpsterSize || form.debrisType || form.deliveryDate || form.rentalDuration ||
    form.deliveryAddress || form.accessNotes || form.price
  );
  const isValid = form.firstName.trim() && form.phone.trim() && hasJobDetail;

  const submit = async (book) => {
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const lead = await api.createManualLead({
        ...form,
        vertical,
        subVertical,
        book,
      });
      // Opened from a missed call → fold the placeholder away now that it's a
      // real lead, so it leaves the Action Queue. Non-blocking: a failure here
      // shouldn't stop the owner from reaching their new lead.
      if (navState.missedCallId) {
        try { await api.updateLead(navState.missedCallId, { discarded: 1 }); } catch { /* ignore */ }
      }
      navigate(`/leads/${lead.id}`, { state: { fresh: true } });
    } catch (err) {
      setError(err.message || 'Failed to create lead');
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h2 className="text-lg font-bold text-gray-900">New Lead — Manual Entry</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Add a customer who walked in, texted, emailed, or was booked directly. Only name, phone,
          and one job detail are required.
        </p>
      </div>

      {/* Contact */}
      <SectionCard title="Contact Info" icon={User}>
        <Field label="First Name" required>
          <input className={inputCls} value={form.firstName} onChange={set('firstName')} placeholder="Jane" />
        </Field>
        <Field label="Last Name">
          <input className={inputCls} value={form.lastName} onChange={set('lastName')} placeholder="Doe" />
        </Field>
        <Field label="Phone" required>
          <input className={inputCls} value={form.phone} onChange={set('phone')} placeholder="555-123-4567" />
        </Field>
        <Field label="Email">
          <input className={inputCls} type="email" value={form.email} onChange={set('email')} placeholder="jane@example.com" />
        </Field>
      </SectionCard>

      {/* Job details */}
      <SectionCard title="Job Details" icon={Wrench}>
        <Field label={t.sizeLabel}>
          <select className={inputCls} value={form.dumpsterSize} onChange={set('dumpsterSize')}>
            <option value="">Select a size…</option>
            {DUMPSTER_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Debris Type">
          <select className={inputCls} value={form.debrisType} onChange={set('debrisType')}>
            <option value="">Select debris type…</option>
            {DEBRIS_TYPES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
        <Field label={t.startDate}>
          <input className={inputCls} type="date" value={form.deliveryDate} onChange={set('deliveryDate')} />
        </Field>
        <Field label={`${t.durationLabel} (days)`}>
          <input className={inputCls} type="number" min="1" value={form.rentalDuration} onChange={set('rentalDuration')} placeholder="e.g. 7" />
        </Field>
        <Field label={t.endDate}>
          <div className="text-sm text-gray-600 px-3 py-2 bg-gray-50 border border-gray-100 rounded-lg min-h-[38px] flex items-center">
            {pickupISO ? formatPickup(pickupISO) : <span className="text-gray-400 italic">Set date + duration to calculate</span>}
          </div>
        </Field>
        <Field label={t.addressLabel} span2>
          <input className={inputCls} value={form.deliveryAddress} onChange={set('deliveryAddress')} placeholder="123 Main St, City" />
        </Field>
        <Field label={t.accessLabel} span2>
          <textarea className={inputCls} rows={2} value={form.accessNotes} onChange={set('accessNotes')} placeholder="Gate code, where to place, etc." />
        </Field>
      </SectionCard>

      {/* Quote / payment */}
      <SectionCard title="Quote / Payment" icon={DollarSign}>
        <Field label="Price">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
            <input className={`${inputCls} pl-6`} type="number" min="0" step="1" value={form.price} onChange={set('price')} placeholder="0" />
          </div>
        </Field>
        <Field label="Payment Status">
          <select className={inputCls} value={form.paymentStatus} onChange={set('paymentStatus')}>
            <option value="not_paid">Not paid</option>
            <option value="paid">Paid</option>
          </select>
        </Field>
      </SectionCard>

      {/* Lead status */}
      <SectionCard title="Lead Status" icon={ClipboardList}>
        <Field label="Job Status">
          <select className={inputCls} value={form.jobStatus} onChange={set('jobStatus')}>
            {JOB_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Intent">
          <select className={inputCls} value={form.intent} onChange={set('intent')}>
            {INTENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Notes / Recommendation" span2>
          <textarea className={inputCls} rows={3} value={form.notes} onChange={set('notes')} placeholder="Any context — how they reached out, what they need, next step…" />
        </Field>
      </SectionCard>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
      )}

      {/* Save options */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => submit(false)}
          disabled={!isValid || submitting}
          className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:opacity-90 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
        >
          <Save size={15} /> Save as Lead
        </button>
        <button
          onClick={() => submit(true)}
          disabled={!isValid || submitting}
          className="flex items-center gap-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
        >
          <CheckCircle2 size={15} /> Book Job
        </button>
        {!isValid && (
          <span className="text-xs text-gray-400">Name, phone, and one job detail required.</span>
        )}
      </div>
    </div>
  );
}
