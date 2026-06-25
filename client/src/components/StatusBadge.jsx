const STATUS_STYLES = {
  new: 'bg-brand/10 text-brand border-brand/30',
  contacted: 'bg-warning/10 text-warning border-warning/30',
  appointment_set: 'bg-success/10 text-success border-success/30',
  sold: 'bg-success/10 text-success border-success/30',
  lost: 'bg-surface-2 text-muted border-divider',
};

const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  appointment_set: 'Appt Set',
  sold: 'Sold',
  lost: 'Lost',
};

export default function StatusBadge({ status, size = 'sm' }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.new;
  const label = STATUS_LABELS[status] || status;
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center font-medium rounded-full border ${style} ${padding}`}>
      {label}
    </span>
  );
}
