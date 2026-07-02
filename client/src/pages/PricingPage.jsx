import { useEffect, useState, useCallback } from 'react';
import {
  DollarSign, Percent, PlusCircle, Edit2, Trash2, X, Check, Truck, Ban, Package,
} from 'lucide-react';
import { api } from '../utils/api';

const inputCls = 'w-full text-sm border border-divider rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'block text-xs font-medium text-muted uppercase tracking-wide mb-1';
const btnPrimary = 'flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg';
const btnGhost = 'flex items-center gap-1.5 text-sm text-muted hover:text-content px-3 py-2 rounded-lg';

// Segmented (pick-one) control — the "which model do you use" toggle.
function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex rounded-lg border border-divider overflow-hidden">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`text-xs font-medium px-3 py-1.5 transition-colors ${value === o.value ? 'bg-accent text-content' : 'bg-surface text-muted hover:text-content hover:bg-surface-2'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// "Do you offer this?" switch — the toggle-what-you-offer pattern.
function OfferToggle({ checked, onChange, label }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2 text-sm">
      <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-divider'}`}>
        <span className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-surface shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </span>
      <span className="text-content">{label}</span>
    </button>
  );
}

function emptyConfig() {
  return {
    pricing_style: 'flat',
    flat_rate: '',
    tiers: [],
    weight_allowance_tons: '',
    overage_rate_per_ton: '',
    day_rate: { enabled: false, rate: '' },
    swap: { mode: 'same_as_rate', custom_price: '' },
  };
}

// Merge a stored config (possibly null / partial) over the empty shape so every
// control is controlled and defined.
function toFormConfig(cfg, legacyRate) {
  const base = emptyConfig();
  // Legacy row with no saved pricing model yet: default to Flat and carry the old
  // base rate (unit_price) forward as the flat rate, so an existing size's price
  // migrates into the model on next save instead of being lost.
  if (!cfg || typeof cfg !== 'object') return { ...base, flat_rate: legacyRate ?? '' };
  return {
    pricing_style: cfg.pricing_style === 'tiered' ? 'tiered' : 'flat',
    flat_rate: cfg.flat_rate ?? '',
    tiers: Array.isArray(cfg.tiers) ? cfg.tiers.map((t) => ({ label: t.label ?? '', days: t.days ?? '', rate: t.rate ?? '' })) : [],
    weight_allowance_tons: cfg.weight_allowance_tons ?? '',
    overage_rate_per_ton: cfg.overage_rate_per_ton ?? '',
    day_rate: { enabled: !!(cfg.day_rate && cfg.day_rate.enabled), rate: (cfg.day_rate && cfg.day_rate.rate) ?? '' },
    swap: { mode: (cfg.swap && cfg.swap.mode) || 'same_as_rate', custom_price: (cfg.swap && cfg.swap.custom_price) ?? '' },
  };
}

// ── Per-size config editor ─────────────────────────────────────────────────────
function SizeConfigForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({
    label: initial?.label || '',
  });
  const [cfg, setCfg] = useState(toFormConfig(initial?.pricing_config, initial?.unit_price));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setC = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setTier = (i, k, v) => setCfg((c) => ({ ...c, tiers: c.tiers.map((t, idx) => (idx === i ? { ...t, [k]: v } : t)) }));
  const addTier = () => setCfg((c) => ({ ...c, tiers: [...c.tiers, { label: '', days: '', rate: '' }] }));
  const removeTier = (i) => setCfg((c) => ({ ...c, tiers: c.tiers.filter((_, idx) => idx !== i) }));

  const submit = async (e) => {
    e.preventDefault();
    const size = form.label.trim();
    if (!size) { setError('Size is required'); return; }
    setSaving(true); setError(null);
    try {
      await onSave({
        // The internal size key is derived from the Size by the shared server-side
        // normalizer ("20 Yard Dumpster" → "20yd"); unit is always 'rental' here.
        // Neither is shown in the form. unit_price (the legacy base rate) is omitted
        // so an existing size's stored value is preserved on edit.
        service_key: size,
        label: size,
        unit: initial?.unit || 'rental',
        pricing_config: cfg,
      });
    } catch (err) { setError(err.message || 'Save failed'); setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <p className="text-xs text-danger">{error}</p>}

      {/* Size — the human-facing name. The internal size key is derived from this. */}
      <div className="max-w-sm">
        <label className={labelCls}>Size</label>
        <input className={inputCls} value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="20 Yard Dumpster" />
      </div>

      {/* Pricing model: flat vs tiered */}
      <div className="border-t border-divider pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-content uppercase tracking-wide">Pricing Model</span>
          <Segmented
            value={cfg.pricing_style}
            onChange={(v) => setC('pricing_style', v)}
            options={[{ value: 'flat', label: 'Flat' }, { value: 'tiered', label: 'Tiered' }]}
          />
        </div>
        {cfg.pricing_style === 'flat' ? (
          <div className="max-w-xs"><label className={labelCls}>Flat Rate ($)</label><input type="number" min="0" step="0.01" className={inputCls} value={cfg.flat_rate} onChange={(e) => setC('flat_rate', e.target.value)} /></div>
        ) : (
          <div className="space-y-2">
            {cfg.tiers.length === 0 && <p className="text-xs text-muted">No tiers yet — add one per rental length (e.g. 3-day, 7-day).</p>}
            {cfg.tiers.map((t, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-end">
                <div className="col-span-5"><label className={labelCls}>Label</label><input className={inputCls} value={t.label} onChange={(e) => setTier(i, 'label', e.target.value)} placeholder="7-day" /></div>
                <div className="col-span-3"><label className={labelCls}>Days</label><input type="number" min="0" step="1" className={inputCls} value={t.days} onChange={(e) => setTier(i, 'days', e.target.value)} placeholder="7" /></div>
                <div className="col-span-3"><label className={labelCls}>Rate ($)</label><input type="number" min="0" step="0.01" className={inputCls} value={t.rate} onChange={(e) => setTier(i, 'rate', e.target.value)} placeholder="545" /></div>
                <div className="col-span-1"><button type="button" onClick={() => removeTier(i)} className="p-2 rounded text-muted hover:text-danger hover:bg-danger/10"><Trash2 size={14} /></button></div>
              </div>
            ))}
            <button type="button" onClick={addTier} className="flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"><PlusCircle size={13} /> Add tier</button>
          </div>
        )}
      </div>

      {/* Weight allowance + overage */}
      <div className="border-t border-divider pt-4 grid grid-cols-2 gap-3 max-w-md">
        <div><label className={labelCls}>Weight Allowance (tons)</label><input type="number" min="0" step="0.1" className={inputCls} value={cfg.weight_allowance_tons} onChange={(e) => setC('weight_allowance_tons', e.target.value)} placeholder="2" /></div>
        <div><label className={labelCls}>Overage ($/ton)</label><input type="number" min="0" step="0.01" className={inputCls} value={cfg.overage_rate_per_ton} onChange={(e) => setC('overage_rate_per_ton', e.target.value)} placeholder="75" /></div>
      </div>

      {/* Day rate (optional) */}
      <div className="border-t border-divider pt-4 space-y-2">
        <OfferToggle checked={cfg.day_rate.enabled} onChange={(v) => setC('day_rate', { ...cfg.day_rate, enabled: v })} label="Offer extra-day rate" />
        {cfg.day_rate.enabled && (
          <div className="max-w-xs"><label className={labelCls}>Per Extra Day ($)</label><input type="number" min="0" step="0.01" className={inputCls} value={cfg.day_rate.rate} onChange={(e) => setC('day_rate', { ...cfg.day_rate, rate: e.target.value })} /></div>
        )}
      </div>

      {/* Swap */}
      <div className="border-t border-divider pt-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-content uppercase tracking-wide">Swap-out</span>
          <Segmented
            value={cfg.swap.mode}
            onChange={(v) => setC('swap', { ...cfg.swap, mode: v })}
            options={[{ value: 'same_as_rate', label: 'Same as rate' }, { value: 'custom', label: 'Custom' }, { value: 'off', label: 'Off' }]}
          />
        </div>
        {cfg.swap.mode === 'custom' && (
          <div className="max-w-xs"><label className={labelCls}>Swap Price ($)</label><input type="number" min="0" step="0.01" className={inputCls} value={cfg.swap.custom_price} onChange={(e) => setC('swap', { ...cfg.swap, custom_price: e.target.value })} /></div>
        )}
      </div>

      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className={btnGhost}><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className={btnPrimary}><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

// Read-only summary chips for a size card.
function SizeSummary({ it }) {
  const c = it.pricing_config || {};
  const chips = [];
  if (c.pricing_style === 'tiered') chips.push(`Tiered · ${(c.tiers || []).length} tier${(c.tiers || []).length === 1 ? '' : 's'}`);
  else if (c.pricing_style === 'flat' && c.flat_rate != null) chips.push(`Flat $${c.flat_rate}`);
  else if (it.unit_price != null) chips.push(`Flat $${it.unit_price}`); // legacy row: show base rate until re-saved
  if (c.weight_allowance_tons != null) chips.push(`${c.weight_allowance_tons}t incl.`);
  if (c.overage_rate_per_ton != null) chips.push(`$${c.overage_rate_per_ton}/ton over`);
  if (c.day_rate && c.day_rate.enabled && c.day_rate.rate != null) chips.push(`+$${c.day_rate.rate}/day`);
  if (c.swap && c.swap.mode === 'custom' && c.swap.custom_price != null) chips.push(`Swap $${c.swap.custom_price}`);
  else if (c.swap && c.swap.mode === 'off') chips.push('No swap');
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {chips.map((ch, i) => <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-surface-2 text-muted border border-divider">{ch}</span>)}
    </div>
  );
}

// ── Business fee editor ─────────────────────────────────────────────────────────
function FeeForm({ initial, onSave, onCancel }) {
  const isMileage = (initial?.fee_type || 'delivery') === 'mileage';
  const [form, setForm] = useState({
    fee_type: initial?.fee_type || 'delivery',
    label: initial?.label || '',
    amount: initial?.amount ?? '',
    enabled: initial ? !!initial.enabled : true,
    threshold_miles: (initial?.config && initial.config.threshold_miles) ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const mileage = form.fee_type === 'mileage';

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const body = {
        fee_type: form.fee_type,
        label: form.label.trim() || (mileage ? 'Out-of-area' : 'Delivery'),
        amount: form.amount === '' ? null : Number(form.amount),
        enabled: form.enabled,
        config: mileage ? { threshold_miles: form.threshold_miles === '' ? null : Number(form.threshold_miles) } : null,
      };
      await onSave(body);
    } catch (err) { setError(err.message || 'Save failed'); setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-between">
        <Segmented
          value={form.fee_type}
          onChange={(v) => set('fee_type', v)}
          options={[{ value: 'delivery', label: 'Delivery (flat)' }, { value: 'mileage', label: 'Mileage / out-of-area' }]}
        />
        <OfferToggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div><label className={labelCls}>Label</label><input className={inputCls} value={form.label} onChange={(e) => set('label', e.target.value)} placeholder={mileage ? 'Out-of-area' : 'Delivery'} /></div>
        <div><label className={labelCls}>{mileage ? 'Rate ($/mile)' : 'Amount ($)'}</label><input type="number" min="0" step="0.01" className={inputCls} value={form.amount} onChange={(e) => set('amount', e.target.value)} /></div>
        {mileage && <div><label className={labelCls}>Beyond (miles)</label><input type="number" min="0" step="1" className={inputCls} value={form.threshold_miles} onChange={(e) => set('threshold_miles', e.target.value)} placeholder="25" /></div>}
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className={btnGhost}><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className={btnPrimary}><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

// ── Special / restricted item editor ───────────────────────────────────────────
function SpecialItemForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    kind: initial?.kind || 'surcharge',
    charge_amount: initial?.charge_amount ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      await onSave({
        name: form.name.trim(),
        kind: form.kind,
        charge_amount: form.kind === 'surcharge' && form.charge_amount !== '' ? Number(form.charge_amount) : null,
      });
    } catch (err) { setError(err.message || 'Save failed'); setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 items-end">
        <div><label className={labelCls}>Item</label><input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Mattress" /></div>
        <div>
          <label className={labelCls}>Type</label>
          <Segmented
            value={form.kind}
            onChange={(v) => set('kind', v)}
            options={[{ value: 'surcharge', label: 'Surcharge' }, { value: 'prohibited', label: 'Prohibited' }]}
          />
        </div>
        {form.kind === 'surcharge' && <div><label className={labelCls}>Charge ($)</label><input type="number" min="0" step="0.01" className={inputCls} value={form.charge_amount} onChange={(e) => set('charge_amount', e.target.value)} placeholder="40" /></div>}
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className={btnGhost}><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className={btnPrimary}><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
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
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try { await onSave({ ...form, discount_percent: Number(form.discount_percent) || 0 }); }
    catch (err) { setError(err.message || 'Save failed'); setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="grid grid-cols-3 gap-3">
        <div><label className={labelCls}>Group Name</label><input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Contractor" /></div>
        <div><label className={labelCls}>Discount %</label><input type="number" min="0" max="100" step="0.1" className={inputCls} value={form.discount_percent} onChange={(e) => set('discount_percent', e.target.value)} /></div>
        <div><label className={labelCls}>Default Net Terms</label><input className={inputCls} value={form.default_net_terms} onChange={(e) => set('default_net_terms', e.target.value)} placeholder="Net 30" /></div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className={btnGhost}><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className={btnPrimary}><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

// Card section wrapper with a titled header + add button.
function Section({ icon, title, count, adding, onAdd, addLabel, children }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-divider flex items-center justify-between">
        <div className="flex items-center gap-2">{icon}<h2 className="text-sm font-bold text-content">{title}{count != null ? ` (${count})` : ''}</h2></div>
        {!adding && onAdd && <button onClick={onAdd} className="flex items-center gap-1.5 text-sm font-medium text-content bg-accent hover:bg-accent/90 px-3 py-1.5 rounded-lg"><PlusCircle size={14} /> {addLabel}</button>}
      </div>
      {children}
    </div>
  );
}

export default function PricingPage() {
  const [items, setItems] = useState([]);
  const [groups, setGroups] = useState([]);
  const [fees, setFees] = useState([]);
  const [specialItems, setSpecialItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const [addingItem, setAddingItem] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [addingFee, setAddingFee] = useState(false);
  const [editingFee, setEditingFee] = useState(null);
  const [addingSpecial, setAddingSpecial] = useState(false);
  const [editingSpecial, setEditingSpecial] = useState(null);

  const load = useCallback(() => api.getPricing().then((p) => {
    setItems(p.items || []);
    setGroups(p.groups || []);
    setFees(p.fees || []);
    setSpecialItems(p.special_items || []);
  }), []);
  useEffect(() => { load().catch(console.error).finally(() => setLoading(false)); }, [load]);

  const saveItem = async (form) => {
    if (editingItem) await api.updatePriceItem(editingItem, form);
    else await api.createPriceItem(form);
    setAddingItem(false); setEditingItem(null);
    await load();
  };
  const deleteItem = async (id) => { if (!confirm('Delete this size?')) return; await api.deletePriceItem(id); await load(); };

  const saveGroup = async (form) => {
    if (editingGroup) await api.updateDiscountGroup(editingGroup, form);
    else await api.createDiscountGroup(form);
    setAddingGroup(false); setEditingGroup(null);
    await load();
  };
  const deleteGroup = async (id) => { if (!confirm('Delete this group? Customers in it become retail-priced.')) return; await api.deleteDiscountGroup(id); await load(); };

  const saveFee = async (form) => {
    if (editingFee) await api.updatePricingFee(editingFee, form);
    else await api.createPricingFee(form);
    setAddingFee(false); setEditingFee(null);
    await load();
  };
  const toggleFee = async (fee) => { await api.updatePricingFee(fee.id, { enabled: !fee.enabled }); await load(); };
  const deleteFee = async (id) => { if (!confirm('Delete this fee?')) return; await api.deletePricingFee(id); await load(); };

  const saveSpecial = async (form) => {
    if (editingSpecial) await api.updateSpecialItem(editingSpecial, form);
    else await api.createSpecialItem(form);
    setAddingSpecial(false); setEditingSpecial(null);
    await load();
  };
  const deleteSpecial = async (id) => { if (!confirm('Delete this item?')) return; await api.deleteSpecialItem(id); await load(); };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" /></div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <p className="text-xs text-muted px-1">
        Configure how you price each dumpster size, your business fees, and restricted items. Turn on only the
        options you offer. Discount groups apply a percentage off for contractor or commercial accounts, and any
        customer can have their own custom rate that overrides everything — set per customer on their profile.
      </p>

      {/* Sizes & rates */}
      <Section
        icon={<DollarSign size={16} className="text-muted" />}
        title="Sizes & Rates" count={items.length}
        adding={addingItem}
        onAdd={() => { setAddingItem(true); setEditingItem(null); }}
        addLabel="Add Size"
      >
        {addingItem && <div className="px-5 py-4 border-b border-divider bg-surface-2"><SizeConfigForm onSave={saveItem} onCancel={() => setAddingItem(false)} /></div>}
        {items.length === 0 && !addingItem ? (
          <div className="px-5 py-8 text-center text-sm text-muted">No sizes yet. Add your dumpster sizes and rates above.</div>
        ) : (
          <div className="divide-y divide-divider">
            {items.map((it) => editingItem === it.id ? (
              <div key={it.id} className="px-5 py-4 bg-surface-2"><SizeConfigForm initial={it} onSave={saveItem} onCancel={() => setEditingItem(null)} /></div>
            ) : (
              <div key={it.id} className="px-5 py-3.5 flex items-start justify-between hover:bg-surface-2 transition-colors">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-content">{it.label || it.service_key}</span>
                  </div>
                  <SizeSummary it={it} />
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-3">
                  <button onClick={() => { setEditingItem(it.id); setAddingItem(false); }} className="p-1.5 rounded text-muted hover:text-accent hover:bg-brand/10"><Edit2 size={13} /></button>
                  <button onClick={() => deleteItem(it.id)} className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger/10"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Business fees */}
      <Section
        icon={<Truck size={16} className="text-muted" />}
        title="Business Fees" count={fees.length}
        adding={addingFee}
        onAdd={() => { setAddingFee(true); setEditingFee(null); }}
        addLabel="Add Fee"
      >
        {addingFee && <div className="px-5 py-4 border-b border-divider bg-surface-2"><FeeForm onSave={saveFee} onCancel={() => setAddingFee(false)} /></div>}
        {fees.length === 0 && !addingFee ? (
          <div className="px-5 py-8 text-center text-sm text-muted">No fees. Add a delivery or mileage/out-of-area fee.</div>
        ) : (
          <div className="divide-y divide-divider">
            {fees.map((f) => editingFee === f.id ? (
              <div key={f.id} className="px-5 py-4 bg-surface-2"><FeeForm initial={f} onSave={saveFee} onCancel={() => setEditingFee(null)} /></div>
            ) : (
              <div key={f.id} className={`px-5 py-3.5 flex items-center justify-between hover:bg-surface-2 transition-colors ${f.enabled ? '' : 'opacity-60'}`}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-content">{f.label || (f.fee_type === 'mileage' ? 'Out-of-area' : 'Delivery')}</span>
                    <span className="text-sm text-content font-semibold">
                      {f.amount != null ? `$${f.amount}${f.fee_type === 'mileage' ? '/mi' : ''}` : '—'}
                      {f.fee_type === 'mileage' && f.config && f.config.threshold_miles != null ? ` beyond ${f.config.threshold_miles} mi` : ''}
                    </span>
                  </div>
                  {!f.enabled && <span className="text-[11px] text-muted">Disabled</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <OfferToggle checked={!!f.enabled} onChange={() => toggleFee(f)} label="" />
                  <button onClick={() => { setEditingFee(f.id); setAddingFee(false); }} className="p-1.5 rounded text-muted hover:text-accent hover:bg-brand/10"><Edit2 size={13} /></button>
                  <button onClick={() => deleteFee(f.id)} className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger/10"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Prohibited / restricted items */}
      <Section
        icon={<Ban size={16} className="text-muted" />}
        title="Prohibited Items" count={specialItems.length}
        adding={addingSpecial}
        onAdd={() => { setAddingSpecial(true); setEditingSpecial(null); }}
        addLabel="Add Item"
      >
        {addingSpecial && <div className="px-5 py-4 border-b border-divider bg-surface-2"><SpecialItemForm onSave={saveSpecial} onCancel={() => setAddingSpecial(false)} /></div>}
        {specialItems.length === 0 && !addingSpecial ? (
          <div className="px-5 py-8 text-center text-sm text-muted">No items. Add prohibited items or per-item surcharges (e.g. mattress, tires, appliances).</div>
        ) : (
          <div className="divide-y divide-divider">
            {specialItems.map((s) => editingSpecial === s.id ? (
              <div key={s.id} className="px-5 py-4 bg-surface-2"><SpecialItemForm initial={s} onSave={saveSpecial} onCancel={() => setEditingSpecial(null)} /></div>
            ) : (
              <div key={s.id} className="px-5 py-3.5 flex items-center justify-between hover:bg-surface-2 transition-colors">
                <div className="flex items-center gap-2">
                  <Package size={14} className="text-muted" />
                  <span className="font-medium text-content">{s.name}</span>
                  {s.kind === 'prohibited'
                    ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20">Prohibited</span>
                    : <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-2 text-content border border-divider">Surcharge{s.charge_amount != null ? ` · $${s.charge_amount}` : ''}</span>}
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-3">
                  <button onClick={() => { setEditingSpecial(s.id); setAddingSpecial(false); }} className="p-1.5 rounded text-muted hover:text-accent hover:bg-brand/10"><Edit2 size={13} /></button>
                  <button onClick={() => deleteSpecial(s.id)} className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger/10"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Discount groups (unchanged) */}
      <Section
        icon={<Percent size={16} className="text-muted" />}
        title="Discount Groups" count={groups.length}
        adding={addingGroup}
        onAdd={() => { setAddingGroup(true); setEditingGroup(null); }}
        addLabel="Add Group"
      >
        {addingGroup && <div className="px-5 py-4 border-b border-divider bg-surface-2"><GroupForm onSave={saveGroup} onCancel={() => setAddingGroup(false)} /></div>}
        {groups.length === 0 && !addingGroup ? (
          <div className="px-5 py-8 text-center text-sm text-muted">No discount groups. Create one for contractor or commercial pricing.</div>
        ) : groups.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-divider">
              <tr>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Group</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Discount</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Net Terms</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {groups.map((g) => editingGroup === g.id ? (
                <tr key={g.id} className="bg-surface-2"><td colSpan={4} className="px-5 py-4"><GroupForm initial={g} onSave={saveGroup} onCancel={() => setEditingGroup(null)} /></td></tr>
              ) : (
                <tr key={g.id} className="hover:bg-surface-2 transition-colors">
                  <td className="px-5 py-3 font-medium text-content">{g.name}</td>
                  <td className="px-4 py-3 text-content">−{g.discount_percent}%</td>
                  <td className="px-4 py-3 text-muted">{g.default_net_terms || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => { setEditingGroup(g.id); setAddingGroup(false); }} className="p-1.5 rounded text-muted hover:text-accent hover:bg-brand/10"><Edit2 size={13} /></button>
                      <button onClick={() => deleteGroup(g.id)} className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger/10"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
