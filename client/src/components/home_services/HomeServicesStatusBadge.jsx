import { HOME_SERVICES_STATUSES, HOME_SERVICES_STATUS_STYLES } from '../../utils/verticalConfig';

const LABELS = Object.fromEntries(HOME_SERVICES_STATUSES.map(s => [s.value, s.label]));

export default function HomeServicesStatusBadge({ status, size = 'sm' }) {
  const style = HOME_SERVICES_STATUS_STYLES[status] || HOME_SERVICES_STATUS_STYLES.new;
  const label = LABELS[status] || status || 'New';
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center font-medium rounded-full border ${style} ${padding}`}>
      {label}
    </span>
  );
}
