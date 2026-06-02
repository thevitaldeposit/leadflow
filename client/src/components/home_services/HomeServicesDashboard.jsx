import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  AlertTriangle, TrendingUp, CalendarCheck2, Truck, CheckCircle2,
  DollarSign, Phone, MessageSquare, Package, CalendarSearch,
} from 'lucide-react';
import { api } from '../../utils/api';
import socket from '../../socket';
import { getLeadActionState, parseVerticalData, OPERATIONAL_JOB_STATUSES, JOB_STATUS_STYLES } from '../../utils/verticalConfig';
import { playChime } from '../../utils/chime';
import IntentBadge from './IntentBadge';
import VoicemailBadge from './VoicemailBadge';
import { getSettings } from '../../utils/settings';
import { useNavigate } from 'react-router-dom';

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatCurrency(amount) {
  if (amount == null || Number.isNaN(amount)) return '$0';
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}k`;
  return `$${Math.round(amount).toLocaleString()}`;
}

function getLeadName(lead) {
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    return vd.customerName || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown';
  } catch {
    return [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown';
  }
}

function getLeadService(lead) {
  try {
    const vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {};
    if (lead.sub_vertical === 'dumpster_rental') {
      return [vd.dumpsterSize, vd.debrisType].filter(Boolean).join(' · ') || 'Dumpster Rental';
    }
    return vd.serviceType || vd.equipmentType || 'Home Services';
  } catch {
    return 'Home Services';
  }
}

function getFollowUpLabel(followUpDate) {
  if (!followUpDate) return null;
  const now = new Date();
  const diff = followUpDate - now;
  if (diff < 0) return 'Overdue';
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 1) return 'Due now';
  if (hrs < 24) return `Due in ${hrs}h`;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Due today';
  return `Due in ${days}d`;
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// Parse a YYYY-MM-DD string as a local-calendar date.  Avoids the UTC-midnight
// shift that `new Date("YYYY-MM-DD")` produces in negative-offset timezones —
// e.g. "2026-06-01" landing on May 31 23:00 local in EST/CDT.
function parseLocalDate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── sub-components ───────────────────────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, color = 'bg-gray-50', textColor = 'text-gray-700' }) {
  return (
    <div className={`${color} rounded-xl border border-gray-100 px-5 py-4 flex items-center gap-3`}>
      <Icon size={20} className={`${textColor} opacity-70 flex-shrink-0`} />
      <div>
        <p className={`text-2xl font-bold ${textColor} leading-tight`}>{value}</p>
        <p className="text-xs text-gray-500 leading-tight mt-0.5">{label}</p>
      </div>
    </div>
  );
}

// Outbound click-to-call button. POSTs to the server, which rings Austin's
// phone first and then bridges him to the customer. Disabled for 5s after a
// successful trigger to guard against accidental double-calls.
function CallButton({ lead, name }) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null); // { type: 'info' | 'error', text }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const handleCall = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await api.callLead(lead.id);
      setToast({ type: 'info', text: `Calling ${name}… your phone will ring shortly` });
      setTimeout(() => setBusy(false), 5000);
    } catch (err) {
      setToast({ type: 'error', text: 'Call failed, please try again' });
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={handleCall}
        disabled={busy}
        className={`p-1.5 rounded-lg transition-colors ${
          busy
            ? 'text-gray-300 cursor-not-allowed'
            : 'text-gray-400 hover:text-emerald-600 hover:bg-emerald-50'
        }`}
        title={busy ? 'Calling…' : 'Call'}
      >
        <Phone size={14} />
      </button>
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-xs px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-slide-in ${
            toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'
          }`}
        >
          {toast.text}
        </div>
      )}
    </>
  );
}

function AttentionRow({ lead, state, onBooked, onLost }) {
  const navigate = useNavigate();
  const vd = parseVerticalData(lead);
  const name = getLeadName(lead);
  const service = getLeadService(lead);
  const followUpLabel = getFollowUpLabel(state.followUpDate);

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer rounded-lg transition-colors"
      onClick={() => navigate(`/leads/${lead.id}`)}
    >
      <IntentBadge value={state.intent} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900 truncate">{name}</span>
          {lead.phone && <span className="text-xs text-gray-400 flex-shrink-0">{lead.phone}</span>}
          {lead.call_type === 'voicemail' && <VoicemailBadge />}
        </div>
        <p className="text-xs text-gray-500 truncate">{service}</p>
        {state.recommendation && (
          <p className="text-xs text-accent font-medium truncate mt-0.5">{state.recommendation}</p>
        )}
      </div>
      {followUpLabel && (
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${
          followUpLabel === 'Overdue' || followUpLabel === 'Due now'
            ? 'bg-red-100 text-red-700'
            : 'bg-amber-100 text-amber-700'
        }`}>
          {followUpLabel}
        </span>
      )}
      <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
        {lead.phone && <CallButton lead={lead} name={name} />}
        {/* SMS disabled until A2P registration completes. Kept visible but
            muted/non-functional so the affordance returns easily later. */}
        <span
          className="p-1.5 rounded-lg text-gray-200 cursor-not-allowed"
          title="SMS coming soon"
          aria-disabled="true"
        >
          <MessageSquare size={14} />
        </span>
      </div>
    </div>
  );
}

// Pull just the city out of a delivery address or city field. Addresses look
// like "123 Main St, Springfield, IL 62704" — the city is the segment before
// the state/zip. Falls back to a dedicated city field when present.
function getDeliveryCity(vd) {
  if (vd.city) return String(vd.city).trim();
  const addr = vd.deliveryAddress;
  if (!addr) return null;
  const parts = String(addr).split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  // 3+ parts: street, city, state zip → city is second-to-last.
  // 2 parts: city, state zip → city is first.
  const city = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
  return city || null;
}

// Format a YYYY-MM-DD date string without UTC shifting. `new Date('2026-06-01')`
// parses as UTC midnight, which renders as the prior day in negative-offset
// zones — so build the date from local Y/M/D parts instead.
function formatDeliveryDate(value) {
  if (!value) return null;
  const [datePart] = String(value).split('T');
  const [year, month, day] = datePart.split('-');
  if (!year || !month || !day) return null;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function BookedJobRow({ lead }) {
  const navigate = useNavigate();
  const vd = parseVerticalData(lead);
  const name = getLeadName(lead);
  const jobStatus = lead.job_status || 'booked';
  const statusStyle = JOB_STATUS_STYLES[jobStatus] || 'bg-gray-100 text-gray-500';
  const size = vd.dumpsterSize || null;
  const price = vd.quotedPrice || (lead.estimated_revenue ? formatCurrency(lead.estimated_revenue) : null);
  const city = getDeliveryCity(vd);
  const deliveryDate = formatDeliveryDate(vd.deliveryDate);

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 rounded-lg cursor-pointer transition-colors"
      onClick={() => navigate(`/leads/${lead.id}`)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-gray-900 truncate">{name}</span>
          {(size || price) && (
            <span className="text-xs text-gray-500 flex-shrink-0">
              · {[size, price].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 truncate">
          {[city, deliveryDate].filter(Boolean).join(' · ') || 'Details TBD'}
        </p>
      </div>
      <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${statusStyle}`}>
        {jobStatus.replace('_', ' ')}
      </span>
    </div>
  );
}

function ScheduleGroup({ date, leads }) {
  const isToday = new Set(['TODAY', 'TOMORROW']).has(date);
  const navigate = useNavigate();

  return (
    <div className="mb-3">
      <p className={`text-xs font-bold uppercase tracking-wide mb-1 ${isToday ? 'text-accent' : 'text-gray-500'}`}>
        {date}
      </p>
      {leads.map(({ lead, type, time }) => {
        const name = getLeadName(lead);
        return (
          <div
            key={`${lead.id}-${type}`}
            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer transition-colors"
            onClick={() => navigate(`/leads/${lead.id}`)}
          >
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
              type === 'delivery' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {type === 'delivery' ? 'DROP' : 'PICK'}
            </span>
            <span className="text-sm text-gray-800 flex-1 truncate">{name}</span>
            {time && <span className="text-xs text-gray-400">{time}</span>}
          </div>
        );
      })}
    </div>
  );
}

// Mark Booked modal
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
  const size = vd.dumpsterSize || null;
  // Pre-populate from flat column first, then vertical_data fallback (both should match post-extraction)
  const [date, setDate] = useState(lead.delivery_date || vd.deliveryDate || '');
  const [rentalDays, setRentalDays] = useState(() => {
    const n = parseRentalDays(vd.rentalDuration);
    return n ? String(n) : '';
  });
  const [availability, setAvailability] = useState(null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const name = getLeadName(lead);

  const daysNum = Number(rentalDays);
  const pickupISO = (date && daysNum >= 1) ? calcPickupFromDuration(date, String(daysNum)) : null;
  const isValid = !!date && daysNum >= 1;

  // Re-check availability whenever the date window changes. Pool-based: the
  // server returns per-size counts (owned − in service − overlapping active jobs).
  useEffect(() => {
    if (!date || !pickupISO) { setAvailability(null); return; }
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
  }, [date, rentalDays, lead.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Confirm Booking</h3>
        <p className="text-sm text-gray-500 mb-5">{name}{size ? ` · ${size}` : ''}</p>
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
            onClick={() => onConfirm({ date, rentalDays: daysNum })}
            disabled={!isValid}
            className="flex-1 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
          >
            Confirm Booking
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 rounded-xl transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// Quick Availability Check — lightweight, button-triggered availability lookup
// for use during live calls. Reuses the shared /schedule/availability endpoint
// (same data the SchedulePage checker and booking modal rely on); no new API.
function QuickAvailabilityCheck() {
  const [sizes, setSizes] = useState([]);
  const [size, setSize] = useState('');
  const [date, setDate] = useState('');
  const [duration, setDuration] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { status, available, owned }

  // Populate the size dropdown from the inventory pools (one row per size).
  useEffect(() => {
    let cancelled = false;
    api.getInventory()
      .then(rows => {
        if (!cancelled) setSizes((rows || []).map(r => r.size).filter(Boolean));
      })
      .catch(() => { if (!cancelled) setSizes([]); });
    return () => { cancelled = true; };
  }, []);

  const handleCheck = async () => {
    if (!size || !date || !duration || Number(duration) < 1) {
      setResult({ status: 'incomplete' });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const data = await api.getAvailability(date, duration);
      // Prefer an exact size match (dropdown values come from the same pools the
      // endpoint reports); fall back to matching by leading number just in case.
      const match = (data.bySizes || []).find(s => s.size === size)
        || (data.bySizes || []).find(s => sizeMatches(s.size, size))
        || null;
      if (match && match.availableCount > 0) {
        setResult({ status: 'available', available: match.availableCount, owned: match.ownedCount });
      } else {
        setResult({ status: 'none' });
      }
    } catch {
      setResult({ status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <CalendarSearch size={15} className="text-accent" />
          <h2 className="text-sm font-bold text-gray-900">Quick Availability Check</h2>
        </div>
        <p className="text-xs text-gray-500 mt-0.5">Check dumpster availability in seconds</p>
      </div>

      <div className="px-4 py-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Dumpster Size
            </label>
            <select
              value={size}
              onChange={e => setSize(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">Select size…</option>
              {sizes.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Delivery Date
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
              Rental Duration (days)
            </label>
            <input
              type="number"
              min="1"
              max="365"
              placeholder="e.g. 7"
              value={duration}
              onChange={e => setDuration(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>

        <button
          onClick={handleCheck}
          disabled={loading}
          className="w-full mt-3 text-sm font-medium text-white bg-accent hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg transition-opacity"
        >
          {loading ? 'Checking…' : 'Check Availability'}
        </button>

        {result && (
          <div className="mt-3">
            {result.status === 'incomplete' && (
              <p className="text-sm text-gray-500">Please fill in all fields</p>
            )}
            {result.status === 'available' && (
              <p className="text-sm font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
                {result.available} of {result.owned} available for {size} on {formatDeliveryDate(date)}
              </p>
            )}
            {result.status === 'none' && (
              <p className="text-sm font-semibold text-red-600 bg-red-50 rounded-lg px-3 py-2">
                No {size} available for selected dates
              </p>
            )}
            {result.status === 'error' && (
              <p className="text-sm text-amber-600">Could not check availability — please try again.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── main dashboard ────────────────────────────────────────────────────────────

export default function HomeServicesDashboard() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bookingLead, setBookingLead] = useState(null);
  const [bookedRange, setBookedRange] = useState('7d');
  const settings = getSettings();
  const greeting = getGreeting();

  const load = useCallback(() => {
    return api.getLeads({ vertical: 'home_services', sort: 'created_at', order: 'desc' })
      .then(setLeads);
  }, []);

  useEffect(() => {
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    const handleNewLead = (lead) => {
      if (lead.vertical !== 'home_services') return;
      setLeads(prev => prev.some(l => l.id === lead.id) ? prev : [lead, ...prev]);
      playChime();
    };
    const handleLeadUpdated = (lead) => {
      if (lead.vertical !== 'home_services') return;
      setLeads(prev => prev.map(l => l.id === lead.id ? lead : l));
    };
    const handleReconnect = () => { loadRef.current().catch(console.error); };
    socket.on('new_lead', handleNewLead);
    socket.on('lead_updated', handleLeadUpdated);
    socket.io.on('reconnect', handleReconnect);
    return () => {
      socket.off('new_lead', handleNewLead);
      socket.off('lead_updated', handleLeadUpdated);
      socket.io.off('reconnect', handleReconnect);
    };
  }, []);

  const handleLost = useCallback(async (id) => {
    try {
      const updated = await api.updateLead(id, { job_status: 'lost', status: 'lost' });
      setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
    } catch (e) { console.error(e); }
  }, []);

  const handleBookedConfirm = useCallback(async ({ date, rentalDays }) => {
    if (!bookingLead) return;
    try {
      const updates = {
        job_status: 'booked',
        status: 'booked',
      };
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
      const updated = await api.updateLead(bookingLead.id, updates);
      setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
      setBookingLead(null);
    } catch (e) { console.error(e); }
  }, [bookingLead]);

  const { needsAttention, bookedJobs, schedule, metrics, insights } = useMemo(() => {
    const now = new Date();
    const enriched = leads.map(l => ({ lead: l, state: getLeadActionState(l, now), vd: parseVerticalData(l) }));

    // Needs Attention — a lead belongs here if ANY of these are true:
    // 1. urgency is ASAP and still pre-booked (must surface immediately)
    // 2. follow_up_date is in the past or today
    // 3. high intent and created more than 2 hours ago with no follow-up taken
    // 4. stale (48h+ with no contact)
    // 5. captured from voicemail and not yet acted on (customer awaiting callback)
    const endOfToday = new Date(now); endOfToday.setHours(23,59,59,999);
    const needsAttention = enriched
      .filter(e => {
        if (!e.state.isOpportunity || !e.state.isActive) return false;
        return (
          e.state.isAsapActive ||
          (e.state.followUpDate && e.state.followUpDate <= endOfToday) ||
          e.state.voicemailCallback ||
          e.state.highIntentUncontacted ||
          e.state.noConfirmedDelivery ||
          e.state.stale
        );
      })
      .sort((a, b) => b.state.priority - a.state.priority);

    // Booked Jobs = operational (booked → completed)
    const bookedJobs = enriched
      .filter(e => e.state.isOperational)
      .sort((a, b) => {
        const da = a.lead.delivery_date || a.vd.deliveryDateISO || '';
        const db2 = b.lead.delivery_date || b.vd.deliveryDateISO || '';
        return da < db2 ? -1 : da > db2 ? 1 : 0;
      });

    // Schedule: upcoming deliveries and pickups grouped by date.
    // Only confirmed jobs (booked → picked_up) appear — not inquiries or opportunities.
    const SCHEDULE_STATUSES = new Set(['booked', 'scheduled', 'delivered', 'active_rental', 'picked_up']);
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const in7days = new Date(today); in7days.setDate(in7days.getDate() + 7);

    const scheduleEntries = [];
    for (const { lead, vd } of enriched) {
      if (!SCHEDULE_STATUSES.has(lead.job_status)) continue;
      const deliveryStr = lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate;
      const pickupStr = lead.pickup_date || vd.pickupDate;
      // parseLocalDate keeps the calendar date intact across the UTC→local
      // boundary; using new Date("YYYY-MM-DD") here would mis-bucket dates by
      // one day for users west of UTC.
      if (deliveryStr) {
        const d = parseLocalDate(deliveryStr);
        if (d && d >= today && d <= in7days) scheduleEntries.push({ lead, date: d, type: 'delivery', time: vd.deliveryTime || null });
      }
      if (pickupStr) {
        const d = parseLocalDate(pickupStr);
        if (d && d >= today && d <= in7days) scheduleEntries.push({ lead, date: d, type: 'pickup', time: null });
      }
    }
    scheduleEntries.sort((a, b) => a.date - b.date);

    const scheduleGroups = [];
    const seenDates = new Map();
    for (const entry of scheduleEntries) {
      const d = entry.date;
      let label;
      const dNorm = new Date(d); dNorm.setHours(0,0,0,0);
      if (dNorm.getTime() === today.getTime()) label = 'TODAY';
      else if (dNorm.getTime() === tomorrow.getTime()) label = 'TOMORROW';
      else label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      if (!seenDates.has(label)) {
        seenDates.set(label, []);
        scheduleGroups.push({ date: label, leads: seenDates.get(label) });
      }
      seenDates.get(label).push(entry);
    }

    // Metrics
    const now2 = new Date();
    const monthStart = new Date(now2.getFullYear(), now2.getMonth(), 1);
    const weekStart = new Date(now2); weekStart.setDate(weekStart.getDate() - 7);

    const needsAttentionCount = needsAttention.length;
    const hotOpps = enriched.filter(e => e.state.isOpportunity && e.state.intent === 'high').length;
    const bookedThisWeek = leads.filter(l => (l.job_status === 'booked' || l.status === 'booked') && new Date(l.updated_at) >= weekStart).length;
    const onSchedule = scheduleEntries.filter(e => e.type === 'delivery').length;
    const completedMonth = leads.filter(l => l.job_status === 'completed' && new Date(l.updated_at) >= monthStart).length;

    // 30 Day Snapshot — rolling 30-day window (today minus 30 days), not the
    // current calendar month. `today` is normalized to local midnight above.
    const thirtyDaysAgo = new Date(today); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    // parseLocalDate avoids the UTC shift that new Date("YYYY-MM-DD") would cause.
    const deliveryDateOf = (lead, vd) => parseLocalDate(lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate);
    const inSnapshot = (d) => d && d >= thirtyDaysAgo && d <= today;

    const monthLeads = leads.filter(l => new Date(l.created_at) >= thirtyDaysAgo).length;
    const monthBooked = enriched.filter(({ lead, vd }) => inSnapshot(deliveryDateOf(lead, vd))).length;
    const bookingRate = monthLeads > 0 ? Math.round((monthBooked / monthLeads) * 100) : 0;
    const revenue = enriched
      .filter(({ lead, vd }) => inSnapshot(deliveryDateOf(lead, vd)))
      .reduce((sum, { lead }) => sum + (lead.estimated_revenue || 0), 0);

    // AI insights
    const insights = [];
    const highNotContacted = enriched.filter(e => e.state.intent === 'high' && e.state.isOpportunity && (e.state.jobStatus === 'inquiry' || !e.state.jobStatus));
    if (highNotContacted.length > 0) {
      const potentialRev = highNotContacted.reduce((s, e) => s + (e.state.estimatedRevenue || 450), 0);
      insights.push(`${highNotContacted.length} high-intent lead${highNotContacted.length === 1 ? '' : 's'} waiting for first contact. Potential revenue at risk: ${formatCurrency(potentialRev)}.`);
    }
    if (bookingRate > 0) {
      insights.push(`Your booking rate over the last 30 days is ${bookingRate}%. Leads contacted within 1 hour are 3× more likely to book.`);
    }
    const staleCount = enriched.filter(e => e.state.stale).length;
    if (staleCount > 0) {
      insights.push(`${staleCount} lead${staleCount === 1 ? '' : 's'} going cold (48h+ with no contact). Reach out now to recover them.`);
    }

    return {
      needsAttention,
      bookedJobs,
      schedule: scheduleGroups,
      metrics: { needsAttentionCount, hotOpps, bookedThisWeek, onSchedule, completedMonth, monthLeads, monthBooked, bookingRate, revenue },
      insights,
    };
  }, [leads]);

  // Booked Jobs panel filter — client-side window over the already-computed list.
  // Windows are backward-looking on booking date (updated_at):
  // 1D = booked today, 7D = booked in last 7 days, 30D = booked in last 30 days.
  const filteredBookedJobs = useMemo(() => {
    const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);
    const daysBack = bookedRange === '1d' ? 0 : bookedRange === '30d' ? 30 : 7;
    cutoff.setDate(cutoff.getDate() - daysBack);
    return bookedJobs.filter(({ lead }) => {
      if (!lead.updated_at) return false;
      return new Date(lead.updated_at) >= cutoff;
    });
  }, [bookedJobs, bookedRange]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{greeting}, {settings.ownerFirstName}! 👋</h1>
          <p className="text-sm text-gray-500 mt-1">Here's what needs your attention today.</p>
        </div>
        <p className="text-sm text-gray-400 mt-1 flex-shrink-0">{today}</p>
      </div>

      {/* Top metric cards */}
      <div className="grid grid-cols-5 gap-3">
        <MetricCard icon={AlertTriangle} label="Needs Attention" value={metrics.needsAttentionCount}
          color="bg-red-50" textColor="text-red-700" />
        <MetricCard icon={TrendingUp} label="Hot Opportunities" value={metrics.hotOpps}
          color="bg-amber-50" textColor="text-amber-700" />
        <MetricCard icon={CalendarCheck2} label="Booked This Week" value={metrics.bookedThisWeek}
          color="bg-emerald-50" textColor="text-emerald-700" />
        <MetricCard icon={Truck} label="On Schedule (7d)" value={metrics.onSchedule}
          color="bg-blue-50" textColor="text-blue-700" />
        <MetricCard icon={CheckCircle2} label="Completed This Month" value={metrics.completedMonth}
          color="bg-gray-50" textColor="text-gray-600" />
      </div>

      {/* Main two-column layout */}
      <div className="grid grid-cols-[1fr_360px] gap-5">
        {/* LEFT COLUMN */}
        <div className="space-y-5 min-w-0">
          {/* Needs Attention Today */}
          <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle size={15} className="text-red-500" />
                <h2 className="text-sm font-bold text-gray-900">Needs Attention Today</h2>
              </div>
              {needsAttention.length > 0 && (
                <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium">
                  {needsAttention.length} action{needsAttention.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            {needsAttention.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                Inbox clear — great work! 🎉
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {needsAttention.map(({ lead, state }) => (
                  <AttentionRow
                    key={lead.id}
                    lead={lead}
                    state={state}
                    onBooked={() => setBookingLead(lead)}
                    onLost={handleLost}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Quick Availability Check */}
          <QuickAvailabilityCheck />
        </div>

        {/* RIGHT COLUMN */}
        <div className="space-y-5">
          {/* Booked Jobs */}
          <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CalendarCheck2 size={15} className="text-emerald-600" />
                <h2 className="text-sm font-bold text-gray-900">Booked Jobs</h2>
              </div>
              <div className="flex items-center gap-1">
                {['1d', '7d', '30d'].map(r => (
                  <button
                    key={r}
                    onClick={() => setBookedRange(r)}
                    className={`text-[10px] font-semibold tracking-wide px-2 py-1 rounded transition-colors ${
                      bookedRange === r
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {r.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            {filteredBookedJobs.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-gray-400">
                {bookedJobs.length === 0 ? 'No booked jobs yet.' : 'No booked jobs in this period.'}
              </p>
            ) : (
              <div className="divide-y divide-gray-50 px-2 py-1">
                {filteredBookedJobs.slice(0, 8).map(({ lead }) => (
                  <BookedJobRow key={lead.id} lead={lead} />
                ))}
              </div>
            )}
          </section>

          {/* Upcoming Schedule */}
          <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
              <Truck size={15} className="text-blue-600" />
              <h2 className="text-sm font-bold text-gray-900">Upcoming Schedule</h2>
            </div>
            {schedule.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-gray-400">No deliveries or pickups in the next 7 days.</p>
            ) : (
              <div className="px-4 py-3">
                {schedule.map(group => (
                  <ScheduleGroup key={group.date} date={group.date} leads={group.leads} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* AI Insights */}
      {insights.length > 0 && (
        <section className="bg-blue-50 rounded-xl border border-blue-100 px-5 py-4">
          <p className="text-xs font-bold text-blue-600 uppercase tracking-wide mb-2">AI Insights</p>
          <div className="space-y-1.5">
            {insights.map((insight, i) => (
              <p key={i} className="text-sm text-blue-800">{insight}</p>
            ))}
          </div>
        </section>
      )}

      {/* 30 Day Snapshot */}
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-bold text-gray-700 mb-4">30 Day Snapshot</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className="text-center">
            <p className="text-2xl font-bold text-gray-900">{metrics.monthLeads}</p>
            <p className="text-xs text-gray-500 mt-0.5">Leads Captured</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-emerald-600">{metrics.monthBooked}</p>
            <p className="text-xs text-gray-500 mt-0.5">Booked Jobs</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-600">{metrics.bookingRate}%</p>
            <p className="text-xs text-gray-500 mt-0.5">Booking Rate</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-violet-600">{formatCurrency(metrics.revenue)}</p>
            <p className="text-xs text-gray-500 mt-0.5">Revenue</p>
          </div>
        </div>
      </section>

      {/* Booked modal */}
      {bookingLead && (
        <BookedModal
          lead={bookingLead}
          onConfirm={handleBookedConfirm}
          onClose={() => setBookingLead(null)}
        />
      )}
    </div>
  );
}
