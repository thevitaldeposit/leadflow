import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CheckCircle2, XCircle, Calendar, Package } from 'lucide-react';
import { api } from '../utils/api';

// ── helpers ────────────────────────────────────────────────────────────────────

function addDays(isoDate, days) {
  // Stay in local-calendar space throughout so the YYYY-MM-DD string we return
  // is the same calendar day a user would write on paper, regardless of TZ.
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateShort(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Availability Checker ───────────────────────────────────────────────────────

function AvailabilitySection() {
  const [deliveryDate, setDeliveryDate] = useState('');
  const [rentalDuration, setRentalDuration] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  const pickupDate = deliveryDate && rentalDuration && Number(rentalDuration) > 0
    ? addDays(deliveryDate, Number(rentalDuration))
    : null;

  const runCheck = useCallback((date, duration) => {
    setLoading(true);
    api.getAvailability(date, duration)
      .then(data => setResults(data))
      .catch(() => setResults(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!deliveryDate || !rentalDuration || Number(rentalDuration) < 1) {
      setResults(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runCheck(deliveryDate, rentalDuration), 350);
    return () => clearTimeout(debounceRef.current);
  }, [deliveryDate, rentalDuration, runCheck]);

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
        <Package size={16} className="text-emerald-600" />
        <h2 className="text-sm font-bold text-gray-900">Availability Checker</h2>
        <span className="ml-2 text-xs text-gray-400">Used during live calls — results update instantly</span>
      </div>

      {/* Inputs */}
      <div className="px-5 py-4 flex flex-wrap items-end gap-6">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            Delivery Date
          </label>
          <input
            type="date"
            value={deliveryDate}
            onChange={e => setDeliveryDate(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-white"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            Rental Duration (days)
          </label>
          <input
            type="number"
            min="1"
            max="365"
            placeholder="e.g. 7"
            value={rentalDuration}
            onChange={e => setRentalDuration(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 w-28 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        {pickupDate && (
          <div className="pb-2">
            <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold mb-0.5">Pickup Date</p>
            <p className="text-sm font-semibold text-gray-800">{formatDate(pickupDate)}</p>
          </div>
        )}
        {loading && (
          <div className="pb-2 flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-gray-400">Checking…</span>
          </div>
        )}
      </div>

      {/* Results */}
      {results && results.bySizes && (
        <div className="px-5 pb-5 space-y-4">
          {results.bySizes.length === 0 ? (
            <p className="text-sm text-gray-400">No dumpsters in inventory.</p>
          ) : (
            results.bySizes.map(group => (
              <SizeGroup
                key={group.size}
                group={group}
                deliveryDate={results.deliveryDate}
                pickupDate={results.pickupDate}
              />
            ))
          )}
        </div>
      )}

      {!deliveryDate && !rentalDuration && (
        <div className="px-5 pb-5">
          <p className="text-xs text-gray-400 italic">Enter a delivery date and rental duration to see real-time availability.</p>
        </div>
      )}
    </section>
  );
}

function SizeGroup({ group, deliveryDate, pickupDate }) {
  const allUnavailable = group.availableCount === 0;

  return (
    <div className={`rounded-xl border ${allUnavailable ? 'border-red-100 bg-red-50/30' : 'border-gray-100'} overflow-hidden`}>
      {/* Size header */}
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
        <span className="text-sm font-bold text-gray-800">{group.size}</span>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
            group.availableCount > 0
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-red-100 text-red-600'
          }`}>
            {group.availableCount} available
          </span>
          <span className="text-xs text-gray-400">{group.totalCount} total</span>
        </div>
      </div>

      <div className="divide-y divide-gray-100">
        {/* Available */}
        {group.available.map(d => (
          <div key={d.id} className="flex items-center gap-3 px-4 py-2.5">
            <CheckCircle2 size={15} className="text-emerald-500 flex-shrink-0" />
            <span className="text-sm font-semibold text-gray-800">{d.asset_number}</span>
            <span className="text-xs text-emerald-600 font-medium">Available</span>
          </div>
        ))}

        {/* Unavailable */}
        {group.unavailable.map(d => (
          <div key={d.id} className="flex items-center gap-3 px-4 py-2.5 bg-red-50/40">
            <XCircle size={15} className="text-red-400 flex-shrink-0" />
            <span className="text-sm font-semibold text-gray-700">{d.asset_number}</span>
            {d.conflict && (
              <span className="text-xs text-red-500">
                Booked {formatDateShort(d.conflict.deliveryDate)} → {formatDateShort(d.conflict.pickupDate)}
                {d.conflict.customerName && ` · ${d.conflict.customerName}`}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Suggestion row when fully unavailable */}
      {allUnavailable && group.nextAvailableDate && (
        <div className="px-4 py-2.5 bg-amber-50 border-t border-amber-100">
          <p className="text-xs text-amber-700">
            <span className="font-semibold">Next available:</span> {formatDate(group.nextAvailableDate)} (returns from prior job)
          </p>
        </div>
      )}
    </div>
  );
}

// ── Calendar ───────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function CalendarSection() {
  const navigate = useNavigate();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-indexed
  const [calData, setCalData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null); // YYYY-MM-DD

  const load = useCallback((y, m) => {
    setLoading(true);
    api.getCalendar(y, m)
      .then(data => setCalData(data))
      .catch(() => setCalData(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(year, month); }, [year, month, load]);

  function prevMonth() {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
    setSelectedDay(null);
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
    setSelectedDay(null);
  }
  function goToday() {
    const now = new Date();
    setYear(now.getFullYear());
    setMonth(now.getMonth() + 1);
    setSelectedDay(null);
  }

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const firstDow = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  // Local-calendar today; toISOString() would shift to UTC and mis-highlight
  // "today" in negative-offset timezones.
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Build calendar grid cells
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null); // empty leading cells
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  function dayKey(d) {
    return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function getDayData(d) {
    if (!calData) return null;
    return calData.days[dayKey(d)] || null;
  }

  const selectedData = selectedDay && calData ? calData.days[selectedDay] : null;

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-blue-600" />
          <h2 className="text-sm font-bold text-gray-900">Calendar</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={goToday}
            className="text-xs font-medium text-gray-500 hover:text-gray-800 px-2.5 py-1 rounded-lg hover:bg-gray-100 transition-colors"
          >
            Today
          </button>
          <button onClick={prevMonth} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors">
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-semibold text-gray-800 min-w-[160px] text-center">{monthLabel}</span>
          <button onClick={nextMonth} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" />Delivery</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400 inline-block" />Pickup</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block" />Active</span>
        </div>
      </div>

      <div className="flex">
        {/* Grid */}
        <div className="flex-1 p-4">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Day name headers */}
              <div className="grid grid-cols-7 mb-1">
                {DAY_NAMES.map(n => (
                  <div key={n} className="text-center text-[11px] font-semibold text-gray-400 uppercase tracking-wide py-1">
                    {n}
                  </div>
                ))}
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7 gap-1">
                {cells.map((d, i) => {
                  if (!d) return <div key={`e-${i}`} />;
                  const dk = dayKey(d);
                  const data = getDayData(d);
                  const hasDelivery = data && data.deliveries.length > 0;
                  const hasPickup = data && data.pickups.length > 0;
                  const hasActive = data && data.activeRentals.length > 0;
                  const isToday = dk === todayStr;
                  const isSelected = dk === selectedDay;
                  const hasAny = hasDelivery || hasPickup || hasActive;

                  return (
                    <button
                      key={dk}
                      onClick={() => setSelectedDay(isSelected ? null : dk)}
                      className={`relative rounded-lg p-1.5 min-h-[56px] flex flex-col items-start transition-colors ${
                        isSelected
                          ? 'bg-accent/10 ring-2 ring-accent'
                          : hasAny
                          ? 'hover:bg-gray-50 cursor-pointer'
                          : 'hover:bg-gray-50 cursor-default'
                      }`}
                    >
                      <span className={`text-xs font-medium mb-1 rounded-full w-5 h-5 flex items-center justify-center ${
                        isToday
                          ? 'bg-accent text-white'
                          : 'text-gray-700'
                      }`}>
                        {d}
                      </span>
                      <div className="flex gap-0.5 flex-wrap">
                        {hasDelivery && <span className="w-2 h-2 rounded-full bg-emerald-400" title={`${data.deliveries.length} delivery`} />}
                        {hasPickup && <span className="w-2 h-2 rounded-full bg-blue-400" title={`${data.pickups.length} pickup`} />}
                        {hasActive && <span className="w-2 h-2 rounded-full bg-orange-400" title={`${data.activeRentals.length} active`} />}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Day panel */}
        {selectedDay && (
          <div className="w-72 border-l border-gray-100 flex-shrink-0">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
              <p className="text-sm font-bold text-gray-800">{formatDate(selectedDay)}</p>
            </div>
            <div className="overflow-y-auto max-h-[420px]">
              {!selectedData || (selectedData.deliveries.length + selectedData.pickups.length + selectedData.activeRentals.length === 0) ? (
                <p className="px-4 py-6 text-xs text-gray-400 italic">No jobs on this day.</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {selectedData.deliveries.map(job => (
                    <DayJobRow key={`d-${job.id}`} job={job} type="delivery" navigate={navigate} />
                  ))}
                  {selectedData.pickups.map(job => (
                    <DayJobRow key={`p-${job.id}`} job={job} type="pickup" navigate={navigate} />
                  ))}
                  {selectedData.activeRentals.map(job => (
                    <DayJobRow key={`a-${job.id}`} job={job} type="active" navigate={navigate} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function DayJobRow({ job, type, navigate }) {
  const typeConfig = {
    delivery: { label: 'DROP', bg: 'bg-emerald-100 text-emerald-700' },
    pickup: { label: 'PICK', bg: 'bg-blue-100 text-blue-700' },
    active: { label: 'ACTIVE', bg: 'bg-orange-100 text-orange-700' },
  };
  const { label, bg } = typeConfig[type];

  return (
    <button
      onClick={() => navigate(`/leads/${job.id}`)}
      className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
    >
      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${bg}`}>
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-800 truncate">{job.customerName}</p>
        {job.dumpsterSize && <p className="text-xs text-gray-500">{job.dumpsterSize}</p>}
        {job.address && <p className="text-xs text-gray-400 truncate">{job.address}</p>}
      </div>
    </button>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <AvailabilitySection />
      <CalendarSection />
    </div>
  );
}
