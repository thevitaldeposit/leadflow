import { useState, useEffect, useCallback, useMemo } from 'react';
import { Package, PlusCircle, Edit2, X, Check, Wrench, Truck, Archive, RotateCcw, Warehouse } from 'lucide-react';
import { api } from '../utils/api';

const SIZE_SUGGESTIONS = ['10 yard', '15 yard', '20 yard', '30 yard', '40 yard'];

// Two statuses reduce availability: `out_of_service` (down for maintenance) and
// `at_yard` (came back off a job, still full, not yet dumped — it can't go out again
// until its weight is recorded). `out` doesn't, because the job it's on is already
// subtracted by the date-overlap count.
//
// Setting a unit back to `Available` fully frees it: the server also closes any
// unsettled assignment for that unit, so it becomes droppable again.
const STATUS_META = {
  available: { label: 'Available' },
  out: { label: 'Out on job' },
  at_yard: { label: 'At yard (awaiting dump)' },
  out_of_service: { label: 'Out of service' },
};
const STATUS_ORDER = ['available', 'out', 'at_yard', 'out_of_service'];

function AssetForm({ initial, knownSizes, onSave, onCancel }) {
  const [form, setForm] = useState({
    label: initial?.label || '',
    size: initial?.size || '',
    status: initial?.status || 'available',
    notes: initial?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.label.trim()) { setError('Unit number is required'); return; }
    if (!form.size.trim()) { setError('Size is required'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        label: form.label.trim(),
        size: form.size.trim(),
        status: form.status,
        notes: form.notes,
      });
    } catch (err) {
      setError(err.message || 'Save failed');
      setSaving(false);
    }
  };

  const sizeOptions = [...new Set([...knownSizes, ...SIZE_SUGGESTIONS])];

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">Unit Number</label>
          <input
            value={form.label}
            onChange={e => set('label', e.target.value)}
            placeholder="e.g. 104"
            className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">Size</label>
          <input
            value={form.size}
            onChange={e => set('size', e.target.value)}
            placeholder="20 yard"
            list="size-suggestions"
            className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <datalist id="size-suggestions">
            {sizeOptions.map(s => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">Status</label>
          <select
            value={form.status}
            onChange={e => set('status', e.target.value)}
            className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1">Notes</label>
          <input
            value={form.notes}
            onChange={e => set('notes', e.target.value)}
            placeholder="Optional notes…"
            className="w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 text-sm text-muted hover:text-content px-3 py-2 rounded-lg transition-colors"
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg transition-colors"
        >
          <Check size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

export default function InventoryPage() {
  const [assets, setAssets] = useState([]);
  const [bySize, setBySize] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [showRetired, setShowRetired] = useState(false);
  // One-line confirmation after an action that did more than it looks like it did.
  const [notice, setNotice] = useState(null);

  const load = useCallback((includeRetired) => {
    return api.getFleet(includeRetired ? { include_retired: 1 } : {}).then(res => {
      setAssets(res.assets || []);
      setBySize(res.bySize || []);
    });
  }, []);

  useEffect(() => {
    load(showRetired).catch(console.error).finally(() => setLoading(false));
  }, [load, showRetired]);

  const handleAdd = async (form) => {
    await api.createAsset(form);
    await load(showRetired);
    setShowAdd(false);
  };

  const handleEdit = async (id, form) => {
    await api.updateAsset(id, form);
    await load(showRetired);
    setEditingId(null);
  };

  // Inline status change without entering full edit mode. Setting a unit back to
  // Available also closes any stale job record the server still holds for it, which is
  // what actually makes a stuck unit droppable again — so say when that happened.
  const changeStatus = async (asset, status) => {
    const res = await api.updateAsset(asset.id, { status });
    setNotice(
      res?.clearedAssignments > 0
        ? `Unit ${asset.label} is available again — cleared ${res.clearedAssignments} open job record${res.clearedAssignments === 1 ? '' : 's'} still holding it. No weight was recorded.`
        : null
    );
    await load(showRetired);
  };

  const handleRetire = async (asset) => {
    if (!confirm(`Retire ${asset.label} from the fleet? It stops counting toward availability.`)) return;
    await api.retireAsset(asset.id);
    await load(showRetired);
  };

  const handleUnretire = async (asset) => {
    await api.updateAsset(asset.id, { active: 1 });
    await load(showRetired);
  };

  const knownSizes = useMemo(
    () => [...new Set(bySize.map(s => s.size).filter(Boolean))],
    [bySize]
  );

  const activeAssets = assets.filter(a => a.active !== 0);
  const retiredAssets = assets.filter(a => a.active === 0);
  const totalOwned = activeAssets.length;
  const totalInService = activeAssets.filter(a => a.status === 'out_of_service').length;
  const totalAtYard = activeAssets.filter(a => a.status === 'at_yard').length;
  const totalSellable = totalOwned - totalInService - totalAtYard;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  const renderAssetRow = (a) => (
    editingId === a.id ? (
      <tr key={a.id} className="bg-surface-2">
        <td colSpan={5} className="px-5 py-4">
          <AssetForm
            initial={a}
            knownSizes={knownSizes}
            onSave={(form) => handleEdit(a.id, form)}
            onCancel={() => setEditingId(null)}
          />
        </td>
      </tr>
    ) : (
      <tr key={a.id} className={`hover:bg-surface-2 transition-colors ${a.active === 0 ? 'opacity-50' : ''}`}>
        <td className="px-5 py-3 font-semibold text-content">{a.label}</td>
        <td className="px-4 py-3 text-content">{a.size}</td>
        <td className="px-4 py-3">
          {a.active === 0 ? (
            <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full border bg-surface-2 text-muted border-divider">
              Retired
            </span>
          ) : (
            <select
              value={a.status}
              onChange={e => changeStatus(a, e.target.value)}
              className="text-xs border border-divider rounded-lg px-2 py-1 bg-surface focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </select>
          )}
        </td>
        <td className="px-4 py-3 text-muted text-xs max-w-[200px] truncate">{a.notes || '—'}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1 justify-end">
            {a.active === 0 ? (
              <button
                onClick={() => handleUnretire(a)}
                className="p-1.5 rounded text-muted hover:text-success hover:bg-success/10 transition-colors"
                title="Return to fleet"
              >
                <RotateCcw size={13} />
              </button>
            ) : (
              <>
                <button
                  onClick={() => setEditingId(a.id)}
                  className="p-1.5 rounded text-muted hover:text-accent hover:bg-brand/10 transition-colors"
                  title="Edit"
                >
                  <Edit2 size={13} />
                </button>
                <button
                  onClick={() => handleRetire(a)}
                  className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                  title="Retire"
                >
                  <Archive size={13} />
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
    )
  );

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-divider bg-surface px-4 py-3">
          <p className="text-2xl font-bold text-content">{totalOwned}</p>
          <p className="text-xs text-muted mt-0.5">Dumpsters Owned</p>
        </div>
        <div className="rounded-xl border border-success/30 bg-success/10 px-4 py-3">
          <p className="text-2xl font-bold text-success">{Math.max(0, totalSellable)}</p>
          <p className="text-xs text-success/80 mt-0.5">Sellable Now</p>
        </div>
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3">
          <p className="text-2xl font-bold text-warning">{totalAtYard}</p>
          <p className="text-xs text-warning/80 mt-0.5">At Yard (awaiting dump)</p>
        </div>
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3">
          <p className="text-2xl font-bold text-warning">{totalInService}</p>
          <p className="text-xs text-warning/80 mt-0.5">Out of Service</p>
        </div>
      </div>

      {notice && (
        <p className="text-xs text-success bg-success/10 border border-success/30 rounded-xl px-3 py-2.5">
          {notice}
        </p>
      )}

      <p className="text-xs text-muted px-1">
        Availability counts the dumpsters registered below. A unit marked <strong>out of service</strong> or
        sitting <strong>at the yard</strong> (picked up and still full, waiting on a dump) is removed from
        availability — an at-yard can comes back the moment you record its weight. Setting a unit to{' '}
        <strong>Available</strong> frees it immediately and clears any job record still holding it.
        Availability for a specific date also subtracts jobs active on that date — see the Schedule page.
      </p>

      {/* Fleet registry */}
      <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-divider flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Truck size={16} className="text-muted" />
            <h2 className="text-sm font-bold text-content">My Dumpsters ({activeAssets.length})</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowRetired(v => !v)}
              className="text-xs text-muted hover:text-content px-2 py-1.5 rounded-lg transition-colors"
            >
              {showRetired ? 'Hide retired' : 'Show retired'}
            </button>
            {!showAdd && (
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 px-3 py-1.5 rounded-lg transition-colors"
              >
                <PlusCircle size={14} /> Add Dumpster
              </button>
            )}
          </div>
        </div>

        {showAdd && (
          <div className="px-5 py-4 border-b border-divider bg-surface-2">
            <p className="text-xs font-semibold text-muted mb-3">New Dumpster</p>
            <AssetForm knownSizes={knownSizes} onSave={handleAdd} onCancel={() => setShowAdd(false)} />
          </div>
        )}

        {activeAssets.length === 0 && retiredAssets.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted">
            No dumpsters registered yet. Add your first one above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-divider">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Unit</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Size</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Notes</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {activeAssets.map(renderAssetRow)}
              {showRetired && retiredAssets.map(renderAssetRow)}
            </tbody>
          </table>
        )}
      </div>

      {/* Per-size rollup — derived from the fleet above */}
      {bySize.length > 0 && (
        <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-divider flex items-center gap-2">
            <Package size={16} className="text-muted" />
            <h2 className="text-sm font-bold text-content">By Size</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-divider">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Size</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Owned</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Out of Service</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">At Yard</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted uppercase tracking-wide">Sellable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {bySize.map(s => (
                <tr key={s.size} className="hover:bg-surface-2 transition-colors">
                  <td className="px-5 py-3 font-semibold text-content">{s.size}</td>
                  <td className="px-4 py-3 text-content">{s.quantity}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-content">
                      <Wrench size={13} className="text-warning" />
                      {s.units_in_service}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-content">
                      <Warehouse size={13} className="text-warning" />
                      {s.units_at_yard || 0}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-semibold text-success">
                    {Math.max(0, s.quantity - s.units_in_service - (s.units_at_yard || 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
