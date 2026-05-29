import { useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Trash2, CheckCircle, Mic, ChevronDown, ChevronUp } from 'lucide-react';
import LeadCardExpanded from '../components/LeadCardExpanded';
import HomeServicesLeadDetail from '../components/home_services/HomeServicesLeadDetail';
import { api } from '../utils/api';

function AudioSection({ lead }) {
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
          <audio
            controls
            className="w-full h-10"
            src={lead.audio_file_path}
          >
            Your browser does not support audio playback.
          </audio>
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
              <pre className="text-xs text-gray-600 font-mono leading-relaxed whitespace-pre-wrap mt-3 max-h-72 overflow-y-auto">
                {lead.raw_transcript}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function extractionLabel(type) {
  switch (type) {
    case 'transcript': return 'From transcript';
    case 'upsheet_image': return 'From up sheet';
    case 'audio_upload': return 'From audio recording';
    case 'phone_auto': return 'Auto-captured (phone)';
    default: return type || 'Unknown source';
  }
}

export default function LeadDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isFresh = location.state?.fresh;

  useEffect(() => {
    api.getLead(id)
      .then(setLead)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!confirm('Permanently delete this lead?')) return;
    await api.deleteLead(id);
    navigate('/leads');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !lead) {
    return (
      <div className="text-center py-12 text-gray-500 text-sm">
        {error || 'Lead not found.'}
        <button onClick={() => navigate('/leads')} className="block mx-auto mt-3 text-accent hover:underline">
          Back to leads
        </button>
      </div>
    );
  }

  const fullName = [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'Unknown Customer';
  const isAudio = lead.extraction_type === 'audio_upload' || lead.extraction_type === 'phone_auto' || lead.extraction_type === 'ios_callkit';
  const isHomeServices = lead.vertical === 'home_services';

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ArrowLeft size={15} />
          Back
        </button>
        <div className="flex items-center gap-2">
          {isFresh && (
            <div className="flex items-center gap-1.5 text-sm text-green-600 bg-green-50 border border-green-200 px-3 py-1.5 rounded-lg">
              <CheckCircle size={14} />
              Lead extracted and saved
            </div>
          )}
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-600 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors"
          >
            <Trash2 size={14} />
            Delete Lead
          </button>
        </div>
      </div>

      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-gray-900">{fullName}</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          {extractionLabel(lead.extraction_type)} · {new Date(lead.created_at).toLocaleString()}
        </p>
      </div>

      {/* Audio player + transcript for audio leads */}
      {isAudio && <AudioSection lead={lead} />}

      {isHomeServices
        ? <HomeServicesLeadDetail lead={lead} onUpdate={setLead} />
        : <LeadCardExpanded lead={lead} onUpdate={setLead} />}
    </div>
  );
}
