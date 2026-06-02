const STORAGE_KEY = 'leadflow:settings';

const DEFAULTS = {
  businessName: 'Valley Binz',
  ownerFirstName: 'Austin',
  cashAppHandle: '',
  venmoHandle: '',
  squareApiKey: '',
  smsEnabled: true,
  timezone: 'America/Chicago',
  // Action Queue grace periods (hours). A lead leaves the queue and moves to
  // All Opportunities once it sits past these windows with no action taken.
  action_queue_asap_expiry_hours: 24,
  action_queue_followup_expiry_hours: 48,
  action_queue_voicemail_expiry_hours: 24,
};

export function getSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(partial) {
  try {
    const current = getSettings();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...partial }));
  } catch { /* ignore */ }
}
