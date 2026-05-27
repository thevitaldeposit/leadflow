import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Image, Upload, Loader2, AlertCircle, X } from 'lucide-react';
import { api } from '../utils/api';

export default function UpsheetUpload() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const handleFile = (f) => {
    if (!f) return;
    setFile(f);
    setError(null);
    const url = URL.createObjectURL(f);
    setPreview(url);
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
    setPreview(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleExtract = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const lead = await api.extractUpsheet(file);
      navigate(`/leads/${lead.id}`, { state: { fresh: true } });
    } catch (e) {
      setError(e.message || 'Image extraction failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Image size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-gray-800">Upload Up Sheet Photo</h2>
        </div>

        {!file ? (
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
              dragging
                ? 'border-accent bg-blue-50'
                : 'border-gray-200 hover:border-accent hover:bg-blue-50/50'
            }`}
          >
            <Upload size={32} className={`mx-auto mb-3 ${dragging ? 'text-accent' : 'text-gray-300'}`} />
            <p className="text-sm font-medium text-gray-600">
              Drop your up sheet photo here, or <span className="text-accent">browse</span>
            </p>
            <p className="text-xs text-gray-400 mt-1">Supports JPG, PNG, HEIC (phone photos)</p>
            <input
              ref={inputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.heif"
              onChange={e => handleFile(e.target.files[0])}
              className="hidden"
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="relative inline-block">
              <img
                src={preview}
                alt="Up sheet preview"
                className="max-h-80 rounded-xl border border-gray-200 shadow-sm"
              />
              <button
                onClick={clear}
                className="absolute top-2 right-2 bg-white rounded-full p-1 shadow-md hover:bg-red-50 transition-colors"
              >
                <X size={14} className="text-gray-600" />
              </button>
            </div>
            <p className="text-xs text-gray-500">{file.name} ({(file.size / 1024).toFixed(0)} KB)</p>
          </div>
        )}

        {file && (
          <div className="flex items-center justify-end gap-3 mt-4">
            <button
              onClick={clear}
              className="text-sm text-gray-400 hover:text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
            >
              Remove
            </button>
            <button
              onClick={handleExtract}
              disabled={loading}
              className="flex items-center gap-2 bg-accent text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Reading up sheet...
                </>
              ) : (
                <>
                  <Image size={15} />
                  Extract Lead
                </>
              )}
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

      {loading && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
          <Loader2 size={28} className="animate-spin text-accent mx-auto mb-3" />
          <p className="text-sm font-medium text-blue-700">AI is reading your up sheet...</p>
          <p className="text-xs text-blue-500 mt-1">Interpreting handwriting, extracting fields, scoring confidence</p>
        </div>
      )}
    </div>
  );
}
