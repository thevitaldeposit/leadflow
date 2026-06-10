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

module.exports = { sendPasswordResetEmail };
