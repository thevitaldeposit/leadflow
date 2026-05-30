import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  AlertTriangle, TrendingUp, CalendarCheck2, Truck, CheckCircle2,
  DollarSign, Phone, MessageSquare, Package,
} from 'lucide-react';
import { api } from '../../utils/api';
import socket from '../../socket';
import { getLeadActionState, parseVerticalData, OPERATIONAL_JOB_STATUSES, JOB_STATUS_STYLES } from '../../utils/verticalConfig';
import { playChime } from '../../utils/chime';
import IntentBadge from './IntentBadge';
import UrgencyBadge from './UrgencyBadge';
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
        {lead.phone && (
          <a
            href={`tel:${lead.phone}`}
            className="p-1.5 rounded-lg text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
            title="Call"
          >
            <Phone size={14} />
          </a>
        )}
        {lead.phone && (
          <a
            href={`sms:${lead.phone}`}
            className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
            title="Text"
          >
            <MessageSquare size={14} />
          </a>
        )}
      </div>
    </div>
  );
}

function OpportunityCard({ lead, state, onBooked, onLost }) {
  const navigate = useNavigate();
  const vd = parseVerticalData(lead);
  const name = getLeadName(lead);
  const service = getLeadService(lead);
  const ageMs = Date.now() - new Date(lead.created_at).getTime();
  const ageLabel = ageMs < 3600000 ? `${Math.floor(ageMs / 60000)}m ago`
    : ageMs < 86400000 ? `${Math.floor(ageMs / 3600000)}h ago`
    : `${Math.floor(ageMs / 86400000)}d ago`;

  return (
    <div
      className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => navigate(`/leads/${lead.id}`)}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <IntentBadge value={state.intent} size="sm" />
          <UrgencyBadge value={vd.urgency} size="sm" />
        </div>
        <span className="text-xs text-gray-400 flex-shrink-0">{ageLabel}</span>
      </div>
      <p className="text-sm font-semibold text-gray-900">{name}</p>
      <p className="text-xs text-gray-500 mt-0.5 mb-2">{service}</p>
      {state.recommendation && (
        <p className="text-xs text-accent bg-blue-50 rounded px-2 py-1 mb-3">{state.recommendation}</p>
      )}
      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => onBooked(lead)}
          className="flex-1 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 rounded-lg transition-colors"
        >
          Mark Booked
        </button>
        <button
          onClick={() => onLost(lead.id)}
          className="flex-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg transition-colors"
        >
          Mark Lost
        </button>
      </div>
    </div>
  );
}

function BookedJobRow({ lead }) {
  const navigate = useNavigate();
  const vd = parseVerticalData(lead);
  const name = getLeadName(lead);
  const jobStatus = lead.job_status || 'booked';
  const statusStyle = JOB_STATUS_STYLES[jobStatus] || 'bg-gray-100 text-gray-500';
  const price = vd.quotedPrice || (lead.estimated_revenue ? formatCurrency(lead.estimated_revenue) : null);
  const date = lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate || null;

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 rounded-lg cursor-pointer transition-colors"
      onClick={() => navigate(`/leads/${lead.id}`)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 truncate">{name}</span>
          {price && <span className="text-xs text-gray-500 flex-shrink-0">{price}</span>}
        </div>
        <p className="text-xs text-gray-400">{date || 'Date TBD'}</p>
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
function BookedModal({ lead, dumpsters, onConfirm, onClose }) {
  const [date, setDate] = useState('');
  const [dumpsterId, setDumpsterId] = useState('');
  const available = dumpsters.filter(d => d.status === 'available');
  const name = getLeadName(lead);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Confirm Booking</h3>
        <p className="text-sm text-gray-500 mb-5">{name}</p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Delivery Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Assign Dumpster {available.length === 0 && <span className="text-red-500">(none available)</span>}
            </label>
            <select
              value={dumpsterId}
              onChange={e => setDumpsterId(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-white"
            >
              <option value="">— Skip for now —</option>
              {available.map(d => (
                <option key={d.id} value={d.id}>{d.asset_number} · {d.size}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => onConfirm({ date, dumpsterId: dumpsterId ? Number(dumpsterId) : null })}
            className="flex-1 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 px-4 py-2.5 rounded-xl transition-colors"
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

// ─── main dashboard ────────────────────────────────────────────────────────────

export default function HomeServicesDashboard() {
  const [leads, setLeads] = useState([]);
  const [dumpsters, setDumpsters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bookingLead, setBookingLead] = useState(null);
  const settings = getSettings();
  const greeting = getGreeting();

  const load = useCallback(() => {
    return Promise.all([
      api.getLeads({ vertical: 'home_services', sort: 'created_at', order: 'desc' }),
      api.getDumpsters(),
    ]).then(([l, d]) => {
      setLeads(l);
      setDumpsters(d);
    });
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
    const handleReconnect = () => { loadRef.current().catch(console.error); };
    socket.on('new_lead', handleNewLead);
    socket.io.on('reconnect', handleReconnect);
    return () => {
      socket.off('new_lead', handleNewLead);
      socket.io.off('reconnect', handleReconnect);
    };
  }, []);

  const handleLost = useCallback(async (id) => {
    try {
      const updated = await api.updateLead(id, { job_status: 'lost', status: 'lost' });
      setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
    } catch (e) { console.error(e); }
  }, []);

  const handleBookedConfirm = useCallback(async ({ date, dumpsterId }) => {
    if (!bookingLead) return;
    try {
      const updates = {
        job_status: 'booked',
        status: 'booked',
      };
      if (date) {
        updates.delivery_date = date;
        updates.vertical_data = { deliveryDateISO: date };
      }
      if (dumpsterId) {
        updates.assigned_dumpster_id = dumpsterId;
        await api.updateDumpster(dumpsterId, { status: 'on_job', current_job_id: bookingLead.id });
        setDumpsters(prev => prev.map(d => d.id === dumpsterId ? { ...d, status: 'on_job', current_job_id: bookingLead.id } : d));
      }
      const updated = await api.updateLead(bookingLead.id, updates);
      setLeads(prev => prev.map(l => l.id === updated.id ? updated : l));
      setBookingLead(null);
    } catch (e) { console.error(e); }
  }, [bookingLead]);

  const { needsAttention, allOpportunities, bookedJobs, schedule, metrics, insights } = useMemo(() => {
    const now = new Date();
    const enriched = leads.map(l => ({ lead: l, state: getLeadActionState(l, now), vd: parseVerticalData(l) }));

    // Needs Attention = active opportunities with follow-up due within 1 day
    const endOfTomorrow = new Date(now); endOfTomorrow.setDate(endOfTomorrow.getDate() + 1); endOfTomorrow.setHours(23,59,59,999);
    const needsAttention = enriched
      .filter(e => e.state.isOpportunity && e.state.isActive && (
        (e.state.followUpDate && e.state.followUpDate <= endOfTomorrow) ||
        e.state.stale ||
        (e.state.intent === 'high' && !e.state.jobStatus)
      ))
      .sort((a, b) => b.state.priority - a.state.priority);

    // All Opportunities = pre-booked, not requiring immediate action
    const attentionIds = new Set(needsAttention.map(e => e.lead.id));
    const allOpportunities = enriched
      .filter(e => e.state.isOpportunity && e.state.isActive && !attentionIds.has(e.lead.id))
      .sort((a, b) => b.state.priority - a.state.priority);

    // Booked Jobs = operational (booked → completed)
    const bookedJobs = enriched
      .filter(e => e.state.isOperational)
      .sort((a, b) => {
        const da = a.lead.delivery_date || a.vd.deliveryDateISO || '';
        const db2 = b.lead.delivery_date || b.vd.deliveryDateISO || '';
        return da < db2 ? -1 : da > db2 ? 1 : 0;
      });

    // Schedule: upcoming deliveries and pickups grouped by date
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const in7days = new Date(today); in7days.setDate(in7days.getDate() + 7);

    const scheduleEntries = [];
    for (const { lead, vd } of enriched) {
      const deliveryStr = lead.delivery_date || vd.deliveryDateISO || vd.deliveryDate;
      const pickupStr = vd.pickupDate;
      if (deliveryStr) {
        const d = new Date(deliveryStr); d.setHours(0,0,0,0);
        if (d >= today && d <= in7days) scheduleEntries.push({ lead, date: d, type: 'delivery', time: vd.deliveryTime || null });
      }
      if (pickupStr) {
        const d = new Date(pickupStr); d.setHours(0,0,0,0);
        if (d >= today && d <= in7days) scheduleEntries.push({ lead, date: d, type: 'pickup', time: null });
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

    // Month at a glance
    const monthLeads = leads.filter(l => new Date(l.created_at) >= monthStart).length;
    const monthBooked = leads.filter(l => (l.job_status === 'booked' || l.status === 'booked') && new Date(l.created_at) >= monthStart).length;
    const bookingRate = monthLeads > 0 ? Math.round((monthBooked / monthLeads) * 100) : 0;
    const revenue = leads
      .filter(l => ['booked','completed'].includes(l.job_status || '') || ['booked'].includes(l.status || ''))
      .reduce((sum, l) => sum + (l.estimated_revenue || 0), 0);

    // AI insights
    const insights = [];
    const highNotContacted = enriched.filter(e => e.state.intent === 'high' && e.state.isOpportunity && (e.state.jobStatus === 'inquiry' || !e.state.jobStatus));
    if (highNotContacted.length > 0) {
      const potentialRev = highNotContacted.reduce((s, e) => s + (e.state.estimatedRevenue || 450), 0);
      insights.push(`${highNotContacted.length} high-intent lead${highNotContacted.length === 1 ? '' : 's'} waiting for first contact. Potential revenue at risk: ${formatCurrency(potentialRev)}.`);
    }
    if (bookingRate > 0) {
      insights.push(`Your booking rate this month is ${bookingRate}%. Leads contacted within 1 hour are 3× more likely to book.`);
    }
    const staleCount = enriched.filter(e => e.state.stale).length;
    if (staleCount > 0) {
      insights.push(`${staleCount} lead${staleCount === 1 ? '' : 's'} going cold (48h+ with no contact). Reach out now to recover them.`);
    }

    return {
      needsAttention,
      allOpportunities,
      bookedJobs,
      schedule: scheduleGroups,
      metrics: { needsAttentionCount, hotOpps, bookedThisWeek, onSchedule, completedMonth, monthLeads, monthBooked, bookingRate, revenue },
      insights,
    };
  }, [leads]);

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

          {/* All Opportunities */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-gray-700">All Opportunities</h2>
              <span className="text-xs text-gray-400">{allOpportunities.length} leads</span>
            </div>
            {allOpportunities.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 text-center text-sm text-gray-400">
                No other open opportunities.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {allOpportunities.map(({ lead, state }) => (
                  <OpportunityCard
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
            </div>
            {bookedJobs.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-gray-400">No booked jobs yet.</p>
            ) : (
              <div className="divide-y divide-gray-50 px-2 py-1">
                {bookedJobs.slice(0, 8).map(({ lead }) => (
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

      {/* This Month at a Glance */}
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-bold text-gray-700 mb-4">This Month at a Glance</h2>
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
          dumpsters={dumpsters}
          onConfirm={handleBookedConfirm}
          onClose={() => setBookingLead(null)}
        />
      )}
    </div>
  );
}
