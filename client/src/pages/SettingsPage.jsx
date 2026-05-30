import { useState } from 'react';
import { Settings, Key, Database, Zap, Building2, User } from 'lucide-react';
import { getSettings, saveSettings } from '../utils/settings';

export default function SettingsPage() {
  const [settings, setSettings] = useState(getSettings);

  const update = (field, value) => {
    const next = { ...settings, [field]: value };
    setSettings(next);
    saveSettings({ [field]: value });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-6">
          <Settings size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-gray-800">Business Settings</h2>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Business Name
            </label>
            <div className="flex items-center gap-2">
              <Building2 size={16} className="text-gray-400 flex-shrink-0" />
              <input
                type="text"
                value={settings.businessName}
                onChange={e => update('businessName', e.target.value)}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="Valley Binz"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Owner First Name
            </label>
            <div className="flex items-center gap-2">
              <User size={16} className="text-gray-400 flex-shrink-0" />
              <input
                type="text"
                value={settings.ownerFirstName}
                onChange={e => update('ownerFirstName', e.target.value)}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="Austin"
              />
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-4">Changes are saved automatically to this device.</p>
      </div>

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
