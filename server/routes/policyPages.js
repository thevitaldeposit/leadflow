const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { getSetting } = require('../services/settingsService');

// ── Per-customer SMS compliance pages (privacy policy + SMS terms) ───────────
// Public, server-rendered HTML at /c/:slug/privacy and /c/:slug/terms. One route
// + one template renders every Stream customer from their `businesses` row — no
// per-customer files. Carrier A2P 10DLC review loads these directly (no login,
// no client-side JS render), so each handler returns full HTML with a 200, and an
// unknown slug returns a real 404 (a blank/parked page gets the campaign rejected).

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Render an ISO-ish date ("2026-06-23" or a full timestamp) as "June 23, 2026".
// Parsed from the literal Y-M-D parts (not via Date) so it never timezone-shifts
// to the previous day. Falls back to the raw string if it doesn't look like a date.
function formatEffectiveDate(value) {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!m) return String(value);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return String(value);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

// Format a US phone number for display, e.g. "+18155030701" -> "(815) 503-0701".
// Anything that isn't a recognizable 10-digit (optionally +1) number is returned
// unchanged so already-formatted values pass through untouched.
function formatPhone(value) {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return String(value);
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// Pull just the date portion ("2026-06-23") out of a stored timestamp.
function dateOnly(value) {
  if (!value) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : '';
}

// Assemble the five fields the templates need from a business row, layering in
// sensible fallbacks so a page is always complete (an empty field reads as a
// parked page to a carrier reviewer). The dedicated columns win; then Settings;
// then other columns already on the business.
function policyData(biz) {
  const businessName = (biz.name && biz.name.trim()) || 'This Business';

  const service =
    (biz.service && biz.service.trim()) ||
    (biz.industry_type && biz.industry_type.trim().toLowerCase()) ||
    'service';

  const contactEmail =
    (biz.contact_email && biz.contact_email.trim()) ||
    getSetting('businessEmail', biz.id) ||
    '';

  const contactPhone =
    (biz.contact_phone && biz.contact_phone.trim()) ||
    getSetting('businessPhone', biz.id) ||
    formatPhone(biz.user_phone_number) ||
    '';

  const effectiveDate = formatEffectiveDate(biz.policy_effective_date || dateOnly(biz.created_at));

  return { businessName, service, contactEmail, contactPhone, effectiveDate };
}

function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#1a202c;max-width:720px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:24px;line-height:1.25;margin:0 0 4px}
  .effective{color:#64748b;font-size:14px;margin:0 0 24px}
  p{margin:0 0 16px}
  strong{color:#0f172a}
  .footer{margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px}
</style>
</head>
<body>
${body}
<div class="footer">Messaging powered by Stream.</div>
</body>
</html>`;
}

// PRIVACY POLICY template. The trailing "services" in the overview/use sentences
// is literal — `service` is the noun phrase (e.g. "dumpster rental"), giving
// "...book dumpster rental services...".
function renderPrivacy(d) {
  const name = esc(d.businessName);
  const service = esc(d.service);
  const email = esc(d.contactEmail);
  const phone = esc(d.contactPhone);
  const body = `
<h1>${name} — Privacy Policy</h1>
<p class="effective">Effective ${esc(d.effectiveDate)}</p>

<p><strong>Overview</strong> — This Privacy Policy describes how ${name} ("we", "us") collects and uses information when you book ${service} services and when we send you transactional text messages about your booking. We send these messages using Stream, a messaging platform acting on our behalf.</p>

<p><strong>Information we collect</strong> — We collect the information you provide when booking a service, including your name, mobile phone number, service address, and booking details. We collect your mobile number specifically to send you a payment link and booking-related updates by SMS.</p>

<p><strong>How we use your information</strong> — We use your information to schedule and fulfill your ${service} booking, to send you a one-time payment link by SMS after your booking is confirmed, and to respond to your questions. We do not use your mobile number to send marketing or promotional messages.</p>

<p><strong>SMS consent and your mobile information</strong> — No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Information sharing with subcontractors in support services, such as customer service or our messaging provider, is permitted solely to deliver the service you requested. All other categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.</p>

<p><strong>Opting out</strong> — You can stop receiving text messages at any time by replying STOP to any message. For help, reply HELP or contact us at ${email}. Message and data rates may apply.</p>

<p><strong>Contact</strong> — ${name} / Email: ${email} / Phone: ${phone}</p>`;
  return shell(`${d.businessName} — Privacy Policy`, body);
}

// SMS TERMS & CONDITIONS template.
function renderTerms(d) {
  const name = esc(d.businessName);
  const service = esc(d.service);
  const email = esc(d.contactEmail);
  const phone = esc(d.contactPhone);
  const body = `
<h1>${name} — SMS Terms &amp; Conditions</h1>
<p class="effective">Effective ${esc(d.effectiveDate)}</p>

<p><strong>Program description</strong> — When you book ${service} services with ${name}, you may agree during your booking call to receive a transactional text message containing a one-time payment link for your booking. This is a transactional program; we do not send marketing or promotional texts.</p>

<p><strong>How you consent</strong> — During a recorded booking call, our representative tells you that a payment link will be sent by text to the mobile number you provide, and you verbally agree to receive it. Consent to receive texts is not a condition of purchasing any goods or services.</p>

<p><strong>Message frequency</strong> — Message frequency varies and is tied to your bookings — typically one message containing a payment link per confirmed booking.</p>

<p><strong>Cost</strong> — Message and data rates may apply, depending on your mobile carrier and plan.</p>

<p><strong>Opt out and help</strong> — Reply STOP to any message to stop receiving texts; you will receive a confirmation and no further messages. Reply HELP for help, or contact ${name} at ${email} or ${phone}.</p>

<p><strong>Carriers</strong> — Carriers are not liable for delayed or undelivered messages.</p>

<p><strong>Changes</strong> — We may update these terms; the effective date above reflects the latest version.</p>`;
  return shell(`${d.businessName} — SMS Terms & Conditions`, body);
}

function notFound(res) {
  return res.status(404).type('text/html').send(shell('Page Not Found', `
<h1>Page Not Found</h1>
<p>We couldn't find a policy page at this address. Please check the link and try again.</p>`));
}

// Look up the business by slug. Slugs are stored lowercased; lowercase + trim the
// incoming param so a capitalized or padded URL still resolves, but never
// re-slugify (that could collapse a different slug onto this one).
function findBusinessBySlug(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) return null;
  return db
    .prepare(
      'SELECT id, name, slug, service, contact_email, contact_phone, policy_effective_date, industry_type, user_phone_number, created_at FROM businesses WHERE slug = ?'
    )
    .get(normalized);
}

// GET /c/:slug/privacy
router.get('/:slug/privacy', (req, res) => {
  try {
    const biz = findBusinessBySlug(req.params.slug);
    if (!biz) return notFound(res);
    res.type('text/html').send(renderPrivacy(policyData(biz)));
  } catch (err) {
    console.error('[policyPages] privacy render error:', err);
    res.status(500).type('text/html').send('<h1 style="font-family:sans-serif;padding:40px">Error loading page.</h1>');
  }
});

// GET /c/:slug/terms
router.get('/:slug/terms', (req, res) => {
  try {
    const biz = findBusinessBySlug(req.params.slug);
    if (!biz) return notFound(res);
    res.type('text/html').send(renderTerms(policyData(biz)));
  } catch (err) {
    console.error('[policyPages] terms render error:', err);
    res.status(500).type('text/html').send('<h1 style="font-family:sans-serif;padding:40px">Error loading page.</h1>');
  }
});

module.exports = router;
