const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { getSetting } = require('../services/settingsService');

// ── Per-customer consumer legal pages (privacy policy + SMS terms) ───────────
// Public, server-rendered HTML at /c/:slug/privacy and /c/:slug/terms. One route
// + one layout renders every Stream customer from their `businesses` row — no
// per-customer files, no second table. These are each business's standalone
// consumer policies and satisfy A2P 10DLC carrier review; they are SEPARATE from
// Stream's own platform Privacy/Terms at /privacy and /terms.
//
// Carrier review bots load these directly and may not run JavaScript, so the
// full copy is rendered server-side in the initial HTML — the table-of-contents,
// scrollspy, and styling are progressive enhancement only and gate no content.
// Each handler returns full HTML with a 200; an unknown slug returns a real 404
// (a blank/parked page gets the campaign rejected).

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

// Build a `tel:` href from a phone string if it carries a usable number; returns
// '' otherwise so the caller can fall back to plain text.
function telHref(value) {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `tel:+${digits}`;
  return '';
}

// Assemble every field the templates need from a business row, layering in
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

  const processor = (biz.processor && biz.processor.trim()) || 'Stripe';

  // Governing-law state. When a business hasn't set one, fall back to a neutral
  // phrase that still reads correctly inside "governed by the laws of ___".
  const stateRaw = (biz.state && biz.state.trim()) || '';
  const state = stateRaw || `the state in which ${businessName} operates`;

  return { businessName, service, contactEmail, contactPhone, effectiveDate, processor, state };
}

// ── Layout ───────────────────────────────────────────────────────────────────
// One professional legal-document shell shared by both pages. `sections` is an
// ordered list of { id, title, body } where `body` is pre-built, escaped HTML.
// The numbered table of contents and the section numbers are derived from the
// array order so they can never drift out of sync. Numbers are real text content
// (not CSS counters) so a non-JS, non-CSS bot still sees the structure.
function layout({ pageTitle, docTitle, businessName, effectiveDate, sections }) {
  const toc = sections
    .map((s, i) => `        <li><a href="#${s.id}">${i + 1}. ${esc(s.title)}</a></li>`)
    .join('\n');

  const main = sections
    .map(
      (s, i) => `      <section id="${s.id}" class="section" tabindex="-1" aria-labelledby="${s.id}-h">
        <h2 id="${s.id}-h"><span class="num">${i + 1}</span><span class="htext">${esc(s.title)}</span></h2>
${s.body}
      </section>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index,follow">
<title>${esc(pageTitle)}</title>
<style>
  :root{
    --accent:#345a82;--accent-strong:#284766;--accent-tint:#eef3f9;--accent-edge:#cfdeeb;
    --ink:#1f2933;--ink-soft:#52606d;--muted:#7b8794;--line:#e4e8ec;--bg:#ffffff;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    --serif:Georgia,'Iowan Old Style','Palatino Linotype','Times New Roman',serif;
  }
  *,*::before,*::after{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--serif);font-size:17px;line-height:1.72}
  .page{max-width:1060px;margin:0 auto;padding:52px 24px 88px}

  /* Letterhead */
  .letterhead{border-bottom:1px solid var(--line);padding-bottom:30px;margin-bottom:40px}
  .eyebrow{font-family:var(--sans);font-variant:small-caps;font-feature-settings:"smcp" 1;letter-spacing:.06em;font-size:16px;font-weight:600;color:var(--accent);margin:0 0 10px}
  .letterhead h1{font-family:var(--sans);font-size:30px;line-height:1.18;font-weight:700;letter-spacing:-.01em;color:var(--ink);margin:0 0 14px}
  .effective{font-family:var(--sans);font-size:14px;color:var(--muted);margin:0}
  .operator{font-family:var(--sans);font-size:14px;color:var(--ink-soft);margin:8px 0 0}

  /* Two-column layout: sticky TOC + reading column */
  .layout{display:grid;grid-template-columns:236px minmax(0,1fr);gap:52px;align-items:start}
  .toc{position:sticky;top:28px;font-family:var(--sans)}
  .toc-title{text-transform:uppercase;letter-spacing:.13em;font-size:11px;font-weight:700;color:var(--muted);margin:0 0 14px}
  .toc ol{list-style:none;margin:0;padding:0;border-left:2px solid var(--line)}
  .toc li{margin:0}
  .toc a{display:block;padding:6px 0 6px 16px;margin-left:-2px;border-left:2px solid transparent;color:var(--ink-soft);text-decoration:none;font-size:13.5px;line-height:1.45;transition:color .15s ease,border-color .15s ease}
  .toc a:hover{color:var(--accent)}
  .toc a.active{color:var(--accent-strong);border-left-color:var(--accent);font-weight:600}

  /* Reading column — ~720px measure */
  .content{max-width:720px;min-width:0}
  .section{scroll-margin-top:24px;padding-top:6px;margin-bottom:34px}
  .section + .section{border-top:1px solid var(--line);padding-top:30px}
  .content h2{font-family:var(--sans);font-size:19px;font-weight:700;line-height:1.3;color:var(--ink);margin:0 0 14px;display:flex;align-items:baseline;gap:12px}
  .content h2 .num{font-size:13px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:16px}
  .content p{margin:0 0 16px}
  .content ul{margin:0 0 16px;padding-left:22px}
  .content li{margin:0 0 9px}
  .content li:last-child{margin-bottom:0}
  .content strong{color:var(--ink);font-weight:700}
  .content a{color:var(--accent)}
  .lead{color:var(--ink-soft)}

  /* Highlighted callout (verbatim mobile-sharing clause) */
  .callout{font-family:var(--sans);background:var(--accent-tint);border:1px solid var(--accent-edge);border-left:4px solid var(--accent);border-radius:8px;padding:18px 20px;margin:6px 0 18px}
  .callout p{margin:0;font-size:15px;line-height:1.62;color:#27425d}

  /* Contact block */
  .contact dl{font-family:var(--sans);margin:0;font-size:15px}
  .contact dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 2px}
  .contact dt:first-child{margin-top:0}
  .contact dd{margin:0;color:var(--ink)}
  .contact dd a{color:var(--accent)}

  /* Footer */
  .footer{font-family:var(--sans);max-width:720px;margin:52px 0 0;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px;line-height:1.6}
  .footer a{color:var(--muted)}

  /* Keyboard focus */
  a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
  .section:focus{outline:none}

  /* Motion */
  @media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
  @media (prefers-reduced-motion:reduce){.toc a{transition:none}}

  /* Responsive: collapse to a single column with an inline TOC */
  @media (max-width:840px){
    .layout{grid-template-columns:1fr;gap:0}
    .toc{position:static;margin-bottom:34px;padding-bottom:26px;border-bottom:1px solid var(--line)}
    .toc ol{border-left:0;display:flex;flex-wrap:wrap;gap:4px 20px}
    .toc a{padding:3px 0;border-left:0!important}
    .content,.footer{max-width:none}
  }
  @media (max-width:520px){
    .page{padding:34px 18px 64px}
    .letterhead h1{font-size:25px}
    body{font-size:16.5px}
  }

  /* Print */
  @media print{
    .toc,.footer{display:none}
    .layout{grid-template-columns:1fr;gap:0}
    body{font-size:11.5pt;color:#000;line-height:1.55}
    .page{max-width:none;padding:0}
    .content{max-width:none}
    .callout{background:transparent;border:1px solid #999}
    .section + .section{border-top:1px solid #ccc}
    a{color:#000}
  }
</style>
</head>
<body>
  <div class="page">
    <header class="letterhead">
      <p class="eyebrow">${esc(businessName)}</p>
      <h1>${esc(docTitle)}</h1>
      <p class="effective">Effective ${esc(effectiveDate)}</p>
      <p class="operator">This page is operated by Stream on behalf of ${esc(businessName)}.</p>
    </header>
    <div class="layout">
      <nav class="toc" aria-label="Table of contents">
        <p class="toc-title">Contents</p>
        <ol>
${toc}
        </ol>
      </nav>
      <main class="content">
${main}
      </main>
    </div>
    <footer class="footer">
      <p>This ${esc(docTitle)} is provided by ${esc(businessName)} and applies to its services and booking-related messaging. Messaging and software are operated by Stream on ${esc(businessName)}'s behalf. Stream's own platform policies are available at <a href="https://joinstream.app/privacy">joinstream.app/privacy</a> and <a href="https://joinstream.app/terms">joinstream.app/terms</a>.</p>
    </footer>
  </div>
  <script>
    // Scrollspy: highlight the table-of-contents entry for the section in view.
    // Pure progressive enhancement — without JS the links are plain anchors and
    // every section is already in the server-rendered HTML.
    (function () {
      var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
      if (!links.length || !('IntersectionObserver' in window)) return;
      var byId = {};
      links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
      var ratios = {};
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { ratios[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; });
        var topId = null, top = -1;
        Object.keys(ratios).forEach(function (id) { if (ratios[id] > top) { top = ratios[id]; topId = id; } });
        links.forEach(function (a) { a.classList.remove('active'); });
        if (topId && byId[topId]) byId[topId].classList.add('active');
      }, { rootMargin: '-12% 0px -72% 0px', threshold: [0, 0.25, 0.5, 1] });
      document.querySelectorAll('.section').forEach(function (s) { observer.observe(s); });
    })();
  </script>
</body>
</html>`;
}

// Render the contact section body shared by both documents.
function contactBody(d) {
  const name = esc(d.businessName);
  const email = esc(d.contactEmail);
  const phone = esc(d.contactPhone);
  const tel = telHref(d.contactPhone);
  let rows = `        <dt>Business</dt>\n        <dd>${name}</dd>`;
  if (email) {
    rows += `\n        <dt>Email</dt>\n        <dd><a href="mailto:${email}">${email}</a></dd>`;
  }
  if (phone) {
    const phoneCell = tel ? `<a href="${esc(tel)}">${phone}</a>` : phone;
    rows += `\n        <dt>Phone</dt>\n        <dd>${phoneCell}</dd>`;
  }
  return `        <div class="contact"><dl>\n${rows}\n        </dl></div>`;
}

// ── Privacy Policy ───────────────────────────────────────────────────────────
// The trailing word "services" in several sentences is literal — `service` is
// the bare noun phrase (e.g. "dumpster rental"), giving "...dumpster rental
// services...". All interpolated values are escaped here.
function renderPrivacy(d) {
  const name = esc(d.businessName);
  const service = esc(d.service);
  const email = esc(d.contactEmail);
  const processor = esc(d.processor);

  const sections = [
    {
      id: 'introduction',
      title: 'Introduction',
      body: `        <p class="lead">This Privacy Policy explains how ${name} ("we," "us," or "our") collects, uses, and protects information in connection with the ${service} services we provide and the transactional text messages we send about your booking.</p>
        <p>These services and messages are delivered using Stream, a software and messaging platform that operates this page and our text messaging on our behalf. Throughout this policy, "we" and "us" refer to ${name}.</p>`,
    },
    {
      id: 'information-we-collect',
      title: 'Information we collect',
      body: `        <p>We collect only the information needed to book and complete your service:</p>
        <ul>
          <li><strong>Booking information you provide by phone.</strong> When you call to book ${service} services, we collect your name, mobile phone number, email address (if you provide one), service address, and the details of the job you request.</li>
          <li><strong>Payment information.</strong> Payments are processed by ${processor}, our payment provider. ${processor} collects your card details directly through its secure checkout; neither ${name} nor Stream stores your full card number.</li>
          <li><strong>Limited technical information.</strong> When you open a page we host (such as a payment link or this policy), routine technical data such as your IP address, browser type, and the time of your visit may be logged to keep those pages secure and working.</li>
        </ul>`,
    },
    {
      id: 'how-we-use',
      title: 'How we use your information',
      body: `        <p>We use the information we collect to:</p>
        <ul>
          <li>schedule, confirm, and fulfill your ${service} booking;</li>
          <li>send you a one-time text message containing a payment link for your booking;</li>
          <li>process your payment through ${processor};</li>
          <li>respond to your questions and provide customer support; and</li>
          <li>protect the security of our services and comply with our legal obligations.</li>
        </ul>
        <p>We do <strong>not</strong> send marketing or promotional text messages, and we do not use your mobile number for marketing.</p>`,
    },
    {
      id: 'how-we-share',
      title: 'How we share information',
      body: `        <p>We share information only as needed to provide our services:</p>
        <ul>
          <li><strong>Service providers.</strong> We share information with the companies that help us operate, including Stream (our messaging and software platform) and ${processor} (our payment processor). They may use it only to perform services for us.</li>
          <li><strong>Legal reasons.</strong> We may disclose information if required by law, or to protect our rights, safety, or property.</li>
          <li><strong>Business transfers.</strong> If our business is sold or reorganized, information may be transferred as part of that transaction.</li>
          <li><strong>With your consent.</strong> We may share information for any other purpose you have agreed to.</li>
        </ul>
        <div class="callout">
          <p>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Sharing with subcontractors who provide support services, such as our messaging and payment providers, is permitted solely to deliver the service you requested. All other categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.</p>
        </div>`,
    },
    {
      id: 'text-message-program',
      title: 'Text message program',
      body: `        <p>We operate a transactional text message program tied to your booking:</p>
        <ul>
          <li><strong>How you opt in.</strong> During a recorded booking call, our representative tells you that a one-time payment link will be sent by text to the mobile number you provide, that message and data rates may apply, and that you can reply STOP to opt out. You verbally agree on the call to receive the message. There is no website checkbox or online opt-in form; consent is given verbally.</li>
          <li><strong>What we send.</strong> Transactional messages only — typically a single text containing your payment link per confirmed booking.</li>
          <li><strong>Message and data rates.</strong> Message and data rates may apply, depending on your mobile carrier and plan.</li>
          <li><strong>Opting out and help.</strong> Reply STOP to any message to stop receiving texts, or reply HELP for help.</li>
          <li><strong>Not a condition of purchase.</strong> Agreeing to receive texts is not a condition of purchasing any goods or services.</li>
        </ul>`,
    },
    {
      id: 'cookies',
      title: 'Cookies and tracking',
      body: `        <p>The pages we host are intentionally simple. We do not use advertising or cross-site tracking cookies, and we do not use your information for behavioral advertising. We may use a small number of strictly necessary cookies or similar technologies to keep hosted pages — such as the payment checkout — secure and functioning.</p>`,
    },
    {
      id: 'retention',
      title: 'Data retention',
      body: `        <p>We keep booking and payment records for as long as needed to provide our services, resolve disputes, meet our tax and accounting obligations, and comply with the law. When information is no longer needed for these purposes, we delete or de-identify it.</p>`,
    },
    {
      id: 'security',
      title: 'Security',
      body: `        <p>We use reasonable administrative, technical, and physical safeguards designed to protect your information. Payment card data is handled by ${processor} under its own security standards and is not stored by us. No method of transmission or storage is completely secure, so we cannot guarantee absolute security.</p>`,
    },
    {
      id: 'your-choices',
      title: 'Your choices and privacy rights',
      body: `        <p>Depending on where you live, you may have the right to access, correct, or delete the personal information we hold about you, or to opt out of certain processing. You can stop text messages at any time by replying STOP.</p>
        <p>To make a request about your information, contact us using the details below; we will respond as required by applicable law and will not discriminate against you for exercising these rights.</p>`,
    },
    {
      id: 'children',
      title: "Children's privacy",
      body: `        <p>Our services are intended for adults. We do not knowingly collect personal information from children under 13. If you believe a child has provided us with information, please contact us and we will delete it.</p>`,
    },
    {
      id: 'changes',
      title: 'Changes to this policy',
      body: `        <p>We may update this Privacy Policy from time to time. The effective date shown at the top of this page reflects the most recent version, and material changes take effect when posted here.</p>`,
    },
    {
      id: 'contact',
      title: 'Contact us',
      body: `        <p>If you have questions about this Privacy Policy or your information, contact ${name}:</p>
${contactBody(d)}`,
    },
  ];

  return layout({
    pageTitle: `${d.businessName} — Privacy Policy`,
    docTitle: 'Privacy Policy',
    businessName: d.businessName,
    effectiveDate: d.effectiveDate,
    sections,
  });
}

// ── SMS Terms & Conditions ────────────────────────────────────────────────────
function renderTerms(d) {
  const name = esc(d.businessName);
  const service = esc(d.service);
  const processor = esc(d.processor);
  const state = esc(d.state);

  const sections = [
    {
      id: 'acceptance',
      title: 'Acceptance of these terms',
      body: `        <p class="lead">These Terms &amp; Conditions govern your booking of ${service} services from ${name} ("we," "us," or "our") and the text messages we send about your booking.</p>
        <p>By booking with us, you agree to these Terms. Payments are processed by ${processor}, and your payment is also subject to ${processor}'s applicable terms.</p>`,
    },
    {
      id: 'services',
      title: 'Our services and phone booking',
      body: `        <p>We provide ${service} services, which you book by phone. During the call we confirm the details of your job — including scope, service address, scheduling, and price — and arrange your booking. Our representative may also explain that a one-time payment link will be sent to you by text message.</p>`,
    },
    {
      id: 'payment',
      title: 'Payment',
      body: `        <p>Payment is collected through a secure checkout hosted by ${processor}, reached from a one-time payment link we text to you. By completing payment, you authorize the charge for the agreed amount plus any applicable taxes and fees.</p>
        <p>Card details are entered directly with ${processor}. ${name} does not store your full card number.</p>`,
    },
    {
      id: 'cancellations',
      title: 'Cancellations and refunds',
      body: `        <p>If you need to cancel or reschedule, please contact us as soon as possible using the details below. Refund eligibility depends on the timing of your request and the status of the work. We will work with you in good faith and consistent with applicable law.</p>`,
    },
    {
      id: 'sms-terms',
      title: 'Text messaging terms',
      body: `        <p>By providing your mobile number during a recorded booking call and verbally agreeing on that call, you consent to receive a transactional text message containing your payment link. This is a transactional program — typically one message per confirmed booking.</p>
        <ul>
          <li>Message and data rates may apply, depending on your carrier and plan.</li>
          <li>Reply STOP at any time to opt out, or reply HELP for help.</li>
          <li>Consent to receive texts is not a condition of purchasing any goods or services.</li>
          <li>Mobile carriers are not liable for delayed or undelivered messages.</li>
        </ul>`,
    },
    {
      id: 'responsibilities',
      title: 'Your responsibilities',
      body: `        <p>You agree to provide accurate booking information, to ensure safe and lawful access to the service location, and to provide a mobile number you are authorized to use. You are responsible for any charges your carrier applies to messages you receive.</p>`,
    },
    {
      id: 'disclaimers',
      title: 'Disclaimers and limitation of liability',
      body: `        <p>To the fullest extent permitted by law, our services are provided "as is" and "as available," without warranties of any kind, whether express or implied.</p>
        <p>To the maximum extent permitted by law, ${name}'s total liability arising out of or relating to your booking or these Terms will not exceed the amount you paid for the service giving rise to the claim. We are not liable for any indirect, incidental, special, or consequential damages.</p>`,
    },
    {
      id: 'governing-law',
      title: 'Governing law',
      body: `        <p>These Terms are governed by the laws of ${state}, without regard to its conflict-of-laws rules. Any dispute arising out of or relating to these Terms or your booking will be subject to the courts located in ${state}, unless applicable law requires otherwise.</p>`,
    },
    {
      id: 'changes',
      title: 'Changes to these terms',
      body: `        <p>We may update these Terms from time to time. The effective date shown at the top of this page reflects the latest version, and changes take effect when posted here.</p>`,
    },
    {
      id: 'contact',
      title: 'Contact us',
      body: `        <p>Questions about these Terms? Contact ${name}:</p>
${contactBody(d)}`,
    },
  ];

  return layout({
    pageTitle: `${d.businessName} — Terms of Service`,
    docTitle: 'Terms of Service',
    businessName: d.businessName,
    effectiveDate: d.effectiveDate,
    sections,
  });
}

// A real, styled 404 — never a blank or half-rendered page (a parked page fails
// carrier review). Standalone HTML so it doesn't depend on a business row.
function notFound(res) {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page Not Found</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;color:#1f2933;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding:24px}
  .box{max-width:420px;text-align:center}
  .code{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#345a82;margin:0 0 10px}
  h1{font-size:24px;margin:0 0 10px}
  p{color:#52606d;line-height:1.6;margin:0}
</style>
</head>
<body>
  <div class="box">
    <p class="code">404 — Not Found</p>
    <h1>We couldn't find that page</h1>
    <p>There is no policy page at this address. Please check the link and try again.</p>
  </div>
</body>
</html>`;
  return res.status(404).type('text/html').send(body);
}

// Look up the business by slug. Slugs are stored lowercased; lowercase + trim the
// incoming param so a capitalized or padded URL still resolves, but never
// re-slugify (that could collapse a different slug onto this one).
function findBusinessBySlug(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) return null;
  return db
    .prepare(
      `SELECT id, name, slug, service, contact_email, contact_phone, policy_effective_date,
              state, processor, industry_type, user_phone_number, created_at
       FROM businesses WHERE slug = ?`
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
