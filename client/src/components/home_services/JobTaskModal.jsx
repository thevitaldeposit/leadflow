import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Check, ChevronRight, ExternalLink, MapPin, Navigation, Phone, Trash2, Truck, X,
} from 'lucide-react';
import { api } from '../../utils/api';
import { getTerminology, formatTime12 } from '../../utils/verticalConfig';
import DumpTicketAction from './DumpTicketAction';
import { UnitDropAction, UnitPickupStep } from './UnitAssignmentAction';

const term = getTerminology('home_services', 'dumpster_rental');

// ── The guided job task ───────────────────────────────────────────────────────
//
// Tapping a day card on the schedule opens THIS, not the customer profile. It walks
// the driver through the one task that card represents, in the order it happens on
// the ground, so nothing is left half-recorded:
//
//   DELIVERY → who/where + Call/Navigate → which unit went on the ground → done
//   PICKUP   → who/where + Call/Navigate → which unit came back → which dump site
//              (+ directions) → the weight   [or "picked up, weigh later"]
//   ACTIVE   → who/where + Call/Navigate → record the swap replacement's unit
//
// It OWNS NO LOGIC. Every step renders the existing prop-driven component unchanged
// (UnitDropAction, UnitPickupStep, DumpTicketAction) against the existing endpoints;
// this file only sequences them and carries the picked unit + chosen dump site from
// one step to the next. The profile is still one tap away via "Open profile".

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
  const cls = 'flex-1 flex items-center justify-center gap-2 text-sm font-semibold px-3 py-2.5 rounded-xl transition-colors';

  return (
    <div className="flex items-center gap-2">
      {tel ? (
        <a href={tel} className={`${cls} text-content bg-surface-2 hover:bg-divider`}>
          <Phone size={15} /> Call
        </a>
      ) : (
        <span className={`${cls} text-muted bg-surface-2 opacity-50 cursor-default`} title="No phone number on this job">
          <Phone size={15} /> Call
        </span>
      )}
      {maps ? (
        <a href={maps} target="_blank" rel="noreferrer" className={`${cls} text-content bg-surface-2 hover:bg-divider`}>
          <Navigation size={15} /> Navigate
        </a>
      ) : (
        <span className={`${cls} text-muted bg-surface-2 opacity-50 cursor-default`} title="No delivery address on this job">
          <Navigation size={15} /> Navigate
        </span>
      )}
    </div>
  );
}

// Step chrome: a numbered heading so the driver can see where they are in the
// sequence and what's still coming.
function Step({ n, of, title, children }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold text-muted uppercase tracking-widest">Step {n} of {of}</span>
        <span className="h-px flex-1 bg-divider" />
      </div>
      <p className="text-sm font-bold text-content">{title}</p>
      {children}
    </div>
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

  if (sites === null) return <p className="text-xs text-muted">Loading dump sites…</p>;

  if (sites.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted bg-surface-2 px-2.5 py-2 rounded-lg">
          {err || 'No dump sites saved yet.'} You can still record the weight — add your
          landfills once and they'll be one tap away here.
        </p>
        <Link to="/dump-sites" className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand hover:underline">
          <MapPin size={12} /> Add a dump site
        </Link>
      </div>
    );
  }

  const maps = directionsUrl(selected?.address);

  return (
    <div className="space-y-2">
      <div className="space-y-1.5 max-h-52 overflow-y-auto">
        {sites.map(s => {
          const isOn = selected?.id === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(isOn ? null : s)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors ${
                isOn ? 'border-brand bg-brand/10' : 'border-divider bg-surface hover:bg-surface-2'
              }`}
            >
              <span className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                isOn ? 'border-brand bg-brand' : 'border-divider'
              }`}>
                {isOn && <Check size={10} className="text-white" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-content truncate">{s.name}</span>
                {s.address && <span className="block text-[11px] text-muted truncate">{s.address}</span>}
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
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-content bg-surface-2 hover:bg-divider px-2.5 py-1.5 rounded-lg transition-colors"
          >
            <Navigation size={12} /> Get directions to {selected.name}
          </a>
        ) : (
          <p className="text-[11px] text-muted">No address saved for {selected.name} — add one to get directions.</p>
        )
      )}
    </div>
  );
}

export default function JobTaskModal({ job, type, onClose, onChanged }) {
  // What the pickup sequence has settled so far, carried forward step to step.
  const [picked, setPicked] = useState(null);       // { label, assignmentId }
  const [dumpSite, setDumpSite] = useState(null);
  const [stage, setStage] = useState(type === 'pickup' ? 'unit' : 'drop');
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyErr, setLegacyErr] = useState(null);

  const onSite = job.assignedUnits || [];
  const { label, bg } = TYPE_CONFIG[type];
  const timeLabel = type === 'active' ? null : (formatTime12(job.scheduledTime) || 'Flexible');
  // A job with no unit assignments at all is the legacy case — there is nothing to
  // derive "done" from, so it gets the explicit stamp instead (server-guarded: it
  // refuses this the moment the job does track units).
  const isLegacy = job.hasAssignments === false && onSite.length === 0;

  // Close on Escape like every other dismissable surface.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const markLegacyDone = useCallback(async (task) => {
    setLegacyBusy(true); setLegacyErr(null);
    try {
      await api.markTaskDone(job.id, task);
      onChanged?.();
      onClose();
    } catch (e) {
      setLegacyErr(e.message || 'Could not mark this done.');
    } finally {
      setLegacyBusy(false);
    }
  }, [job.id, onChanged, onClose]);

  const isPickup = type === 'pickup';
  const totalSteps = isPickup ? 3 : 1;

  return (
    // Bottom sheet on a phone (thumb reach), centered dialog from sm up.
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: who, where, what — the card's own content, so opening the modal
            never loses context. */}
        <div className="px-5 pt-4 pb-3 border-b border-divider sticky top-0 bg-surface z-10">
          <div className="flex items-start gap-2">
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 mt-1 ${bg}`}>
              {label}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-bold text-content truncate">{job.customerName}</p>
              <p className="text-xs text-muted">
                {[job.dumpsterSize, timeLabel].filter(Boolean).join(' · ')}
              </p>
              {job.address && <p className="text-xs text-muted truncate">{job.address}</p>}
              {onSite.length > 0 && (
                <p className="text-xs font-semibold text-brand mt-0.5">
                  {onSite.map(u => `Unit ${u.label}`).join(', ')} on site
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 -mr-1.5 rounded-lg text-muted hover:bg-surface-2 hover:text-content transition-colors flex-shrink-0"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
          {/* The profile is now an explicit affordance rather than what a card tap
              does — the task is the primary action. */}
          <Link
            to={`/leads/${job.id}`}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline mt-2"
          >
            Open profile <ExternalLink size={11} />
          </Link>
        </div>

        <div className="px-5 py-4 space-y-5">
          <ContactRow job={job} />

          {/* ── DELIVERY / ACTIVE: capture the unit on the ground ───────────── */}
          {!isPickup && (
            <Step
              n={1}
              of={1}
              title={type === 'active' ? 'Which unit did you leave as the replacement?' : 'Confirm the drop'}
            >
              <UnitDropAction
                leadId={job.id}
                jobSize={job.dumpsterSize}
                onDone={() => { onChanged?.(); onClose(); }}
                onCancel={onClose}
              />
              {/* Legacy / no-fleet fallback: nothing to record the drop against, so the
                  owner can still clear the task off today's schedule. */}
              {isLegacy && type === 'delivery' && (
                <div className="pt-1">
                  <button
                    onClick={() => markLegacyDone('delivery')}
                    disabled={legacyBusy}
                    className="text-[11px] font-medium text-muted hover:text-content underline disabled:opacity-50"
                  >
                    {legacyBusy ? 'Saving…' : 'No unit numbers tracked — just mark this delivered'}
                  </button>
                </div>
              )}
            </Step>
          )}

          {/* ── PICKUP: unit → dump site → weight ───────────────────────────── */}
          {isPickup && (
            <>
              <Step n={1} of={totalSteps} title="Which unit are you picking up?">
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
                    onChanged?.();
                  }}
                />
                {/* No unit on site and nothing was ever captured — the pre-capture job.
                    The step is informational and the sequence continues. */}
                {onSite.length === 0 && stage === 'unit' && (
                  <button
                    onClick={() => setStage('site')}
                    className="flex items-center gap-1.5 text-xs font-semibold text-brand bg-brand/10 hover:bg-brand/20 px-2.5 py-1.5 rounded-lg transition-colors"
                  >
                    Continue <ChevronRight size={12} />
                  </button>
                )}
              </Step>

              {stage !== 'unit' && (
                <Step n={2} of={totalSteps} title="Where are you taking it?">
                  <DumpSiteStep selected={dumpSite} onSelect={setDumpSite} />
                  {stage === 'site' && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        onClick={() => setStage('weight')}
                        className="flex items-center gap-1.5 text-xs font-semibold text-white bg-brand hover:opacity-90 px-2.5 py-1.5 rounded-lg transition-colors"
                      >
                        <Trash2 size={12} /> Continue to the weight
                      </button>
                      {/* The load often isn't weighed until later that day (or the next).
                          The pickup is already recorded, so leaving now is a legitimate
                          finish — the unit waits in the yard queue for its weight. */}
                      <button
                        onClick={() => (isLegacy ? markLegacyDone('pickup') : onClose())}
                        disabled={legacyBusy}
                        className="flex items-center gap-1.5 text-xs font-medium text-muted bg-surface-2 hover:bg-divider disabled:opacity-50 px-2.5 py-1.5 rounded-lg transition-colors"
                      >
                        <ArrowRight size={12} /> {legacyBusy ? 'Saving…' : 'Picked up — weigh later'}
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
                    onDone={onChanged}
                  />
                </Step>
              )}
            </>
          )}

          {legacyErr && <p className="text-xs text-danger">{legacyErr}</p>}
        </div>

        <div className="px-5 py-3 border-t border-divider sticky bottom-0 bg-surface">
          <button
            onClick={onClose}
            className="w-full flex items-center justify-center gap-1.5 text-sm font-medium text-muted hover:text-content px-3 py-2 rounded-xl transition-colors"
          >
            <Truck size={14} /> Done for now
          </button>
        </div>
      </div>
    </div>
  );
}
