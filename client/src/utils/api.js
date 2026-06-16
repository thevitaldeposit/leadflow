const BASE = '/api';

async function request(path, options = {}) {
  // credentials:'include' sends the httpOnly auth cookie on same-origin requests
  // (direct in prod, via the Vite proxy in dev).
  const res = await fetch(`${BASE}${path}`, { credentials: 'include', ...options });
  let data = null;
  try { data = await res.json(); } catch { /* empty/non-JSON body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  // Auth
  login: (email, password) =>
    request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  register: (body) =>
    request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  getMe: () => request('/auth/me'),
  forgotPassword: (email) =>
    request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token, newPassword) =>
    request('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    }),
  changePassword: (currentPassword, newPassword) =>
    request('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // Leads
  getLeads: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/leads${qs ? `?${qs}` : ''}`);
  },
  getLead: (id) => request(`/leads/${id}`),
  getLeadActivity: (id) => request(`/leads/${id}/activity`),
  updateLead: (id, body) =>
    request(`/leads/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteLead: (id) => request(`/leads/${id}`, { method: 'DELETE' }),
  createManualLead: (body) =>
    request('/leads/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

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
  getMorningBrief: () => request('/dashboard/morning-brief'),

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

  // Stream signups — public create (marketing site), authed list (admin view)
  createSignup: (body) =>
    request('/signups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  getSignups: () => request('/signups'),

  // Contact form — public, relays the message to info@joinstream.app via Resend
  sendContactMessage: (body) =>
    request('/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // Billing (Stripe subscriptions)
  // Public, pre-account: creates the customer + incomplete subscription for the
  // signup payment step and returns a PaymentIntent client_secret for Elements.
  createSignupSubscription: (body) =>
    request('/billing/public/create-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // Public, pre-account: validates a signup promo code and returns the promotion
  // code id + discount label to apply when (re)creating the subscription.
  validatePromo: (code) =>
    request('/billing/validate-promo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }),
  getSubscriptionStatus: () => request('/billing/subscription-status'),
  createCheckoutSession: () => request('/billing/create-checkout-session', { method: 'POST' }),
  createPortalSession: () => request('/billing/create-portal-session', { method: 'POST' }),

  // Admin panel — all endpoints are restricted to business_id = 1 (403 otherwise).
  getAdminBusinesses: () => request('/admin/businesses'),
  setBusinessSubscription: (id, status) =>
    request(`/admin/businesses/${id}/subscription`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  setBusinessTrial: (id, trialDays) =>
    request(`/admin/businesses/${id}/trial`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trialDays }),
    }),
  markBusinessOnboarded: (id) =>
    request(`/admin/businesses/${id}/onboarding`, { method: 'PATCH' }),
  resetBusinessPassword: (id) =>
    request(`/admin/businesses/${id}/reset-password`, { method: 'POST' }),
};
