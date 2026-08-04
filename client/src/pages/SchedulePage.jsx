import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Calendar, Package, Phone, Navigation, Scale, Truck } from 'lucide-react';
import { api } from '../utils/api';
import { getTerminology, formatTime12 } from '../utils/verticalConfig';
import DumpTicketAction from '../components/home_services/DumpTicketAction';
import { UnitDropAction, UnitPickupStep } from '../components/home_services/UnitAssignmentAction';
import YardQueue from '../components/home_services/YardQueue';

// This page serves the Home Services dumpster-rental business; wording comes from
// the shared terminology table so the same calendar can label other verticals.
const term = getTerminology('home_services', 'dumpster_rental');

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

// Minutes past midnight for an "HH:MM" scheduled time, or null when unset
// (which sorts after all timed jobs).
function timeToMinutes(t) {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Sort jobs so timed ones lead (ascending), with "Flexible" (untimed) jobs after.
function byScheduledTime(a, b) {
  const ta = timeToMinutes(a.scheduledTime);
  const tb = timeToMinutes(b.scheduledTime);
  if (ta == null && tb == null) return 0;
  if (ta == null) return 1;
  if (tb == null) return -1;
  return ta - tb;
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
    <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-divider flex items-center gap-2">
        <Package size={16} className="text-success" />
        <h2 className="text-sm font-bold text-content">Availability Checker</h2>
        <span className="ml-2 text-xs text-muted">Used during live calls — results update instantly</span>
      </div>

      {/* Inputs */}
      <div className="px-5 py-4 flex flex-wrap items-end gap-6">
        <div>
          <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">
            Delivery Date
          </label>
          <input
            type="date"
            value={deliveryDate}
            onChange={e => setDeliveryDate(e.target.value)}
            className="text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-surface"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">
            Rental Duration (days)
          </label>
          <input
            type="number"
            min="1"
            max="365"
            placeholder="e.g. 7"
            value={rentalDuration}
            onChange={e => setRentalDuration(e.target.value)}
            className="text-sm border border-divider rounded-lg px-3 py-2 w-28 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        {pickupDate && (
          <div className="pb-2">
            <p className="text-xs text-muted uppercase tracking-wide font-semibold mb-0.5">Pickup Date</p>
            <p className="text-sm font-semibold text-content">{formatDate(pickupDate)}</p>
          </div>
        )}
        {loading && (
          <div className="pb-2 flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-muted">Checking…</span>
          </div>
        )}
      </div>

      {/* Results */}
      {results && results.bySizes && (
        <div className="px-5 pb-5 space-y-4">
          {results.bySizes.length === 0 ? (
            <p className="text-sm text-muted">No inventory configured yet.</p>
          ) : (
            results.bySizes.map(group => (
              <SizeGroup key={group.size} group={group} />
            ))
          )}
        </div>
      )}

      {!deliveryDate && !rentalDuration && (
        <div className="px-5 pb-5">
          <p className="text-xs text-muted italic">Enter a delivery date and rental duration to see real-time availability.</p>
        </div>
      )}
    </section>
  );
}

function SizeGroup({ group }) {
  const { size, ownedCount, unitsInService, bookedCount, availableCount } = group;
  const none = availableCount <= 0;

  return (
    <div className={`rounded-xl border ${none ? 'border-danger/30 bg-danger/10' : 'border-divider'} px-4 py-3 flex items-center justify-between gap-3`}>
      <div className="min-w-0">
        <p className="text-sm font-bold text-content">{size}</p>
        <p className="text-xs text-muted mt-0.5">
          {ownedCount} owned · {bookedCount} on jobs{unitsInService > 0 ? ` · ${unitsInService} in service` : ''}
        </p>
      </div>
      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0 ${
        none ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'
      }`}>
        {none ? `No ${size} available` : `${availableCount} of ${ownedCount} available`}
      </span>
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

  // Re-pull the month after a drop or pickup is recorded from a day card, so the
  // assigned unit, the ticket list, units-out and any completed job reflect
  // immediately (a completed job leaves the calendar entirely).
  const reload = useCallback(() => load(year, month), [load, year, month]);

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
    <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-divider flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-brand" />
          <h2 className="text-sm font-bold text-content">Calendar</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={goToday}
            className="text-xs font-medium text-muted hover:text-content px-2.5 py-1 rounded-lg hover:bg-surface-2 transition-colors"
          >
            Today
          </button>
          <button onClick={prevMonth} className="p-1.5 rounded-lg text-muted hover:bg-surface-2 hover:text-content transition-colors">
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-semibold text-content min-w-[160px] text-center">{monthLabel}</span>
          <button onClick={nextMonth} className="p-1.5 rounded-lg text-muted hover:bg-surface-2 hover:text-content transition-colors">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-success inline-block" />{term.startAction}</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-brand inline-block" />{term.endAction}</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-warning inline-block" />Active</span>
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
                  <div key={n} className="text-center text-[11px] font-semibold text-muted uppercase tracking-wide py-1">
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
                          ? 'hover:bg-surface-2 cursor-pointer'
                          : 'hover:bg-surface-2 cursor-default'
                      }`}
                    >
                      <span className={`text-xs font-medium mb-1 rounded-full w-5 h-5 flex items-center justify-center ${
                        isToday
                          ? 'bg-accent text-content'
                          : 'text-content'
                      }`}>
                        {d}
                      </span>
                      <div className="flex gap-0.5 flex-wrap">
                        {hasDelivery && <span className="w-2 h-2 rounded-full bg-success" title={`${data.deliveries.length} delivery`} />}
                        {hasPickup && <span className="w-2 h-2 rounded-full bg-brand" title={`${data.pickups.length} pickup`} />}
                        {hasActive && <span className="w-2 h-2 rounded-full bg-warning" title={`${data.activeRentals.length} active`} />}
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
          <div className="w-80 border-l border-divider flex-shrink-0">
            <div className="px-4 py-3 bg-surface-2 border-b border-divider">
              <p className="text-sm font-bold text-content">{formatDate(selectedDay)}</p>
            </div>
            <div className="overflow-y-auto max-h-[420px]">
              {!selectedData || (selectedData.deliveries.length + selectedData.pickups.length + selectedData.activeRentals.length === 0) ? (
                <p className="px-4 py-6 text-xs text-muted italic">No jobs on this day.</p>
              ) : (
                <div className="divide-y divide-divider">
                  {[...selectedData.deliveries].sort(byScheduledTime).map(job => (
                    <DayJobRow key={`d-${job.id}`} job={job} type="delivery" navigate={navigate} onChanged={reload} />
                  ))}
                  {[...selectedData.pickups].sort(byScheduledTime).map(job => (
                    <DayJobRow key={`p-${job.id}`} job={job} type="pickup" navigate={navigate} onChanged={reload} />
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

// Directions to the job site in whatever maps app the device prefers. Address-only —
// no geocoding; Google resolves the destination string itself.
function directionsUrl(address) {
  return address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null;
}

// Deliveries and pickups are jobs to DO, so both rows carry what the driver needs on
// site: call the customer, navigate to the address, and record the unit —
//   delivery → which dumpster went on the ground (required; also the swap replacement)
//   pickup   → which of the job's on-site units came back (required), then the weight,
//              the same DumpTicketAction the customer profile uses, unchanged.
//   active   → the same call/navigate/drop, because a SWAP happens mid-rental: the
//              replacement can is dropped on a day that is neither the delivery nor the
//              pickup, and until this the drop step only existed on the delivery card, so
//              a swap replacement never became an assignment (and could never be picked
//              up or weighed as itself). Weight entry stays pickup-only.
function DayJobRow({ job, type, navigate, onChanged }) {
  const [showWeight, setShowWeight] = useState(false);
  const [showDrop, setShowDrop] = useState(false);
  // The unit step gates the weight entry only while a captured unit is still on site;
  // a job delivered before unit capture existed (no assignment) falls straight through
  // to the weight entry exactly as it did before. Holds the unit just picked up — its
  // label so the step reads as "Unit 41 picked up", and its ASSIGNMENT so the weight
  // entered next is attributed to that can and its job (Phase 2c).
  const [picked, setPicked] = useState(null);
  const onSite = job.assignedUnits || [];
  const typeConfig = {
    delivery: { label: term.startBadge, bg: 'bg-success/10 text-success' },
    pickup: { label: term.endBadge, bg: 'bg-brand/10 text-brand' },
    active: { label: 'ACTIVE', bg: 'bg-warning/10 text-warning' },
  };
  const { label, bg } = typeConfig[type];
  // Active rentals are ongoing, so a specific time of day doesn't apply to them.
  const timeLabel = type === 'active' ? null : (formatTime12(job.scheduledTime) || 'Flexible');

  const isPickup = type === 'pickup';
  const isDelivery = type === 'delivery';
  const isActive = type === 'active';
  const tel = job.phone ? `tel:${String(job.phone).replace(/[^\d+]/g, '')}` : null;
  const maps = directionsUrl(job.address);
  // A drop is recordable whenever the job is live — at delivery, and mid-rental for the
  // swap replacement. Named for what it is in context so the swap case is findable.
  const canDrop = isDelivery || isActive;
  const dropLabel = onSite.length === 0
    ? 'Record drop'
    : (isActive ? 'Record replacement' : 'Assign another unit');
  // units_out is only initialized once the delivery date lands, so treat "unknown"
  // (null) as still out — the server defaults it to 1 anyway. Hidden only when every
  // unit is explicitly back.
  const canRecord = isPickup && (job.unitsOut == null || job.unitsOut > 0);

  const actionClass = 'flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors';

  return (
    <div className="px-4 py-3 hover:bg-surface-2 transition-colors">
      <button
        onClick={() => navigate(`/leads/${job.id}`)}
        className="w-full flex items-start gap-3 text-left"
      >
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${bg}`}>
          {label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-content truncate">{job.customerName}</p>
            {timeLabel && (
              <span className="text-xs font-semibold flex-shrink-0 text-muted">{timeLabel}</span>
            )}
          </div>
          {job.dumpsterSize && <p className="text-xs text-muted">{job.dumpsterSize}</p>}
          {job.address && <p className="text-xs text-muted truncate">{job.address}</p>}
          {/* Which physical dumpster is sitting on this job right now. */}
          {onSite.length > 0 && (
            <p className="text-xs font-semibold text-brand mt-0.5">
              {onSite.map(u => `Unit ${u.label}`).join(', ')} on site
            </p>
          )}
        </div>
      </button>

      {(isPickup || isDelivery || isActive) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-1">
          {tel ? (
            <a href={tel} className={`${actionClass} text-content bg-surface-2 hover:bg-divider`}>
              <Phone size={11} /> Call
            </a>
          ) : (
            <span className={`${actionClass} text-muted bg-surface-2 opacity-50 cursor-default`} title="No phone number on this job">
              <Phone size={11} /> Call
            </span>
          )}
          {maps ? (
            <a href={maps} target="_blank" rel="noreferrer" className={`${actionClass} text-content bg-surface-2 hover:bg-divider`}>
              <Navigation size={11} /> Navigate
            </a>
          ) : (
            <span className={`${actionClass} text-muted bg-surface-2 opacity-50 cursor-default`} title="No delivery address on this job">
              <Navigation size={11} /> Navigate
            </span>
          )}
          {canDrop && (
            <button
              onClick={() => setShowDrop(v => !v)}
              className={`${actionClass} ${showDrop ? 'text-white bg-brand' : 'text-brand bg-brand/10 hover:bg-brand/20'}`}
            >
              <Truck size={11} /> {showDrop ? 'Close' : dropLabel}
            </button>
          )}
          {canRecord && (
            <button
              onClick={() => setShowWeight(v => !v)}
              className={`${actionClass} ${showWeight ? 'text-white bg-brand' : 'text-brand bg-brand/10 hover:bg-brand/20'}`}
            >
              <Scale size={11} /> {showWeight ? 'Close' : 'Record pickup'}
            </button>
          )}
        </div>
      )}

      {/* Drop: the unit number is required, so this is the whole step. */}
      {showDrop && (
        <div className="mt-2.5 pl-1">
          <UnitDropAction
            leadId={job.id}
            jobSize={job.dumpsterSize}
            onDone={onChanged}
            onCancel={() => setShowDrop(false)}
          />
        </div>
      )}

      {/* Pickup: which unit came back (required while one is on site), then the
          unchanged weight / dump-ticket entry. */}
      {showWeight && (
        <div className="mt-2.5 pl-1 space-y-3">
          <UnitPickupStep
            leadId={job.id}
            onSite={onSite}
            pickedLabel={picked?.label}
            onPicked={(res) => {
              setPicked({ label: res?.assignment?.label || '—', assignmentId: res?.assignment?.id || null });
              onChanged?.();
            }}
          />
          {(picked || onSite.length === 0) && (
            <DumpTicketAction
              compact
              leadId={job.id}
              unitsOut={job.unitsOut}
              dumpTickets={job.dumpTickets || []}
              overageNeedsRate={job.overageNeedsRate}
              // The can just picked up — its weight bills THIS job and prices against
              // that unit's size. Null for a job delivered before unit capture.
              assignmentId={picked?.assignmentId || null}
              unitLabel={picked?.label || null}
              // A paid swap the server is already tracking — hides the redundant manual
              // swap checkbox, and the form asks for the replacement's unit after the haul.
              pendingSwapOuts={job.pendingSwapOuts || 0}
              onDone={onChanged}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Cans sitting at the yard still owing a weight — leads because it's work the
          owner already owes; renders nothing when the yard is clear. */}
      <YardQueue />
      <AvailabilitySection />
      <CalendarSection />
    </div>
  );
}
