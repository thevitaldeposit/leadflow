import { useState, useEffect, useCallback } from 'react';
import { Package, PlusCircle, Edit2, Trash2, X, Check } from 'lucide-react';
import { api } from '../utils/api';

const SIZES = ['10 yard', '15 yard', '20 yard', '30 yard', '40 yard'];
const STATUSES = ['available', 'on_job', 'needs_service', 'out_of_service'];

const STATUS_STYLES = {
  available: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  on_job: 'bg-blue-100 text-blue-700 border-blue-200',
  needs_service: 'bg-amber-100 text-amber-700 border-amber-200',
  out_of_service: 'bg-red-100 text-red-700 border-red-200',
};

const STATUS_LABELS = {
  available: 'Available',
  on_job: 'On Job',
  needs_service: 'Needs Service',
  out_of_service: 'Out of Service',
};

function StatusBadge({ status }) {
  const cls = STATUS_STYLES[status] || 'bg-gray-100 text-gray-500';
  return (
    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${cls}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function DumpsterForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({
    asset_number: initial?.asset_number || '',
    size: initial?.size || '10 yard',
    status: initial?.status || 'available',
    notes: initial?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.asset_number.trim()) { setError('Asset number is required'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err) {
      setError(err.message || 'Save failed');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Asset Number</label>
          <input
            value={form.asset_number}
            onChange={e => set('asset_number', e.target.value)}
            placeholder="VB-001"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Size</label>
          <select
            value={form.size}
            onChange={e => set('size', e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-white"
          >
            {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Status</label>
          <select
            value={form.status}
            onChange={e => set('status', e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent bg-white"
          >
            {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Notes</label>
          <input
            value={form.notes}
            onChange={e => set('notes', e.target.value)}
            placeholder="Condition, maintenance notes…"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg transition-colors"
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg transition-colors"
        >
          <Check size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

export default function InventoryPage() {
  const [dumpsters, setDumpsters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const load = useCallback(() => {
    return api.getDumpsters().then(setDumpsters);
  }, []);

  useEffect(() => {
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  const handleAdd = async (form) => {
    const created = await api.createDumpster(form);
    setDumpsters(prev => [...prev, created].sort((a, b) => a.asset_number.localeCompare(b.asset_number)));
    setShowAdd(false);
  };

  const handleEdit = async (id, form) => {
    const updated = await api.updateDumpster(id, form);
    setDumpsters(prev => prev.map(d => d.id === updated.id ? updated : d));
    setEditingId(null);
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this dumpster from inventory?')) return;
    await api.deleteDumpster(id);
    setDumpsters(prev => prev.filter(d => d.id !== id));
  };

  // Summary by status
  const summary = STATUSES.reduce((acc, s) => {
    acc[s] = dumpsters.filter(d => d.status === s).length;
    return acc;
  }, {});

  // Available by size
  const availableBySizeMap = {};
  for (const d of dumpsters.filter(d => d.status === 'available')) {
    availableBySizeMap[d.size] = (availableBySizeMap[d.size] || 0) + 1;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-4 gap-3">
        {STATUSES.map(s => (
          <div key={s} className={`rounded-xl border px-4 py-3 ${STATUS_STYLES[s] || 'bg-gray-50'}`}>
            <p className="text-2xl font-bold">{summary[s] || 0}</p>
            <p className="text-xs opacity-80 mt-0.5">{STATUS_LABELS[s]}</p>
          </div>
        ))}
      </div>

      {Object.keys(availableBySizeMap).length > 0 && (
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-5 py-3">
          <p className="text-xs font-bold text-emerald-700 uppercase tracking-wide mb-1.5">Available by Size</p>
          <div className="flex flex-wrap gap-3">
            {Object.entries(availableBySizeMap).sort().map(([size, count]) => (
              <span key={size} className="text-sm font-medium text-emerald-800">
                {count}× {size}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package size={16} className="text-gray-500" />
            <h2 className="text-sm font-bold text-gray-800">Fleet Inventory ({dumpsters.length})</h2>
          </div>
          {!showAdd && (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 px-3 py-1.5 rounded-lg transition-colors"
            >
              <PlusCircle size={14} /> Add Dumpster
            </button>
          )}
        </div>

        {showAdd && (
          <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
            <p className="text-xs font-semibold text-gray-600 mb-3">New Dumpster</p>
            <DumpsterForm onSave={handleAdd} onCancel={() => setShowAdd(false)} />
          </div>
        )}

        {dumpsters.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-gray-400">
            No dumpsters in inventory yet. Add your first one above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Asset #</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Size</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Current Job</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Notes</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {dumpsters.map(d => (
                editingId === d.id ? (
                  <tr key={d.id} className="bg-gray-50">
                    <td colSpan={6} className="px-5 py-4">
                      <DumpsterForm
                        initial={d}
                        onSave={(form) => handleEdit(d.id, form)}
                        onCancel={() => setEditingId(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={d.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3 font-mono font-semibold text-gray-900">{d.asset_number}</td>
                    <td className="px-4 py-3 text-gray-700">{d.size || '—'}</td>
                    <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                    <td className="px-4 py-3 text-gray-500">
                      {d.current_job_id ? (
                        <a href={`/leads/${d.current_job_id}`} className="text-accent hover:underline text-xs">
                          Job #{d.current_job_id}
                        </a>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs max-w-[200px] truncate">{d.notes || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => setEditingId(d.id)}
                          className="p-1.5 rounded text-gray-400 hover:text-accent hover:bg-blue-50 transition-colors"
                          title="Edit"
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(d.id)}
                          className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
