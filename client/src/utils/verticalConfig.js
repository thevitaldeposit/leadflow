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

// Sub-verticals that share the home_services dashboard.
export const HOME_SERVICES_SUB_VERTICALS = [
  { id: 'dumpster_rental', label: 'Dumpster Rental' },
  { id: 'hvac', label: 'HVAC' },
];

// Field packs render the "Industry Details" section of the lead detail view.
// Field types:
//   - text       single-line editable string
//   - multiline  textarea editable string
//   - bool       Yes / No / unset toggle
//   - enum       dropdown driven by `options`
// `span` controls grid layout (1 = half row, 2 = full row).
export const HOME_SERVICES_FIELD_PACKS = {
  dumpster_rental: {
    label: 'Dumpster Rental',
    // Card subtitle: which vertical_data field summarizes the job at a glance.
    summaryKey: 'dumpsterSize',
    industryFields: [
      { key: 'dumpsterSize', label: 'Dumpster Size', type: 'text' },
      { key: 'debrisType', label: 'Debris Type', type: 'text' },
      { key: 'deliveryDate', label: 'Delivery Date', type: 'text' },
      { key: 'pickupDate', label: 'Pickup Date', type: 'text' },
      { key: 'rentalDuration', label: 'Rental Duration', type: 'text' },
      { key: 'permitNeeded', label: 'Permit Needed', type: 'bool' },
      { key: 'deliveryAddress', label: 'Delivery Address', type: 'text', span: 2 },
      { key: 'accessNotes', label: 'Access Notes', type: 'multiline', span: 2 },
    ],
    quoteFields: [
      { key: 'quotedPrice', label: 'Quoted Price', type: 'text' },
      { key: 'paymentStatus', label: 'Payment Status', type: 'text' },
    ],
  },
  hvac: {
    label: 'HVAC',
    summaryKey: 'serviceType',
    industryFields: [
      {
        key: 'serviceType',
        label: 'Service Type',
        type: 'enum',
        options: ['repair', 'maintenance', 'install', 'replacement', 'estimate', 'unknown'],
      },
      {
        key: 'equipmentType',
        label: 'Equipment',
        type: 'enum',
        options: ['furnace', 'ac', 'heat_pump', 'boiler', 'ductwork', 'other', 'unknown'],
      },
      { key: 'systemAge', label: 'System Age', type: 'text' },
      { key: 'brandOrModel', label: 'Brand / Model', type: 'text' },
      { key: 'emergencyStatus', label: 'Emergency', type: 'bool' },
      { key: 'appointmentRequested', label: 'Appointment Requested', type: 'bool' },
      { key: 'propertyAddress', label: 'Property Address', type: 'text', span: 2 },
      { key: 'issueDescription', label: 'Issue Description', type: 'multiline', span: 2 },
    ],
    quoteFields: [
      { key: 'quotedPrice', label: 'Quoted Price', type: 'text' },
      { key: 'followUpNeeded', label: 'Follow-Up Needed', type: 'bool' },
    ],
  },
};

export function getSubVertical(lead) {
  const sv = lead?.sub_vertical;
  if (sv && HOME_SERVICES_FIELD_PACKS[sv]) return sv;
  // Legacy/back-compat: any home_services lead without a sub_vertical is dumpster_rental.
  return 'dumpster_rental';
}

export function getFieldPack(lead) {
  return HOME_SERVICES_FIELD_PACKS[getSubVertical(lead)];
}

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
