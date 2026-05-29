import { INTENT_LABELS, INTENT_STYLES } from '../../utils/verticalConfig';

export default function IntentBadge({ value, size = 'sm' }) {
  if (!value || !INTENT_LABELS[value]) return null;
  const style = INTENT_STYLES[value];
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center font-medium rounded-full border ${style} ${padding}`}>
      {INTENT_LABELS[value]}
    </span>
  );
}
