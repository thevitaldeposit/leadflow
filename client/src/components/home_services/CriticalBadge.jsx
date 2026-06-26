import { AlertTriangle } from 'lucide-react';

export default function CriticalBadge({ size = 'sm' }) {
  const padding = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  const icon = size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3';
  return (
    <span className={`inline-flex items-center gap-1 font-medium rounded-full border bg-danger/10 text-danger border-danger/30 ${padding}`}>
      <AlertTriangle className={icon} />
      Critical
    </span>
  );
}
