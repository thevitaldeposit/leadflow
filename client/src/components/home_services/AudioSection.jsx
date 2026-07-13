import { useState } from 'react';
import { Mic, ChevronDown, ChevronRight } from 'lucide-react';

// Call recording player + a small, unobtrusive raw-transcript toggle placed right
// by the playback controls. Display-only; reused by the lead detail page and the
// customer profile's per-call intelligence. Renders nothing when the lead has
// neither a recording nor a transcript.
//
// `collapsible` (customer profile) renders a compact, collapsed-by-default player:
// just a small header row until the owner expands it to play. Recordings aren't
// used often, so this keeps them from dominating the layout. The lead detail page
// leaves it off and shows the full player inline.
export default function AudioSection({ lead, collapsible = false }) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [expanded, setExpanded] = useState(!collapsible);

  if (!lead.audio_file_path && !lead.raw_transcript) return null;

  // Player + transcript link — shared by both the full and collapsible layouts.
  const body = (
    <>
      {/* Audio player */}
      {lead.audio_file_path && (
        lead.recording_deleted_at ? (
          <p className="text-xs text-muted italic">Recording deleted after 30 days</p>
        ) : (
          <audio
            controls
            className="w-full h-10"
            src={lead.audio_file_path}
          >
            Your browser does not support audio playback.
          </audio>
        )
      )}

      {/* Small raw-transcript link near the playback controls (demoted from the
          old big collapsible dropdown). Clicking reveals the transcript inline. */}
      {lead.raw_transcript && (
        <div className={lead.audio_file_path ? 'mt-2' : ''}>
          <button
            onClick={() => setTranscriptOpen(v => !v)}
            className="text-xs text-muted hover:text-content hover:underline transition-colors"
          >
            {transcriptOpen ? 'Hide transcript' : 'Raw transcript'}
          </button>
          {transcriptOpen && (
            <pre className="text-xs text-muted font-mono leading-relaxed whitespace-pre-wrap mt-2 pt-2 border-t border-divider">
              {lead.raw_transcript}
            </pre>
          )}
        </div>
      )}
    </>
  );

  // Compact, collapsed-by-default variant for the customer profile: a small toggle
  // header that expands to reveal the player. Same card styling, less footprint.
  if (collapsible) {
    return (
      <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 transition-colors"
        >
          {expanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
          <Mic size={14} className="text-accent" />
          <span className="text-sm font-semibold text-content">Call Recording</span>
          {lead.transcription_provider && (
            <span className="ml-auto text-xs text-muted bg-surface-2 px-2 py-0.5 rounded-full">
              Transcribed via {lead.transcription_provider}
            </span>
          )}
        </button>
        {expanded && <div className="px-4 pb-4 pt-1">{body}</div>}
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <Mic size={15} className="text-accent" />
        <span className="text-sm font-semibold text-content">Call Recording</span>
        {lead.transcription_provider && (
          <span className="ml-auto text-xs text-muted bg-surface-2 px-2 py-0.5 rounded-full">
            Transcribed via {lead.transcription_provider}
          </span>
        )}
      </div>
      {body}
    </div>
  );
}
