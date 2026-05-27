import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Upload, Loader2, AlertCircle, X, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../utils/api';

const STEPS = [
  { label: 'Uploading audio...' },
  { label: 'Transcribing call...' },
  { label: 'Extracting lead data...' },
  { label: 'Done!' },
];

const MAX_SIZE_MB = 25;
const ACCEPTED = '.mp3,.m4a,.wav,.ogg,.webm,.mp4';

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ProgressSteps({ step }) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
      <div className="space-y-3">
        {STEPS.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div key={i} className="flex items-center gap-3">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                done ? 'bg-green-500' : active ? 'bg-accent' : 'bg-gray-200'
              }`}>
                {done ? (
                  <Check size={12} className="text-white" />
                ) : active ? (
                  <Loader2 size={12} className="text-white animate-spin" />
                ) : (
                  <span className="text-xs text-gray-400 font-medium">{i + 1}</span>
                )}
              </div>
              <span className={`text-sm ${
                done ? 'text-green-700 line-through' : active ? 'text-blue-700 font-medium' : 'text-gray-400'
              }`}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
      {step === 1 && (
        <p className="text-xs text-blue-500 mt-4">
          Transcription typically takes 10–30 seconds depending on call length.
        </p>
      )}
    </div>
  );
}

export default function AudioUpload() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(-1);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const handleFile = (f) => {
    if (!f) return;
    if (f.size > MAX_SIZE_MB * 1024 * 1024) {
      setError(`File is too large. Maximum size is ${MAX_SIZE_MB}MB.`);
      return;
    }
    setFile(f);
    setError(null);
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, []);

  const onDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  const clear = () => {
    setFile(null);
    setError(null);
    setStep(-1);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleExtract = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setStep(0); // Uploading

    // After a short delay, advance to "Transcribing" — the file is uploaded fast
    // but transcription takes much longer, so we show it early
    const transcribeTimer = setTimeout(() => setStep(1), 1200);

    try {
      const lead = await api.extractAudio(file);
      clearTimeout(transcribeTimer);
      setStep(2); // Extracting
      await new Promise(r => setTimeout(r, 500));
      setStep(3); // Done
      await new Promise(r => setTimeout(r, 400));
      navigate(`/leads/${lead.id}`, { state: { fresh: true } });
    } catch (e) {
      clearTimeout(transcribeTimer);
      setError(e.message || 'Audio extraction failed. Please try again.');
      setStep(-1);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Mic size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-gray-800">Upload Call Recording</h2>
        </div>

        {!file ? (
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => !loading && inputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
              dragging
                ? 'border-accent bg-blue-50'
                : 'border-gray-200 hover:border-accent hover:bg-blue-50/50'
            }`}
          >
            <Upload size={32} className={`mx-auto mb-3 ${dragging ? 'text-accent' : 'text-gray-300'}`} />
            <p className="text-sm font-medium text-gray-600">
              Drop your call recording here, or <span className="text-accent">browse</span>
            </p>
            <p className="text-xs text-gray-400 mt-1">
              MP3, M4A, WAV, OGG, WebM, MP4 · Max {MAX_SIZE_MB}MB
            </p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              onChange={e => handleFile(e.target.files[0])}
              className="hidden"
            />
          </div>
        ) : (
          <div className="flex items-center gap-3 bg-gray-50 rounded-xl px-4 py-3 border border-gray-200">
            <Mic size={18} className="text-accent flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
              <p className="text-xs text-gray-400">{formatSize(file.size)}</p>
            </div>
            {!loading && (
              <button
                onClick={clear}
                className="flex-shrink-0 p-1 rounded hover:bg-gray-200 transition-colors"
              >
                <X size={14} className="text-gray-500" />
              </button>
            )}
          </div>
        )}

        {file && !loading && (
          <div className="flex items-center justify-end gap-3 mt-4">
            <button
              onClick={clear}
              className="text-sm text-gray-400 hover:text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
            >
              Remove
            </button>
            <button
              onClick={handleExtract}
              className="flex items-center gap-2 bg-accent text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors"
            >
              <Mic size={15} />
              Extract Lead
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {loading && step >= 0 && <ProgressSteps step={step} />}
    </div>
  );
}
