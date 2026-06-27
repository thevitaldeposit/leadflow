// Booking date math + the Confirm Booking update builder. Shared by the lead
// detail header (HomeServicesStickyHeader) and the customer profile's manual
// "Mark Booked" so a booking persists identically from either surface. Pure
// functions only — no extraction, booking-signal, or auto-book logic lives here.

export function parseRentalDays(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (s.includes('week')) return Math.round(num * 7);
  if (s.includes('month')) return Math.round(num * 30);
  return Math.round(num);
}

export function calcPickupFromDuration(deliveryISO, rentalDuration) {
  if (!deliveryISO || !rentalDuration) return null;
  const days = parseRentalDays(rentalDuration);
  if (!days) return null;
  const d = new Date(deliveryISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Build the lead updates that book a job from the Confirm Booking modal's
// { date, rentalDays, size } payload. Single source of truth: same pickup-date
// math, same job_status/status='booked', same camelCase + legacy vertical_data
// keys (the server merges this patch, never wiping other fields).
export function buildBookingUpdates({ date, rentalDays, size }) {
  const updates = { job_status: 'booked', status: 'booked' };
  const vd = {};
  // Persist the (possibly changed) dumpster size selected in the modal.
  if (size) vd.dumpsterSize = size;
  if (date) {
    updates.delivery_date = date;
    // Write the keys the Industry Details field pack reads from (camelCase)
    // alongside the legacy deliveryDateISO for back-compat with older readers.
    vd.deliveryDate = date;
    vd.deliveryDateISO = date;
    if (rentalDays >= 1) {
      const pickup = calcPickupFromDuration(date, String(rentalDays));
      if (pickup) {
        updates.pickup_date = pickup;
        vd.pickupDate = pickup;
      }
      vd.rentalDuration = `${rentalDays} days`;
    }
  }
  if (Object.keys(vd).length) updates.vertical_data = vd;
  return updates;
}
