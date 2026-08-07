import { useState, useEffect, useCallback } from 'react';
import { Check, Truck, X } from 'lucide-react';
import { api } from '../../utils/api';

// Which physical dumpster is on this job (pickup rework, Phase 2b).
//
// Two steps, both driver-facing and both REQUIRING a unit number:
//   • UnitDropAction   — at delivery: pick the actual can going on the ground.
//                        Also the swap-replacement drop (a job can hold more than
//                        one open assignment at a time).
//   • UnitPickupStep   — at pickup: pick which of the job's on-site units came back.
//
// Capture only. Neither touches weight, overage, units_out, the swap markers, or the
// job's completion — the dump-ticket flow below them is unchanged.

// One selectable unit: big number, size + state underneath.
function UnitOption({ unit, selected, onSelect, sublabel }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(unit)}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl border text-left transition-colors ${
        selected
          ? 'border-brand bg-brand/10'
          : 'border-divider bg-surface hover:bg-surface-2'
      }`}
    >
      <span className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${
        selected ? 'border-brand bg-brand' : 'border-divider'
      }`}>
        {selected && <Check size={12} className="text-white" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold text-content truncate">Unit {unit.label}</span>
        <span className="block text-sm text-muted truncate">{[unit.size, sublabel].filter(Boolean).join(' · ')}</span>
      </span>
    </button>
  );
}

// The step once a unit is actually on the ground. This exists because the picker
// used to stay on screen after a successful drop and silently repopulate — see
// `showingAll` below.
function DroppedConfirmation({ label, note }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 px-3.5 py-3">
      <span className="w-6 h-6 rounded-full bg-success flex items-center justify-center flex-shrink-0">
        <Check size={14} className="text-white" />
      </span>
      <div className="min-w-0">
        <p className="text-base font-semibold text-content">Unit {label} is on the ground</p>
        {note && <p className="text-sm text-muted mt-0.5">{note}</p>}
      </div>
    </div>
  );
}

// ── Drop ──────────────────────────────────────────────────────────────────────
// Units of the job's size are offered; "Different size (substitute)" opens the rest
// of the free fleet. Confirm is disabled until a unit is chosen — there is no skip,
// capturing the number IS the point of the step.
//
// After a successful drop the step SETTLES: it shows which unit went on the ground
// and stops rendering a picker. It used to re-fetch the fleet and stay open, and
// because the unit just dropped is no longer assignable, a job whose last free
// matching unit had just gone out fell through the old
// `matching.length === 0 → show everything` fallback and repainted with the entire
// fleet under "which unit is going on the ground?". The all-sizes list is now an
// explicit choice only — never a consequence of an empty filtered list.
export function UnitDropAction({ leadId, jobSize, onDone, onCancel }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [allSizes, setAllSizes] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // The unit this step put on the ground, once it's recorded. Set → the step is done.
  const [dropped, setDropped] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getLeadUnits(leadId)
      .then(d => { setData(d); setErr(null); })
      .catch(e => setErr(e.message || 'Could not load the fleet.'))
      .finally(() => setLoading(false));
  }, [leadId]);

  useEffect(() => { load(); }, [load]);

  const size = jobSize || data?.jobSize || null;
  const available = data?.available || [];
  const matching = available.filter(u => u.sizeMatches);
  // EXPLICIT only: the owner asked for other sizes, or the job never recorded one.
  const showingAll = allSizes || !size;
  const options = showingAll ? available : matching;
  const otherSizesFree = available.length > matching.length;

  const confirm = async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.dropUnit(leadId, { assetId: selected.id });
      // Settle the step rather than re-opening a picker against a fleet this drop
      // just changed.
      setDropped({
        label: res.assignment?.label || selected.label,
        size: res.assignment?.size || selected.size || null,
      });
      setSelected(null);
      onDone?.(res);
    } catch (e) {
      // The server refuses a unit that's already out on another job and says which —
      // show that verbatim.
      setErr(e.message || 'Could not assign that unit.');
    } finally {
      setBusy(false);
    }
  };

  if (dropped) {
    return (
      <DroppedConfirmation
        label={dropped.label}
        note={dropped.size && size && dropped.size !== size
          ? `${dropped.size} substituted for the ${size} on the job — the job now reads ${dropped.size}.`
          : null}
      />
    );
  }

  if (loading && !data) return <p className="text-sm text-muted">Loading units…</p>;

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-muted">
        Which unit is going on the ground?
      </p>

      {data?.onSite?.length > 0 && (
        <p className="text-sm text-muted">
          Already on site: {data.onSite.map(u => `Unit ${u.label}`).join(', ')}
        </p>
      )}

      {options.length === 0 ? (
        // Two different empty states. "No unit of THIS size is free" is not the same
        // as "the whole fleet is out", and only the first one has a way forward.
        otherSizesFree ? (
          <div className="space-y-2.5">
            <p className="text-sm text-warning bg-warning/10 px-3 py-2.5 rounded-xl">
              No {size} is free right now — every one is out on a job or out of service.
            </p>
            <button
              onClick={() => setAllSizes(true)}
              className="text-sm font-semibold text-brand hover:underline"
            >
              Drop a different size instead →
            </button>
          </div>
        ) : (
          <p className="text-sm text-warning bg-warning/10 px-3 py-2.5 rounded-xl">
            No units are free — every dumpster is out on a job or out of service. Add or
            free one on the Inventory page.
          </p>
        )
      ) : (
        <div className="space-y-2">
          {options.map(u => (
            <UnitOption
              key={u.id}
              unit={u}
              selected={selected?.id === u.id}
              onSelect={setSelected}
              sublabel={u.status === 'at_yard' ? 'at the yard' : null}
            />
          ))}
        </div>
      )}

      {!showingAll && otherSizesFree && options.length > 0 && (
        <button
          onClick={() => setAllSizes(true)}
          className="text-sm font-medium text-brand hover:underline"
        >
          Different size (substitute) →
        </button>
      )}
      {showingAll && size && matching.length > 0 && (
        <button
          onClick={() => setAllSizes(false)}
          className="text-sm font-medium text-muted hover:underline"
        >
          ← Only {size}
        </button>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={confirm}
          disabled={!selected || busy}
          className="flex items-center gap-2 text-sm font-semibold text-white bg-brand hover:opacity-90 disabled:opacity-40 px-4 py-2.5 rounded-xl transition-colors"
        >
          <Truck size={15} /> {busy ? 'Saving…' : 'Confirm drop'}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex items-center gap-2 text-sm font-medium text-muted bg-surface-2 hover:bg-divider px-4 py-2.5 rounded-xl transition-colors"
          >
            <X size={15} /> Cancel
          </button>
        )}
      </div>

      {err && <p className="text-sm text-danger">{err}</p>}
    </div>
  );
}

// ── Pickup ────────────────────────────────────────────────────────────────────
// The unit(s) on site for THIS job are the only options — you can't pick up a can
// that was never dropped here. Auto-selects when there's only one. Renders nothing
// but a note for a job whose drop predates this feature (no assignment captured),
// so the weight entry behind it still works exactly as before.
export function UnitPickupStep({ leadId, onSite = [], pickedLabel = null, onPicked }) {
  const [chosenId, setChosenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Derived, not synced: the owner's pick while that unit is still on site, else the
  // only unit when there's just one. Self-corrects when the list changes underneath
  // (e.g. the first of two swap units was just picked up and the card re-rendered).
  const selected = onSite.find(u => u.assetId === chosenId)
    || (onSite.length === 1 ? onSite[0] : null);

  if (onSite.length === 0) {
    return pickedLabel ? (
      <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 px-3.5 py-3">
        <span className="w-6 h-6 rounded-full bg-success flex items-center justify-center flex-shrink-0">
          <Check size={14} className="text-white" />
        </span>
        <p className="text-base font-semibold text-content">Unit {pickedLabel} picked up — back at the yard</p>
      </div>
    ) : (
      <p className="text-sm text-muted bg-surface-2 px-3 py-2.5 rounded-xl">
        No unit was recorded when this job was delivered — record the weight below as usual.
      </p>
    );
  }

  const confirm = async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.pickUpUnit(leadId, { assetId: selected.assetId });
      onPicked?.(res);
    } catch (e) {
      setErr(e.message || 'Could not record the pickup.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-muted">
        Which unit are you picking up?
      </p>
      <div className="space-y-2">
        {onSite.map(u => (
          <UnitOption
            key={u.assetId}
            unit={u}
            selected={selected?.assetId === u.assetId}
            onSelect={(picked) => setChosenId(picked.assetId)}
            sublabel="on site"
          />
        ))}
      </div>
      <button
        onClick={confirm}
        disabled={!selected || busy}
        className="flex items-center gap-2 text-sm font-semibold text-white bg-brand hover:opacity-90 disabled:opacity-40 px-4 py-2.5 rounded-xl transition-colors"
      >
        <Check size={15} /> {busy ? 'Saving…' : 'Confirm pickup'}
      </button>
      {err && <p className="text-sm text-danger">{err}</p>}
    </div>
  );
}

export default UnitDropAction;
