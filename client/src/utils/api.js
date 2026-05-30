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

  // Dumpsters
  getDumpsters: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/dumpsters${qs ? `?${qs}` : ''}`);
  },
  createDumpster: (body) =>
    request('/dumpsters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateDumpster: (id, body) =>
    request(`/dumpsters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteDumpster: (id) => request(`/dumpsters/${id}`, { method: 'DELETE' }),
};
