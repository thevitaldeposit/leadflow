import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, ExternalLink } from 'lucide-react';
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
export default function CustomerCallIntelligence({ jobId, compact = false }) {
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.getLead(jobId)
      .then(l => { if (active) setLead(l); })
      .catch(e => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [jobId]);

  if (loading) return <div className="px-5 py-4 text-sm text-muted">Loading call details…</div>;
  if (error || !lead) return <div className="px-5 py-4 text-sm text-muted">{error || 'Call details unavailable.'}</div>;

  const vd = parseVerticalData(lead);
  const t = getTerminology(lead.vertical, getSubVertical(lead));
  const intent = vd.intentLevel ? (INTENT_LABELS[vd.intentLevel] || vd.intentLevel) : null;

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
          stored values, never recomputed). The industry fields self-hide when the
          call didn't capture them (e.g. non-dumpster verticals). */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm p-4 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
        {vd.dumpsterSize && <ROField label="Dumpster Size" value={vd.dumpsterSize} />}
        {vd.rentalDuration && <ROField label="Rental Duration" value={vd.rentalDuration} />}
        {vd.debrisType && <ROField label="Debris Type" value={vd.debrisType} />}
        <ROField label={t.startDate} value={fmtDate(lead.delivery_date)} />
        <ROField label={t.endDate} value={fmtDate(lead.pickup_date)} />
        <ROField label={t.startTime} value={formatTime12(lead.scheduled_time)} />
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

      {/* Recording + transcript (shared with the lead detail) */}
      <AudioSection lead={lead} />

      <div className="flex justify-end">
        <Link to={`/leads/${lead.id}`} className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline">
          Open full call detail <ExternalLink size={11} />
        </Link>
      </div>
    </div>
  );
}
