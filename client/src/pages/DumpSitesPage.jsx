import { useCallback, useEffect, useState } from 'react';
import { MapPin, Navigation, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { api } from '../utils/api';

// ── Dump Sites ────────────────────────────────────────────────────────────────
//
// The landfills / transfer stations this business hauls to. Owner-managed reference
// data: a name and an address. The guided pickup flow lists these so the driver picks
// where the load is going and taps straight through to directions.
//
// Deliberately NOT priced and NOT geocoded — no distance is computed and nothing here
// touches the mileage fee, the weight allowance, or the overage rate. Retiring a site
// is a soft delete so an older dump ticket that names it still reads correctly.

// Directions in whatever maps app the device prefers. Address-only — the maps app
// resolves the destination string itself.
function directionsUrl(address) {
  return address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null;
}

const fieldCls = 'w-full text-sm border border-divider rounded-lg px-3 py-2 bg-surface text-content focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'block text-xs font-semibold text-muted uppercase tracking-wide mb-1';

function SiteForm({ initial, onSave, onCancel, busy }) {
  const [name, setName] = useState(initial?.name || '');
  const [address, setAddress] = useState(initial?.address || '');
  const [notes, setNotes] = useState(initial?.notes || '');

  return (
    <div className="border border-divider rounded-xl p-4 space-y-3 bg-surface-2/40">
      <div>
        <label className={labelCls}>Site name <span className="text-danger">*</span></label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. County Transfer Station"
          className={fieldCls}
        />
      </div>
      <div>
        <label className={labelCls}>Address</label>
        <input
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="Street, city, state — this is what Directions opens"
          className={fieldCls}
        />
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Hours, gate code, which scale to use…"
          className={fieldCls}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave({ name, address, notes })}
          disabled={busy || !name.trim()}
          className="text-sm font-semibold text-white bg-brand hover:opacity-90 disabled:opacity-40 px-3 py-2 rounded-lg transition-colors"
        >
          {busy ? 'Saving…' : 'Save site'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex items-center gap-1.5 text-sm font-medium text-muted bg-surface-2 hover:bg-divider px-3 py-2 rounded-lg transition-colors"
        >
          <X size={14} /> Cancel
        </button>
      </div>
    </div>
  );
}

function SiteRow({ site, onEdit, onRetire, onRestore, busy }) {
  const maps = directionsUrl(site.address);
  const actionCls = 'flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors';

  return (
    <div className={`px-4 py-3 flex items-start gap-3 ${site.active ? '' : 'opacity-55'}`}>
      <MapPin size={15} className="text-muted flex-shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-content truncate">
          {site.name}
          {!site.active && <span className="ml-2 text-[10px] font-bold uppercase text-muted">Retired</span>}
        </p>
        {site.address && <p className="text-xs text-muted truncate">{site.address}</p>}
        {site.notes && <p className="text-xs text-muted italic truncate">{site.notes}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {maps ? (
            <a href={maps} target="_blank" rel="noreferrer" className={`${actionCls} text-content bg-surface-2 hover:bg-divider`}>
              <Navigation size={11} /> Get directions
            </a>
          ) : (
            <span className={`${actionCls} text-muted bg-surface-2 opacity-60 cursor-default`} title="Add an address to get directions">
              <Navigation size={11} /> Get directions
            </span>
          )}
          <button onClick={() => onEdit(site)} disabled={busy} className={`${actionCls} text-brand bg-brand/10 hover:bg-brand/20 disabled:opacity-50`}>
            <Pencil size={11} /> Edit
          </button>
          {site.active ? (
            <button onClick={() => onRetire(site)} disabled={busy} className={`${actionCls} text-muted bg-surface-2 hover:bg-divider disabled:opacity-50`}>
              <Trash2 size={11} /> Retire
            </button>
          ) : (
            <button onClick={() => onRestore(site)} disabled={busy} className={`${actionCls} text-muted bg-surface-2 hover:bg-divider disabled:opacity-50`}>
              <RotateCcw size={11} /> Restore
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DumpSitesPage() {
  const [sites, setSites] = useState(null);
  const [showRetired, setShowRetired] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback((withRetired) => {
    api.getDumpSites(withRetired ? { include_retired: 1 } : {})
      .then(d => { setSites(d.sites || []); setErr(null); })
      .catch(e => { setSites([]); setErr(e.message || 'Could not load your dump sites.'); });
  }, []);

  useEffect(() => { load(showRetired); }, [load, showRetired]);

  const run = async (fn) => {
    setBusy(true); setErr(null);
    try {
      await fn();
      setAdding(false); setEditing(null);
      load(showRetired);
    } catch (e) {
      setErr(e.message || 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <section className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-divider flex items-center gap-2">
          <MapPin size={16} className="text-brand" />
          <h2 className="text-sm font-bold text-content">Dump Sites</h2>
          <span className="text-xs text-muted">Where your loads go</span>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={showRetired}
                onChange={e => setShowRetired(e.target.checked)}
                className="rounded"
              />
              Show retired
            </label>
            <button
              onClick={() => { setAdding(true); setEditing(null); }}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-brand hover:opacity-90 px-2.5 py-1.5 rounded-lg transition-colors"
            >
              <Plus size={13} /> Add site
            </button>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-muted">
            These appear in the pickup flow on the Schedule, so a driver can pick where
            they're taking the load and open directions in one tap. Names and addresses
            only — nothing here affects pricing, mileage, or weight allowances.
          </p>

          {err && <p className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{err}</p>}

          {adding && (
            <SiteForm
              busy={busy}
              onCancel={() => setAdding(false)}
              onSave={(body) => run(() => api.createDumpSite(body))}
            />
          )}

          {sites === null ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : sites.length === 0 ? (
            <p className="text-sm text-muted italic">
              No dump sites yet. Add the landfills and transfer stations you use and
              they'll be one tap away during a pickup.
            </p>
          ) : (
            <div className="border border-divider rounded-xl divide-y divide-divider overflow-hidden">
              {sites.map(site => (
                editing?.id === site.id ? (
                  <div key={site.id} className="p-4">
                    <SiteForm
                      initial={site}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={(body) => run(() => api.updateDumpSite(site.id, body))}
                    />
                  </div>
                ) : (
                  <SiteRow
                    key={site.id}
                    site={site}
                    busy={busy}
                    onEdit={(s) => { setEditing(s); setAdding(false); }}
                    onRetire={(s) => run(() => api.retireDumpSite(s.id))}
                    onRestore={(s) => run(() => api.updateDumpSite(s.id, { active: true }))}
                  />
                )
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
