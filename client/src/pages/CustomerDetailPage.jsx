import { useEffect, useState, useCallback, Fragment } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, Phone, PhoneMissed, PhoneOutgoing, MessageSquare, Voicemail,
  StickyNote, RefreshCw, MapPin, Edit2, Trash2, Check, X, FileText, DollarSign, Plus,
  ChevronDown, ChevronRight, Zap, Briefcase, Clock,
} from 'lucide-react';
import { api } from '../utils/api';
import {
  CUSTOMER_STATUSES, CUSTOMER_STATUS_STYLES, getCustomerStatusLabel,
  JOB_STATUS_STYLES,
  INVOICE_STATUS_STYLES, getInvoiceStatusLabel,
} from '../utils/verticalConfig';
import CustomerCallIntelligence from '../components/home_services/CustomerCallIntelligence';

const money = (n, c = 'USD') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(v); }
  catch { return `$${v.toFixed(2)}`; }
};

const ACTIVITY_ICONS = {
  inbound_call: Phone,
  outbound_call: PhoneOutgoing,
  missed_call: PhoneMissed,
  voicemail: Voicemail,
  sms_sent: MessageSquare,
  status_change: RefreshCw,
  note_added: StickyNote,
};

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(' ', 'T')}Z` : iso;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const inputCls = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';

function Card({ title, icon: Icon, children, action }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} className="text-gray-500" />}
          <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function ProfileForm({ customer, onSave, onCancel }) {
  const [form, setForm] = useState({
    firstName: customer.first_name || '', lastName: customer.last_name || '',
    company: customer.company || '', phone: customer.phone || '',
    email: customer.email || '', address: customer.address || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try { await onSave(form); }
    catch (err) { setError(err.message || 'Save failed'); setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="px-5 py-4 space-y-3">
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div><label className={labelCls}>First Name</label><input className={inputCls} value={form.firstName} onChange={e => set('firstName', e.target.value)} /></div>
        <div><label className={labelCls}>Last Name</label><input className={inputCls} value={form.lastName} onChange={e => set('lastName', e.target.value)} /></div>
        <div><label className={labelCls}>Company</label><input className={inputCls} value={form.company} onChange={e => set('company', e.target.value)} /></div>
        <div><label className={labelCls}>Phone</label><input className={inputCls} value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
        <div><label className={labelCls}>Email</label><input className={inputCls} value={form.email} onChange={e => set('email', e.target.value)} /></div>
        <div><label className={labelCls}>Primary Address</label><input className={inputCls} value={form.address} onChange={e => set('address', e.target.value)} /></div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg"><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg"><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

export default function CustomerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [groups, setGroups] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [termsDraft, setTermsDraft] = useState('');
  const [priceDrafts, setPriceDrafts] = useState({});
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingTerms, setSavingTerms] = useState(false);

  const load = useCallback(() => {
    return Promise.all([api.getCustomer(id), api.getPricing(), api.getInvoices({ customer_id: id })]).then(([c, p, inv]) => {
      setCustomer(c);
      setGroups(p.groups || []);
      setInvoices(inv || []);
      setNotesDraft(c.notes || '');
      setTermsDraft(c.contract_terms || '');
    });
  }, [id]);

  useEffect(() => {
    setLoading(true);
    load().catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  const patch = async (body) => {
    await api.updateCustomer(id, body);
    await load();
  };

  const handleProfileSave = async (form) => {
    await patch(form);
    setEditingProfile(false);
  };

  const handleStatusChange = async (value) => {
    await patch({ status: value }); // 'auto' releases the manual override
  };

  const handleGroupChange = async (value) => {
    await patch({ discount_group_id: value === '' ? null : Number(value) });
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    try { await patch({ notes: notesDraft }); } finally { setSavingNotes(false); }
  };
  const saveTerms = async () => {
    setSavingTerms(true);
    try { await patch({ contract_terms: termsDraft }); } finally { setSavingTerms(false); }
  };

  const saveOverride = async (key, label, unit) => {
    const raw = priceDrafts[key];
    if (raw === undefined) return; // untouched
    const body = { service_key: key, label, unit, custom_price: raw === '' ? null : Number(raw) };
    const pricing = await api.setCustomerPricing(id, body);
    setCustomer(c => ({ ...c, pricing }));
    setPriceDrafts(d => { const n = { ...d }; delete n[key]; return n; });
  };

  const handleDelete = async () => {
    if (!confirm('Delete this customer? Their calls and jobs are preserved.')) return;
    await api.deleteCustomer(id);
    navigate('/customers');
  };

  // Manually close an Active Inquiry (Mark Lost / Close). The engagement's open
  // calls go terminal, so it leaves the action queue; booked/completed work is
  // never affected. Nothing here re-runs extraction or booking.
  const handleCloseEngagement = async (engagement, reason) => {
    await api.closeEngagement(id, engagement.lead_ids, reason);
    await load();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" /></div>;
  }
  if (error || !customer) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link to="/customers" className="text-sm text-accent inline-flex items-center gap-1"><ArrowLeft size={14} /> Customers</Link>
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-sm text-gray-400 mt-4">{error || 'Customer not found'}</div>
      </div>
    );
  }

  const c = customer;
  const statusStyle = CUSTOMER_STATUS_STYLES[c.status] || CUSTOMER_STATUS_STYLES.lead;
  const pricing = c.pricing || { items: [], group: null };

  // Engagements: one ongoing piece of business (inquiry → job → completed). The
  // single open one (if any) is the "active" engagement, expanded below; the rest
  // (completed / closed) collapse into Job History.
  const engagements = c.engagements || [];
  const activeEngagement = engagements.find(e => e.is_active) || null;
  const historyEngagements = engagements.filter(e => !e.is_active);

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <Link to="/customers" className="text-sm text-accent inline-flex items-center gap-1 hover:underline"><ArrowLeft size={14} /> Customers</Link>

      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold text-gray-900">{c.display_name}</h1>
              <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${statusStyle}`}>
                {getCustomerStatusLabel(c.status)}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              {[c.company, c.phone, c.email].filter(Boolean).join(' · ') || 'No contact info'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right">
              <select
                value={c.status_overridden ? c.status : '__derived__'}
                onChange={e => handleStatusChange(e.target.value === '__derived__' ? 'auto' : e.target.value)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="__derived__">Auto (from jobs)</option>
                {CUSTOMER_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <p className="text-[10px] text-gray-400 mt-1">{c.status_overridden ? 'Pinned manually' : 'Auto from job history'}</p>
            </div>
            <button onClick={handleDelete} title="Delete customer" className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
          </div>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-4 gap-3 mt-4">
          {[
            ['Jobs', c.totals.jobs],
            ['Open', c.totals.open_jobs],
            ['Completed', c.totals.completed_jobs],
            ['Revenue', c.totals.total_revenue ? `$${c.totals.total_revenue.toLocaleString()}` : '$0'],
          ].map(([label, val]) => (
            <div key={label} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
              <p className="text-lg font-bold text-gray-900">{val}</p>
              <p className="text-[11px] text-gray-500">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Active engagement — the current Active Inquiry or booked Job, expanded by
          default so its details (booking signals, key dates, industry fields, AI
          summary, recording) show on load. Display-only; never re-runs booking. */}
      {activeEngagement && (
        <ActiveEngagement engagement={activeEngagement} onClose={handleCloseEngagement} />
      )}

      {/* Contact / profile */}
      <Card
        title="Contact"
        action={!editingProfile && (
          <button onClick={() => setEditingProfile(true)} className="flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent/80"><Edit2 size={13} /> Edit</button>
        )}
      >
        {editingProfile ? (
          <ProfileForm customer={c} onSave={handleProfileSave} onCancel={() => setEditingProfile(false)} />
        ) : (
          <div className="px-5 py-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Field label="Name" value={[c.first_name, c.last_name].filter(Boolean).join(' ')} />
            <Field label="Company" value={c.company} />
            <Field label="Phone" value={c.phone} />
            <Field label="Email" value={c.email} />
            <div className="col-span-2">
              <p className={labelCls}>Addresses</p>
              {c.addresses.length === 0 ? <p className="text-gray-400">—</p> : (
                <div className="space-y-1">
                  {c.addresses.map((a, i) => (
                    <p key={i} className="text-gray-700 flex items-center gap-1.5"><MapPin size={13} className="text-gray-400" /> {a}</p>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Job History — completed and closed engagements, collapsed for review.
          Each row expands to that engagement's calls + intelligence. */}
      <Card
        title={`Job History (${historyEngagements.length})`}
        action={historyEngagements.length > 0 && <span className="text-[11px] text-gray-400">Tap to expand</span>}
      >
        {historyEngagements.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            {activeEngagement ? 'No completed or closed jobs yet.' : 'No jobs yet.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Service</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {historyEngagements.map(e => <EngagementRow key={e.id} engagement={e} />)}
            </tbody>
          </table>
        )}
      </Card>

      {/* Per-client pricing */}
      <Card title="Pricing" icon={DollarSign}>
        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Discount Group</label>
              <select value={c.discount_group_id || ''} onChange={e => handleGroupChange(e.target.value)} className={inputCls}>
                <option value="">No group (retail)</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name} (−{g.discount_percent}%)</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Contract Terms</label>
              <div className="flex gap-2">
                <input className={inputCls} value={termsDraft} onChange={e => setTermsDraft(e.target.value)} placeholder="e.g. Net 30, PO required" />
                {termsDraft !== (c.contract_terms || '') && (
                  <button onClick={saveTerms} disabled={savingTerms} className="text-xs font-medium text-white bg-accent hover:bg-accent/90 px-3 rounded-lg disabled:opacity-50">Save</button>
                )}
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className={labelCls + ' mb-0'}>Effective Rates</p>
              <Link to="/pricing" className="text-[11px] text-accent hover:underline">Edit default price list →</Link>
            </div>
            {pricing.items.length === 0 ? (
              <p className="text-sm text-gray-400">No price list yet. <Link to="/pricing" className="text-accent hover:underline">Set up default prices</Link>.</p>
            ) : (
              <table className="w-full text-sm border border-gray-100 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Service</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Default</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Custom</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Effective</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {pricing.items.map(it => {
                    const draftVal = priceDrafts[it.service_key] !== undefined
                      ? priceDrafts[it.service_key]
                      : (it.custom_price != null ? String(it.custom_price) : '');
                    return (
                      <tr key={it.service_key}>
                        <td className="px-3 py-2 text-gray-800">{it.label}{it.unit ? <span className="text-gray-400 text-xs"> / {it.unit}</span> : null}</td>
                        <td className="px-3 py-2 text-gray-500">{it.default_price != null ? `$${it.default_price}` : '—'}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <span className="text-gray-400 text-xs">$</span>
                            <input
                              type="number" min="0" step="0.01"
                              value={draftVal}
                              placeholder="—"
                              onChange={e => setPriceDrafts(d => ({ ...d, [it.service_key]: e.target.value }))}
                              onBlur={() => saveOverride(it.service_key, it.label, it.unit)}
                              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                              className="w-20 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-semibold text-gray-900">{it.effective_price != null ? `$${it.effective_price}` : '—'}</span>
                          {it.source !== 'default' && (
                            <span className={`ml-1.5 text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${it.source === 'custom' ? 'bg-violet-100 text-violet-700' : 'bg-amber-100 text-amber-700'}`}>{it.source}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="text-[11px] text-gray-400 mt-1.5">Effective rate = custom override, else group discount, else the default price.</p>
          </div>
        </div>
      </Card>

      {/* Invoices */}
      <Card
        title={`Invoices (${invoices.length})`}
        icon={FileText}
        action={
          <button onClick={() => navigate(`/invoices/new?customer_id=${id}`)} className="flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent/80">
            <Plus size={13} /> New Invoice
          </button>
        }
      >
        {invoices.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-gray-400">No invoices yet.</p>
            <p className="text-xs text-gray-400 mt-1">Create one — line items and terms prefill from this customer's rates.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Invoice</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Issued</th>
                <th className="text-right px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-50 cursor-pointer transition-colors" onClick={() => navigate(`/invoices/${inv.id}`)}>
                  <td className="px-5 py-3 font-medium text-gray-800">{inv.invoice_number}</td>
                  <td className="px-4 py-3">
                    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${INVOICE_STATUS_STYLES[inv.status] || INVOICE_STATUS_STYLES.draft}`}>
                      {getInvoiceStatusLabel(inv.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(inv.issue_date)}</td>
                  <td className="px-5 py-3 text-right text-gray-900 font-medium whitespace-nowrap">{money(inv.total, inv.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Activity timeline */}
      <Card title={`Activity (${c.activity.length})`}>
        {c.activity.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">No activity yet.</div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {c.activity.map(a => {
              const Icon = ACTIVITY_ICONS[a.activity_type] || StickyNote;
              return (
                <li key={a.id} className="px-5 py-3 flex items-start gap-3">
                  <Icon size={15} className="text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700">{a.description || a.activity_type}</p>
                    <p className="text-xs text-gray-400">{fmtDateTime(a.created_at)}</p>
                  </div>
                  <Link to={`/leads/${a.lead_id}`} className="text-[11px] text-accent hover:underline flex-shrink-0">Job →</Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Notes */}
      <Card title="Notes" icon={StickyNote}>
        <div className="px-5 py-4 space-y-2">
          <textarea
            value={notesDraft}
            onChange={e => setNotesDraft(e.target.value)}
            rows={4}
            placeholder="Free-text notes about this customer…"
            className={inputCls + ' resize-y'}
          />
          {notesDraft !== (c.notes || '') && (
            <div className="flex justify-end">
              <button onClick={saveNotes} disabled={savingNotes} className="flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded-lg">
                <Check size={14} /> {savingNotes ? 'Saving…' : 'Save notes'}
              </button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className="text-gray-800">{value || '—'}</p>
    </div>
  );
}

// The body shared by the active engagement and an expanded history row: the
// newest call's full intelligence (booking signals, dates, industry fields, AI
// summary, recording) plus any earlier calls in the same engagement, expandable.
function EngagementBody({ engagement: e }) {
  const [openCalls, setOpenCalls] = useState(() => new Set());
  const toggle = (cid) => setOpenCalls(prev => {
    const next = new Set(prev);
    if (next.has(cid)) next.delete(cid); else next.add(cid);
    return next;
  });
  const earlier = (e.calls || []).slice(1); // calls[0] is the representative (newest)

  return (
    <>
      <CustomerCallIntelligence jobId={e.representative_lead_id} />
      {earlier.length > 0 && (
        <div className="px-5 pb-4">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
            Earlier calls in this engagement ({earlier.length})
          </p>
          <div className="border border-gray-100 rounded-lg divide-y divide-gray-50 overflow-hidden">
            {earlier.map(call => {
              const open = openCalls.has(call.id);
              return (
                <Fragment key={call.id}>
                  <button
                    onClick={() => toggle(call.id)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
                  >
                    <span className="flex items-center gap-2 text-sm text-gray-700">
                      {open ? <ChevronDown size={13} className="text-gray-400" /> : <ChevronRight size={13} className="text-gray-400" />}
                      {fmtDateTime(call.created_at) || fmtDate(call.created_at)}
                    </span>
                    <span className="text-xs text-gray-400">{call.service}</span>
                  </button>
                  {open && <CustomerCallIntelligence jobId={call.id} />}
                </Fragment>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// The active engagement — the open Active Inquiry or booked Job — rendered
// expanded with its status, a Stale flag for an idle inquiry, and (for an
// inquiry) the manual Close / Mark Lost actions. Nothing here changes booking.
function ActiveEngagement({ engagement: e, onClose }) {
  const [closing, setClosing] = useState(false);
  const style = JOB_STATUS_STYLES[e.status] || JOB_STATUS_STYLES.inquiry;
  const close = async (reason) => {
    const msg = reason === 'lost'
      ? 'Mark this inquiry as Lost? It will close and leave the action queue.'
      : 'Close this inquiry? It will leave the action queue.';
    if (!confirm(msg)) return;
    setClosing(true);
    try { await onClose(e, reason); } finally { setClosing(false); }
  };

  return (
    <Card title={e.label} icon={e.status === 'booked' ? Briefcase : MessageSquare}>
      <div className="px-5 pt-4 flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${style}`}>{e.label}</span>
        {e.stale && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border bg-orange-100 text-orange-700 border-orange-200">
            <Clock size={11} /> Stale
          </span>
        )}
        {e.auto_booked && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-700 border-emerald-200">
            <Zap size={11} /> Auto-booked
          </span>
        )}
        <span className="flex-1" />
        {e.estimated_revenue ? <span className="text-sm font-semibold text-gray-900">${Math.round(e.estimated_revenue).toLocaleString()}</span> : null}
      </div>

      <EngagementBody engagement={e} />

      {e.status === 'inquiry' && (
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <span className="text-[11px] text-gray-400 mr-auto">Inquiries stay open until you close them.</span>
          <button onClick={() => close('lost')} disabled={closing} className="text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg disabled:opacity-50">Mark Lost</button>
          <button onClick={() => close('closed')} disabled={closing} className="text-xs font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 px-3 py-1.5 rounded-lg disabled:opacity-50">Close</button>
        </div>
      )}
    </Card>
  );
}

// One collapsed history engagement (completed / closed). Expands to its calls.
function EngagementRow({ engagement: e }) {
  const [open, setOpen] = useState(false);
  const style = JOB_STATUS_STYLES[e.status] || 'bg-gray-100 text-gray-500';
  return (
    <Fragment>
      <tr className="hover:bg-gray-50 cursor-pointer transition-colors" onClick={() => setOpen(o => !o)}>
        <td className="px-5 py-3 text-gray-800">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />}
            <span>{e.service}</span>
            {e.auto_booked && (
              <span title="Auto-booked from the call" className="inline-flex items-center text-emerald-500"><Zap size={12} /></span>
            )}
          </div>
        </td>
        <td className="px-4 py-3">
          <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${style}`}>{e.label}</span>
        </td>
        <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{e.delivery_date ? fmtDate(e.delivery_date) : fmtDate(e.created_at)}</td>
        <td className="px-4 py-3 text-gray-700">{e.estimated_revenue ? `$${Math.round(e.estimated_revenue).toLocaleString()}` : '—'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="p-0 border-t border-gray-100">
            <EngagementBody engagement={e} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
