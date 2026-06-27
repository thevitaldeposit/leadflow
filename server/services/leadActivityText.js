// Human-readable text for lead activity-feed events. Pure string builders with
// no DB or pipeline dependencies, so both the live PUT /leads route and the
// idempotent migration backfill can share one source of truth for the wording.

// One clean activity line for a job that just got booked, e.g.
// "Dumpster booked — 20 yard · delivery Fri, Jun 26". Reads the stored size and
// delivery date off the (already-updated) lead — it never recomputes booking.
function describeBooking(lead) {
  let vd = {};
  try { vd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { vd = {}; }
  const noun = (lead.sub_vertical === 'dumpster_rental' || vd.dumpsterSize) ? 'Dumpster' : 'Job';
  const parts = [];
  if (vd.dumpsterSize) parts.push(String(vd.dumpsterSize));
  const dd = lead.delivery_date ? String(lead.delivery_date).slice(0, 10) : null;
  if (dd && /^\d{4}-\d{2}-\d{2}$/.test(dd)) {
    const d = new Date(`${dd}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      parts.push(`delivery ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`);
    }
  }
  return parts.length ? `${noun} booked — ${parts.join(' · ')}` : `${noun} booked`;
}

module.exports = { describeBooking };
