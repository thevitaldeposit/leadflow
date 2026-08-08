import { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { calcPickupFromDuration } from '../../utils/booking';

// Match a job's free-text size ("10 yard dumpster") to a pool size by leading number.
function sizeMatches(a, b) {
  const na = String(a || '').match(/\d+/);
  const nb = String(b || '').match(/\d+/);
  return na && nb && na[0] === nb[0];
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Shared availability check for the MANUAL booking surfaces (the Create Job form and
// the customer-profile Create Job modal). Mirrors the Confirm Booking modal's count
// ("N of M available for this date") using the SAME pool-availability endpoint, and
// when none are free it also fetches + shows the NEXT available date.
//
// This is a HARD GATE, not advice: a full window blocks the booking actions (there is
// no dumpster to promise, so there is no "book it anyway"). `onBlockedChange` reports
// that state up to the parent, which disables its book / send-link / mark-paid
// buttons; the server refuses the same booking independently, so this is the visible
// half of one rule, never the only enforcement. Pure display + reads — no writes.
export default function AvailabilityCheck({ size, deliveryDate, rentalDays, excludeLeadId = null, onBlockedChange = null }) {
  const daysNum = Number(rentalDays);
  const pickupISO = (deliveryDate && daysNum >= 1) ? calcPickupFromDuration(deliveryDate, String(daysNum)) : null;
  const ready = !!(size && deliveryDate && pickupISO);

  const [loading, setLoading] = useState(false);
  const [availability, setAvailability] = useState(null);
  const [nextDate, setNextDate] = useState(null);
  const [checkedNext, setCheckedNext] = useState(false);
  // No inventory configured at all → there's nothing to enforce capacity against, so
  // booking stays open (the server makes the same carve-out). Only a business that
  // HAS a fleet can be blocked by it.
  const [noFleet, setNoFleet] = useState(false);

  useEffect(() => {
    if (!ready) { setAvailability(null); setNextDate(null); setCheckedNext(false); return; }
    let cancelled = false;
    setLoading(true);
    setNextDate(null);
    setCheckedNext(false);

    const params = { delivery_date: deliveryDate, pickup_date: pickupISO };
    if (excludeLeadId != null) params.exclude_lead_id = excludeLeadId;

    api.getInventory(params)
      .then(async (rows) => {
        if (cancelled) return;
        const match = (rows || []).find((r) => sizeMatches(r.size, size)) || null;
        setAvailability(match);
        setNoFleet((rows || []).length === 0);
        setLoading(false);
        // Only look up the next opening when the requested window is full.
        if (!match || match.available <= 0) {
          try {
            const nextParams = { size, delivery_date: deliveryDate, rental_duration: daysNum };
            if (excludeLeadId != null) nextParams.exclude_lead_id = excludeLeadId;
            const res = await api.getNextAvailability(nextParams);
            if (!cancelled) { setNextDate(res?.nextAvailableDate || null); setCheckedNext(true); }
          } catch {
            if (!cancelled) setCheckedNext(true);
          }
        }
      })
      .catch(() => { if (!cancelled) { setAvailability(null); setLoading(false); } });

    return () => { cancelled = true; };
  }, [size, deliveryDate, pickupISO, daysNum, excludeLeadId, ready]);

  // Blocked = we checked and nothing of this size is free for the window. An
  // unchecked/in-flight window is NOT blocked here — the server still refuses it, so a
  // half-filled form disables nothing prematurely.
  const blocked = ready && !loading && !noFleet && !(availability && availability.available > 0);
  useEffect(() => {
    if (onBlockedChange) onBlockedChange(blocked);
  }, [blocked, onBlockedChange]);

  if (!ready) {
    return <p className="text-xs text-muted">Set a size, delivery date, and duration to check availability.</p>;
  }
  if (loading) return <p className="text-xs text-muted">Checking availability…</p>;

  const label = size || 'this size';
  if (availability && availability.available > 0) {
    return (
      <p className="text-sm font-semibold text-success">
        {availability.available} of {availability.quantity} available for this date
      </p>
    );
  }

  // Unavailable (no pool row, or 0 free) → state it plainly and show the next open
  // date. The parent has disabled the booking actions off this same state: there is no
  // unit to promise, so there is no overbook-anyway path.
  return (
    <div className="text-sm space-y-1">
      <p className="font-semibold text-danger">
        {availability ? `No ${label} available for these dates` : `No ${label} in inventory for these dates`}
      </p>
      {checkedNext && (
        <p className="text-xs text-muted">
          {nextDate
            ? <>Next available: <span className="font-medium text-content">{fmtDate(nextDate)}</span></>
            : 'No opening for this size in the next 60 days.'}
        </p>
      )}
      <p className="text-xs text-warning">
        {noFleet
          ? 'No inventory is set up yet — add your fleet in Inventory so availability can be tracked.'
          : 'Booking is unavailable for these dates. Change the date or the size to book.'}
      </p>
    </div>
  );
}
