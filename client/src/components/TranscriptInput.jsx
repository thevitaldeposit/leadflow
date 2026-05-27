import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Loader2, AlertCircle, FlaskConical } from 'lucide-react';
import { api } from '../utils/api';

const SAMPLE_TRANSCRIPT = `[Receptionist]: Thank you for calling Riverside Motors, how can I direct your call?

[Customer]: Yeah hi, I'm calling about a truck I saw on your website. A Silverado, I think it was black.

[Receptionist]: Sure, let me transfer you to our sales team. Can I get your name?

[Customer]: It's Mike. Mike Patterson.

[Receptionist]: One moment please, Mike.

[pause — transfer]

[Salesperson]: Hey this is Derek in sales, how can I help you?

[Customer]: Hey Derek, yeah I was looking online and you guys have a black Silverado listed, I think it was like a 2024? The RST trim?

[Salesperson]: Yeah! I think I know the one you're talking about. Let me pull it up. Yeah, 2024 Silverado RST, black, we've got it right here. Stock number 7842. That's a sharp truck. Are you looking to come take a look at it?

[Customer]: Yeah definitely. I've been shopping around for about two weeks now. I've got a 2019 F-150 I'd be trading in. It's got about 62 thousand miles on it. It's in pretty good shape, just a small dent on the rear bumper.

[Salesperson]: Okay nice, we can definitely take a look at your trade. Do you know if you owe anything on it still?

[Customer]: Yeah I think I still owe about twelve grand on it.

[Salesperson]: Got it. And are you looking to finance the Silverado or...?

[Customer]: Yeah I'd need to finance. I'm trying to stay somewhere around 600 a month if possible. I could probably put about 3 grand down.

[Salesperson]: Okay that gives me a good picture. We can definitely work with that. When were you thinking about coming in?

[Customer]: Well I need to bring my wife to see it too. Could we do Saturday around 2?

[Salesperson]: Saturday at 2 works perfect. Let me get your number so I can confirm with you Friday.

[Customer]: Sure it's 555-312-8847.

[Salesperson]: Got it. And just in case we get disconnected, do you have an email?

[Customer]: Yeah it's mike.patterson@gmail.com

[Salesperson]: Perfect Mike, we'll see you Saturday at 2. I'll have the Silverado pulled up front for you.

[Customer]: Sounds good, thanks Derek.

[Salesperson]: Thank you, have a good one.`;

export default function TranscriptInput() {
  const [transcript, setTranscript] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const handleExtract = async () => {
    if (!transcript.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const lead = await api.extractTranscript(transcript);
      navigate(`/leads/${lead.id}`, { state: { fresh: true } });
    } catch (e) {
      setError(e.message || 'Extraction failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-accent" />
            <h2 className="text-base font-semibold text-gray-800">Paste Call Transcript</h2>
          </div>
          <button
            onClick={() => setTranscript(SAMPLE_TRANSCRIPT)}
            className="flex items-center gap-1.5 text-xs text-accent hover:text-blue-700 font-medium border border-accent/30 px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors"
          >
            <FlaskConical size={13} />
            Load Sample
          </button>
        </div>

        <textarea
          value={transcript}
          onChange={e => setTranscript(e.target.value)}
          placeholder="Paste your call transcript here...&#10;&#10;The AI will extract: customer name, phone, email, vehicle of interest, trade-in details, budget, appointment, and more."
          className="w-full h-72 text-sm text-gray-700 border border-gray-200 rounded-lg p-3 resize-none focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-gray-300 font-mono leading-relaxed"
          disabled={loading}
        />

        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-gray-400">
            {transcript.length > 0 ? `${transcript.split(/\s+/).filter(Boolean).length} words` : 'No transcript pasted'}
          </p>
          <div className="flex gap-3">
            {transcript && (
              <button
                onClick={() => setTranscript('')}
                className="text-sm text-gray-400 hover:text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                Clear
              </button>
            )}
            <button
              onClick={handleExtract}
              disabled={!transcript.trim() || loading}
              className="flex items-center gap-2 bg-accent text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Analyzing transcript...
                </>
              ) : (
                'Extract Lead'
              )}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {loading && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
          <Loader2 size={28} className="animate-spin text-accent mx-auto mb-3" />
          <p className="text-sm font-medium text-blue-700">AI is analyzing your transcript...</p>
          <p className="text-xs text-blue-500 mt-1">Extracting customer info, vehicle details, deal structure, and more</p>
        </div>
      )}
    </div>
  );
}
