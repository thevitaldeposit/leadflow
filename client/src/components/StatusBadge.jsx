const STATUS_STYLES = {
  new: 'bg-blue-100 text-blue-700 border-blue-200',
  contacted: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  appointment_set: 'bg-green-100 text-green-700 border-green-200',
  sold: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  lost: 'bg-gray-100 text-gray-500 border-gray-200',
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
