const { Resend } = require('resend');

// RESEND_API_KEY is read lazily (never at module load) so a deployment missing
// the variable still boots and serves every existing route — only the password-
// reset email fails, and it fails clearly, until the key is configured.
const FROM_ADDRESS = 'Stream <noreply@joinstream.app>';

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

module.exports = { sendPasswordResetEmail, sendContactNotification, sendContactConfirmation };
