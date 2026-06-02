const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Leads
  getLeads: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/leads${qs ? `?${qs}` : ''}`);
  },
  getLead: (id) => request(`/leads/${id}`),
  updateLead: (id, body) =>
    request(`/leads/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteLead: (id) => request(`/leads/${id}`, { method: 'DELETE' }),

  // Extraction
  extractTranscript: (transcript) =>
    request('/extract/transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    }),
  extractUpsheet: (file) => {
    const form = new FormData();
    form.append('image', file);
    return request('/extract/upsheet', { method: 'POST', body: form });
  },
  extractAudio: (file) => {
    const form = new FormData();
    form.append('audio', file);
    return request('/extract/audio', { method: 'POST', body: form });
  },

  // Dashboard
  getDashboardStats: () => request('/dashboard/stats'),

  // Inventory pools (path stays /dumpsters for back-compat; each row is a size pool)
  getInventory: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/dumpsters${qs ? `?${qs}` : ''}`);
  },
  createInventory: (body) =>
    request('/dumpsters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateInventory: (id, body) =>
    request(`/dumpsters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteInventory: (id) => request(`/dumpsters/${id}`, { method: 'DELETE' }),

  // Schedule
  getAvailability: (deliveryDate, rentalDuration) =>
    request(`/schedule/availability?delivery_date=${encodeURIComponent(deliveryDate)}&rental_duration=${encodeURIComponent(rentalDuration)}`),
  getCalendar: (year, month) =>
    request(`/schedule/calendar?year=${year}&month=${month}`),

  // Settings (server-side, used by payment page)
  getSettings: () => request('/settings'),
  updateSettings: (body) =>
    request('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // Payment SMS
  resendPaymentSms: (id) =>
    request(`/leads/${id}/resend-payment-sms`, { method: 'POST' }),

  // Outbound click-to-call (Twilio rings the user first, then the customer)
  callLead: (id) =>
    request(`/leads/${id}/call`, { method: 'POST' }),
};
