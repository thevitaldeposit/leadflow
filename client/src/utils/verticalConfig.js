export const VERTICALS = [
  { id: 'auto_dealer', label: 'Auto Dealer' },
  { id: 'home_services', label: 'Home Services' },
];

export const HOME_SERVICES_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'quote_sent', label: 'Quote Sent' },
  { value: 'booked', label: 'Booked' },
  { value: 'lost', label: 'Lost' },
];

export const HOME_SERVICES_STATUS_STYLES = {
  new: 'bg-blue-100 text-blue-700 border-blue-200',
  contacted: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  quote_sent: 'bg-purple-100 text-purple-700 border-purple-200',
  booked: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  lost: 'bg-gray-100 text-gray-500 border-gray-200',
};

export const URGENCY_VALUES = ['ASAP', 'This Week', 'Next Week', 'Flexible'];

export const URGENCY_STYLES = {
  'ASAP': 'bg-red-100 text-red-700 border-red-200',
  'This Week': 'bg-orange-100 text-orange-700 border-orange-200',
  'Next Week': 'bg-yellow-100 text-yellow-700 border-yellow-200',
  'Flexible': 'bg-green-100 text-green-700 border-green-200',
};

const STORAGE_KEY = 'leadflow:activeVertical';

export function getActiveVertical() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VERTICALS.find(x => x.id === v)?.id || 'auto_dealer';
  } catch {
    return 'auto_dealer';
  }
}

export function setActiveVertical(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
}

export function parseVerticalData(lead) {
  if (!lead?.vertical_data) return {};
  try { return JSON.parse(lead.vertical_data); } catch { return {}; }
}
