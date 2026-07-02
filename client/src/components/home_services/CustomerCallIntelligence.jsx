import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../utils/api';
import BookingSignalsPanel from './BookingSignalsPanel';
import AudioSection from './AudioSection';
import {
  parseVerticalData,
  getSubVertical,
  getTerminology,
  formatTime12,
  INTENT_LABELS,
} from '../../utils/verticalConfig';

// Local, read-only date formatters (mirror CustomerDetailPage's helpers).
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return null;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(' ', 'T')}Z` : iso;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ROField({ label, value }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      <span className="text-sm text-content">{value || <span className="text-muted italic">—</span>}</span>
    </div>
  );
}

// Read-only per-call intelligence, surfaced inside the Customer Profile's Job
// History (one instance per call/lead). It lazy-loads the full lead — the
// customer payload intentionally omits the heavy recording + transcript — and
// renders the SAME blocks the lead detail shows: booking signals, the resolved
// delivery/pickup dates + scheduled time / intent / urgency / follow-up, the AI
// summary, and the recording + transcript. Strictly read-only.
//
// AUTO-BOOK SAFETY: this only GETs the lead (api.getLead). It never writes and
// never re-runs extraction or booking, so mounting it cannot trigger or change
// auto-booking. Editing still happens on the full lead detail via the link below.
export default function CustomerCallIntelligence({ jobId, compact = false, refreshKey = 0, schedule = null }) {
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // refreshKey bumps after an in-place edit (e.g. Edit Job Details) so this
  // self-fetched grid re-pulls the lead and reflects the new values immediately.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.getLead(jobId)
      .then(l => { if (active) setLead(l); })
      .catch(e => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [jobId, refreshKey]);

  if (loading) return <div className="px-5 py-4 text-sm text-muted">Loading call details…</div>;
  if (error || !lead) return <div className="px-5 py-4 text-sm text-muted">{error || 'Call details unavailable.'}</div>;

  const vd = parseVerticalData(lead);
  const subVertical = getSubVertical(lead);
  const t = getTerminology(lead.vertical, subVertical);
  const intent = vd.intentLevel ? (INTENT_LABELS[vd.intentLevel] || vd.intentLevel) : null;
  // Dumpster jobs always show the size / duration / debris fields (as a dash when
  // blank), so a manually-created inquiry with no details still surfaces them on the
  // profile for the owner to fill in via Edit Job Details. Other verticals keep
  // self-hiding fields they didn't capture.
  const isDumpster = subVertical === 'dumpster_rental';

  // Schedule grid only: prefer the engagement's already-resolved (booked-sourced)
  // override when present, falling back to THIS call's stored lead values. For a
  // booked job the override carries the booked lead's dates/size, so a later empty
  // follow-up call (the representative we fetch) no longer blanks the card. The AI
  // summary, recording, and transcript below stay bound to this specific call.
  const schedSize = schedule?.dumpster_size ?? vd.dumpsterSize;
  const schedDuration = schedule?.rental_duration ?? vd.rentalDuration;
  const schedDebris = schedule?.debris_type ?? vd.debrisType;
  const schedDelivery = schedule?.delivery_date ?? lead.delivery_date;
  const schedPickup = schedule?.pickup_date ?? lead.pickup_date;
  const schedTime = schedule?.scheduled_time ?? lead.scheduled_time;

  // Compact mode (earlier calls in an engagement): show ONLY the AI summary, the
  // recording player, and the small Raw transcript link. The structured fields,
  // booking signals, and key dates already live in the authoritative Active
  // Inquiry section up top, so we don't repeat them per earlier call.
  if (compact) {
    return (
      <div className="px-5 py-4 space-y-4 bg-surface-2/60">
        {lead.call_summary && (
          <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
              <Sparkles size={15} className="text-muted" />
              <h3 className="text-sm font-semibold text-content">AI Summary</h3>
            </div>
            <div className="p-4">
              <p className="text-sm text-content leading-relaxed bg-brand/10 px-3 py-2 rounded-lg">{lead.call_summary}</p>
            </div>
          </div>
        )}
        <AudioSection lead={lead} />
      </div>
    );
  }

  return (
    <div className="px-5 py-4 space-y-4 bg-surface-2/60">
      <BookingSignalsPanel
        autoBooked={lead.auto_booked === 1}
        bookingSignals={vd.bookingSignalsDetected || []}
        bookingConfidence={vd.bookingConfidence || null}
      />

      {/* Industry fields + key dates + intent / urgency / follow-up (read-only;
          stored values, never recomputed). For dumpster jobs these always render
          (dash when blank) so a details-less manual inquiry still shows them; other
          verticals self-hide fields the call didn't capture. */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm p-4 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
        {(isDumpster || schedSize) && <ROField label="Dumpster Size" value={schedSize} />}
        {(isDumpster || schedDuration) && <ROField label="Rental Duration" value={schedDuration} />}
        {(isDumpster || schedDebris) && <ROField label="Debris Type" value={schedDebris} />}
        <ROField label={t.startDate} value={fmtDate(schedDelivery)} />
        <ROField label={t.endDate} value={fmtDate(schedPickup)} />
        <ROField label={t.startTime} value={formatTime12(schedTime)} />
        <ROField label="Intent" value={intent} />
        <ROField label="Urgency" value={vd.urgency} />
        <ROField label="Follow-Up" value={fmtDateTime(vd.followUpDate)} />
      </div>

      {/* AI Summary */}
      {lead.call_summary && (
        <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-divider flex items-center gap-2 bg-surface-2">
            <Sparkles size={15} className="text-muted" />
            <h3 className="text-sm font-semibold text-content">AI Summary</h3>
          </div>
          <div className="p-4">
            <p className="text-sm text-content leading-relaxed bg-brand/10 px-3 py-2 rounded-lg">{lead.call_summary}</p>
          </div>
        </div>
      )}

      {/* Recording + transcript (shared with the lead detail). This profile view
          already inlines the booking signals, resolved dates, AI summary, and the
          recording + transcript for the call, so the old "Open full call detail →"
          link to the retired /leads/:id page was redundant and has been removed.
          Editing the job is still available via the engagement's Edit action. */}
      <AudioSection lead={lead} />
    </div>
  );
}
