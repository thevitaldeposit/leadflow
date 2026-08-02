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
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors ${
        selected
          ? 'border-brand bg-brand/10'
          : 'border-divider bg-surface hover:bg-surface-2'
      }`}
    >
      <span className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
        selected ? 'border-brand bg-brand' : 'border-divider'
      }`}>
        {selected && <Check size={10} className="text-white" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-content truncate">Unit {unit.label}</span>
        <span className="block text-[11px] text-muted truncate">{[unit.size, sublabel].filter(Boolean).join(' · ')}</span>
      </span>
    </button>
  );
}

// ── Drop ──────────────────────────────────────────────────────────────────────
// Units of the job's size are offered first; "Show all sizes" opens the rest of the
// free fleet for a substitution. Confirm is disabled until a unit is chosen — there
// is no skip, capturing the number IS the point of the step.
export function UnitDropAction({ leadId, jobSize, onDone, onCancel }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [allSizes, setAllSizes] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

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
  // Fall back to the whole free fleet when nothing matches (or the job never captured
  // a size) so the driver is never stuck with an empty list.
  const showingAll = allSizes || matching.length === 0 || !size;
  const options = showingAll ? available : matching;

  const confirm = async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.dropUnit(leadId, { assetId: selected.id });
      setMsg(`Unit ${res.assignment?.label || selected.label} is now on this job.`);
      setSelected(null);
      onDone?.(res);
      load();
    } catch (e) {
      // The server refuses a unit that's already out on another job and says which —
      // show that verbatim.
      setErr(e.message || 'Could not assign that unit.');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <p className="text-xs text-muted">Loading units…</p>;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-muted uppercase tracking-wide">
        Which unit is going on the ground?
      </p>

      {data?.onSite?.length > 0 && (
        <p className="text-[11px] text-muted">
          Already on site: {data.onSite.map(u => `Unit ${u.label}`).join(', ')}
        </p>
      )}

      {options.length === 0 ? (
        <p className="text-xs text-warning bg-warning/10 px-2 py-1.5 rounded-lg">
          No units are free — every dumpster is out on a job or out of service. Add or
          free one on the Inventory page.
        </p>
      ) : (
        <div className="space-y-1.5 max-h-52 overflow-y-auto">
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

      {!showingAll && (
        <button
          onClick={() => setAllSizes(true)}
          className="text-[11px] font-medium text-brand hover:underline"
        >
          Different size (substitute) →
        </button>
      )}
      {showingAll && size && matching.length > 0 && (
        <button
          onClick={() => setAllSizes(false)}
          className="text-[11px] font-medium text-muted hover:underline"
        >
          ← Only {size}
        </button>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button
          onClick={confirm}
          disabled={!selected || busy}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-brand hover:opacity-90 disabled:opacity-40 px-2.5 py-1.5 rounded-lg transition-colors"
        >
          <Truck size={12} /> {busy ? 'Saving…' : 'Confirm drop'}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 text-xs font-medium text-muted bg-surface-2 hover:bg-divider px-2.5 py-1.5 rounded-lg transition-colors"
          >
            <X size={12} /> Cancel
          </button>
        )}
      </div>

      {err && <p className="text-[11px] text-danger">{err}</p>}
      {msg && <p className="text-[11px] text-success">{msg}</p>}
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
      <p className="text-[11px] text-success bg-success/10 px-2 py-1.5 rounded-lg">
        Unit {pickedLabel} picked up — back at the yard.
      </p>
    ) : (
      <p className="text-[11px] text-muted bg-surface-2 px-2 py-1.5 rounded-lg">
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
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-muted uppercase tracking-wide">
        Which unit are you picking up?
      </p>
      <div className="space-y-1.5">
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
        className="flex items-center gap-1.5 text-xs font-semibold text-white bg-brand hover:opacity-90 disabled:opacity-40 px-2.5 py-1.5 rounded-lg transition-colors"
      >
        <Check size={12} /> {busy ? 'Saving…' : 'Confirm pickup'}
      </button>
      {err && <p className="text-[11px] text-danger">{err}</p>}
    </div>
  );
}

export default UnitDropAction;
