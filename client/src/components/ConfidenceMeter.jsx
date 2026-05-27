export default function ConfidenceMeter({ value, showLabel = true }) {
  if (value === null || value === undefined || value === 0) return null;

  let color, label, bg;
  if (value >= 0.8) {
    color = 'bg-green-500';
    bg = 'bg-green-100';
    label = 'High';
  } else if (value >= 0.6) {
    color = 'bg-yellow-400';
    bg = 'bg-yellow-100';
    label = 'Med';
  } else if (value >= 0.4) {
    color = 'bg-orange-400';
    bg = 'bg-orange-100';
    label = 'Low';
  } else {
    color = 'bg-red-500';
    bg = 'bg-red-100';
    label = 'Very Low';
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span className={`w-2 h-2 rounded-full ${color} flex-shrink-0`} />
      {showLabel && (
        <span className={`text-xs font-medium px-1 rounded ${bg} ${color.replace('bg-', 'text-')}`}>
          {label}
        </span>
      )}
    </span>
  );
}
