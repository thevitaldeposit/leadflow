import { useState, useEffect, useCallback } from 'react';
import { Package, PlusCircle, Edit2, Trash2, X, Check, Wrench } from 'lucide-react';
import { api } from '../utils/api';

const SIZE_SUGGESTIONS = ['10 yard', '15 yard', '20 yard', '30 yard', '40 yard'];

function PoolForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({
    size: initial?.size || '',
    quantity: initial?.quantity ?? 0,
    units_in_service: initial?.units_in_service ?? 0,
    notes: initial?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.size.trim()) { setError('Size is required'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        size: form.size.trim(),
        quantity: Math.max(0, parseInt(form.quantity, 10) || 0),
        units_in_service: Math.max(0, parseInt(form.units_in_service, 10) || 0),
        notes: form.notes,
      });
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
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Size</label>
          <input
            value={form.size}
            onChange={e => set('size', e.target.value)}
            placeholder="10 yard"
            list="size-suggestions"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <datalist id="size-suggestions">
            {SIZE_SUGGESTIONS.map(s => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Quantity Owned</label>
          <input
            type="number"
            min="0"
            value={form.quantity}
            onChange={e => set('quantity', e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Units Needing Service</label>
          <input
            type="number"
            min="0"
            value={form.units_in_service}
            onChange={e => set('units_in_service', e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Notes</label>
          <input
            value={form.notes}
            onChange={e => set('notes', e.target.value)}
            placeholder="Optional notes…"
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
  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const load = useCallback(() => {
    return api.getInventory().then(setPools);
  }, []);

  useEffect(() => {
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  const handleAdd = async (form) => {
    const created = await api.createInventory(form);
    setPools(prev => [...prev, created]);
    setShowAdd(false);
  };

  const handleEdit = async (id, form) => {
    const updated = await api.updateInventory(id, form);
    setPools(prev => prev.map(p => p.id === updated.id ? updated : p));
    setEditingId(null);
  };

  const handleDelete = async (id) => {
    if (!confirm('Remove this size from inventory?')) return;
    await api.deleteInventory(id);
    setPools(prev => prev.filter(p => p.id !== id));
  };

  // Inline service adjustment without entering full edit mode.
  const adjustService = async (pool, value) => {
    const units_in_service = Math.max(0, Math.min(pool.quantity, parseInt(value, 10) || 0));
    const updated = await api.updateInventory(pool.id, { units_in_service });
    setPools(prev => prev.map(p => p.id === updated.id ? updated : p));
  };

  const totalOwned = pools.reduce((sum, p) => sum + (p.quantity || 0), 0);
  const totalInService = pools.reduce((sum, p) => sum + (p.units_in_service || 0), 0);
  const totalAvailable = pools.reduce((sum, p) => sum + Math.max(0, (p.quantity || 0) - (p.units_in_service || 0)), 0);

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
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-gray-100 bg-white px-4 py-3">
          <p className="text-2xl font-bold text-gray-900">{totalOwned}</p>
          <p className="text-xs text-gray-500 mt-0.5">Total Units Owned</p>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3">
          <p className="text-2xl font-bold text-emerald-700">{totalAvailable}</p>
          <p className="text-xs text-emerald-700/80 mt-0.5">Available (excl. service)</p>
        </div>
        <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3">
          <p className="text-2xl font-bold text-amber-700">{totalInService}</p>
          <p className="text-xs text-amber-700/80 mt-0.5">Needing Service</p>
        </div>
      </div>

      <p className="text-xs text-gray-400 px-1">
        Availability for a specific date is calculated against active jobs on the Schedule page.
        Units needing service are removed from availability until you set them back to zero.
      </p>

      {/* Pool table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package size={16} className="text-gray-500" />
            <h2 className="text-sm font-bold text-gray-800">Inventory by Size ({pools.length})</h2>
          </div>
          {!showAdd && (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 px-3 py-1.5 rounded-lg transition-colors"
            >
              <PlusCircle size={14} /> Add Size
            </button>
          )}
        </div>

        {showAdd && (
          <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
            <p className="text-xs font-semibold text-gray-600 mb-3">New Size</p>
            <PoolForm onSave={handleAdd} onCancel={() => setShowAdd(false)} />
          </div>
        )}

        {pools.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-gray-400">
            No sizes in inventory yet. Add your first one above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Size</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Owned</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Needing Service</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Available</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Notes</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pools.map(p => (
                editingId === p.id ? (
                  <tr key={p.id} className="bg-gray-50">
                    <td colSpan={6} className="px-5 py-4">
                      <PoolForm
                        initial={p}
                        onSave={(form) => handleEdit(p.id, form)}
                        onCancel={() => setEditingId(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3 font-semibold text-gray-900">{p.size}</td>
                    <td className="px-4 py-3 text-gray-700">{p.quantity}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Wrench size={13} className="text-amber-500" />
                        <input
                          type="number"
                          min="0"
                          max={p.quantity}
                          value={p.units_in_service}
                          onChange={e => adjustService(p, e.target.value)}
                          className="w-16 text-sm border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-emerald-700">
                        {Math.max(0, p.quantity - p.units_in_service)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs max-w-[200px] truncate">{p.notes || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => setEditingId(p.id)}
                          className="p-1.5 rounded text-gray-400 hover:text-accent hover:bg-blue-50 transition-colors"
                          title="Edit"
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(p.id)}
                          className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="Remove"
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
