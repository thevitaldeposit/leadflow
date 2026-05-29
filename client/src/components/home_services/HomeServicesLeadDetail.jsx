import { useState } from 'react';
import { User, Wrench, DollarSign, AlertCircle, Check, X } from 'lucide-react';
import HomeServicesStatusBadge from './HomeServicesStatusBadge';
import UrgencyBadge from './UrgencyBadge';
import { api } from '../../utils/api';
import {
  HOME_SERVICES_STATUSES,
  URGENCY_VALUES,
  parseVerticalData,
} from '../../utils/verticalConfig';

function EditableText({ label, value, onSave, multiline = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');

  const commit = () => {
    setEditing(false);
    if (draft !== (value || '')) onSave(draft || null);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
      {editing ? (
        multiline ? (
          <textarea
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            rows={3}
            className="text-sm border border-accent rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
          />
        ) : (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => e.key === 'Enter' && commit()}
            className="text-sm border border-accent rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
          />
        )
      ) : (
        <button
          onClick={() => { setDraft(value || ''); setEditing(true); }}
          className="text-sm text-left text-gray-800 hover:text-accent hover:bg-blue-50 px-1 py-0.5 rounded transition-colors min-h-[26px] whitespace-pre-wrap"
        >
          {value || <span className="text-gray-300 italic">—</span>}
        </button>
      )}
    </div>
  );
}

function EditableBool({ label, value, onSave }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave(value === true ? null : true)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            value === true ? 'bg-green-100 text-green-700' : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
          }`}
        >
          <Check size={12} /> Yes
        </button>
        <button
          onClick={() => onSave(value === false ? null : false)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            value === false ? 'bg-red-100 text-red-700' : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
          }`}
        >
          <X size={12} /> No
        </button>
      </div>
    </div>
  );
}

function SectionHeader({ title, icon: Icon }) {
  return (
    <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 bg-gray-50">
      <Icon size={15} className="text-gray-500" />
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
    </div>
  );
}

export default function HomeServicesLeadDetail({ lead: initialLead, onUpdate }) {
  const [lead, setLead] = useState(initialLead);
  const [saving, setSaving] = useState(false);
  const vd = parseVerticalData(lead);

  const applyUpdate = async (body) => {
    setSaving(true);
    try {
      const updated = await api.updateLead(lead.id, body);
      setLead(updated);
      onUpdate?.(updated);
    } catch (e) {
      console.error('Save error:', e);
    } finally {
      setSaving(false);
    }
  };

  const saveCommon = (field) => (value) => applyUpdate({ [field]: value });
  const saveVertical = (field) => (value) => applyUpdate({ vertical_data: { [field]: value } });

  return (
    <div className="space-y-4">
      {/* Status bar + AI summary */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Status</p>
            <select
              value={lead.status || 'new'}
              onChange={e => applyUpdate({ status: e.target.value })}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {HOME_SERVICES_STATUSES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <HomeServicesStatusBadge status={lead.status} size="lg" />
        </div>

        {lead.call_summary && (
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">AI Summary</p>
            <p className="text-sm text-gray-700 leading-relaxed bg-blue-50 px-3 py-2 rounded-lg">
              {lead.call_summary}
            </p>
          </div>
        )}
      </div>

      {/* Section 1 — Contact Info */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <SectionHeader title="Contact Info" icon={User} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          <EditableText label="First Name" value={lead.customer_first_name} onSave={saveCommon('customer_first_name')} />
          <EditableText label="Last Name" value={lead.customer_last_name} onSave={saveCommon('customer_last_name')} />
          <EditableText label="Phone" value={lead.phone} onSave={saveCommon('phone')} />
          <EditableText label="Email" value={lead.email} onSave={saveCommon('email')} />
          <div className="col-span-2">
            <EditableText label="Service Address" value={vd.serviceAddress} onSave={saveVertical('serviceAddress')} />
          </div>
        </div>
      </div>

      {/* Section 2 — Service Details */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <SectionHeader title="Service Details" icon={Wrench} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          <EditableText label="Service Type" value={vd.serviceType} onSave={saveVertical('serviceType')} />
          <EditableText label="Size / Scope" value={vd.serviceSize} onSave={saveVertical('serviceSize')} />
          <EditableText label="Rental Duration" value={vd.rentalDuration} onSave={saveVertical('rentalDuration')} />
          <div />
          <EditableText label="Delivery Date" value={vd.deliveryDate} onSave={saveVertical('deliveryDate')} />
          <EditableText label="Pickup Date" value={vd.pickupDate} onSave={saveVertical('pickupDate')} />
          <div className="col-span-2">
            <EditableText label="Project Description" value={vd.projectDescription} onSave={saveVertical('projectDescription')} multiline />
          </div>
          <div className="col-span-2">
            <EditableText label="Access Notes" value={vd.accessNotes} onSave={saveVertical('accessNotes')} multiline />
          </div>
        </div>
      </div>

      {/* Section 3 — Quote & Payment */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <SectionHeader title="Quote & Payment" icon={DollarSign} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          <EditableBool label="Quote Requested" value={vd.quoteRequested} onSave={saveVertical('quoteRequested')} />
          <div />
          <EditableText label="Price Discussed" value={vd.priceDiscussed} onSave={saveVertical('priceDiscussed')} />
          <EditableText label="Payment Discussed" value={vd.paymentDiscussed} onSave={saveVertical('paymentDiscussed')} />
        </div>
      </div>

      {/* Section 4 — Urgency + Notes + Confidence */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <SectionHeader title="Urgency, Notes & Confidence" icon={AlertCircle} />
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Urgency</span>
            <div className="flex items-center gap-2">
              <select
                value={vd.urgency || ''}
                onChange={e => saveVertical('urgency')(e.target.value || null)}
                className="text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">—</option>
                {URGENCY_VALUES.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
              <UrgencyBadge value={vd.urgency} />
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Confidence</span>
            <span className="text-sm font-semibold text-gray-800">{lead.confidence ?? 0} / 100</span>
          </div>
          <div className="col-span-2">
            <EditableText label="Notes" value={vd.notes} onSave={saveVertical('notes')} multiline />
          </div>
        </div>
      </div>

      {saving && <p className="text-xs text-center text-gray-400">Saving...</p>}
    </div>
  );
}
