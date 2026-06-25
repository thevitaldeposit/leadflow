import { useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Trash2, CheckCircle } from 'lucide-react';
import LeadCardExpanded from '../components/LeadCardExpanded';
import HomeServicesLeadDetail from '../components/home_services/HomeServicesLeadDetail';
import HomeServicesStickyHeader from '../components/home_services/HomeServicesStickyHeader';
import AudioSection from '../components/home_services/AudioSection';
import { api } from '../utils/api';

function extractionLabel(type) {
  switch (type) {
    case 'transcript': return 'From transcript';
    case 'upsheet_image': return 'From up sheet';
    case 'audio_upload': return 'From audio recording';
    case 'phone_auto': return 'Auto-captured (phone)';
    case 'manual': return 'Manually added';
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

  // Home Services hoists the sticky customer header out of the max-w-3xl
  // wrapper so it sits as a direct child of <main> (the scroll container).
  // Inside the wrapper, sticky positioning depended on the wrapper being
  // the sticky's containing block — but the wrapper is `mx-auto`-centered
  // with no explicit height, and on some viewports the sticky un-stuck
  // before reaching the bottom of the content. Promoting the header to a
  // direct child of the scroll container makes the scroll container itself
  // the sticky's containing block, so it stays pinned at top:0 through
  // every card, audio player, and transcript below it. Auto Dealer keeps
  // its original chrome.
  if (isHomeServices) {
    return (
      <>
        <HomeServicesStickyHeader lead={lead} onUpdate={setLead} />

        <div className="max-w-3xl mx-auto">
          {/* Secondary top bar — back / delete. Lives below the sticky so it
              scrolls away with the rest of the page (the sticky carries the
              primary actions). */}
          <div className="flex items-center justify-between mb-4">
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

          <HomeServicesLeadDetail lead={lead} onUpdate={setLead} />

          <p className="text-xs text-gray-400 px-1 mt-4">
            {extractionLabel(lead.extraction_type)} · {new Date(lead.created_at).toLocaleString()}
          </p>
          {isAudio && <div className="mt-3"><AudioSection lead={lead} /></div>}
        </div>
      </>
    );
  }

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

      <div>
        <h2 className="text-xl font-bold text-gray-900">{fullName}</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          {extractionLabel(lead.extraction_type)} · {new Date(lead.created_at).toLocaleString()}
        </p>
      </div>

      {isAudio && <AudioSection lead={lead} />}
      <LeadCardExpanded lead={lead} onUpdate={setLead} />
    </div>
  );
}
