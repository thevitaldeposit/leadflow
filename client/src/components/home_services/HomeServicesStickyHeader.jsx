import { useState, useEffect } from 'react';
import {
  Sparkles,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import UrgencyBadge from './UrgencyBadge';
import IntentBadge from './IntentBadge';
import VoicemailBadge from './VoicemailBadge';
import { api } from '../../utils/api';
import { parseVerticalData, getLeadActionState, JOB_STATUS_STYLES, getJobStatusLabel, JOB_STATUSES } from '../../utils/verticalConfig';

function parseRentalDays(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (s.includes('week')) return Math.round(num * 7);
  if (s.includes('month')) return Math.round(num * 30);
  return Math.round(num);
}

function calcPickupFromDuration(deliveryISO, rentalDuration) {
  if (!deliveryISO || !rentalDuration) return null;
  const days = parseRentalDays(rentalDuration);
  if (!days) return null;
  const d = new Date(deliveryISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatPickupDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function getLeadName(lead) {
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    return vd.customerName || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown Customer';
  } catch {
    return [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown Customer';
  }
}

// Match a job's free-text size ("10 yard dumpster") to a pool size by leading number.
function sizeMatches(a, b) {
  const na = String(a || '').match(/\d+/);
  const nb = String(b || '').match(/\d+/);
  return na && nb && na[0] === nb[0];
}

function AvailabilityNote({ loading, availability, size }) {
  const label = size || 'this size';
  if (loading) return <p className="text-xs text-gray-400">Checking availability…</p>;
  if (!availability) {
    return <p className="text-xs text-amber-600">No {label} in inventory for the selected dates.</p>;
  }
  if (availability.available > 0) {
    return (
      <p className="text-sm font-semibold text-emerald-700">
        {availability.available} of {availability.quantity} available for this date
      </p>
    );
  }
  return <p className="text-sm font-semibold text-red-600">No {label} available for selected dates</p>;
}

function BookedModal({ lead, onConfirm, onClose }) {
  const vd = parseVerticalData(lead);
  const extractedSize = vd.dumpsterSize || null;
  // Pre-populate from flat column first, then vertical_data fallback (both should match post-extraction)
  const [date, setDate] = useState(lead.delivery_date || vd.deliveryDate || '');
  const [rentalDays, setRentalDays] = useState(() => {
    const n = parseRentalDays(vd.rentalDuration);
    return n ? String(n) : '';
  });
  // Default to the size extracted from the call; the user can switch to any pool
  // size below, which drives the availability check and is saved on confirm.
  const [size, setSize] = useState(extractedSize || '');
  const [poolSizes, setPoolSizes] = useState([]);
  const [availability, setAvailability] = useState(null);
  const [loadingAvail, setLoadingAvail] = useState(false);

  const daysNum = Number(rentalDays);
  const pickupISO = (date && daysNum >= 1) ? calcPickupFromDuration(date, String(daysNum)) : null;
  const isValid = !!date && daysNum >= 1 && !!size;

  // Load the inventory pool sizes (one row per size) for the selector. Normalize
  // the extracted free-text size ("10 yard dumpster") to the matching pool label
  // so it shows as the selected option.
  useEffect(() => {
    let cancelled = false;
    api.getInventory()
      .then(rows => {
        if (cancelled) return;
        const sizes = (rows || []).map(r => r.size).filter(Boolean);
        setPoolSizes(sizes);
        if (extractedSize) {
          const match = sizes.find(s => sizeMatches(s, extractedSize));
          if (match) setSize(match);
        }
      })
      .catch(() => { if (!cancelled) setPoolSizes([]); });
    return () => { cancelled = true; };
  }, []);

  // The dropdown offers every pool size; if the extracted size isn't in the pool,
  // surface it too so the default selection is always visible.
  const sizeOptions = poolSizes.some(s => s === size) || !size ? poolSizes : [size, ...poolSizes];

  // Re-check availability whenever the date window or selected size changes.
  // Pool-based: the server returns per-size counts (owned − in service −
  // overlapping active jobs).
  useEffect(() => {
    if (!date || !pickupISO || !size) { setAvailability(null); return; }
    let cancelled = false;
    setLoadingAvail(true);
    api.getInventory({ delivery_date: date, pickup_date: pickupISO, exclude_lead_id: lead.id })
      .then(rows => {
        if (cancelled) return;
        const match = (rows || []).find(r => sizeMatches(r.size, size)) || null;
        setAvailability(match);
        setLoadingAvail(false);
      })
      .catch(() => { if (!cancelled) { setAvailability(null); setLoadingAvail(false); } });
    return () => { cancelled = true; };
  }, [date, rentalDays, size, lead.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Confirm Booking</h3>
        <p className="text-sm text-gray-500 mb-5">{getLeadName(lead)}{size ? ` · ${size}` : ''}</p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Dumpster Size <span className="text-red-500">*</span>
            </label>
            <select
              value={size}
              onChange={e => setSize(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-white"
            >
              {!size && <option value="">Select a size…</option>}
              {sizeOptions.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Delivery Date <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Rental Duration (days) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min="1"
              value={rentalDays}
              onChange={e => setRentalDays(e.target.value)}
              placeholder="e.g. 7"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {pickupISO ? (
              <p className="text-xs text-gray-500 mt-1">Pickup: {formatPickupDate(pickupISO)}</p>
            ) : (
              <p className="text-xs text-gray-400 mt-1">Enter duration to calculate pickup date</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Availability
            </label>
            {isValid ? (
              <AvailabilityNote loading={loadingAvail} availability={availability} size={size} />
            ) : (
              <p className="text-xs text-gray-400">Enter a delivery date and duration to check availability.</p>
            )}
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => onConfirm({ date, rentalDays: daysNum, size })}
            disabled={!isValid}
            className="flex-1 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
          >
            Confirm Booking
          </button>
          <button onClick={onClose} className="px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 rounded-xl transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function HomeServicesStickyHeader({ lead, onUpdate }) {
  const [showBooked, setShowBooked] = useState(false);
  const vd = parseVerticalData(lead);
  const state = getLeadActionState(lead);

  const displayedName = getLeadName(lead);
  const summary = state.summaryDetail || vd.serviceType || null;
  const jobStatus = lead.job_status || vd.job_status || 'inquiry';
  const jobStatusStyle = JOB_STATUS_STYLES[jobStatus] || 'bg-gray-100 text-gray-500';

  const applyUpdate = async (body) => {
    try {
      const updated = await api.updateLead(lead.id, body);
      onUpdate?.(updated);
    } catch (err) {
      console.error('Sticky action failed:', err);
    }
  };

  const handleBookedConfirm = async ({ date, rentalDays, size }) => {
    const updates = { job_status: 'booked', status: 'booked' };
    const vd = {};
    // Persist the (possibly changed) dumpster size selected in the modal.
    if (size) vd.dumpsterSize = size;
    if (date) {
      updates.delivery_date = date;
      // Write the keys the Industry Details field pack reads from (camelCase)
      // alongside the legacy deliveryDateISO for back-compat with older readers.
      vd.deliveryDate = date;
      vd.deliveryDateISO = date;
      if (rentalDays >= 1) {
        const pickup = calcPickupFromDuration(date, String(rentalDays));
        if (pickup) {
          updates.pickup_date = pickup;
          vd.pickupDate = pickup;
        }
        vd.rentalDuration = `${rentalDays} days`;
      }
    }
    if (Object.keys(vd).length) updates.vertical_data = vd;
    await applyUpdate(updates);
    setShowBooked(false);
  };

  return (
    <>
      {/* The header is rendered as a direct child of <main> (LeadDetailPage
          passes us in a fragment, not inside the max-w-3xl wrapper) so the
          scroll container itself is the sticky's containing block and the
          header stays pinned through every section below. -mt-6 cancels
          main's p-6 top padding so the bar touches the very top of the
          scroll port. max-w-[51rem] (max-w-3xl + 2*p-6 = 48rem + 3rem)
          keeps the bar's outer width identical to the prior design, where
          the inner max-w-3xl column was bracketed by -mx-6 against the
          page-wrapper edge. */}
      <div className="-mt-6 mb-4 max-w-[51rem] mx-auto bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-gray-900">{displayedName}</h2>
              {summary && <p className="text-sm text-gray-600 mt-0.5">{summary}</p>}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {lead.call_type === 'voicemail' && <VoicemailBadge size="md" />}
              <IntentBadge value={state.intent} size="md" />
              <UrgencyBadge value={vd.urgency} size="md" />
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${jobStatusStyle}`}>
                {getJobStatusLabel(jobStatus)}
              </span>
            </div>
          </div>

          {state.recommendation && (
            <div className="mt-3 flex items-start gap-2 text-sm text-gray-700 bg-blue-50 px-3 py-2 rounded-lg">
              <Sparkles size={14} className="text-accent mt-0.5 flex-shrink-0" />
              <span>{state.recommendation}</span>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {!state.isOperational && (
              <button
                onClick={() => setShowBooked(true)}
                className="flex items-center gap-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 px-3 py-2 rounded-lg transition-colors"
              >
                <CheckCircle2 size={14} /> Mark Booked
              </button>
            )}
            {!state.isOperational && (
              <button
                onClick={() => applyUpdate({ job_status: 'lost', status: 'lost' })}
                className="flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 px-3 py-2 rounded-lg transition-colors"
              >
                <XCircle size={14} /> Mark Lost
              </button>
            )}
            {/* Job status quick selector */}
            <select
              value={jobStatus}
              onChange={e => applyUpdate({ job_status: e.target.value })}
              className="ml-auto text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent bg-white text-gray-600"
            >
              {JOB_STATUSES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {showBooked && (
        <BookedModal lead={lead} onConfirm={handleBookedConfirm} onClose={() => setShowBooked(false)} />
      )}
    </>
  );
}
