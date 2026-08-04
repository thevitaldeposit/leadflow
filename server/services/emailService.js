const { Resend } = require('resend');
const db = require('../db/database');
const { logActivity } = require('./activityLog');

// RESEND_API_KEY is read lazily (never at module load) so a deployment missing
// the variable still boots and serves every existing route — only the password-
// reset email fails, and it fails clearly, until the key is configured.
const FROM_ADDRESS = 'Stream <noreply@joinstream.app>';

// Shared font stack + Stream brand blues (blue-600 primary, blue-500 accent —
// pulled from the landing-page CTAs and the AudioLines logo mark).
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const STREAM_BLUE = '#2563eb';
const STREAM_BLUE_LIGHT = '#3b82f6';

// One deliverability test for every "we are about to email this" decision. Same
// shape as the signup/contact validators — an address must be non-blank and look
// like one. Anything that fails here can NEVER be emailed, so a caller that would
// have "sent" to it must block instead of silently no-op'ing.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(value) {
  if (value === null || value === undefined) return false;
  return EMAIL_RE.test(String(value).trim());
}

let _resend = null;
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error('RESEND_API_KEY is not configured — set it in the environment (Railway env vars / .env)');
  }
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

// Send the password-reset email containing a one-hour link to the reset page.
async function sendPasswordResetEmail(to, resetUrl) {
  const html = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #111827;">
    <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 16px;">Reset your password</h1>
    <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 0 0 24px;">
      We received a request to reset your Stream password. Click the button below to choose a new password. This link expires in 1 hour.
    </p>
    <a href="${resetUrl}" style="display: inline-block; background: #6366f1; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 500; padding: 12px 24px; border-radius: 8px;">
      Reset password
    </a>
    <p style="font-size: 13px; line-height: 1.6; color: #9ca3af; margin: 32px 0 0;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </div>`;

  return getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Reset your Stream password',
    html,
  });
}

// Welcome email sent right after a new account is created at signup. Greets the
// owner by first name and points them to the dashboard + setup call.
async function sendWelcomeEmail({ to, firstName }) {
  const greetingName = firstName ? escapeHtml(firstName) : 'there';

  const html = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #111827;">
    <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 20px;">You're in. Welcome to Stream.</h1>
    <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 0 0 16px;">Hi ${greetingName},</p>
    <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 0 0 16px;">
      Your Stream account is all set up and ready to go.
    </p>
    <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 0 0 8px;">Here's what happens next:</p>
    <ul style="font-size: 15px; line-height: 1.6; color: #374151; margin: 0 0 24px; padding-left: 20px;">
      <li>Log in to your dashboard at joinstream.app</li>
      <li>Schedule your setup call to activate your advanced booking and extraction features</li>
      <li>Once your setup is complete, every customer call will be automatically captured and turned into an actionable lead</li>
    </ul>
    <a href="https://joinstream.app/dashboard" style="display: inline-block; background: #6366f1; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 500; padding: 12px 24px; border-radius: 8px;">
      Go to Dashboard
    </a>
    <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 32px 0 0;">
      If you have any questions before your setup call, reply to this email or reach out at info@joinstream.app.
    </p>
    <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 24px 0 0;">
      Talk soon,<br />The Stream Team
    </p>
    <p style="font-size: 12px; line-height: 1.6; color: #9ca3af; margin: 32px 0 0; border-top: 1px solid #e5e7eb; padding-top: 16px;">
      Stream by Three T's Capital LLC · info@joinstream.app · <a href="https://joinstream.app/unsubscribe" style="color: #9ca3af;">joinstream.app/unsubscribe</a>
    </p>
  </div>`;

  return getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Welcome to Stream — let's get you set up",
    html,
  });
}

// Build the branded HTML for a customer invoice email. Email-safe: table-based
// layout, inline styles, mobile-friendly single column. Stream-blue header card,
// prominent amount, a single "View & Pay" CTA to the tokenized public invoice
// page, and a copy-paste fallback link. No due-date language by design. Pure
// (no I/O) so it can be rendered and inspected without sending.
function buildInvoiceEmailHtml({ businessName, customerName, invoiceNumber, total, link }) {
  const safeBiz = escapeHtml(businessName || 'Your service provider');
  const safeNum = escapeHtml(invoiceNumber || 'Invoice');
  const safeLink = escapeHtml(link || '#');
  const firstName = customerName ? escapeHtml(String(customerName).split(' ')[0]) : null;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const totalStr = total != null
    ? `$${Number(total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${safeNum} from ${safeBiz}</title>
</head>
<body style="margin:0; padding:0; width:100%; background-color:#eef2f7; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2f7;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:520px; margin:0 auto;">

          <!-- Header card (Stream blue) -->
          <tr>
            <td style="background-color:${STREAM_BLUE}; background-image:linear-gradient(135deg, ${STREAM_BLUE} 0%, ${STREAM_BLUE_LIGHT} 100%); border-radius:16px 16px 0 0; padding:36px 32px;">
              <p style="margin:0 0 22px; font-family:${FONT}; font-size:15px; font-weight:700; letter-spacing:0.04em; color:#ffffff;">Stream</p>
              <h1 style="margin:0; font-family:${FONT}; font-size:24px; line-height:1.25; font-weight:700; color:#ffffff;">You have a new invoice</h1>
              <p style="margin:8px 0 0; font-family:${FONT}; font-size:15px; color:#dbeafe;">${safeNum}</p>
            </td>
          </tr>

          <!-- Body card -->
          <tr>
            <td style="background-color:#ffffff; border-radius:0 0 16px 16px; padding:32px;">
              <p style="margin:0 0 16px; font-family:${FONT}; font-size:15px; line-height:1.6; color:#374151;">${greeting}</p>
              <p style="margin:0 0 24px; font-family:${FONT}; font-size:15px; line-height:1.6; color:#374151;">
                <strong style="color:#111827;">${safeBiz}</strong> has sent you an invoice${totalStr ? ` for <strong style="color:#111827;">${totalStr}</strong>` : ''}. Review the details and sign to confirm.
              </p>

              <!-- Invoice details panel -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb; border-radius:12px; background-color:#f8fafc;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 14px; font-family:${FONT}; font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#6b7280;">Invoice Details</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding:3px 0; font-family:${FONT}; font-size:14px; color:#6b7280;">From</td>
                        <td align="right" style="padding:3px 0; font-family:${FONT}; font-size:14px; font-weight:600; color:#111827;">${safeBiz}</td>
                      </tr>
                      <tr>
                        <td style="padding:3px 0; font-family:${FONT}; font-size:14px; color:#6b7280;">Invoice</td>
                        <td align="right" style="padding:3px 0; font-family:${FONT}; font-size:14px; font-weight:600; color:#111827;">${safeNum}</td>
                      </tr>
                    </table>
                    ${totalStr ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px; border-top:1px solid #e5e7eb;">
                      <tr>
                        <td style="padding-top:16px; font-family:${FONT}; font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#6b7280; vertical-align:bottom;">Total</td>
                        <td align="right" style="padding-top:16px; font-family:${FONT}; font-size:30px; font-weight:700; letter-spacing:-0.02em; color:#111827;">${totalStr}</td>
                      </tr>
                    </table>` : ''}
                  </td>
                </tr>
              </table>

              <!-- Call to action -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding:28px 0 4px;">
                    <a href="${safeLink}" style="display:inline-block; background-color:${STREAM_BLUE}; background-image:linear-gradient(135deg, ${STREAM_BLUE} 0%, ${STREAM_BLUE_LIGHT} 100%); color:#ffffff; text-decoration:none; font-family:${FONT}; font-size:16px; font-weight:600; line-height:1; padding:15px 44px; border-radius:10px;">View &amp; Pay</a>
                  </td>
                </tr>
              </table>

              <!-- Fallback link -->
              <p style="margin:20px 0 0; font-family:${FONT}; font-size:13px; line-height:1.6; color:#9ca3af;">
                If the button doesn't work, copy and paste this link into your browser:<br />
                <a href="${safeLink}" style="color:${STREAM_BLUE}; word-break:break-all;">${safeLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:22px 32px 8px;">
              <p style="margin:0; font-family:${FONT}; font-size:12px; color:#9ca3af;">Powered by <span style="font-weight:700; color:#6b7280;">Stream</span></p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Deliver an invoice link to the customer: a branded HTML email with a single
// "View & Pay" call-to-action to the tokenized public invoice page (review +
// sign + pay). Additive — reuses the lazy Resend client; never touches the
// other mails.
async function sendInvoiceEmail({ to, businessName, customerName, invoiceNumber, total, link }) {
  const safeBiz = escapeHtml(businessName || 'Your service provider');
  const safeNum = escapeHtml(invoiceNumber || 'Invoice');
  const html = buildInvoiceEmailHtml({ businessName, customerName, invoiceNumber, total, link });

  return getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `${safeNum} from ${safeBiz}`,
    html,
  });
}

// Email a customer a link to review + pay one invoice — the same Resend path the
// payment-link + owner "Send invoice" flows use. Resolves the business name from
// settings and builds the tokenized /invoice/:token link off the customer-facing app
// origin (PUBLIC_APP_URL, else joinstream.app). Used by the weight/overage flow to
// deliver an auto-generated overage/swap bill. Best-effort: returns {sent, reason};
// never throws into the caller. Never touches the call/recording/voice path.
async function sendInvoiceLinkEmail(invoice) {
  const raw = invoice && invoice.bill_to_email ? String(invoice.bill_to_email).trim() : null;
  const to = isValidEmail(raw) ? raw : null;
  if (!to) return { sent: false, reason: 'no_email' };
  if (!process.env.RESEND_API_KEY) return { sent: false, reason: 'no_email_provider' };
  const businessName = getDbSetting('businessName', invoice.business_id) || 'our team';
  const origin = (process.env.PUBLIC_APP_URL || 'https://joinstream.app').replace(/\/+$/, '');
  const link = `${origin}/invoice/${invoice.public_token}`;
  try {
    await sendInvoiceEmail({
      to,
      businessName,
      customerName: invoice.bill_to_name || null,
      invoiceNumber: invoice.invoice_number,
      total: invoice.total,
      link,
    });
    if (invoice.lead_id) logActivity(invoice.lead_id, 'invoice_sent', `Invoice ${invoice.invoice_number} emailed to ${to}`);
    console.log(`[email] Invoice ${invoice.invoice_number} emailed to ${to}`);
    return { sent: true, to, link };
  } catch (err) {
    console.error(`[email] Failed to email invoice ${invoice.id}:`, err.message);
    return { sent: false, reason: 'send_error', error: err.message };
  }
}

// Read a per-business setting value (mirrors smsService.getDbSetting) for the
// business name shown in the payment email.
function getDbSetting(key, businessId) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ? AND business_id = ?').get(key, businessId);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  } catch { return null; }
}

// Escape user-supplied text before interpolating it into the contact emails so a
// submission can't inject markup into the HTML body.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Notify the team of a new contact-form submission. Sets replyTo to the
// submitter so a reply from the inbox goes straight back to them.
async function sendContactNotification({ name, email, subject, message }) {
  const safeSubject = subject || 'General Inquiry';
  const submittedAt = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });

  const html = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #111827;">
    <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 20px;">New Contact Form Submission</h1>
    <table style="width: 100%; border-collapse: collapse; font-size: 15px; line-height: 1.6;">
      <tr><td style="padding: 6px 0; color: #6b7280; width: 120px; vertical-align: top;">Name</td><td style="padding: 6px 0; color: #111827;">${escapeHtml(name)}</td></tr>
      <tr><td style="padding: 6px 0; color: #6b7280; vertical-align: top;">Email</td><td style="padding: 6px 0; color: #111827;">${escapeHtml(email)}</td></tr>
      <tr><td style="padding: 6px 0; color: #6b7280; vertical-align: top;">Subject</td><td style="padding: 6px 0; color: #111827;">${escapeHtml(safeSubject)}</td></tr>
      <tr><td style="padding: 6px 0; color: #6b7280; vertical-align: top;">Message</td><td style="padding: 6px 0; color: #111827; white-space: pre-wrap;">${escapeHtml(message)}</td></tr>
      <tr><td style="padding: 6px 0; color: #6b7280; vertical-align: top;">Submitted at</td><td style="padding: 6px 0; color: #111827;">${escapeHtml(submittedAt)}</td></tr>
    </table>
  </div>`;

  return getResend().emails.send({
    from: FROM_ADDRESS,
    to: 'info@joinstream.app',
    replyTo: email,
    subject: `New Contact Form Submission: ${safeSubject}`,
    html,
  });
}

// Confirmation receipt sent back to whoever submitted the form.
async function sendContactConfirmation({ name, email }) {
  const html = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #111827;">
    <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 16px;">We received your message</h1>
    <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 0;">
      Hi ${escapeHtml(name)}, thanks for reaching out to Stream. We've received your message and will get back to you within 1 business day.
    </p>
    <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 24px 0 0;">— The Stream Team</p>
  </div>`;

  return getResend().emails.send({
    from: FROM_ADDRESS,
    to: email,
    subject: 'We received your message — Stream',
    html,
  });
}

module.exports = { sendPasswordResetEmail, sendContactNotification, sendContactConfirmation, sendWelcomeEmail, sendInvoiceEmail, sendInvoiceLinkEmail, buildInvoiceEmailHtml, isValidEmail };
