import { useState } from 'react';
import { Briefcase, Check, Plus, X, Pencil } from 'lucide-react';
import { api } from '../../utils/api';

// Manual dump-ticket / weight entry for a job with a dumpster still out. This is the
// TRIGGER the future photo-OCR feature will reuse (same api.recordDumpTicket path —
// OCR just auto-fills the weight). Records the weight (computing/flagging any overage
// server-side) and advances the lifecycle swap-safely: only the LAST unit back
// advances the job past active_rental. onDone refreshes whatever rendered it.
//
// Weight is entered in POUNDS (what the scale ticket prints); the server converts once
// and stores tons, so the size's weight allowance keeps its meaning. A recorded weight
// stays EDITABLE — the ticket is the source of truth, and correcting it rewrites the
// overage on the invoice and logs the correction (blocked once that invoice is
// signed/paid, which the server enforces).
//
// Rendered on the customer profile AND on the schedule's pickup card (compact — no
// outer card chrome), so a pickup can be recorded from wherever the owner is standing.
//
// The weight belongs to a UNIT (Phase 2c). Callers name it one of two ways:
//   • assignmentId — the unit is already settled (the schedule's pickup step just
//     recorded which can came back), so this just passes it through.
//   • units[]      — the job's on-site cans; the owner picks which one is being
//     weighed (auto-selected when there's only one).
// Either way the server attributes the ticket to that unit's job and prices the
// overage on the unit's own size. Neither given (a job delivered before unit capture)
// → the by-lead path, unchanged.

const LBS_PER_TON = 2000;

// A stored (tons) weight shown back in the unit it was entered in.
function tonsToLbs(tons) {
  if (tons == null || !Number.isFinite(Number(tons))) return null;
  return Math.round(Number(tons) * LBS_PER_TON);
}
function fmtLbs(lbs) {
  return lbs == null ? null : `${lbs.toLocaleString('en-US')} lbs`;
}
function describeWeight(tons) {
  const lbs = tonsToLbs(tons);
  return lbs == null ? 'weight not entered' : `${fmtLbs(lbs)} (${Number(tons)} tons)`;
}

// One recorded ticket: what it weighed, whether it was a swap, what it billed — plus
// inline correction of the weight.
function TicketRow({ leadId, ticket: t, index, onDone }) {
  const [editing, setEditing] = useState(false);
  const [lbs, setLbs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const open = () => {
    setLbs(tonsToLbs(t.weightTons) ?? '');
    setErr(null);
    setEditing(true);
  };

  const save = async () => {
    if (lbs === '' || Number(lbs) < 0) { setErr('Enter the weight in pounds.'); return; }
    setBusy(true); setErr(null);
    try {
      await api.updateDumpTicketWeight(leadId, index, { weightLbs: Number(lbs) });
      setEditing(false);
      onDone?.();
    } catch (e) {
      // The server refuses a correction once the ticket's invoice is signed/paid and
      // says why — show that verbatim rather than a generic failure.
      setErr(e.message || 'Could not update the weight.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="text-xs text-muted">
      <div className="flex items-start gap-2">
        <Check size={12} className="text-success flex-shrink-0 mt-0.5" />
        <span className="flex-1">
          {describeWeight(t.weightTons)}
          {t.unitLabel ? ` · Unit ${t.unitLabel}` : ''}
          {t.editedAt ? ' · corrected' : ''}
          {t.swap ? ' · swap-out' : ''}
          {t.swapCharge != null ? ` · swap $${t.swapCharge}` : ''}
          {t.overageTons > 0 ? (t.overageAmount != null ? ` · overage $${t.overageAmount}` : ' · overage (rate needed)') : ''}
        </span>
        {!editing && (
          <button
            onClick={open}
            className="flex items-center gap-1 text-[11px] font-medium text-brand hover:underline flex-shrink-0"
          >
            <Pencil size={11} /> Edit
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-1.5 ml-5 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <input
              type="number" min="0" step="1" value={lbs}
              onChange={(e) => setLbs(e.target.value)}
              placeholder="lbs"
              className="w-28 px-2 py-1 text-xs rounded-lg border border-divider bg-surface text-content focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
            <span className="text-[11px] text-muted">lbs</span>
            <button
              onClick={save} disabled={busy}
              className="text-[11px] font-medium text-white bg-brand hover:opacity-90 disabled:opacity-50 px-2 py-1 rounded-lg"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setErr(null); }}
              className="text-[11px] font-medium text-muted bg-surface-2 px-2 py-1 rounded-lg"
            >
              Cancel
            </button>
          </div>
          {err && <p className="text-[11px] text-danger">{err}</p>}
        </div>
      )}
    </li>
  );
}

export default function DumpTicketAction({
  leadId, unitsOut, dumpTickets = [], overageNeedsRate, onDone, compact = false,
  assignmentId = null, unitLabel = null, units = [],
}) {
  const [open, setOpen] = useState(false);
  const [lbs, setLbs] = useState('');
  const [swap, setSwap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [chosenId, setChosenId] = useState(null);

  // Derived, not synced, so it self-corrects when the on-site list changes underneath
  // (the other half of a swap just came back). A caller-supplied assignmentId always
  // wins — that unit is already settled.
  const pickable = assignmentId ? [] : units;
  const chosen = pickable.find(u => u.assignmentId === chosenId)
    || (pickable.length === 1 ? pickable[0] : null);
  const effectiveAssignmentId = assignmentId || chosen?.assignmentId || null;
  const effectiveUnitLabel = unitLabel || chosen?.label || null;
  const needsUnitPick = pickable.length > 1 && !chosen;

  const submit = async () => {
    setBusy(true); setMsg(null);
    const entered = lbs === '' ? null : Number(lbs);
    try {
      const res = await api.recordDumpTicket(leadId, {
        weightLbs: entered,
        swap,
        assignmentId: effectiveAssignmentId,
      });
      const parts = [];
      // Echo back the pounds the owner actually typed, so a tons/lbs mix-up is obvious
      // immediately rather than three screens later on an invoice.
      if (entered != null) {
        parts.push(`Recorded ${fmtLbs(Math.round(entered))}${effectiveUnitLabel ? ` for Unit ${effectiveUnitLabel}` : ''}.`);
      }
      if (res.overage && res.overage.overTons > 0) {
        parts.push(res.overage.amount != null
          ? `Overage: ${res.overage.overTons}t ($${res.overage.amount})`
          : `Overage: ${res.overage.overTons}t — set overage pricing for this size on the Pricing page to bill it`);
      }
      if (res.overageInvoiceId) parts.push('Invoice emailed to the customer.');
      if (res.advancedTo === 'completed') parts.push('Job completed.');
      else if (res.advancedTo === 'awaiting_final_payment') parts.push('Awaiting final charges.');
      else parts.push(`${res.unitsOut} unit(s) still out.`);
      setMsg(parts.join(' '));
      setLbs(''); setSwap(false); setOpen(false); setChosenId(null);
      onDone?.();
    } catch (e) {
      // The server refuses a unit that's already been weighed (and says which) — show
      // that verbatim rather than a generic failure.
      setMsg(e.message || 'Failed to record — check server logs.');
      console.error('Dump ticket error:', e);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className={compact ? 'space-y-3' : 'p-4 space-y-3'}>
      {dumpTickets.length > 0 && (
        <ul className="space-y-1.5">
          {dumpTickets.map((t, i) => (
            <TicketRow key={i} leadId={leadId} ticket={t} index={i} onDone={onDone} />
          ))}
        </ul>
      )}
      {overageNeedsRate && (
        <p className="text-xs text-warning bg-warning/10 px-2 py-1.5 rounded-lg">
          Overage recorded but not priced — set this size's weight allowance and per-ton overage rate on the Pricing page to bill it.
        </p>
      )}
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-sm font-medium text-brand bg-brand/10 hover:bg-brand/10 px-3 py-2 rounded-lg transition-colors"
        >
          <Plus size={13} /> {compact ? 'Enter weight' : 'Add dump ticket / enter weight'}
        </button>
      ) : (
        <div className="space-y-2.5">
          {/* Which can this weight came off — it decides the overage allowance and,
              on a shared screen, which job gets billed. */}
          {pickable.length > 1 && (
            <div>
              <label className="text-xs font-medium text-muted uppercase tracking-wide mb-1 block">Which unit?</label>
              <div className="flex flex-wrap gap-1.5">
                {pickable.map(u => (
                  <button
                    key={u.assignmentId}
                    type="button"
                    onClick={() => setChosenId(u.assignmentId)}
                    className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                      chosen?.assignmentId === u.assignmentId
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-divider bg-surface text-content hover:bg-surface-2'
                    }`}
                  >
                    Unit {u.label}{u.size ? ` · ${u.size}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          {effectiveUnitLabel && pickable.length <= 1 && (
            <p className="text-[11px] text-muted">
              Weighing <span className="font-semibold text-content">Unit {effectiveUnitLabel}</span>
              {chosen?.size ? ` (${chosen.size})` : ''}
            </p>
          )}
          <div>
            <label className="text-xs font-medium text-muted uppercase tracking-wide mb-1 block">Weight (lbs)</label>
            <input
              type="number" min="0" step="1" value={lbs}
              onChange={(e) => setLbs(e.target.value)}
              placeholder="e.g. 7000"
              className="w-full px-3 py-2 text-sm rounded-lg border border-divider bg-surface text-content focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-content">
            <input type="checkbox" checked={swap} onChange={(e) => setSwap(e.target.checked)} className="rounded mt-0.5" />
            Swap-out — a replacement dumpster was dropped (a unit is still on site)
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={submit} disabled={busy || needsUnitPick}
              className="flex items-center gap-1.5 text-sm font-medium text-white bg-brand hover:opacity-90 disabled:opacity-50 px-3 py-2 rounded-lg transition-colors"
            >
              <Check size={13} /> {busy ? 'Saving…' : 'Record ticket'}
            </button>
            <button
              onClick={() => { setOpen(false); setMsg(null); }}
              className="flex items-center gap-1.5 text-sm font-medium text-muted bg-surface-2 hover:bg-surface-2 px-3 py-2 rounded-lg transition-colors"
            >
              <X size={13} /> Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <p className="text-xs text-content bg-surface-2 px-2 py-1.5 rounded-lg">{msg}</p>}
    </div>
  );

  // Compact (schedule pickup card): body only — the card around it is the caller's.
  if (compact) return body;

  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
        <Briefcase size={15} className="text-muted" />
        <h3 className="text-sm font-semibold text-content">Dump Ticket / Weight</h3>
        <span className="ml-auto text-[11px] font-medium text-muted">
          {unitsOut != null ? `${unitsOut} dumpster${unitsOut === 1 ? '' : 's'} out` : ''}
        </span>
      </div>
      {body}
    </div>
  );
}
