import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Scale, Warehouse } from 'lucide-react';
import { api } from '../../utils/api';

// ── The yard queue (pickup rework, Phase 2c) ──────────────────────────────────
//
// Cans that came back but haven't been weighed yet. This is the weekend case: four
// dumpsters collected Saturday, the scale tickets sorted out over the following days.
// Each row carries the JOB its unit sat on, so entering a weight here bills that
// customer — the same assignment→job path the pickup card uses, just entered later.
//
// Renders nothing when the yard is clear, so it costs the owner no screen space on a
// normal day. Ordered oldest pickup first: the can that's been sitting longest is the
// one to clear.

function fmtWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// One at-yard unit: what it is, whose job it was on, and the weight entry.
function YardRow({ unit, onWeighed }) {
  const navigate = useNavigate();
  const [lbs, setLbs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    if (lbs === '' || Number(lbs) < 0) { setErr('Enter the weight in pounds.'); return; }
    setBusy(true); setErr(null);
    try {
      // Posted against the unit's OWN job with its assignment id, so the overage
      // prices on this can's size and the job it sat on is the one that advances.
      const res = await api.recordDumpTicket(unit.leadId, {
        weightLbs: Number(lbs),
        assignmentId: unit.assignmentId,
      });
      const bits = [`Unit ${unit.label} weighed for ${unit.customerName}.`];
      if (res.overage && res.overage.overTons > 0) {
        bits.push(res.overage.amount != null
          ? `Overage: ${res.overage.overTons}t ($${res.overage.amount})`
          : `Overage: ${res.overage.overTons}t — set overage pricing for ${unit.size} on the Pricing page to bill it`);
      }
      if (res.advancedTo === 'completed') bits.push('Job completed.');
      else if (res.advancedTo === 'awaiting_final_payment') bits.push('Awaiting final payment.');
      onWeighed?.(bits.join(' '));
    } catch (e) {
      // The server names the unit when it's already been weighed — show that verbatim.
      setErr(e.message || 'Could not record that weight.');
      setBusy(false);
    }
  };

  const picked = fmtWhen(unit.pickedUpAt);
  // A can that came back a different size than the job booked is worth flagging —
  // its allowance comes from the unit, not the booking.
  const sizeNote = unit.jobSize && unit.size && unit.jobSize !== unit.size
    ? `${unit.size} (job booked ${unit.jobSize})`
    : unit.size;

  return (
    <div className="px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-content">
          Unit {unit.label}
          {sizeNote && <span className="ml-1.5 text-xs font-medium text-muted">{sizeNote}</span>}
        </p>
        <button
          onClick={() => navigate(`/leads/${unit.leadId}`)}
          className="text-xs text-muted hover:text-brand hover:underline text-left"
        >
          {unit.customerName}{picked ? ` · picked up ${picked}` : ''}
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          type="number" min="0" step="1" value={lbs}
          onChange={(e) => setLbs(e.target.value)}
          placeholder="lbs"
          className="w-24 px-2 py-1.5 text-sm rounded-lg border border-divider bg-surface text-content focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
        <button
          onClick={save} disabled={busy}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-brand hover:opacity-90 disabled:opacity-50 px-2.5 py-1.5 rounded-lg transition-colors"
        >
          <Scale size={12} /> {busy ? 'Saving…' : 'Record'}
        </button>
      </div>

      {err && <p className="w-full text-[11px] text-danger">{err}</p>}
    </div>
  );
}

export default function YardQueue() {
  const [units, setUnits] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    api.getYardUnits()
      .then(d => setUnits(d.units || []))
      .catch(() => setUnits([]))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Nothing at the yard (or not loaded yet) → no section at all.
  if (!loaded || units.length === 0) {
    return msg ? (
      <p className="text-xs text-success bg-success/10 px-3 py-2 rounded-lg">{msg}</p>
    ) : null;
  }

  return (
    <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-divider flex items-center gap-2">
        <Warehouse size={16} className="text-warning" />
        <h2 className="text-sm font-bold text-content">At the yard — weight needed</h2>
        <span className="ml-auto text-xs font-semibold text-muted">
          {units.length} unit{units.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className="px-5 pt-3 text-xs text-muted">
        Picked up but not yet weighed. Each weight bills the job that unit was on.
      </p>
      <div className="divide-y divide-divider">
        {units.map(u => (
          <YardRow
            key={u.assignmentId}
            unit={u}
            onWeighed={(text) => { setMsg(text); load(); }}
          />
        ))}
      </div>
      {msg && <p className="px-5 py-3 text-xs text-content bg-surface-2">{msg}</p>}
    </section>
  );
}
