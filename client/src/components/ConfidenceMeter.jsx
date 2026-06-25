export default function ConfidenceMeter({ value, showLabel = true }) {
  if (value === null || value === undefined || value === 0) return null;

  let color, label, bg;
  if (value >= 0.8) {
    color = 'bg-success';
    bg = 'bg-success/10';
    label = 'High';
  } else if (value >= 0.6) {
    color = 'bg-warning';
    bg = 'bg-warning/10';
    label = 'Med';
  } else if (value >= 0.4) {
    color = 'bg-warning';
    bg = 'bg-warning/10';
    label = 'Low';
  } else {
    color = 'bg-danger';
    bg = 'bg-danger/10';
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
