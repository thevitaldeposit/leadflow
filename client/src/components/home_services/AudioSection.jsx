import { useState } from 'react';
import { Mic } from 'lucide-react';

// Call recording player + a small, unobtrusive raw-transcript toggle placed right
// by the playback controls. Display-only; reused by the lead detail page and the
// customer profile's per-call intelligence. Renders nothing when the lead has
// neither a recording nor a transcript.
export default function AudioSection({ lead }) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  if (!lead.audio_file_path && !lead.raw_transcript) return null;

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
    </div>
  );
}
