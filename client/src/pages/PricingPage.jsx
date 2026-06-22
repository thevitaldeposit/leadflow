import { useEffect, useState, useCallback } from 'react';
import { DollarSign, Percent, PlusCircle, Edit2, Trash2, X, Check } from 'lucide-react';
import { api } from '../utils/api';

const inputCls = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';

function PriceItemForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({
    service_key: initial?.service_key || '', label: initial?.label || '',
    unit: initial?.unit || '', unit_price: initial?.unit_price ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.service_key.trim()) { setError('Service key is required'); return; }
    setSaving(true); setError(null);
    try { await onSave({ ...form, unit_price: form.unit_price === '' ? null : Number(form.unit_price) }); }
    catch (err) { setError(err.message || 'Save failed'); setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="grid grid-cols-4 gap-3">
        <div><label className={labelCls}>Service Key</label><input className={inputCls} value={form.service_key} onChange={e => set('service_key', e.target.value)} placeholder="20yd" /></div>
        <div><label className={labelCls}>Label</label><input className={inputCls} value={form.label} onChange={e => set('label', e.target.value)} placeholder="20 Yard Dumpster" /></div>
        <div><label className={labelCls}>Unit</label><input className={inputCls} value={form.unit} onChange={e => set('unit', e.target.value)} placeholder="rental" /></div>
        <div><label className={labelCls}>Price ($)</label><input type="number" min="0" step="0.01" className={inputCls} value={form.unit_price} onChange={e => set('unit_price', e.target.value)} /></div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg"><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg"><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

function GroupForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({
    name: initial?.name || '', discount_percent: initial?.discount_percent ?? 0,
    default_net_terms: initial?.default_net_terms || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try { await onSave({ ...form, discount_percent: Number(form.discount_percent) || 0 }); }
    catch (err) { setError(err.message || 'Save failed'); setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="grid grid-cols-3 gap-3">
        <div><label className={labelCls}>Group Name</label><input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)} placeholder="Contractor" /></div>
        <div><label className={labelCls}>Discount %</label><input type="number" min="0" max="100" step="0.1" className={inputCls} value={form.discount_percent} onChange={e => set('discount_percent', e.target.value)} /></div>
        <div><label className={labelCls}>Default Net Terms</label><input className={inputCls} value={form.default_net_terms} onChange={e => set('default_net_terms', e.target.value)} placeholder="Net 30" /></div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg"><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg"><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

export default function PricingPage() {
  const [items, setItems] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addingItem, setAddingItem] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);

  const load = useCallback(() => api.getPricing().then(p => { setItems(p.items || []); setGroups(p.groups || []); }), []);
  useEffect(() => { load().catch(console.error).finally(() => setLoading(false)); }, [load]);

  const saveItem = async (form) => {
    if (editingItem) await api.updatePriceItem(editingItem, form);
    else await api.createPriceItem(form);
    setAddingItem(false); setEditingItem(null);
    await load();
  };
  const deleteItem = async (id) => { if (!confirm('Delete this price?')) return; await api.deletePriceItem(id); await load(); };

  const saveGroup = async (form) => {
    if (editingGroup) await api.updateDiscountGroup(editingGroup, form);
    else await api.createDiscountGroup(form);
    setAddingGroup(false); setEditingGroup(null);
    await load();
  };
  const deleteGroup = async (id) => { if (!confirm('Delete this group? Customers in it become retail-priced.')) return; await api.deleteDiscountGroup(id); await load(); };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" /></div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <p className="text-xs text-gray-400 px-1">
        These are your default/retail rates. Discount groups apply a percentage off for contractor or commercial
        accounts, and any customer can have their own custom rate that overrides both — set per customer on their profile.
      </p>

      {/* Default price list */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2"><DollarSign size={16} className="text-gray-500" /><h2 className="text-sm font-bold text-gray-800">Default Price List ({items.length})</h2></div>
          {!addingItem && <button onClick={() => { setAddingItem(true); setEditingItem(null); }} className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 px-3 py-1.5 rounded-lg"><PlusCircle size={14} /> Add Price</button>}
        </div>
        {addingItem && <div className="px-5 py-4 border-b border-gray-100 bg-gray-50"><PriceItemForm onSave={saveItem} onCancel={() => setAddingItem(false)} /></div>}
        {items.length === 0 && !addingItem ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">No prices yet. Add your standard rates above.</div>
        ) : items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Service Key</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Label</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Unit</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Price</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map(it => editingItem === it.id ? (
                <tr key={it.id} className="bg-gray-50"><td colSpan={5} className="px-5 py-4"><PriceItemForm initial={it} onSave={saveItem} onCancel={() => setEditingItem(null)} /></td></tr>
              ) : (
                <tr key={it.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-gray-900">{it.service_key}</td>
                  <td className="px-4 py-3 text-gray-700">{it.label || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{it.unit || '—'}</td>
                  <td className="px-4 py-3 text-gray-900 font-semibold">{it.unit_price != null ? `$${it.unit_price}` : '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => { setEditingItem(it.id); setAddingItem(false); }} className="p-1.5 rounded text-gray-400 hover:text-accent hover:bg-blue-50"><Edit2 size={13} /></button>
                      <button onClick={() => deleteItem(it.id)} className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Discount groups */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2"><Percent size={16} className="text-gray-500" /><h2 className="text-sm font-bold text-gray-800">Discount Groups ({groups.length})</h2></div>
          {!addingGroup && <button onClick={() => { setAddingGroup(true); setEditingGroup(null); }} className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 px-3 py-1.5 rounded-lg"><PlusCircle size={14} /> Add Group</button>}
        </div>
        {addingGroup && <div className="px-5 py-4 border-b border-gray-100 bg-gray-50"><GroupForm onSave={saveGroup} onCancel={() => setAddingGroup(false)} /></div>}
        {groups.length === 0 && !addingGroup ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">No discount groups. Create one for contractor or commercial pricing.</div>
        ) : groups.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Group</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Discount</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Net Terms</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {groups.map(g => editingGroup === g.id ? (
                <tr key={g.id} className="bg-gray-50"><td colSpan={4} className="px-5 py-4"><GroupForm initial={g} onSave={saveGroup} onCancel={() => setEditingGroup(null)} /></td></tr>
              ) : (
                <tr key={g.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-gray-900">{g.name}</td>
                  <td className="px-4 py-3 text-gray-700">−{g.discount_percent}%</td>
                  <td className="px-4 py-3 text-gray-500">{g.default_net_terms || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => { setEditingGroup(g.id); setAddingGroup(false); }} className="p-1.5 rounded text-gray-400 hover:text-accent hover:bg-blue-50"><Edit2 size={13} /></button>
                      <button onClick={() => deleteGroup(g.id)} className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
