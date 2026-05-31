import { useState, useEffect } from 'react';
import {
  Sparkles,
  CheckCircle2,
  XCircle,
  Package,
} from 'lucide-react';
import HomeServicesStatusBadge from './HomeServicesStatusBadge';
import UrgencyBadge from './UrgencyBadge';
import IntentBadge from './IntentBadge';
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

function BookedModal({ lead, onConfirm, onClose }) {
  const vd = parseVerticalData(lead);
  // Pre-populate from flat column first, then vertical_data fallback (both should match post-extraction)
  const [date, setDate] = useState(lead.delivery_date || vd.deliveryDate || '');
  const [rentalDays, setRentalDays] = useState(() => {
    const n = parseRentalDays(vd.rentalDuration);
    return n ? String(n) : '';
  });
  const [dumpsters, setDumpsters] = useState([]);
  const [dumpsterId, setDumpsterId] = useState('');
  const [loading, setLoading] = useState(true);

  const daysNum = Number(rentalDays);
  const pickupISO = (date && daysNum >= 1) ? calcPickupFromDuration(date, String(daysNum)) : null;
  const isValid = !!date && daysNum >= 1;

  // Re-fetch whenever delivery date OR rental duration changes.  No status filter —
  // availability is determined solely by date-overlap on the computed window,
  // matching the schedule page checker.  on_job dumpsters whose current job ends
  // before this delivery date correctly appear as available.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = {};
    if (date && pickupISO) {
      // Date-availability mode: server excludes needs_service/out_of_service
      // and any unit with a conflicting confirmed booking.
      params.delivery_date = date;
      params.pickup_date = pickupISO;
      params.rental_duration = daysNum;
      params.exclude_lead_id = lead.id;
    } else {
      // No date or no duration yet — show serviceable inventory so dispatcher can browse.
      params.exclude_unserviceable = '1';
    }
    api.getDumpsters(params)
      .then(d => { if (!cancelled) { setDumpsters(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setDumpsters([]); setLoading(false); } });
    return () => { cancelled = true; };
  }, [date, rentalDays, lead.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Confirm Booking</h3>
        <p className="text-sm text-gray-500 mb-5">{getLeadName(lead)}</p>
        <div className="space-y-4">
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
              Assign Dumpster
              {isValid && <span className="ml-1 font-normal text-gray-400 normal-case">(available for selected window)</span>}
            </label>
            {loading ? (
              <p className="text-xs text-gray-400">Loading inventory...</p>
            ) : dumpsters.length === 0 ? (
              <p className="text-xs text-amber-600">No dumpsters available for this window.</p>
            ) : (
              <select
                value={dumpsterId}
                onChange={e => setDumpsterId(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-white"
              >
                <option value="">— Skip for now —</option>
                {dumpsters.map(d => (
                  <option key={d.id} value={d.id}>{d.asset_number} · {d.size}</option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => onConfirm({ date, dumpsterId: dumpsterId ? Number(dumpsterId) : null, rentalDays: daysNum })}
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

function AssignDumpsterModal({ lead, onConfirm, onClose }) {
  const [dumpsters, setDumpsters] = useState([]);
  const [dumpsterId, setDumpsterId] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const params = {};
    if (lead.delivery_date && lead.pickup_date) {
      // Date-availability mode — same overlap logic as booking modal and schedule page
      params.delivery_date = lead.delivery_date;
      params.pickup_date = lead.pickup_date;
      params.exclude_lead_id = lead.id;
    } else {
      // No confirmed dates — show serviceable units
      params.exclude_unserviceable = '1';
    }
    api.getDumpsters(params)
      .then(d => { if (!cancelled) { setDumpsters(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setDumpsters([]); setLoading(false); } });
    return () => { cancelled = true; };
  }, [lead.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Assign Dumpster</h3>
        {loading ? (
          <p className="text-xs text-gray-400 mb-4">Loading inventory...</p>
        ) : (dumpsters || []).length === 0 ? (
          <p className="text-sm text-red-500 mb-4">No dumpsters currently available.</p>
        ) : (
          <select
            value={dumpsterId}
            onChange={e => setDumpsterId(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-white mb-4"
          >
            <option value="">Select a dumpster</option>
            {(dumpsters || []).map(d => (
              <option key={d.id} value={d.id}>{d.asset_number} · {d.size}</option>
            ))}
          </select>
        )}
        <div className="flex gap-3">
          <button
            disabled={!dumpsterId}
            onClick={() => onConfirm(Number(dumpsterId))}
            className="flex-1 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2.5 rounded-xl transition-colors"
          >
            Assign
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
  const [showAssign, setShowAssign] = useState(false);
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

  const handleBookedConfirm = async ({ date, dumpsterId, rentalDays }) => {
    const updates = { job_status: 'booked', status: 'booked' };
    if (date) {
      updates.delivery_date = date;
      // Write the keys the Industry Details field pack reads from (camelCase)
      // alongside the legacy deliveryDateISO for back-compat with older readers.
      const vd = {
        deliveryDate: date,
        deliveryDateISO: date,
      };
      if (rentalDays >= 1) {
        const pickup = calcPickupFromDuration(date, String(rentalDays));
        if (pickup) {
          updates.pickup_date = pickup;
          vd.pickupDate = pickup;
        }
        vd.rentalDuration = `${rentalDays} days`;
      }
      updates.vertical_data = vd;
    }
    if (dumpsterId) {
      await api.updateDumpster(dumpsterId, { status: 'on_job', current_job_id: lead.id });
      updates.assigned_dumpster_id = dumpsterId;
    }
    await applyUpdate(updates);
    setShowBooked(false);
  };

  const handleAssignConfirm = async (dumpsterId) => {
    await api.updateDumpster(dumpsterId, { status: 'on_job', current_job_id: lead.id });
    await applyUpdate({ assigned_dumpster_id: dumpsterId });
    setShowAssign(false);
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
      <div className="sticky top-0 z-20 -mt-6 mb-4 max-w-[51rem] mx-auto bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-gray-900">{displayedName}</h2>
              {summary && <p className="text-sm text-gray-600 mt-0.5">{summary}</p>}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
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
            <button
              onClick={() => setShowAssign(true)}
              className="flex items-center gap-1.5 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 px-3 py-2 rounded-lg transition-colors"
            >
              <Package size={14} /> Assign Dumpster
            </button>
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
      {showAssign && (
        <AssignDumpsterModal lead={lead} onConfirm={handleAssignConfirm} onClose={() => setShowAssign(false)} />
      )}
    </>
  );
}
