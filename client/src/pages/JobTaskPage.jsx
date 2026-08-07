import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Check, ChevronRight, ExternalLink, MapPin, Navigation, Phone, Trash2,
} from 'lucide-react';
import { api } from '../utils/api';
import { getTerminology, formatTime12 } from '../utils/verticalConfig';
import DumpTicketAction from '../components/home_services/DumpTicketAction';
import { UnitDropAction, UnitPickupStep } from '../components/home_services/UnitAssignmentAction';

const term = getTerminology('home_services', 'dumpster_rental');

// ── The job task screen ───────────────────────────────────────────────────────
//
// One job, one task, its own screen — reached from BOTH the Schedule page's day
// cards and the Dashboard's Today's Schedule, at /task/:leadId?type=…
//
//   DELIVERY → who/where + Call/Navigate → which unit went on the ground → done
//   PICKUP   → who/where + Call/Navigate → which unit came back → which dump site
//              (+ directions) → the weight   [or "picked up, weigh later"]
//   ACTIVE   → who/where + Call/Navigate → record the swap replacement's unit
//
// It replaces the bottom-sheet modal this used to be. The modal was a ~450px card
// with a sticky header, a sticky footer and three separate inner scroll regions at
// 11px type — a panel, not something a driver reads standing beside a truck. This is
// full-bleed on a phone and a wide centered card on a desktop, with ONE scroll: the
// page's own.
//
// It OWNS NO LOGIC. Every step renders the existing prop-driven component unchanged
// (UnitDropAction, UnitPickupStep, DumpTicketAction) against the existing endpoints;
// this file only sequences them and carries the picked unit + chosen dump site from
// one step to the next. The customer profile is one tap away in the header.

function directionsUrl(address) {
  return address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null;
}

const TYPE_CONFIG = {
  delivery: { label: term.startBadge, bg: 'bg-success/10 text-success' },
  pickup: { label: term.endBadge, bg: 'bg-brand/10 text-brand' },
  active: { label: 'ACTIVE', bg: 'bg-warning/10 text-warning' },
};

// Call / Navigate: the two things a driver reaches for before anything is recorded.
// Present in every sequence, disabled (with the reason) when the job has no number
// or no address rather than silently missing.
function ContactRow({ job }) {
  const tel = job.phone ? `tel:${String(job.phone).replace(/[^\d+]/g, '')}` : null;
  const maps = directionsUrl(job.address);
  const cls = 'flex-1 flex items-center justify-center gap-2 text-base font-semibold px-4 py-3.5 rounded-xl transition-colors';

  return (
    <div className="flex items-center gap-3">
      {tel ? (
        <a href={tel} className={`${cls} text-content bg-surface-2 hover:bg-divider`}>
          <Phone size={18} /> Call
        </a>
      ) : (
        <span className={`${cls} text-muted bg-surface-2 opacity-50 cursor-default`} title="No phone number on this job">
          <Phone size={18} /> Call
        </span>
      )}
      {maps ? (
        <a href={maps} target="_blank" rel="noreferrer" className={`${cls} text-content bg-surface-2 hover:bg-divider`}>
          <Navigation size={18} /> Navigate
        </a>
      ) : (
        <span className={`${cls} text-muted bg-surface-2 opacity-50 cursor-default`} title="No delivery address on this job">
          <Navigation size={18} /> Navigate
        </span>
      )}
    </div>
  );
}

// Step chrome: a numbered heading so the driver can see where they are in the
// sequence and what's still coming.
function Step({ n, of, title, children }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs font-bold text-muted uppercase tracking-widest">Step {n} of {of}</span>
        <span className="h-px flex-1 bg-divider" />
      </div>
      <h2 className="text-lg font-bold text-content">{title}</h2>
      {children}
    </section>
  );
}

// ── Dump-site picker (pickup only) ────────────────────────────────────────────
// The owner's own landfills / transfer stations, with directions to the one chosen.
// Reference data: picking a site records its name on the ticket and nothing more —
// no distance, no mileage fee, no effect on the weight or the overage.
function DumpSiteStep({ selected, onSelect }) {
  const [sites, setSites] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api.getDumpSites()
      .then(d => { if (alive) setSites(d.sites || []); })
      .catch(e => { if (alive) { setSites([]); setErr(e.message || 'Could not load your dump sites.'); } });
    return () => { alive = false; };
  }, []);

  if (sites === null) return <p className="text-sm text-muted">Loading dump sites…</p>;

  if (sites.length === 0) {
    return (
      <div className="space-y-2.5">
        <p className="text-sm text-muted bg-surface-2 px-3 py-2.5 rounded-xl">
          {err || 'No dump sites saved yet.'} You can still record the weight — add your
          landfills once and they'll be one tap away here.
        </p>
        <Link to="/dump-sites" className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline">
          <MapPin size={14} /> Add a dump site
        </Link>
      </div>
    );
  }

  const maps = directionsUrl(selected?.address);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {sites.map(s => {
          const isOn = selected?.id === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(isOn ? null : s)}
              className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl border text-left transition-colors ${
                isOn ? 'border-brand bg-brand/10' : 'border-divider bg-surface hover:bg-surface-2'
              }`}
            >
              <span className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${
                isOn ? 'border-brand bg-brand' : 'border-divider'
              }`}>
                {isOn && <Check size={12} className="text-white" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-content truncate">{s.name}</span>
                {s.address && <span className="block text-sm text-muted truncate">{s.address}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {selected && (
        maps ? (
          <a
            href={maps}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm font-semibold text-content bg-surface-2 hover:bg-divider px-3.5 py-2.5 rounded-xl transition-colors"
          >
            <Navigation size={15} /> Get directions to {selected.name}
          </a>
        ) : (
          <p className="text-sm text-muted">No address saved for {selected.name} — add one to get directions.</p>
        )
      )}
    </div>
  );
}

// The task the assignments say is already handled. A finished delivery must not open
// into a drop picker — that's how the owner ended up re-dropping (and staring at the
// whole fleet) on a job that was already done.
function AlreadyDone({ title, note, onOverride, overrideLabel }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 px-3.5 py-3">
        <span className="w-6 h-6 rounded-full bg-success flex items-center justify-center flex-shrink-0">
          <Check size={14} className="text-white" />
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold text-content">{title}</p>
          {note && <p className="text-sm text-muted mt-0.5">{note}</p>}
        </div>
      </div>
      {onOverride && (
        <button onClick={onOverride} className="text-sm font-medium text-brand hover:underline">
          {overrideLabel} →
        </button>
      )}
    </div>
  );
}

export default function JobTaskPage() {
  const { leadId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [job, setJob] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  // What the pickup sequence has settled so far, carried forward step to step.
  const [picked, setPicked] = useState(null);       // { label, assignmentId }
  const [dumpSite, setDumpSite] = useState(null);
  // How far the pickup sequence has advanced. Null = wherever the task starts, which
  // is derived from the type rather than stored, so there's no first-render flicker.
  const [advanced, setAdvanced] = useState(null);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyErr, setLegacyErr] = useState(null);
  // The owner explicitly chose to record another unit on a job whose drop is done.
  const [forceDrop, setForceDrop] = useState(false);
  // A drop recorded in THIS session. Keeps the step showing its own "Unit 12 is on
  // the ground" confirmation instead of flipping to the already-handled panel the
  // moment the refreshed job comes back saying the drop is recorded.
  const [justDropped, setJustDropped] = useState(false);

  const requested = params.get('type');
  const type = TYPE_CONFIG[requested] ? requested : 'delivery';
  const isPickup = type === 'pickup';

  const load = useCallback(() => {
    api.getJobTask(leadId)
      .then(d => { setJob(d.task); setLoadErr(null); })
      .catch(e => setLoadErr(e.message || 'Could not load this job.'));
  }, [leadId]);

  useEffect(() => { load(); }, [load]);

  const stage = advanced || (isPickup ? 'unit' : 'drop');
  const setStage = setAdvanced;

  // Back to wherever this was launched from (Today's Schedule or the Schedule page);
  // a cold load straight into the URL falls back to the schedule.
  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/schedule');
  }, [navigate]);

  const markLegacyDone = useCallback(async (task) => {
    setLegacyBusy(true); setLegacyErr(null);
    try {
      await api.markTaskDone(leadId, task);
      goBack();
    } catch (e) {
      setLegacyErr(e.message || 'Could not mark this done.');
    } finally {
      setLegacyBusy(false);
    }
  }, [leadId, goBack]);

  if (loadErr) {
    return (
      <div className="min-h-screen bg-app-bg flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-base text-content">{loadErr}</p>
        <button onClick={goBack} className="text-sm font-semibold text-brand hover:underline">Go back</button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-app-bg flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const onSite = job.assignedUnits || [];
  const { label, bg } = TYPE_CONFIG[type];
  const timeLabel = type === 'active' ? null : (formatTime12(job.scheduledTime) || 'Flexible');
  // A job with no unit assignments at all is the legacy case — there is nothing to
  // derive "done" from, so it gets the explicit stamp instead (server-guarded: it
  // refuses this the moment the job does track units).
  const isLegacy = job.hasAssignments === false && onSite.length === 0;
  const totalSteps = isPickup ? 3 : 1;
  // A delivery whose drop is already recorded opens as DONE, not as a picker. The
  // swap-replacement task ('active') deliberately drops a second unit on a job that
  // already has one, so it is never treated as finished.
  const dropAlreadyDone = type === 'delivery' && job.dropRecorded && !forceDrop && !justDropped;
  const pickupAlreadyDone = isPickup && job.pickupSettled && !picked;

  return (
    // Full-bleed on a phone; a centered card from sm up. The page itself is the only
    // thing that scrolls.
    <div className="min-h-screen bg-app-bg">
      <header className="sticky top-0 z-10 bg-surface border-b border-divider">
        <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={goBack}
              className="p-2 -ml-2 rounded-lg text-muted hover:bg-surface-2 hover:text-content transition-colors flex-shrink-0"
              aria-label="Back"
            >
              <ArrowLeft size={20} />
            </button>
            <span className={`text-xs font-bold uppercase px-2 py-1 rounded flex-shrink-0 ${bg}`}>
              {label}
            </span>
            {timeLabel && <span className="text-sm font-semibold text-muted">{timeLabel}</span>}
            <Link
              to={`/leads/${job.id}`}
              className="ml-auto inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline flex-shrink-0"
            >
              Profile <ExternalLink size={13} />
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-5 space-y-6">
        {/* Who and where — the card's own content, so opening the task never loses
            context. */}
        <div>
          <h1 className="text-2xl font-bold text-content">{job.customerName}</h1>
          <p className="text-base text-muted mt-0.5">
            {[job.dumpsterSize, job.address].filter(Boolean).join(' · ') || 'No address on this job'}
          </p>
          {onSite.length > 0 && (
            <p className="text-base font-semibold text-brand mt-1.5">
              {onSite.map(u => `Unit ${u.label}`).join(', ')} on site
            </p>
          )}
        </div>

        <ContactRow job={job} />

        {/* ── DELIVERY / ACTIVE: capture the unit on the ground ───────────────── */}
        {!isPickup && (
          <Step
            n={1}
            of={1}
            title={type === 'active' ? 'Which unit did you leave as the replacement?' : 'Confirm the drop'}
          >
            {dropAlreadyDone ? (
              <AlreadyDone
                title="This drop is already recorded"
                note={onSite.length > 0
                  ? `${onSite.map(u => `Unit ${u.label}`).join(', ')} on site.`
                  : 'The unit that went out has already been picked up.'}
                onOverride={() => setForceDrop(true)}
                overrideLabel="Record another unit on this job"
              />
            ) : (
              <>
                <UnitDropAction
                  leadId={job.id}
                  jobSize={job.dumpsterSize}
                  onDone={() => { setJustDropped(true); load(); }}
                />
                {/* Legacy / no-fleet fallback: nothing to record the drop against, so the
                    owner can still clear the task off today's schedule. */}
                {isLegacy && type === 'delivery' && (
                  <div className="pt-2">
                    <button
                      onClick={() => markLegacyDone('delivery')}
                      disabled={legacyBusy}
                      className="text-sm font-medium text-muted hover:text-content underline disabled:opacity-50"
                    >
                      {legacyBusy ? 'Saving…' : 'No unit numbers tracked — just mark this delivered'}
                    </button>
                  </div>
                )}
              </>
            )}
          </Step>
        )}

        {/* ── PICKUP: unit → dump site → weight ───────────────────────────────── */}
        {isPickup && (
          <>
            <Step n={1} of={totalSteps} title="Which unit are you picking up?">
              {pickupAlreadyDone ? (
                <AlreadyDone
                  title="This pickup is already recorded"
                  note="Every unit on this job is back. The weight can still be entered below."
                />
              ) : (
                <UnitPickupStep
                  leadId={job.id}
                  onSite={onSite}
                  pickedLabel={picked?.label}
                  onPicked={(res) => {
                    setPicked({
                      label: res?.assignment?.label || '—',
                      assignmentId: res?.assignment?.id || null,
                    });
                    setStage('site');
                    load();
                  }}
                />
              )}
              {/* No unit on site and nothing was ever captured — the pre-capture job.
                  The step is informational and the sequence continues. */}
              {onSite.length === 0 && stage === 'unit' && (
                <button
                  onClick={() => setStage('site')}
                  className="mt-3 flex items-center gap-2 text-sm font-semibold text-brand bg-brand/10 hover:bg-brand/20 px-3.5 py-2.5 rounded-xl transition-colors"
                >
                  Continue <ChevronRight size={14} />
                </button>
              )}
            </Step>

            {stage !== 'unit' && (
              <Step n={2} of={totalSteps} title="Where are you taking it?">
                <DumpSiteStep selected={dumpSite} onSelect={setDumpSite} />
                {stage === 'site' && (
                  <div className="flex flex-wrap items-center gap-2.5 pt-1">
                    <button
                      onClick={() => setStage('weight')}
                      className="flex items-center gap-2 text-sm font-semibold text-white bg-brand hover:opacity-90 px-4 py-2.5 rounded-xl transition-colors"
                    >
                      <Trash2 size={15} /> Continue to the weight
                    </button>
                    {/* The load often isn't weighed until later that day (or the next).
                        The pickup is already recorded, so leaving now is a legitimate
                        finish — the unit waits in the yard queue for its weight. */}
                    <button
                      onClick={() => (isLegacy ? markLegacyDone('pickup') : goBack())}
                      disabled={legacyBusy}
                      className="flex items-center gap-2 text-sm font-medium text-muted bg-surface-2 hover:bg-divider disabled:opacity-50 px-4 py-2.5 rounded-xl transition-colors"
                    >
                      <ArrowRight size={15} /> {legacyBusy ? 'Saving…' : 'Picked up — weigh later'}
                    </button>
                  </div>
                )}
              </Step>
            )}

            {stage === 'weight' && (
              <Step n={3} of={totalSteps} title="What did it weigh?">
                <DumpTicketAction
                  compact
                  autoOpen
                  leadId={job.id}
                  unitsOut={job.unitsOut}
                  dumpTickets={job.dumpTickets || []}
                  overageNeedsRate={job.overageNeedsRate}
                  // The can just picked up — its weight bills THIS job and prices
                  // against that unit's size. Null for a pre-capture job.
                  assignmentId={picked?.assignmentId || null}
                  unitLabel={picked?.label || null}
                  dumpSite={dumpSite}
                  // A paid swap the server already tracks — hides the redundant
                  // manual swap checkbox and asks for the replacement's unit after.
                  pendingSwapOuts={job.pendingSwapOuts || 0}
                  onDone={load}
                />
              </Step>
            )}
          </>
        )}

        {legacyErr && <p className="text-sm text-danger">{legacyErr}</p>}

        <div className="pt-2 pb-8">
          <button
            onClick={goBack}
            className="w-full flex items-center justify-center gap-2 text-base font-semibold text-content bg-surface-2 hover:bg-divider px-4 py-3.5 rounded-xl transition-colors"
          >
            Done — back to the schedule
          </button>
        </div>
      </div>
    </div>
  );
}
