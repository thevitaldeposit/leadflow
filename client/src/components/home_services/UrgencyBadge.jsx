import { URGENCY_STYLES } from '../../utils/verticalConfig';

export default function UrgencyBadge({ value, size = 'sm' }) {
  if (!value) return null;
  const style = URGENCY_STYLES[value] || 'bg-surface-2 text-muted border-divider';
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center font-medium rounded-full border ${style} ${padding}`}>
      {value}
    </span>
  );
}
