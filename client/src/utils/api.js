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
  // Resolve a lead to its owning customer id (robust find-or-create; handles a
  // NULL leads.customer_id). Powers the /leads/:id → /customers/:id redirect.
  getLeadCustomer: (id) => request(`/leads/${id}/customer`),
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
  // Record a dump ticket / weight for a returned unit (swap-safe lifecycle advance).
  // Body: { weightTons?, swap?, unitsRemaining?, note? }.
  recordDumpTicket: (id, body) =>
    request(`/leads/${id}/dump-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  // Resolve a confirm-first cancellation cue. confirm=true → mark lost; false → keep.
  resolveCancel: (id, confirm) =>
    request(`/leads/${id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: !!confirm }),
    }),
  // (Re)send the payment link by email — the approved channel while SMS/A2P pends.
  emailPaymentLink: (id) =>
    request(`/leads/${id}/email-payment-link`, { method: 'POST' }),

  // Customers — the unified person-level record (consolidates leads/opportunities)
  getCustomers: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/customers${qs ? `?${qs}` : ''}`);
  },
  getCustomer: (id) => request(`/customers/${id}`),
  createCustomer: (body) =>
    request('/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateCustomer: (id, body) =>
    request(`/customers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteCustomer: (id) => request(`/customers/${id}`, { method: 'DELETE' }),
  // Manually close an Active Inquiry engagement (Mark Lost / Close). lead_ids are
  // the engagement's calls; reason is 'lost' or 'closed'.
  closeEngagement: (id, leadIds, reason = 'lost') =>
    request(`/customers/${id}/engagements/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_ids: leadIds, reason }),
    }),
  // Add a discrete customer note (also surfaces in the profile's Activity Feed).
  addCustomerNote: (id, body) =>
    request(`/customers/${id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  // Edit a discrete customer note's text (business-scoped server-side). The edit
  // also updates the note's Activity Feed entry (derived from the note at read time).
  updateCustomerNote: (id, noteId, body) =>
    request(`/customers/${id}/notes/${noteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  // Delete a discrete customer note (business-scoped server-side). Its Activity
  // Feed entry disappears too, since the feed is derived from the note row.
  deleteCustomerNote: (id, noteId) =>
    request(`/customers/${id}/notes/${noteId}`, { method: 'DELETE' }),
  getCustomerPricing: (id) => request(`/customers/${id}/pricing`),
  // Upsert (or clear, with custom_price = null) one per-customer rate override.
  setCustomerPricing: (id, body) =>
    request(`/customers/${id}/pricing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // Pricing config — the business default price list + discount groups
  getPricing: () => request('/pricing'),
  createPriceItem: (body) =>
    request('/pricing/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updatePriceItem: (id, body) =>
    request(`/pricing/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deletePriceItem: (id) => request(`/pricing/items/${id}`, { method: 'DELETE' }),
  createDiscountGroup: (body) =>
    request('/pricing/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateDiscountGroup: (id, body) =>
    request(`/pricing/groups/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteDiscountGroup: (id) => request(`/pricing/groups/${id}`, { method: 'DELETE' }),

  // Invoices (owner-facing). Customer-facing review + sign uses the public methods
  // below (no auth, tokenized link).
  getInvoices: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/invoices${qs ? `?${qs}` : ''}`);
  },
  getInvoice: (id) => request(`/invoices/${id}`),
  // Prefill the New Invoice form from a customer (+ optional job) and the pricing layer.
  getInvoicePrefill: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/invoices/prefill${qs ? `?${qs}` : ''}`);
  },
  createInvoice: (body) =>
    request('/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateInvoice: (id, body) =>
    request(`/invoices/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteInvoice: (id) => request(`/invoices/${id}`, { method: 'DELETE' }),
  sendInvoice: (id, channel = 'both') =>
    request(`/invoices/${id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel }),
    }),
  markInvoicePaid: (id, body = {}) =>
    request(`/invoices/${id}/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // Per-business invoice defaults (terms template, due window, tax, numbering).
  getInvoiceDefaults: () => request('/invoices/defaults'),
  setInvoiceDefaults: (body) =>
    request('/invoices/defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // Public, tokenized invoice (no login) — the customer's review + sign page.
  getPublicInvoice: (token) => request(`/public/invoices/${token}`),
  signPublicInvoice: (token, body) =>
    request(`/public/invoices/${token}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // Pay-on-invoice (Stripe Connect direct charge). createInvoicePayment returns
  // { clientSecret, connectedAccountId, ... } to mount Stripe Elements, or
  // { alreadyPaid:true }. confirmInvoicePayment flips the invoice to paid right
  // after a successful confirm (the webhook is the async backstop).
  createInvoicePayment: (token) =>
    request(`/public/invoices/${token}/create-payment-intent`, { method: 'POST' }),
  confirmInvoicePayment: (token, paymentIntentId) =>
    request(`/public/invoices/${token}/confirm-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId }),
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

  // Earliest delivery date after the requested one with a free unit of `size` for
  // the same rental length (the "Next available: …" hint when a window is full).
  // params: { size, delivery_date, rental_duration, exclude_lead_id? }
  getNextAvailability: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/dumpsters/next-available${qs ? `?${qs}` : ''}`);
  },

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

  // Stripe Connect — the business's OWN payments account for collecting invoice
  // payments. Completely separate from the platform subscription above.
  getConnectStatus: () => request('/connect/status'),
  startConnectOnboarding: () => request('/connect/onboard', { method: 'POST' }),

  // Payments / Transactions — the card payments received on the business's own
  // connected account, with in-app refunds. :id is a Stripe charge id (ch_…).
  getPayments: () => request('/payments'),
  getPayment: (id) => request(`/payments/${id}`),
  // Refund a charge. body.amount is dollars; omit it for a full (remaining) refund.
  refundPayment: (id, body = {}) =>
    request(`/payments/${id}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

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
  // Permanently delete an account: cancels its Stripe subscription and removes
  // all of its business_id-scoped data plus its business + user records. Blocked
  // server-side for business_id = 1.
  deleteBusiness: (id) => request(`/admin/businesses/${id}`, { method: 'DELETE' }),
};
