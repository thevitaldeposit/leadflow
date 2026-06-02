import { AlertTriangle } from 'lucide-react';

export default function CriticalBadge({ size = 'sm' }) {
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center gap-1 font-medium rounded-full border bg-red-100 text-red-700 border-red-200 ${padding}`}>
      <AlertTriangle className="w-3 h-3" />
      Critical
    </span>
  );
}
