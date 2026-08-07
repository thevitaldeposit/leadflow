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
    // Surface the parsed response body so callers can read structured error payloads
    // (e.g. a 409 "needs confirmation" response). Additive — existing catch blocks
    // that only read err.message / err.status are unaffected.
    err.data = data;
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
  // Body: { weightLbs?, swap?, unitsRemaining?, note?, assignmentId?, photoPath?,
  // dumpSite? } — weight is entered in POUNDS and converted to the stored tons at the
  // server boundary. assignmentId names the physical unit the weight came off, so the
  // ticket bills the job that can actually sat on and prices the overage on the unit's
  // own size. photoPath (the scale-ticket photo) and dumpSite are record-keeping only:
  // they're stored on the ticket and never read by any pricing or lifecycle decision.
  recordDumpTicket: (id, body) =>
    request(`/leads/${id}/dump-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  // Correct a recorded weight (index into the job's dump tickets). The ticket is the
  // source of truth — the server rewrites its overage invoice line + logs the
  // correction. 409 when that ticket's invoice is already signed/paid.
  updateDumpTicketWeight: (id, index, body) =>
    request(`/leads/${id}/dump-ticket/${index}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  // ── Unit assignment (which physical dumpster is on a job) ────────────────────
  // getLeadUnits resolves to { jobSize, onSite[], available[], history[] }. Capture
  // only — none of these touch weight, overage, or the job's completion.
  getLeadUnits: (id) => request(`/leads/${id}/units`),
  // Record the unit dropped at delivery. Body: { assetId, notes? }. Rejects a unit
  // that's already out on another job.
  dropUnit: (id, body) =>
    request(`/leads/${id}/units/drop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  // Record which unit came back. Body: { assetId } — must be on site for this job.
  pickUpUnit: (id, body) =>
    request(`/leads/${id}/units/pickup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  // The yard queue: units picked up but not yet weighed, each with the job its weight
  // belongs to → { units: [{ assignmentId, leadId, label, size, customerName, … }] }.
  getYardUnits: () => request('/assets/yard'),
  // Mark a delivery/pickup done for a job that has NO unit assignments to derive it
  // from (a legacy job, or a business with no fleet registered). Display state only —
  // the server refuses this when the job does track its units, and it never touches
  // units_out, the completion gate, or any invoice. Body: { task: 'delivery'|'pickup' }.
  markTaskDone: (id, task) =>
    request(`/leads/${id}/task-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    }),
  // Resolve a confirm-first cancellation cue. confirm=true → mark lost; false → keep.
  resolveCancel: (id, confirm) =>
    request(`/leads/${id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: !!confirm }),
    }),
  // Call-driven draft-invoice review (Part 2): the pending swap/extension draft for a
  // lead + a server-computed extension inventory warning. resolveInvoiceReview clears
  // the marker — action 'sent' (owner approved + sent it) or 'discard' (drop the draft).
  getInvoiceReview: (leadId) => request(`/leads/${leadId}/invoice-review`),
  resolveInvoiceReview: (leadId, action) =>
    request(`/leads/${leadId}/invoice-review/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
  // Owner set/changed the swap's delivery date on the review screen → server recomputes
  // the swap line's remaining-days + price (pickup date stays fixed). Returns the new
  // { swapDeliveryDate, days, amount, description, invoice }.
  recomputeSwapDate: (leadId, swapDeliveryDate) =>
    request(`/leads/${leadId}/invoice-review/recompute-swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ swapDeliveryDate }),
    }),
  // Owner set/changed the extension's extra days on the review screen → server reprices the
  // extension line (extraDays × the size's day rate; pickup advances only on payment). Days 0
  // removes the line; a size with no day rate returns { needsRate }. Returns
  // { extraDays, removed, needsRate, amount, dayRate, description, extensionWarning, invoice }.
  recomputeExtensionDays: (leadId, extraDays) =>
    request(`/leads/${leadId}/invoice-review/recompute-extension`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraDays }),
    }),
  // Customers — the unified person-level record (consolidates leads/opportunities)
  getCustomers: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/customers${qs ? `?${qs}` : ''}`);
  },
  getCustomer: (id) => request(`/customers/${id}`),
  // Read-only: does this phone already belong to a DIFFERENT-named customer for this
  // business? Powers the manual booking form's "Next" merge confirm. Creates nothing.
  // Returns { needsConfirmation, customer: { id, name } | null }.
  lookupCustomerByPhone: ({ phone, firstName, lastName } = {}) => {
    const qs = new URLSearchParams();
    if (phone) qs.set('phone', phone);
    if (firstName) qs.set('firstName', firstName);
    if (lastName) qs.set('lastName', lastName);
    return request(`/customers/lookup?${qs.toString()}`);
  },
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
  // Compute a suggested price for a size + rental duration (+ optional customer) from
  // the configured pricing model. Used to PREFILL an editable booking price. Returns
  // the breakdown + `suggested_total` (base + extra days + delivery fee).
  getPriceQuote: (body) =>
    request('/pricing/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
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

  // Business-wide fees (delivery, mileage/out-of-area) — each independently toggleable.
  createPricingFee: (body) =>
    request('/pricing/fees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updatePricingFee: (id, body) =>
    request(`/pricing/fees/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deletePricingFee: (id) => request(`/pricing/fees/${id}`, { method: 'DELETE' }),

  // Special / restricted items (prohibited or surcharge).
  createSpecialItem: (body) =>
    request('/pricing/special-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateSpecialItem: (id, body) =>
    request(`/pricing/special-items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteSpecialItem: (id) => request(`/pricing/special-items/${id}`, { method: 'DELETE' }),

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
  // requireEmail: for callers whose action IS "email this to the customer" (the
  // review screen's Approve & Send). The server then refuses — instead of marking the
  // invoice sent and delivering nothing — when there's no valid address on it.
  sendInvoice: (id, channel = 'both', { requireEmail = false } = {}) =>
    request(`/invoices/${id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, requireEmail }),
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
  // Customer self-serve: verify/correct the booking's delivery address (+ access
  // notes) from the public invoice page before signing. Server whitelists the fields
  // and writes the corrected address to the lead the schedule reads. Returns the
  // refreshed public invoice.
  updateInvoiceDelivery: (token, body) =>
    request(`/public/invoices/${token}/delivery-details`, {
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

  // Fleet registry — the individual dumpsters a business owns. Per-size counts
  // (and therefore availability) are derived from these rows.
  // getFleet resolves to { assets, bySize, statuses }.
  getFleet: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/assets${qs ? `?${qs}` : ''}`);
  },
  createAsset: (body) =>
    request('/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateAsset: (id, body) =>
    request(`/assets/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  retireAsset: (id) => request(`/assets/${id}`, { method: 'DELETE' }),

  // Dump sites — the landfills / transfer stations the business hauls to. Reference
  // data only: the guided pickup flow lists them and opens directions to the address.
  // Nothing here is priced, geocoded, or wired to the mileage fee.
  getDumpSites: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/dump-sites${qs ? `?${qs}` : ''}`);
  },
  createDumpSite: (body) =>
    request('/dump-sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateDumpSite: (id, body) =>
    request(`/dump-sites/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  retireDumpSite: (id) => request(`/dump-sites/${id}`, { method: 'DELETE' }),

  // Upload a photographed scale ticket → { photoPath, reading: { weightLbs, label,
  // confidence } | null, readError? }. The reading only PRE-FILLS the weight box —
  // nothing is submitted until the owner confirms it, and a failed read still returns
  // the stored photoPath so the photo stays attached as overage evidence.
  readScaleTicket: (file) => {
    const form = new FormData();
    form.append('photo', file);
    return request('/scale-tickets/read', { method: 'POST', body: form });
  },

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
