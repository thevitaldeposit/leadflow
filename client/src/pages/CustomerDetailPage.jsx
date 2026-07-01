import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import {
  ArrowLeft, Phone, PhoneMissed, PhoneOutgoing, MessageSquare, Voicemail,
  StickyNote, RefreshCw, MapPin, Mail, Edit2, Trash2, Check, X, FileText,
  DollarSign, Plus, ChevronDown, ChevronRight, Zap, Briefcase, Clock,
  Activity, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { api } from '../utils/api';
import {
  CUSTOMER_STATUSES, CUSTOMER_STATUS_STYLES, getCustomerStatusLabel,
  getTerminology,
  INVOICE_STATUS_STYLES, getInvoiceStatusLabel,
  ENGAGEMENT_STATUS,
} from '../utils/verticalConfig';
import CustomerCallIntelligence from '../components/home_services/CustomerCallIntelligence';
import PaymentLinkSection from '../components/home_services/PaymentLinkSection';
import VoicemailBadge from '../components/home_services/VoicemailBadge';
import { BookedModal, EditJobDetailsModal } from '../components/home_services/HomeServicesStickyHeader';
import { buildBookingUpdates } from '../utils/booking';

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
  job_updated: Edit2,
  reschedule_requested: RefreshCw,
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

const inputCls = 'w-full text-sm border border-divider bg-surface rounded-lg px-3 py-2 text-content focus:outline-none focus:ring-2 focus:ring-brand';
const labelCls = 'block text-xs font-medium text-muted uppercase tracking-wide mb-1';
const badgeCls = 'inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border';

// The inline jump-links below the top card. Each smooth-scrolls the page to the
// matching inline section (single-page scroll — no separate routes).
const JUMP_LINKS = [
  { id: 'active-inquiry', label: 'Active Inquiry' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'notes', label: 'Notes' },
];

// Smooth-scroll to a DOM id, retrying across a few animation frames until it
// exists. Used by the ?call=<leadId> focus and the in-place "View job"/"View"
// links: focusing a collapsed Jobs row / Past-inquiry first force-expands it
// (a state update + re-render), so the target node may not be in the DOM on the
// same tick — this waits for it rather than scrolling to nothing.
function scrollToWhenReady(targetId, attempts = 15) {
  const el = document.getElementById(targetId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (attempts <= 0) return;
  requestAnimationFrame(() => scrollToWhenReady(targetId, attempts - 1));
}

function Card({ id, title, icon: Icon, children, action }) {
  return (
    <div id={id} className={`bg-surface rounded-xl border border-divider shadow-sm overflow-hidden ${id ? 'scroll-mt-6' : ''}`}>
      <div className="px-5 py-3.5 border-b border-divider flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} className="text-brand" />}
          <h2 className="text-sm font-bold text-content">{title}</h2>
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
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div><label className={labelCls}>First Name</label><input className={inputCls} value={form.firstName} onChange={e => set('firstName', e.target.value)} /></div>
        <div><label className={labelCls}>Last Name</label><input className={inputCls} value={form.lastName} onChange={e => set('lastName', e.target.value)} /></div>
        <div><label className={labelCls}>Company</label><input className={inputCls} value={form.company} onChange={e => set('company', e.target.value)} /></div>
        <div><label className={labelCls}>Phone</label><input className={inputCls} value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
        <div><label className={labelCls}>Email</label><input className={inputCls} value={form.email} onChange={e => set('email', e.target.value)} /></div>
        <div><label className={labelCls}>Primary Address</label><input className={inputCls} value={form.address} onChange={e => set('address', e.target.value)} /></div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="flex items-center gap-1.5 text-sm text-muted hover:text-content px-3 py-2 rounded-lg"><X size={14} /> Cancel</button>
        <button type="submit" disabled={saving} className="flex items-center gap-1.5 text-sm font-medium text-content bg-brand hover:bg-brand-hover disabled:opacity-50 px-4 py-2 rounded-lg"><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

// Initials avatar for the top card.
function Avatar({ name }) {
  const initials = (name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]?.toUpperCase()).join('') || '?';
  return (
    <div className="w-16 h-16 rounded-full bg-brand/15 text-brand flex items-center justify-center text-xl font-bold flex-shrink-0">
      {initials}
    </div>
  );
}

function ContactLine({ icon: Icon, value }) {
  if (!value) return null;
  return (
    <p className="flex items-center gap-2">
      <Icon size={14} className="text-brand flex-shrink-0" />
      <span className="text-content truncate">{value}</span>
    </p>
  );
}

// Quick Stats — the rollup numbers on the right of the top card. Real data for
// this customer; the same figures are NOT repeated in the Invoices section.
function QuickStats({ totalJobs, totalSpent, outstanding, lastJob }) {
  const rows = [
    { icon: Briefcase, label: 'Total Jobs', value: totalJobs },
    { icon: DollarSign, label: 'Total Spent', value: totalSpent },
    { icon: AlertCircle, label: 'Outstanding', value: outstanding },
    { icon: Clock, label: 'Last Job', value: lastJob },
  ];
  return (
    <div className="lg:w-72 flex-shrink-0 rounded-xl border border-divider bg-surface-2 p-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">Quick Stats</p>
      <div className="space-y-2.5">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-muted"><r.icon size={14} className="text-subtle" /> {r.label}</span>
            <span className="text-sm font-semibold text-content">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The full-height right rail. Lists interactions/events most-recent first and
// grows as the customer is interacted with (calls, status changes, invoice paid,
// notes added, …). Notes added below are merged in server-side as note_added.
function ActivityFeed({ activity, onViewCall }) {
  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm flex flex-col lg:max-h-[calc(100vh-7rem)]">
      <div className="px-5 py-3.5 border-b border-divider flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-brand" />
          <h2 className="text-sm font-bold text-content">Activity Feed</h2>
        </div>
        <span className="text-[11px] text-muted">{activity.length}</span>
      </div>
      {activity.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted">No activity yet.</div>
      ) : (
        <ul className="divide-y divide-divider overflow-y-auto scrollbar-subtle min-h-0">
          {activity.map(a => {
            const Icon = ACTIVITY_ICONS[a.activity_type] || StickyNote;
            return (
              <li key={a.id} className="px-5 py-3 flex items-start gap-3">
                <span className="mt-0.5 flex-shrink-0 w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center">
                  <Icon size={14} className="text-muted" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-content break-words">{a.description || a.activity_type}</p>
                  <p className="text-xs text-muted mt-0.5">{fmtDateTime(a.created_at)}</p>
                  {a.lead_id && onViewCall && (
                    <button
                      type="button"
                      onClick={() => onViewCall(a.lead_id)}
                      className="text-[11px] text-brand hover:underline"
                    >
                      View job →
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// One discrete note in the Notes section, with inline edit + delete. Editing
// and deleting are Notes-section-only — the Activity Feed has no such controls;
// its note_added entry is derived from this note server-side, so an edit/delete
// here flows through to the feed on reload automatically.
function NoteItem({ note, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [busy, setBusy] = useState(false);

  const startEdit = () => { setDraft(note.body); setEditing(true); };
  const cancel = () => { setEditing(false); setDraft(note.body); };

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    if (body === note.body) { cancel(); return; } // unchanged — skip the round-trip
    setBusy(true);
    try { await onEdit(note.id, body); setEditing(false); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm('Delete this note? This cannot be undone.')) return;
    setBusy(true);
    try { await onDelete(note.id); }
    finally { setBusy(false); }
  };

  if (editing) {
    return (
      <li className="rounded-lg border border-divider bg-surface-2 px-3 py-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={3}
          autoFocus
          className={inputCls + ' resize-y'}
        />
        <div className="flex justify-end gap-2 mt-2">
          <button onClick={cancel} disabled={busy} className="flex items-center gap-1.5 text-xs text-muted hover:text-content px-2.5 py-1.5 rounded-lg disabled:opacity-50"><X size={13} /> Cancel</button>
          <button onClick={save} disabled={busy || !draft.trim()} className="flex items-center gap-1.5 text-xs font-medium text-content bg-brand hover:bg-brand-hover disabled:opacity-50 px-3 py-1.5 rounded-lg"><Check size={13} /> {busy ? 'Saving…' : 'Save'}</button>
        </div>
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-divider bg-surface-2 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-content whitespace-pre-wrap flex-1 min-w-0">{note.body}</p>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button onClick={startEdit} disabled={busy} title="Edit note" className="p-1 rounded text-subtle hover:text-brand hover:bg-surface disabled:opacity-50"><Edit2 size={13} /></button>
          <button onClick={remove} disabled={busy} title="Delete note" className="p-1 rounded text-subtle hover:text-danger hover:bg-danger/10 disabled:opacity-50"><Trash2 size={13} /></button>
        </div>
      </div>
      <p className="text-xs text-muted mt-1">{fmtDateTime(note.created_at)}</p>
    </li>
  );
}

// Notes section — discrete notes the owner adds (important for outbound
// interactions, e.g. a callback recap). Each added note also pushes to the
// Activity Feed (the server merges customer_notes into the activity timeline).
// Edit/delete controls live here only, never in the Activity Feed.
function NotesSection({ id, notes, legacyNote, draft, setDraft, onAdd, onEdit, onDelete, saving }) {
  const canAdd = draft.trim().length > 0 && !saving;
  return (
    <Card id={id} title="Notes" icon={StickyNote}>
      <div className="px-5 py-4 space-y-3">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={3}
          placeholder="Add a note — e.g. recap of an outbound callback, what was discussed…"
          className={inputCls + ' resize-y'}
        />
        <div className="flex justify-end">
          <button
            onClick={onAdd}
            disabled={!canAdd}
            className="flex items-center gap-1.5 text-sm font-medium text-content bg-brand hover:bg-brand-hover disabled:opacity-50 px-4 py-2 rounded-lg"
          >
            <Plus size={14} /> {saving ? 'Adding…' : 'Add Note'}
          </button>
        </div>

        {legacyNote && (
          <div className="rounded-lg border border-divider bg-surface-2 px-3 py-2">
            <p className="text-[11px] font-semibold text-muted uppercase tracking-wide mb-1">General note</p>
            <p className="text-sm text-content whitespace-pre-wrap">{legacyNote}</p>
          </div>
        )}

        {notes.length === 0 && !legacyNote ? (
          <p className="text-sm text-muted text-center py-4">No notes yet. Add one to record a call or follow-up.</p>
        ) : (
          <ul className="space-y-2">
            {notes.map(n => (
              <NoteItem key={n.id} note={n} onEdit={onEdit} onDelete={onDelete} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export default function CustomerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Optional ?call=<leadId> focus: which call the inbound navigation targeted
  // (e.g. a redirect from the retired /leads/:id, a schedule item, or a toast).
  // Absent → load the profile normally (Active Inquiry expanded by default).
  const callParam = new URLSearchParams(location.search).get('call');
  const focusCallId = callParam && Number(callParam) > 0 ? Number(callParam) : null;
  // Post-extraction confirmation: the redirect carries {fresh:true} so the
  // "Lead extracted and saved" banner still shows once we land on the profile.
  const [showFresh, setShowFresh] = useState(!!location.state?.fresh);
  // The engagement to force-expand (a Jobs row or a Past inquiry). Seeded by the
  // ?call focus and set by the in-place "View job" / "View" links so they expand
  // here instead of navigating to the retired /leads/:id page.
  const [focusEngId, setFocusEngId] = useState(null);
  const didInitialFocus = useRef(false);
  const [customer, setCustomer] = useState(null);
  const [groups, setGroups] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [termsDraft, setTermsDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [priceDrafts, setPriceDrafts] = useState({});
  const [savingTerms, setSavingTerms] = useState(false);
  const [activeSection, setActiveSection] = useState(JUMP_LINKS[0].id);
  // Bumped after a job-details edit so the read-only call-intelligence grid
  // (which fetches its own lead) re-fetches and shows the new values immediately.
  const [detailRefresh, setDetailRefresh] = useState(0);

  const load = useCallback(() => {
    return Promise.all([api.getCustomer(id), api.getPricing(), api.getInvoices({ customer_id: id })]).then(([c, p, inv]) => {
      setCustomer(c);
      setGroups(p.groups || []);
      setInvoices(inv || []);
      setTermsDraft(c.contract_terms || '');
    });
  }, [id]);

  useEffect(() => {
    setLoading(true);
    load().catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  // Scroll-spy: highlight the jump link whose inline section is currently in
  // view. Read-only observer — it tracks the topmost visible section and never
  // touches data or layout. Re-runs once the sections exist (after load).
  useEffect(() => {
    if (loading) return;
    const els = JUMP_LINKS.map(l => document.getElementById(l.id)).filter(Boolean);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(en => en.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActiveSection(visible[0].target.id);
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 }
    );
    els.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [loading]);

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

  const saveTerms = async () => {
    setSavingTerms(true);
    try { await patch({ contract_terms: termsDraft }); } finally { setSavingTerms(false); }
  };

  // Add a discrete note; the server persists it AND merges it into the activity
  // feed, so reloading surfaces it in both the Notes list and the Activity Feed.
  const addNote = async () => {
    const body = noteDraft.trim();
    if (!body) return;
    setSavingNote(true);
    try {
      await api.addCustomerNote(id, body);
      setNoteDraft('');
      await load();
    } finally { setSavingNote(false); }
  };

  // Edit/delete a discrete note. Both reload so the Notes list AND the Activity
  // Feed (which derives the note_added entry server-side) stay in sync.
  const editNote = async (noteId, body) => {
    await api.updateCustomerNote(id, noteId, body);
    await load();
  };
  const deleteNote = async (noteId) => {
    await api.deleteCustomerNote(id, noteId);
    await load();
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

  // Manually mark the Active Inquiry booked from the profile. The system only
  // ingests inbound calls, so a booking taken on an OUTBOUND call (e.g. returning
  // a voicemail) has no entry point — this is it. Reuses the lead-detail header's
  // exact path: the same Confirm Booking modal (availability + pickup math run
  // in-modal) and buildBookingUpdates (job_status/status='booked'), applied to the
  // engagement's representative (newest) call so it becomes a Job. No extraction,
  // booking-signal, or auto-book logic runs here.
  const handleBookEngagement = async (engagement, payload) => {
    await api.updateLead(engagement.representative_lead_id, buildBookingUpdates(payload));
    await load();
  };

  // Save manual edits to an open engagement's job details (size, delivery date,
  // duration → recomputed pickup, delivery time, follow-up). The modal hands us a
  // ready-to-send lead update carrying the change summary, which the server logs
  // as ONE "Job details updated — …" activity event. Reload + bump the refresh
  // key so both the engagement summary and the call-intelligence grid update now.
  // No extraction, booking-signal, or auto-book logic runs here.
  const handleEditEngagement = async (engagement, body) => {
    await api.updateLead(engagement.representative_lead_id, body);
    await load();
    setDetailRefresh(n => n + 1);
  };

  // Mark Paid / Mark Unpaid or a payment-SMS send happened on the Open Job card's
  // Payment Link (PaymentLinkSection already called the lead endpoint). Just reload
  // so the engagement re-derives: a paid + past-pickup job flips to Completed, and
  // the paid/SMS state re-renders. No extraction, booking, or Stripe logic here.
  const handlePaymentChange = async () => {
    await load();
  };

  const scrollToId = (sectionId) => (e) => {
    e.preventDefault();
    setActiveSection(sectionId);
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Focus the engagement that contains a given call (lead) IN PLACE: expand its
  // Jobs row / Past-inquiry (via focusEngId below) and scroll to it. Powers both
  // the ?call=<leadId> deep-link and the in-place "View job" (Activity Feed) and
  // "View" (Past inquiries) links — replacing the old jumps to /leads/:id, with no
  // self-loop. A call with no matching engagement (e.g. a discarded lead) is a
  // safe no-op. Read-only — never books, edits, or re-runs extraction.
  const focusCall = useCallback((leadId) => {
    const lid = Number(leadId);
    if (!Number.isFinite(lid)) return;
    const eng = (customer?.engagements || []).find((e) => (e.lead_ids || []).includes(lid));
    if (!eng) return;
    setFocusEngId(eng.id);
    // The active engagement is always expanded at #active-inquiry; everything else
    // lives in a per-engagement row keyed eng-<id> (force-expanded via focusEngId).
    scrollToWhenReady(eng.is_active ? 'active-inquiry' : `eng-${eng.id}`);
  }, [customer]);

  // On first load with ?call=<leadId>, focus that call's engagement once. Guarded
  // so later reloads (after a note/edit/booking) don't yank the page back.
  useEffect(() => {
    if (loading || !customer || !focusCallId || didInitialFocus.current) return;
    didInitialFocus.current = true;
    focusCall(focusCallId);
  }, [loading, customer, focusCallId, focusCall]);

  // Auto-dismiss the post-extraction confirmation a few seconds after the profile
  // is visible (it's also manually dismissable).
  useEffect(() => {
    if (!showFresh || loading) return;
    const t = setTimeout(() => setShowFresh(false), 6000);
    return () => clearTimeout(t);
  }, [showFresh, loading]);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin w-6 h-6 border-2 border-brand border-t-transparent rounded-full" /></div>;
  }
  if (error || !customer) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link to="/customers" className="text-sm text-brand inline-flex items-center gap-1"><ArrowLeft size={14} /> Customers</Link>
        <div className="bg-surface rounded-xl border border-divider p-10 text-center text-sm text-muted mt-4">{error || 'Customer not found'}</div>
      </div>
    );
  }

  const c = customer;
  const statusStyle = CUSTOMER_STATUS_STYLES[c.status] || CUSTOMER_STATUS_STYLES.lead;
  const pricing = c.pricing || { items: [], group: null };
  const primaryAddress = c.address || (c.addresses && c.addresses[0]) || null;

  // Engagements: one ongoing piece of business (inquiry → job → completed).
  //  • activeEngagement — the single OPEN engagement: an Active Inquiry, or a
  //    booked Open Job that hasn't completed. Expanded up top.
  //  • jobEngagements — everything that became a real job (Booked or Completed).
  //    A booked Open Job lives in BOTH places: expanded above AND as a Jobs row.
  //  • pastInquiries — inquiries Closed / Marked Lost (never booked). These do
  //    NOT go to Jobs; they collapse into a lightweight list below the Jobs tab.
  const engagements = c.engagements || [];
  const activeEngagement = engagements.find(e => e.is_active) || null;
  const jobEngagements = engagements.filter(e => e.status === ENGAGEMENT_STATUS.BOOKED || e.status === ENGAGEMENT_STATUS.COMPLETED);
  const pastInquiries = engagements.filter(e => e.status === ENGAGEMENT_STATUS.LOST);

  // Quick Stats: outstanding = unpaid invoice balances; last job = newest
  // booked/completed engagement (— when there are none yet).
  const outstanding = invoices.reduce((s, inv) => {
    if (inv.status === 'paid' || inv.status === 'void') return s;
    const bal = Number(inv.total || 0) - Number(inv.amount_paid || 0);
    return s + (bal > 0 ? bal : 0);
  }, 0);
  const lastJobEng = jobEngagements[0] || null; // engagements are newest-first
  const lastJob = lastJobEng ? fmtDate(lastJobEng.delivery_date || lastJobEng.created_at) : '—';

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Post-extraction confirmation — carried here from the upload/manual flows
          via the /leads/:id → profile redirect ({fresh:true}). Auto-dismisses. */}
      {showFresh && (
        <div className="mb-4 flex items-center justify-between gap-3 text-sm text-success bg-success/10 border border-success/30 px-4 py-2.5 rounded-lg">
          <span className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 size={15} /> Lead extracted and saved
          </span>
          <button
            type="button"
            onClick={() => setShowFresh(false)}
            className="text-success/70 hover:text-success"
            aria-label="Dismiss"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* Action row — breadcrumb left, lifecycle status + edit/delete right */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <Link to="/customers" className="text-sm text-brand inline-flex items-center gap-1 hover:underline"><ArrowLeft size={14} /> Customers</Link>
        <div className="flex items-center gap-2">
          <select
            value={c.status_overridden ? c.status : '__derived__'}
            onChange={e => handleStatusChange(e.target.value === '__derived__' ? 'auto' : e.target.value)}
            title={c.status_overridden ? 'Pinned manually' : 'Auto from job history'}
            className="text-xs border border-divider bg-surface rounded-lg px-2.5 py-2 text-content focus:outline-none focus:ring-2 focus:ring-brand"
          >
            <option value="__derived__">Auto (from jobs)</option>
            {CUSTOMER_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {!editingProfile && (
            <button onClick={() => setEditingProfile(true)} className="inline-flex items-center gap-1.5 text-sm font-medium text-content bg-surface-2 hover:bg-surface border border-divider px-3 py-2 rounded-lg"><Edit2 size={14} /> Edit Customer</button>
          )}
          <button onClick={handleDelete} title="Delete customer" className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger/10 border border-divider"><Trash2 size={15} /></button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-5 items-start">
        {/* ── Main column ─────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 w-full space-y-4">
          {/* Top card: identity + contact (left), empty middle, Quick Stats (right) */}
          <div className="bg-surface rounded-xl border border-divider shadow-sm">
            {editingProfile ? (
              <>
                <div className="px-5 py-3.5 border-b border-divider">
                  <h2 className="text-sm font-bold text-content">Edit Customer</h2>
                </div>
                <ProfileForm customer={c} onSave={handleProfileSave} onCancel={() => setEditingProfile(false)} />
              </>
            ) : (
              <div className="px-6 py-5 flex flex-col lg:flex-row gap-6">
                {/* Left: name + contact */}
                <div className="flex gap-4 min-w-0">
                  <Avatar name={c.display_name} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h1 className="text-2xl font-bold text-content leading-tight">{c.display_name}</h1>
                      <span className={`${badgeCls} ${statusStyle}`}>{getCustomerStatusLabel(c.status)}</span>
                    </div>
                    <div className="mt-3 space-y-2.5 text-sm text-muted">
                      <ContactLine icon={Phone} value={c.phone} />
                      <ContactLine icon={Mail} value={c.email} />
                      <ContactLine icon={MapPin} value={primaryAddress} />
                      {c.company && <ContactLine icon={Briefcase} value={c.company} />}
                      {!c.phone && !c.email && !primaryAddress && !c.company && <p className="text-muted">No contact info</p>}
                    </div>
                  </div>
                </div>

                {/* Middle: intentionally minimal — reserved for future content */}
                <div className="flex-1 hidden lg:block" aria-hidden="true" />

                {/* Right: Quick Stats */}
                <QuickStats
                  totalJobs={c.totals.jobs}
                  totalSpent={money(c.totals.total_revenue)}
                  outstanding={money(outstanding)}
                  lastJob={lastJob}
                />
              </div>
            )}
          </div>

          {/* Jump links — smooth-scroll to each inline section */}
          <nav className="bg-surface rounded-xl border border-divider shadow-sm px-3 py-2 flex items-center gap-1 flex-wrap text-sm">
            {JUMP_LINKS.map(l => (
              <a
                key={l.id}
                href={`#${l.id}`}
                onClick={scrollToId(l.id)}
                aria-current={activeSection === l.id ? 'true' : undefined}
                className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
                  activeSection === l.id
                    ? 'text-brand bg-brand/10'
                    : 'text-muted hover:text-content hover:bg-surface-2'
                }`}
              >
                {l.label}
              </a>
            ))}
          </nav>

          {/* Active Inquiry — the current active engagement, expanded by default */}
          {activeEngagement ? (
            <ActiveEngagement id="active-inquiry" engagement={activeEngagement} onClose={handleCloseEngagement} onBook={handleBookEngagement} onEdit={handleEditEngagement} onPaymentChange={handlePaymentChange} refreshKey={detailRefresh} />
          ) : (
            <Card id="active-inquiry" title="Active Inquiry" icon={MessageSquare}>
              <div className="px-5 py-8 text-center text-sm text-muted">No active inquiry. A new call opens one automatically.</div>
            </Card>
          )}

          {/* Jobs — booked + completed engagements ONLY. A booked Open Job shows
              here as the current job (and also expanded above); a completed one is
              history. Closed/lost inquiries never appear here. Job ID expands in place. */}
          <Card
            id="jobs"
            title={`Jobs (${jobEngagements.length})`}
            icon={Briefcase}
            action={jobEngagements.length > 0 && <span className="text-[11px] text-muted">Tap a Job ID to expand</span>}
          >
            {jobEngagements.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted">
                No jobs yet. A job appears here once an inquiry is booked.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 border-b border-divider">
                    <tr>
                      <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Job ID</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Date</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Service</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Size</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Status</th>
                      <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-divider">
                    {jobEngagements.map(e => <JobHistoryRow key={e.id} engagement={e} onPaymentChange={handlePaymentChange} forceOpen={focusEngId === e.id} />)}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Past inquiries — Closed / Marked Lost inquiries that never booked.
              Lightweight collapsed list (separate from Jobs); they also remain in
              the Activity Feed. Hidden entirely when there are none. */}
          {pastInquiries.length > 0 && <PastInquiries engagements={pastInquiries} forceOpenId={focusEngId} onPaymentChange={handlePaymentChange} />}

          {/* Invoices — Create Invoice when empty; populated otherwise. No Quick Stats here. */}
          <Card
            id="invoices"
            title={`Invoices (${invoices.length})`}
            icon={FileText}
            action={
              <button onClick={() => navigate(`/invoices/new?customer_id=${id}`)} className="flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover">
                <Plus size={13} /> New Invoice
              </button>
            }
          >
            {invoices.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <p className="text-sm text-muted">No invoices yet.</p>
                <p className="text-xs text-muted mt-1">Line items and terms prefill from this customer's rates.</p>
                <button
                  onClick={() => navigate(`/invoices/new?customer_id=${id}`)}
                  className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-content bg-brand hover:bg-brand-hover px-4 py-2 rounded-lg"
                >
                  <Plus size={14} /> Create Invoice
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 border-b border-divider">
                    <tr>
                      <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Invoice</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Status</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Issued</th>
                      <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted uppercase tracking-wide">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-divider">
                    {invoices.map((inv) => (
                      <tr key={inv.id} className="hover:bg-surface-2 cursor-pointer transition-colors" onClick={() => navigate(`/invoices/${inv.id}`)}>
                        <td className="px-5 py-3 font-medium text-content">{inv.invoice_number}</td>
                        <td className="px-4 py-3">
                          <span className={`${badgeCls} ${INVOICE_STATUS_STYLES[inv.status] || INVOICE_STATUS_STYLES.draft}`}>
                            {getInvoiceStatusLabel(inv.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted text-xs whitespace-nowrap">{fmtDate(inv.issue_date)}</td>
                        <td className="px-5 py-3 text-right text-content font-medium whitespace-nowrap">{money(inv.total, inv.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Pricing — per-client rates (kept; existing feature) */}
          <Card id="pricing" title="Pricing" icon={DollarSign}>
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
                      <button onClick={saveTerms} disabled={savingTerms} className="text-xs font-medium text-content bg-brand hover:bg-brand-hover px-3 rounded-lg disabled:opacity-50">Save</button>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className={labelCls + ' mb-0'}>Effective Rates</p>
                  <Link to="/pricing" className="text-[11px] text-brand hover:underline">Edit default price list →</Link>
                </div>
                {pricing.items.length === 0 ? (
                  <p className="text-sm text-muted">No price list yet. <Link to="/pricing" className="text-brand hover:underline">Set up default prices</Link>.</p>
                ) : (
                  <table className="w-full text-sm border border-divider rounded-lg overflow-hidden">
                    <thead className="bg-surface-2">
                      <tr>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-muted uppercase tracking-wide">Service</th>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-muted uppercase tracking-wide">Default</th>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-muted uppercase tracking-wide">Custom</th>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-muted uppercase tracking-wide">Effective</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-divider">
                      {pricing.items.map(it => {
                        const draftVal = priceDrafts[it.service_key] !== undefined
                          ? priceDrafts[it.service_key]
                          : (it.custom_price != null ? String(it.custom_price) : '');
                        return (
                          <tr key={it.service_key}>
                            <td className="px-3 py-2 text-content">{it.label}{it.unit ? <span className="text-muted text-xs"> / {it.unit}</span> : null}</td>
                            <td className="px-3 py-2 text-muted">{it.default_price != null ? `$${it.default_price}` : '—'}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                <span className="text-muted text-xs">$</span>
                                <input
                                  type="number" min="0" step="0.01"
                                  value={draftVal}
                                  placeholder="—"
                                  onChange={e => setPriceDrafts(d => ({ ...d, [it.service_key]: e.target.value }))}
                                  onBlur={() => saveOverride(it.service_key, it.label, it.unit)}
                                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                  className="w-20 text-sm border border-divider bg-surface rounded px-2 py-1 text-content focus:outline-none focus:ring-2 focus:ring-brand"
                                />
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <span className="font-semibold text-content">{it.effective_price != null ? `$${it.effective_price}` : '—'}</span>
                              {it.source !== 'default' && (
                                <span className={`ml-1.5 text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${it.source === 'custom' ? 'bg-brand/10 text-brand' : 'bg-warning/10 text-warning'}`}>{it.source}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <p className="text-[11px] text-muted mt-1.5">Effective rate = custom override, else group discount, else the default price.</p>
              </div>
            </div>
          </Card>

          {/* Notes — adding a note also pushes it to the Activity Feed */}
          <NotesSection
            id="notes"
            notes={c.notes_list || []}
            legacyNote={c.notes}
            draft={noteDraft}
            setDraft={setNoteDraft}
            onAdd={addNote}
            onEdit={editNote}
            onDelete={deleteNote}
            saving={savingNote}
          />
        </div>

        {/* ── Right rail: Activity Feed (full page height) ──────────────────── */}
        <aside className="w-full lg:w-80 flex-shrink-0 lg:sticky lg:top-0 lg:self-start">
          <ActivityFeed activity={c.activity} onViewCall={focusCall} />
        </aside>
      </div>
    </div>
  );
}

// The body shared by the active engagement and an expanded history row: the
// newest call's full intelligence (booking signals, dates, industry fields, AI
// summary, recording) plus any earlier calls in the same engagement, expandable.
// For a booked/completed job it also surfaces the Payment Link + Mark Paid block,
// targeting the engagement's BOOKED lead (see booked_lead_id) — the same actions
// the lead-detail page exposes. onPaymentChange refreshes the profile so a Mark
// Paid that completes the job (paid + pickup passed) reflects immediately.
function EngagementBody({ engagement: e, refreshKey = 0, onPaymentChange }) {
  const [openCalls, setOpenCalls] = useState(() => new Set());
  const toggle = (cid) => setOpenCalls(prev => {
    const next = new Set(prev);
    if (next.has(cid)) next.delete(cid); else next.add(cid);
    return next;
  });
  const earlier = (e.calls || []).slice(1); // calls[0] is the representative (newest)

  return (
    <>
      <CustomerCallIntelligence
        jobId={e.representative_lead_id}
        refreshKey={refreshKey}
        schedule={{
          delivery_date: e.delivery_date,
          pickup_date: e.pickup_date,
          scheduled_time: e.scheduled_time,
          rental_duration: e.rental_duration,
          dumpster_size: e.dumpster_size,
          debris_type: e.debris_type,
        }}
      />
      {earlier.length > 0 && (
        <div className="px-5 pb-4">
          <p className="text-[11px] font-semibold text-muted uppercase tracking-wide mb-1.5">
            Earlier calls in this engagement ({earlier.length})
          </p>
          <div className="border border-divider rounded-lg divide-y divide-divider overflow-hidden">
            {earlier.map(call => {
              const open = openCalls.has(call.id);
              return (
                <Fragment key={call.id}>
                  <button
                    onClick={() => toggle(call.id)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <span className="flex items-center gap-2 text-sm text-content">
                      {open ? <ChevronDown size={13} className="text-muted" /> : <ChevronRight size={13} className="text-muted" />}
                      {fmtDateTime(call.created_at) || fmtDate(call.created_at)}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      {call.call_type === 'voicemail' && <VoicemailBadge size="xs" boxy />}
                      {call.service}
                    </span>
                  </button>
                  {open && <CustomerCallIntelligence jobId={call.id} compact />}
                </Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* Payment Link + Mark Paid — booked/completed jobs only, operating on the
          engagement's booked lead (not the newest call). Reuses the same component
          and api methods (api.updateLead paid_at, api.resendPaymentSms) as the lead
          detail page; onUpdate reloads the profile so completion / paid state sync. */}
      {e.booked_lead_id && (
        <div className="px-5 pb-5 pt-1">
          <PaymentLinkSection
            lead={{
              id: e.booked_lead_id,
              paid_at: e.booked_paid_at,
              payment_sms_sent_at: e.booked_payment_sms_sent_at,
            }}
            onUpdate={() => onPaymentChange?.()}
          />
        </div>
      )}
    </>
  );
}

// The active engagement — the open Active Inquiry or booked Job — rendered
// expanded with its status, a Stale flag for an idle inquiry, and (for an open
// inquiry) the manual Close / Mark Lost actions plus the green "Mark Booked"
// header action. Mark Booked reuses the lead-detail Confirm Booking modal and
// its booking path verbatim; it never re-runs extraction or auto-book logic.
function ActiveEngagement({ id, engagement: e, onClose, onBook, onEdit, onPaymentChange, refreshKey = 0 }) {
  const [closing, setClosing] = useState(false);
  // Manual booking is offered only while the inquiry is still open (status
  // 'inquiry'); once it's a booked Job or completed, the button is hidden.
  const [bookingLead, setBookingLead] = useState(null);
  const [loadingBooking, setLoadingBooking] = useState(false);
  // Editing job details is available the whole time the engagement is open —
  // an unbooked Active Inquiry or a booked Open Job alike.
  const [editLead, setEditLead] = useState(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const canBook = e.status === ENGAGEMENT_STATUS.INQUIRY;

  const close = async (reason) => {
    const msg = reason === 'lost'
      ? 'Mark this inquiry as Lost? It will close and leave the action queue.'
      : 'Close this inquiry? It will leave the action queue.';
    if (!confirm(msg)) return;
    setClosing(true);
    try { await onClose(e, reason); } finally { setClosing(false); }
  };

  // Lazy-load the representative (newest) call so the Confirm Booking modal
  // prefills from the real lead (size/date/duration/name) exactly as the lead
  // detail header does, rather than from the lighter engagement summary.
  const openBooking = async () => {
    setLoadingBooking(true);
    try {
      const lead = await api.getLead(e.representative_lead_id);
      setBookingLead(lead);
    } catch (err) {
      console.error('Failed to load job for booking:', err);
      alert('Could not load this job to book it. Please try again.');
    } finally {
      setLoadingBooking(false);
    }
  };

  const confirmBooking = async (payload) => {
    try {
      await onBook(e, payload);
      setBookingLead(null);
    } catch (err) {
      console.error('Booking failed:', err);
      alert('Could not book this job. Please try again.');
    }
  };

  // Lazy-load the representative (newest) call so the Edit Job Details modal
  // prefills from the real lead (size/date/duration/time/follow-up), mirroring
  // the booking flow above. The modal builds the update + change summary itself.
  const openEdit = async () => {
    setLoadingEdit(true);
    try {
      const lead = await api.getLead(e.representative_lead_id);
      setEditLead(lead);
    } catch (err) {
      console.error('Failed to load job for editing:', err);
      alert('Could not load this job to edit it. Please try again.');
    } finally {
      setLoadingEdit(false);
    }
  };

  const confirmEdit = async (body) => {
    try {
      await onEdit(e, body);
      setEditLead(null);
    } catch (err) {
      console.error('Edit failed:', err);
      alert('Could not save changes. Please try again.');
      throw err; // let the modal clear its "Saving…" state and stay open for retry
    }
  };

  // Booking converts the engagement in place: the same open slot, now a Job. The
  // header flips from "Active Inquiry" to "Open Job" (the green BOOKED badge lives
  // on the top contact card). It only leaves this slot when the job completes.
  const headerTitle = e.status === ENGAGEMENT_STATUS.BOOKED ? 'Open Job' : 'Active Inquiry';

  return (
    <Card
      id={id}
      title={headerTitle}
      icon={e.status === ENGAGEMENT_STATUS.BOOKED ? Briefcase : MessageSquare}
      action={(
        <div className="flex items-center gap-2">
          <button
            onClick={openEdit}
            disabled={loadingEdit}
            title="Edit job details"
            className="flex items-center gap-1.5 text-xs font-medium text-content bg-surface-2 hover:bg-surface border border-divider disabled:opacity-50 px-3 py-1.5 rounded-lg transition-colors"
          >
            <Edit2 size={14} /> {loadingEdit ? 'Loading…' : 'Edit'}
          </button>
          {canBook && (
            <button
              onClick={openBooking}
              disabled={loadingBooking}
              className="flex items-center gap-1.5 text-xs font-medium text-background bg-success hover:bg-success/90 disabled:opacity-50 px-3 py-1.5 rounded-lg transition-colors"
            >
              <CheckCircle2 size={14} /> {loadingBooking ? 'Loading…' : 'Mark Booked'}
            </button>
          )}
        </div>
      )}
    >
      <div className="px-5 pt-4 flex items-center gap-2 flex-wrap">
        {e.stale && (
          <span className={`${badgeCls} bg-warning/10 text-warning border-warning/30`}>
            <Clock size={11} /> Stale
          </span>
        )}
        {e.auto_booked && (
          <span className={`${badgeCls} bg-success/10 text-success border-success/30`}>
            <Zap size={11} /> Auto-booked
          </span>
        )}
        <span className="flex-1" />
        {e.estimated_revenue ? <span className="text-sm font-semibold text-content">${Math.round(e.estimated_revenue).toLocaleString()}</span> : null}
      </div>

      <EngagementBody engagement={e} refreshKey={refreshKey} onPaymentChange={onPaymentChange} />

      {e.status === ENGAGEMENT_STATUS.INQUIRY && (
        <div className="px-5 py-3 border-t border-divider flex items-center justify-end gap-2">
          <span className="text-[11px] text-muted mr-auto">Inquiries stay open until you close them.</span>
          <button onClick={() => close('lost')} disabled={closing} className="text-xs font-medium text-danger border border-danger/30 hover:bg-danger/10 px-3 py-1.5 rounded-lg disabled:opacity-50">Mark Lost</button>
          <button onClick={() => close('closed')} disabled={closing} className="text-xs font-medium text-muted border border-divider hover:bg-surface-2 px-3 py-1.5 rounded-lg disabled:opacity-50">Close</button>
        </div>
      )}

      {bookingLead && (
        <BookedModal lead={bookingLead} onConfirm={confirmBooking} onClose={() => setBookingLead(null)} />
      )}

      {editLead && (
        <EditJobDetailsModal lead={editLead} onConfirm={confirmEdit} onClose={() => setEditLead(null)} />
      )}
    </Card>
  );
}

// Past inquiries — inquiries that were Closed / Marked Lost without ever booking.
// Deliberately lightweight: a collapsed section (closed by default) listing each
// dead inquiry with its service, date, and a Lost/Closed label, plus a link to the
// underlying call. The full record still lives in the Activity Feed; these never
// appear in Jobs (only booked/completed engagements do).
function PastInquiries({ engagements, forceOpenId = null, onPaymentChange }) {
  const [open, setOpen] = useState(false);
  // Which past inquiry is expanded inline (shows its call intelligence). The "View"
  // link toggles this in place — it no longer navigates to the retired /leads/:id.
  const [expandedId, setExpandedId] = useState(null);

  // Focused via ?call / Activity-feed "View job": open the section and expand the
  // matching row so the deep-linked call is visible (the parent scrolls to it).
  useEffect(() => {
    if (forceOpenId != null && engagements.some(e => e.id === forceOpenId)) {
      setOpen(true);
      setExpandedId(forceOpenId);
    }
  }, [forceOpenId, engagements]);

  const toggleRow = (rowId) => setExpandedId(cur => (cur === rowId ? null : rowId));

  return (
    <div className="bg-surface rounded-xl border border-divider shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-3 flex items-center justify-between hover:bg-surface-2 transition-colors"
      >
        <span className="flex items-center gap-2">
          {open ? <ChevronDown size={15} className="text-muted" /> : <ChevronRight size={15} className="text-muted" />}
          <span className="text-sm font-semibold text-content">Past inquiries</span>
          <span className="text-[11px] text-muted">({engagements.length})</span>
        </span>
        <span className="text-[11px] text-muted hidden sm:block">Closed / lost — never booked</span>
      </button>
      {open && (
        <ul className="divide-y divide-divider border-t border-divider">
          {engagements.map(e => {
            const lost = e.close_reason !== 'closed'; // server defaults to 'lost'
            const label = lost ? 'Lost' : 'Closed';
            const style = lost ? 'bg-danger/10 text-danger border-danger/30' : 'bg-surface-2 text-muted border-divider';
            const isExpanded = expandedId === e.id;
            return (
              <li key={e.id} id={`eng-${e.id}`} className="scroll-mt-6">
                <div className="px-5 py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-content truncate">{e.service || 'Inquiry'}</p>
                    <p className="text-xs text-muted">{fmtDate(e.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className={`${badgeCls} ${style}`}>{label}</span>
                    <button
                      type="button"
                      onClick={() => toggleRow(e.id)}
                      className="text-[11px] text-brand hover:underline whitespace-nowrap inline-flex items-center gap-1"
                    >
                      {isExpanded
                        ? <>Hide <ChevronDown size={12} /></>
                        : <>View <ChevronRight size={12} /></>}
                    </button>
                  </div>
                </div>
                {/* The call's full intelligence (recording, transcript, AI summary)
                    inline — same component the active engagement uses. No payment
                    block (a lost inquiry was never booked). */}
                {isExpanded && (
                  <div className="border-t border-divider">
                    <EngagementBody engagement={e} onPaymentChange={onPaymentChange} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// One collapsed Jobs row (a booked or completed engagement). The blue Job ID
// expands the job's call intelligence in place — no separate page.
function JobHistoryRow({ engagement: e, onPaymentChange, forceOpen = false }) {
  const [open, setOpen] = useState(false);
  // Expand in place when this row is the focus target (?call / "View job"). Only
  // opens — the owner can still collapse it afterward.
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  // Service column shows the service TYPE (e.g. "Dumpster rental") from the
  // vertical config — the size lives in its own column. Status is display-only:
  // a booked/open job reads "In progress", a completed one "Completed".
  const serviceType = getTerminology(e.vertical, e.sub_vertical).serviceType;
  const statusText = e.status === ENGAGEMENT_STATUS.COMPLETED ? 'Completed' : 'In progress';
  const toggle = () => setOpen(o => !o);
  return (
    <Fragment>
      <tr id={`eng-${e.id}`} className="hover:bg-surface-2 cursor-pointer transition-colors scroll-mt-6" onClick={toggle}>
        <td className="px-5 py-3 whitespace-nowrap">
          <button
            onClick={(ev) => { ev.stopPropagation(); toggle(); }}
            className="inline-flex items-center gap-1.5 text-brand font-medium hover:underline"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            #{e.id}
          </button>
        </td>
        <td className="px-4 py-3 text-muted text-xs whitespace-nowrap">{fmtDate(e.delivery_date || e.created_at)}</td>
        <td className="px-4 py-3 text-content">
          <span className="inline-flex items-center gap-1.5">
            {serviceType}
            {e.auto_booked && <Zap size={12} className="text-success" title="Auto-booked from the call" />}
          </span>
        </td>
        <td className="px-4 py-3 text-muted whitespace-nowrap">{e.dumpster_size || '—'}</td>
        <td className="px-4 py-3">
          <span className="text-sm font-medium text-success">{statusText}</span>
        </td>
        <td className="px-5 py-3 text-right text-content font-medium whitespace-nowrap">{e.estimated_revenue ? money(e.estimated_revenue) : '—'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="p-0 border-t border-divider">
            <EngagementBody engagement={e} onPaymentChange={onPaymentChange} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
