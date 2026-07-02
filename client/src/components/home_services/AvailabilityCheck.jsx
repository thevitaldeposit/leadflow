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
// when none are free it also fetches + shows the NEXT available date. Advisory only:
// callers never hard-block on it (owners may intentionally overbook), so an unavailable
// window renders a warning, not a gate. Pure display + reads — no writes, no auto-book.
export default function AvailabilityCheck({ size, deliveryDate, rentalDays, excludeLeadId = null }) {
  const daysNum = Number(rentalDays);
  const pickupISO = (deliveryDate && daysNum >= 1) ? calcPickupFromDuration(deliveryDate, String(daysNum)) : null;
  const ready = !!(size && deliveryDate && pickupISO);

  const [loading, setLoading] = useState(false);
  const [availability, setAvailability] = useState(null);
  const [nextDate, setNextDate] = useState(null);
  const [checkedNext, setCheckedNext] = useState(false);

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

  // Unavailable (no pool row, or 0 free) → warn + show the next open date. The owner
  // can still book on top of this (intentional overbook) — this never disables the action.
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
      <p className="text-xs text-warning">You can still book this as an intentional overbook — inventory may run short.</p>
    </div>
  );
}
