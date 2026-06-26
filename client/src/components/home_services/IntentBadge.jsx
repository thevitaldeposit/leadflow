import { INTENT_LABELS, INTENT_STYLES } from '../../utils/verticalConfig';

export default function IntentBadge({ value, size = 'sm', boxy = false }) {
  if (!value || !INTENT_LABELS[value]) return null;
  const style = INTENT_STYLES[value];
  const padding = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  const radius = boxy ? 'rounded-md' : 'rounded-full';
  return (
    <span className={`inline-flex items-center font-medium border ${radius} ${style} ${padding}`}>
      {INTENT_LABELS[value]}
    </span>
  );
}
