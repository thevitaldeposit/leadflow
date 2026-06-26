import { AlertTriangle } from 'lucide-react';

export default function CriticalBadge({ size = 'sm', boxy = false }) {
  const padding = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  const icon = size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3';
  const radius = boxy ? 'rounded-md' : 'rounded-full';
  return (
    <span className={`inline-flex items-center gap-1 font-medium border ${radius} bg-danger/10 text-danger border-danger/30 ${padding}`}>
      <AlertTriangle className={icon} />
      Critical
    </span>
  );
}
