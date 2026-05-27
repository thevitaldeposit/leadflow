import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Zap } from 'lucide-react';

function playChime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
  } catch {
    // Ignore audio errors (user hasn't interacted with page yet, etc.)
  }
}

function Toast({ toast, onDismiss }) {
  const navigate = useNavigate();
  const timerRef = useRef(null);

  useEffect(() => {
    playChime();
    timerRef.current = setTimeout(() => onDismiss(toast.id), 5000);
    return () => clearTimeout(timerRef.current);
  }, [toast.id]);

  const handleClick = () => {
    onDismiss(toast.id);
    if (toast.leadId) navigate(`/leads/${toast.leadId}`);
  };

  return (
    <div
      onClick={handleClick}
      className="flex items-start gap-3 bg-white border border-gray-200 rounded-xl shadow-lg p-4 cursor-pointer hover:shadow-xl transition-shadow max-w-sm w-full animate-slide-in"
    >
      <div className="flex-shrink-0 w-8 h-8 bg-accent rounded-lg flex items-center justify-center">
        <Zap size={15} className="text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{toast.title}</p>
        {toast.sub && <p className="text-xs text-gray-500 mt-0.5 truncate">{toast.sub}</p>}
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDismiss(toast.id); }}
        className="flex-shrink-0 text-gray-300 hover:text-gray-500 transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(t => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
