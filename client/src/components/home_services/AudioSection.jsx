import { useState } from 'react';
import { Mic, ChevronDown, ChevronUp } from 'lucide-react';

// Call recording player + collapsible raw transcript. Display-only; reused by
// the lead detail page and the customer profile's per-call intelligence. Renders
// nothing when the lead has neither a recording nor a transcript.
export default function AudioSection({ lead }) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  if (!lead.audio_file_path && !lead.raw_transcript) return null;

  return (
    <div className="space-y-3">
      {/* Audio player */}
      {lead.audio_file_path && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <div className="flex items-center gap-2 mb-3">
            <Mic size={15} className="text-accent" />
            <span className="text-sm font-semibold text-gray-700">Call Recording</span>
            {lead.transcription_provider && (
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                Transcribed via {lead.transcription_provider}
              </span>
            )}
          </div>
          {lead.recording_deleted_at ? (
            <p className="text-xs text-gray-400 italic">Recording deleted after 30 days</p>
          ) : (
            <audio
              controls
              className="w-full h-10"
              src={lead.audio_file_path}
            >
              Your browser does not support audio playback.
            </audio>
          )}
        </div>
      )}

      {/* Collapsible transcript */}
      {lead.raw_transcript && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <button
            onClick={() => setTranscriptOpen(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <span>Raw Transcript</span>
            {transcriptOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          {transcriptOpen && (
            <div className="px-4 pb-4 border-t border-gray-100">
              <pre className="text-xs text-gray-600 font-mono leading-relaxed whitespace-pre-wrap mt-3">
                {lead.raw_transcript}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
