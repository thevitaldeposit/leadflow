import { useState, useEffect } from 'react';
import { Settings, Key, Database, Zap, Building2, User, DollarSign, MessageSquare } from 'lucide-react';
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

  const inputClass = 'flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';

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
