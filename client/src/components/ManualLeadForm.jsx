import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  User, Wrench, DollarSign, ClipboardList, ArrowRight, ArrowLeft,
  Send, Banknote, AlertTriangle, MessageSquare,
} from 'lucide-react';
import { api } from '../utils/api';
import { getTerminology, formatTime12 } from '../utils/verticalConfig';
import AvailabilityCheck from './home_services/AvailabilityCheck';

const DUMPSTER_SIZES = ['10 yard', '15 yard', '20 yard'];
const DEBRIS_TYPES = [
  'Household items',
  'Construction/remodel',
  'Roofing',
  'Yard waste',
  'Mixed/other',
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

function formatDay(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function Field({ label, required, children, span2 }) {
  return (
    <div className={`flex flex-col gap-1 ${span2 ? 'sm:col-span-2' : ''}`}>
      <label className="text-xs font-medium text-muted uppercase tracking-wide">
        {label} {required && <span className="text-danger">*</span>}
      </label>
      {children}
    </div>
  );
}

const inputCls =
  'w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-surface';

function SectionCard({ title, icon: Icon, children }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
        <Icon size={15} className="text-muted" />
        <h3 className="text-sm font-semibold text-content">{title}</h3>
      </div>
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        {children}
      </div>
    </div>
  );
}

function SummaryRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-divider last:border-0">
      <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      <span className="text-sm text-content text-right">{value || <span className="text-muted italic">—</span>}</span>
    </div>
  );
}

// Manual "Create Job" flow. Reachable from the sidebar (/new/manual), the dashboard
// "Create Job" action, and a customer profile's empty-inquiry "Create Job" (which
// prefills the customer + passes customerId so the job links to that person, not just
// by phone). ONE flow: Step 1 captures/confirms customer + full job details (incl.
// delivery time); Step 2 books it — Send Payment Link (→ pending_payment, emailed) or
// Mark Paid (external/cash → booked + reserved, no link), or just save it as an
// inquiry. Every path feeds the SAME server lifecycle (POST /leads/manual); no
// extraction, booking-signal, or auto-book logic runs here.
export default function ManualLeadForm() {
  const navigate = useNavigate();
  // Navigation state prefills the form. Opened from a missed call → { phone,
  // missedCallId } (the placeholder is discarded after save). Opened from a customer
  // profile → { customerId, firstName, lastName, phone, email } so the new job links
  // straight to that customer.
  const navState = useLocation().state || {};
  const customerId = navState.customerId || null;
  // The manual form is a Home Services tool (dumpster rental schema). sub_vertical
  // drives the field wording via getTerminology, keeping the door open for other
  // verticals later.
  const vertical = 'home_services';
  const subVertical = 'dumpster_rental';
  const t = getTerminology(vertical, subVertical);

  const [form, setForm] = useState({
    firstName: navState.firstName || '',
    lastName: navState.lastName || '',
    phone: navState.phone || '',
    email: navState.email || '',
    dumpsterSize: '',
    debrisType: '',
    deliveryDate: '',
    rentalDuration: '',
    scheduledTime: '',
    deliveryAddress: '',
    accessNotes: '',
    price: '',
    intent: 'warm',
    notes: '',
  });
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [confirmPaid, setConfirmPaid] = useState(false);
  // Set to { id, name, mode } when the entered phone already belongs to a
  // different-named customer and the server is asking us to confirm before creating
  // anything. `mode` is the booking action chosen, so the re-submit repeats it.
  const [confirmCustomer, setConfirmCustomer] = useState(null);
  // Computed-price prefill: the resolver's suggested amount for the chosen size +
  // duration, and whether the owner has manually edited the price (once they do, we
  // stop auto-syncing so their number is never overwritten).
  const [quote, setQuote] = useState(null);
  const [priceEdited, setPriceEdited] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const pickupISO = useMemo(
    () => calcPickup(form.deliveryDate, form.rentalDuration),
    [form.deliveryDate, form.rentalDuration]
  );

  // Fetch a suggested price from the configured pricing model whenever the size or
  // duration changes, and PREFILL the (still editable) price field until the owner
  // overrides it. Size + a ≥1-day duration are required to price a rental.
  useEffect(() => {
    const size = form.dumpsterSize;
    const days = Number(form.rentalDuration);
    if (!size || !(days >= 1)) { setQuote(null); return; }
    let active = true;
    api.getPriceQuote({ size, days, ...(customerId ? { customerId } : {}) })
      .then((q) => {
        if (!active) return;
        setQuote(q);
        if (!priceEdited && q && q.priceable && q.suggested_total != null) {
          setForm((f) => ({ ...f, price: String(q.suggested_total) }));
        }
      })
      .catch(() => { if (active) setQuote(null); });
    return () => { active = false; };
    // priceEdited intentionally omitted: we don't want re-running to clobber an edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.dumpsterSize, form.rentalDuration, customerId]);

  // Owner typing in the price field takes over (stop auto-syncing the suggestion).
  const onPriceChange = (e) => { setPriceEdited(true); setForm((f) => ({ ...f, price: e.target.value })); };
  const useSuggested = () => {
    if (quote && quote.suggested_total != null) {
      setPriceEdited(false);
      setForm((f) => ({ ...f, price: String(quote.suggested_total) }));
    }
  };

  // Job details are ALL optional — only minimal contact (name + phone) is required.
  // A customer can be saved with every job field blank; it lands as an inquiry whose
  // blank fields show (as dashes) and stay editable on the profile via Edit Job Details.
  const isValid = form.firstName.trim() && form.phone.trim();
  const fullName = [form.firstName, form.lastName].map(s => s.trim()).filter(Boolean).join(' ');

  // Open the same-phone / different-name confirm dialog. The server signals this by
  // REFUSING to create the lead: it comes back as a 409 (caught below), but we accept a
  // 2xx body too, defensively. Either way we open the dialog and never navigate — no
  // lead exists yet. `mode` is carried so "Add to <name>" repeats the same booking action.
  const openConfirm = (existingCustomer, mode) => {
    setConfirmCustomer({ ...(existingCustomer || {}), mode });
    setSubmitting(false);
  };

  // mode: 'inquiry' (save only, nothing sent), 'link' (book → email payment link →
  // pending_payment), 'paid' (Mark Paid: external payment → booked + reserved, no link).
  // confirmDifferentName re-submits past the same-phone/different-name gate, attaching
  // the booking to the existing customer that owns the entered phone.
  const submit = async (mode, confirmDifferentName = false) => {
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.createManualLead({
        ...form,
        vertical,
        subVertical,
        customerId,
        book: mode !== 'inquiry',
        markPaid: mode === 'paid',
        ...(confirmDifferentName ? { confirmDifferentName: true } : {}),
      });
      // Defensive: should the confirmation ever arrive as a 2xx body, catch it here
      // and open the dialog instead of treating it as a created lead.
      if (res && res.needsConfirmation) { openConfirm(res.existingCustomer, mode); return; }
      // Only navigate when a lead was actually created — never to a phantom id.
      if (!res || res.id == null) {
        setError('Could not create the booking. Please try again.');
        setSubmitting(false);
        return;
      }
      // Opened from a missed call → fold the placeholder away now that it's a real
      // lead, so it leaves the Action Queue. Non-blocking.
      if (navState.missedCallId) {
        try { await api.updateLead(navState.missedCallId, { discarded: 1 }); } catch { /* ignore */ }
      }
      // /leads/:id resolves to the owning customer and lands on their profile — the
      // same person for a profile-initiated Create Job — with the "saved" confirmation.
      navigate(`/leads/${res.id}`, { state: { fresh: true } });
    } catch (err) {
      // Same phone, different-named customer → the server (409) created nothing and wants
      // confirmation. Open the dialog instead of surfacing it as an error or redirecting.
      if (err && err.status === 409 && err.data && err.data.needsConfirmation) {
        openConfirm(err.data.existingCustomer, mode);
        return;
      }
      setError(err.message || 'Failed to create lead');
      setSubmitting(false);
    }
  };

  // ── Step 2 — Booking ─────────────────────────────────────────────────────────
  if (step === 2) {
    return (
      <div className="max-w-3xl space-y-5">
        {/* Same-phone / different-name confirm — the server created nothing; the owner
            either adds this booking to the existing customer or cancels to fix the number. */}
        {confirmCustomer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-surface rounded-xl border border-divider shadow-lg w-full max-w-md p-5 space-y-4">
              <div className="flex items-start gap-2.5">
                <AlertTriangle size={18} className="text-warning flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-content">Phone number already in use</h3>
                  <p className="text-sm text-muted mt-1">
                    This phone number already belongs to{' '}
                    <strong className="text-content">{confirmCustomer.name}</strong>. Add this booking
                    to them, or cancel and fix the number?
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => { setConfirmCustomer(null); setConfirmPaid(false); setError(null); setStep(1); }}
                  disabled={submitting}
                  className="text-sm font-medium text-muted hover:text-content border border-divider px-4 py-2 rounded-lg disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { const m = confirmCustomer.mode; setConfirmCustomer(null); submit(m, true); }}
                  disabled={submitting}
                  className="text-sm font-medium text-background bg-accent hover:opacity-90 px-4 py-2 rounded-lg disabled:opacity-60"
                >
                  Add to {confirmCustomer.name}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-muted uppercase tracking-wide">Step 2 of 2 · Booking</p>
            <h2 className="text-lg font-bold text-content mt-0.5">Book {fullName ? `${fullName}'s` : 'this'} job</h2>
            <p className="text-sm text-muted mt-0.5">Choose how to book it. Nothing is sent until you pick an option.</p>
          </div>
          <button
            onClick={() => { setError(null); setConfirmPaid(false); setStep(1); }}
            disabled={submitting}
            className="flex items-center gap-1.5 text-sm font-medium text-muted hover:text-content border border-divider px-3 py-2 rounded-lg disabled:opacity-50"
          >
            <ArrowLeft size={14} /> Edit details
          </button>
        </div>

        {/* Job summary — a read-only recap of what will be created */}
        <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
            <ClipboardList size={15} className="text-muted" />
            <h3 className="text-sm font-semibold text-content">Job Summary</h3>
          </div>
          <div className="px-4 py-2">
            <SummaryRow label="Customer" value={fullName} />
            <SummaryRow label="Phone" value={form.phone} />
            <SummaryRow label={t.sizeLabel} value={form.dumpsterSize} />
            <SummaryRow label={t.startDate} value={formatDay(form.deliveryDate)} />
            <SummaryRow label={t.startTime} value={formatTime12(form.scheduledTime)} />
            <SummaryRow label={t.endDate} value={formatDay(pickupISO)} />
            <SummaryRow label="Price" value={form.price ? `$${form.price}` : null} />
          </div>
        </div>

        {/* Availability — same pool check the Confirm Booking modal uses, plus a
            next-available hint when the window is full. Advisory: never blocks a book. */}
        <div className="bg-surface rounded-xl border border-divider shadow-sm p-4">
          <p className="text-xs font-medium text-muted uppercase tracking-wide mb-2">Availability</p>
          <AvailabilityCheck size={form.dumpsterSize} deliveryDate={form.deliveryDate} rentalDays={form.rentalDuration} />
        </div>

        {error && (
          <p className="text-sm text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{error}</p>
        )}

        {/* Booking options */}
        {!confirmPaid ? (
          <div className="space-y-3">
            <button
              onClick={() => submit('link')}
              disabled={submitting}
              className="w-full flex items-center gap-3 text-left text-background bg-success hover:bg-success/90 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-3 rounded-xl transition-colors"
            >
              <Send size={18} className="flex-shrink-0" />
              <span>
                <span className="block text-sm font-semibold">Send Payment Link</span>
                <span className="block text-xs opacity-90">Emails a secure link · books &amp; reserves when the customer pays</span>
              </span>
            </button>
            <button
              onClick={() => setConfirmPaid(true)}
              disabled={submitting}
              className="w-full flex items-center gap-3 text-left text-content bg-surface hover:bg-surface-2 border border-divider disabled:opacity-60 px-4 py-3 rounded-xl transition-colors"
            >
              <Banknote size={18} className="flex-shrink-0 text-muted" />
              <span>
                <span className="block text-sm font-semibold">Mark Paid</span>
                <span className="block text-xs text-muted">Payment collected outside Stream (cash/card) · books &amp; reserves now, no link</span>
              </span>
            </button>
            <button
              onClick={() => submit('inquiry')}
              disabled={submitting}
              className="w-full text-sm font-medium text-muted hover:text-content border border-divider disabled:opacity-60 px-4 py-2.5 rounded-xl transition-colors"
            >
              Save as inquiry (decide later)
            </button>
          </div>
        ) : (
          <div className="bg-warning/5 border border-warning/30 rounded-xl p-4 space-y-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={18} className="text-warning flex-shrink-0 mt-0.5" />
              <p className="text-sm text-content">
                Payment collected outside Stream? This <strong>books the job, reserves the dumpster, and records it as paid</strong> — no payment link is sent.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => submit('paid')}
                disabled={submitting}
                className="flex items-center gap-1.5 text-sm font-medium text-background bg-success hover:bg-success/90 disabled:opacity-60 px-4 py-2.5 rounded-xl transition-colors"
              >
                <Banknote size={15} /> {submitting ? 'Booking…' : 'Yes, mark paid & book'}
              </button>
              <button
                onClick={() => setConfirmPaid(false)}
                disabled={submitting}
                className="text-sm text-muted hover:text-content px-3 py-2.5 rounded-xl disabled:opacity-50"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Step 1 — Customer + job details ──────────────────────────────────────────
  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <p className="text-xs font-semibold text-muted uppercase tracking-wide">Step 1 of 2 · Details</p>
        <h2 className="text-lg font-bold text-content mt-0.5">Create Job</h2>
        <p className="text-sm text-muted mt-0.5">
          {customerId
            ? 'Confirm this customer and (optionally) enter the job details. You choose how to book on the next step.'
            : 'Add a customer who walked in, texted, emailed, or was booked directly. Only name and phone are required — job details are optional and can be filled in later.'}
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

      {/* Job details — all optional; blank fields still render + stay editable on the profile */}
      <SectionCard title="Job Details (Optional)" icon={Wrench}>
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
        <Field label={t.startTime}>
          <input className={inputCls} type="time" value={form.scheduledTime} onChange={set('scheduledTime')} />
        </Field>
        <Field label={`${t.durationLabel} (days)`}>
          <input className={inputCls} type="number" min="1" value={form.rentalDuration} onChange={set('rentalDuration')} placeholder="e.g. 7" />
        </Field>
        <Field label={t.endDate}>
          <div className="text-sm text-muted px-3 py-2 bg-surface-2 border border-divider rounded-lg min-h-[38px] flex items-center">
            {pickupISO ? formatPickup(pickupISO) : <span className="text-muted italic">Set date + duration to calculate</span>}
          </div>
        </Field>
        <Field label={t.addressLabel} span2>
          <input className={inputCls} value={form.deliveryAddress} onChange={set('deliveryAddress')} placeholder="123 Main St, City" />
        </Field>
        <Field label={t.accessLabel} span2>
          <textarea className={inputCls} rows={2} value={form.accessNotes} onChange={set('accessNotes')} placeholder="Gate code, where to place, etc." />
        </Field>
      </SectionCard>

      {/* Quote / notes */}
      <SectionCard title="Quote / Notes" icon={DollarSign}>
        <Field label="Price">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">$</span>
            <input className={`${inputCls} pl-6`} type="number" min="0" step="1" value={form.price} onChange={onPriceChange} placeholder="0" />
          </div>
          {quote && quote.priceable && quote.suggested_total != null && (
            <p className="text-[11px] text-muted mt-1 leading-snug">
              Suggested <span className="font-semibold text-content">${quote.suggested_total}</span>
              {quote.tier_label ? ` · ${quote.tier_label}` : ''}
              {quote.extra_day_charge > 0 ? ` + ${quote.extra_days} extra day${quote.extra_days === 1 ? '' : 's'}` : ''}
              {quote.discount_source === 'group' && quote.discount_percent ? ` · ${quote.discount_percent}% group discount` : ''}
              {quote.discount_source === 'custom' ? ' · custom rate' : ''}
              {quote.delivery_fee ? ` + $${quote.delivery_fee.amount} delivery` : ''}
              {priceEdited && String(form.price) !== String(quote.suggested_total) ? (
                <> · <button type="button" onClick={useSuggested} className="text-accent hover:underline font-medium">use</button></>
              ) : ''}
            </p>
          )}
          {quote && !quote.priceable && form.dumpsterSize && (
            <p className="text-[11px] text-muted mt-1 leading-snug">No configured rate for this size — enter a price or set one on the Pricing page.</p>
          )}
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
        <p className="text-sm text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{error}</p>
      )}

      {/* Continue to booking */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => { setError(null); setStep(2); }}
          disabled={!isValid}
          className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:opacity-90 disabled:bg-surface-2 disabled:text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
        >
          Next <ArrowRight size={15} />
        </button>
        {!isValid && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <MessageSquare size={13} /> Name and phone required. Job details are optional.
          </span>
        )}
      </div>
    </div>
  );
}
