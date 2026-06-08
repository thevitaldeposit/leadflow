import { useState, useEffect } from 'react';
import { Settings, Key, Database, Zap, Building2, User, DollarSign, MessageSquare, Clock, Inbox, Lock } from 'lucide-react';
import { getSettings, saveSettings } from '../utils/settings';
import { api } from '../utils/api';

export default function SettingsPage() {
  const [settings, setSettings] = useState(getSettings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load authoritative values from the server on mount
  useEffect(() => {
    api.getSettings().then((serverSettings) => {
      if (serverSettings && Object.keys(serverSettings).length > 0) {
        setSettings(prev => ({ ...prev, ...serverSettings }));
        saveSettings(serverSettings);
      }
    }).catch(() => { /* fallback to localStorage */ });
  }, []);

  const update = async (field, value) => {
    const next = { ...settings, [field]: value };
    setSettings(next);
    saveSettings({ [field]: value });
    setSaving(true);
    setSaved(false);
    try {
      await api.updateSettings({ [field]: value });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to sync setting to server:', err);
    } finally {
      setSaving(false);
    }
  };

  // Change Password form state — kept separate from the auto-saved business settings.
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);

  const changePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwSuccess(false);

    if (pw.next.length < 8) {
      setPwError('New password must be at least 8 characters.');
      return;
    }
    if (pw.next !== pw.confirm) {
      setPwError('New passwords do not match.');
      return;
    }

    setPwSaving(true);
    try {
      await api.changePassword(pw.current, pw.next);
      setPwSuccess(true);
      setPw({ current: '', next: '', confirm: '' });
      setTimeout(() => setPwSuccess(false), 4000);
    } catch (err) {
      setPwError(err.message || 'Failed to change password.');
    } finally {
      setPwSaving(false);
    }
  };

  const inputClass = 'flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';

  // IANA timezone → label shown in the dropdown. Used to resolve relative dates
  // like "tomorrow" against the business's local calendar.
  const TIMEZONES = [
    { value: 'America/New_York', label: 'Eastern (America/New_York)' },
    { value: 'America/Chicago', label: 'Central (America/Chicago)' },
    { value: 'America/Denver', label: 'Mountain (America/Denver)' },
    { value: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
    { value: 'America/Anchorage', label: 'Alaska (America/Anchorage)' },
    { value: 'Pacific/Honolulu', label: 'Hawaii (Pacific/Honolulu)' },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* Business Settings */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Settings size={18} className="text-accent" />
            <h2 className="text-base font-semibold text-gray-800">Business Settings</h2>
          </div>
          {saving && <span className="text-xs text-gray-400">Saving…</span>}
          {saved && !saving && <span className="text-xs text-green-600">Saved</span>}
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Business Name</label>
            <div className="flex items-center gap-2">
              <Building2 size={16} className="text-gray-400 flex-shrink-0" />
              <input
                type="text"
                value={settings.businessName}
                onChange={e => update('businessName', e.target.value)}
                className={inputClass}
                placeholder="Valley Binz"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Owner First Name</label>
            <div className="flex items-center gap-2">
              <User size={16} className="text-gray-400 flex-shrink-0" />
              <input
                type="text"
                value={settings.ownerFirstName}
                onChange={e => update('ownerFirstName', e.target.value)}
                className={inputClass}
                placeholder="Austin"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Timezone</label>
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-gray-400 flex-shrink-0" />
              <select
                value={settings.timezone || 'America/Chicago'}
                onChange={e => update('timezone', e.target.value)}
                className={`${inputClass} bg-white`}
              >
                {TIMEZONES.map(tz => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-gray-400 mt-1">Used to resolve relative dates like “tomorrow” to the correct local day.</p>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-4">Changes are saved automatically to this device and synced to the server.</p>
      </div>

      {/* Payment Settings */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-6">
          <DollarSign size={18} className="text-green-600" />
          <h2 className="text-base font-semibold text-gray-800">Payment Settings</h2>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Cash App Handle</label>
            <input
              type="text"
              value={settings.cashAppHandle}
              onChange={e => update('cashAppHandle', e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="$ValleyBinz"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Venmo Handle</label>
            <input
              type="text"
              value={settings.venmoHandle}
              onChange={e => update('venmoHandle', e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="@ValleyBinz"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Square API Key <span className="normal-case text-gray-400 font-normal">(activates card payments)</span>
            </label>
            <input
              type="password"
              value={settings.squareApiKey}
              onChange={e => update('squareApiKey', e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent font-mono"
              placeholder="sq0atp-…"
              autoComplete="off"
            />
            <p className="text-xs text-gray-400 mt-1">Card payments will activate automatically once a key is entered.</p>
          </div>
        </div>
      </div>

      {/* SMS Settings */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-6">
          <MessageSquare size={18} className="text-blue-600" />
          <h2 className="text-base font-semibold text-gray-800">SMS Notifications</h2>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-800">Send payment link via SMS</p>
            <p className="text-xs text-gray-500 mt-0.5">Automatically texts the customer a payment link when a job is booked.</p>
          </div>
          <button
            onClick={() => update('smsEnabled', !settings.smsEnabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${settings.smsEnabled ? 'bg-accent' : 'bg-gray-200'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${settings.smsEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </div>

      {/* Change Password */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-1">
          <Lock size={18} className="text-gray-700" />
          <h2 className="text-base font-semibold text-gray-800">Change Password</h2>
        </div>
        <p className="text-xs text-gray-500 mb-6">
          Replace your temporary password with one of your own. Must be at least 8 characters.
        </p>
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Current Password</label>
            <input
              type="password"
              value={pw.current}
              onChange={e => setPw(prev => ({ ...prev, current: e.target.value }))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">New Password</label>
            <input
              type="password"
              value={pw.next}
              onChange={e => setPw(prev => ({ ...prev, next: e.target.value }))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Confirm New Password</label>
            <input
              type="password"
              value={pw.confirm}
              onChange={e => setPw(prev => ({ ...prev, confirm: e.target.value }))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              autoComplete="new-password"
            />
          </div>
          {pwError && <p className="text-sm text-red-600">{pwError}</p>}
          {pwSuccess && <p className="text-sm text-green-600">Password changed successfully.</p>}
          <button
            type="submit"
            disabled={pwSaving || !pw.current || !pw.next || !pw.confirm}
            className="text-sm font-medium bg-accent text-white rounded-lg px-4 py-2 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pwSaving ? 'Changing…' : 'Change Password'}
          </button>
        </form>
      </div>

      {/* Action Queue Settings */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-1">
          <Inbox size={18} className="text-red-500" />
          <h2 className="text-base font-semibold text-gray-800">Action Queue</h2>
        </div>
        <p className="text-xs text-gray-500 mb-6">
          How long a lead stays in the Action Queue before it expires and moves to All Opportunities.
          Critical issues (inventory conflicts, missing payment/address on booked jobs) never expire.
        </p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              ASAP lead expiry after delivery date (hours)
            </label>
            <input
              type="number"
              min="1"
              value={settings.action_queue_asap_expiry_hours ?? 24}
              onChange={e => update('action_queue_asap_expiry_hours', Math.max(1, Number(e.target.value) || 24))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Overdue follow-up expiry (hours)
            </label>
            <input
              type="number"
              min="1"
              value={settings.action_queue_followup_expiry_hours ?? 48}
              onChange={e => update('action_queue_followup_expiry_hours', Math.max(1, Number(e.target.value) || 48))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Voicemail expiry (hours)
            </label>
            <input
              type="number"
              min="1"
              value={settings.action_queue_voicemail_expiry_hours ?? 24}
              onChange={e => update('action_queue_voicemail_expiry_hours', Math.max(1, Number(e.target.value) || 24))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Missed call expiry (hours)
            </label>
            <input
              type="number"
              min="1"
              value={settings.action_queue_missed_call_expiry_hours ?? 24}
              onChange={e => update('action_queue_missed_call_expiry_hours', Math.max(1, Number(e.target.value) || 24))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid grid-cols-1 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-start gap-4">
          <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Key size={18} className="text-accent" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">API Key</p>
            <p className="text-sm text-gray-500 mt-1">
              Set your Anthropic API key in the <code className="bg-gray-100 px-1 rounded text-xs">.env</code> file at the root of the project.
            </p>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-start gap-4">
          <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Database size={18} className="text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">Database</p>
            <p className="text-sm text-gray-500 mt-1">
              SQLite database stored at <code className="bg-gray-100 px-1 rounded text-xs">server/db/leadflow.db</code>. Can be migrated to PostgreSQL for production.
            </p>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-start gap-4">
          <div className="w-10 h-10 bg-violet-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Zap size={18} className="text-violet-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">AI Model</p>
            <p className="text-sm text-gray-500 mt-1">
              Currently using <code className="bg-gray-100 px-1 rounded text-xs">claude-sonnet-4-6</code> for extraction.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
