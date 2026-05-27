import { Settings, Key, Database, Zap } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Settings size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-gray-800">Settings</h2>
        </div>
        <p className="text-sm text-gray-500">Settings page — additional configuration options coming soon.</p>
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
              Currently using <code className="bg-gray-100 px-1 rounded text-xs">claude-sonnet-4-20250514</code> for extraction.
              Update in <code className="bg-gray-100 px-1 rounded text-xs">server/services/extractionEngine.js</code> to upgrade.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
