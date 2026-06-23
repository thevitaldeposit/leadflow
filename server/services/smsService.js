const https = require('https');
const { URLSearchParams } = require('url');
const db = require('../db/database');
const { logActivity } = require('./activityLog');

const PAYMENT_BASE_URL = 'https://leadflow-production-9c02.up.railway.app';

function getDbSetting(key, businessId) {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ? AND business_id = ?')
    .get(key, businessId);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

function twilioPost(accountSid, authToken, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.message || `Twilio HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`Twilio parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendPaymentSms(lead, force = false) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.log('[sms] Twilio credentials not configured — skipping SMS');
    return { sent: false, reason: 'no_credentials' };
  }

  const smsEnabled = getDbSetting('smsEnabled', lead.business_id);
  if (smsEnabled === false) {
    console.log(`[sms] SMS disabled in settings — skipping lead ${lead.id}`);
    return { sent: false, reason: 'disabled' };
  }

  const toNumber = normalizePhone(lead.phone);
  if (!toNumber) {
    console.log(`[sms] Lead ${lead.id} has no valid phone — skipping SMS`);
    return { sent: false, reason: 'no_phone' };
  }

  if (!force && lead.payment_sms_sent_at) {
    console.log(`[sms] Lead ${lead.id} already received payment SMS — skipping`);
    return { sent: false, reason: 'already_sent' };
  }

  let vd = {};
  try { vd = JSON.parse(lead.vertical_data || '{}'); } catch {}

  const businessName = getDbSetting('businessName', lead.business_id) || 'our business';
  const customerName = vd.customerName
    || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')
    || null;
  const dumpsterSize = vd.dumpsterSize || null;
  const deliveryDate = lead.delivery_date
    ? new Date(lead.delivery_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : null;

  const paymentUrl = `${PAYMENT_BASE_URL}/pay/${lead.id}`;
  const greeting = customerName ? `Hi ${customerName.split(' ')[0]}!` : 'Hi there!';
  const sizeStr = dumpsterSize ? `${dumpsterSize} dumpster` : 'dumpster';
  const dateStr = deliveryDate ? ` delivery on ${deliveryDate}` : '';

  const message = `${greeting} Thanks for choosing ${businessName}. Here's your payment link for your ${sizeStr}${dateStr}: ${paymentUrl} Reply STOP to opt out.`;

  try {
    await twilioPost(accountSid, authToken, {
      From: fromNumber,
      To: toNumber,
      Body: message,
    });

    const sentAt = new Date().toISOString();
    db.prepare('UPDATE leads SET payment_sms_sent_at = ? WHERE id = ?').run(sentAt, lead.id);
    logActivity(lead.id, 'sms_sent', 'Payment link sent via SMS');
    console.log(`[sms] Payment SMS sent to ${toNumber} for lead ${lead.id}`);
    return { sent: true, sentAt, phone: toNumber, customerName };
  } catch (err) {
    console.error(`[sms] Failed to send payment SMS for lead ${lead.id}:`, err.message);
    return { sent: false, reason: 'send_error', error: err.message };
  }
}

// Text the customer a link to their invoice (review + sign). Additive sibling to
// sendPaymentSms — reuses the same Twilio Messages API path; does NOT touch the
// inbound call flow, recording, or caller ID. Respects the per-business smsEnabled
// setting. `link` is the fully-built public invoice URL built by the caller.
async function sendInvoiceSms(invoice, link) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.log('[sms] Twilio credentials not configured — skipping invoice SMS');
    return { sent: false, reason: 'no_credentials' };
  }

  const smsEnabled = getDbSetting('smsEnabled', invoice.business_id);
  if (smsEnabled === false) {
    return { sent: false, reason: 'disabled' };
  }

  const toNumber = normalizePhone(invoice.bill_to_phone);
  if (!toNumber) {
    return { sent: false, reason: 'no_phone' };
  }

  const businessName = getDbSetting('businessName', invoice.business_id) || 'our business';
  const firstName = invoice.bill_to_name ? String(invoice.bill_to_name).split(' ')[0] : null;
  const greeting = firstName ? `Hi ${firstName}!` : 'Hi there!';
  const totalStr = invoice.total != null ? ` for $${Number(invoice.total).toFixed(2)}` : '';

  const message = `${greeting} ${businessName} sent you invoice ${invoice.invoice_number}${totalStr}. Review, read the terms, and sign here: ${link} Reply STOP to opt out.`;

  try {
    await twilioPost(accountSid, authToken, { From: fromNumber, To: toNumber, Body: message });
    console.log(`[sms] Invoice SMS sent to ${toNumber} for invoice ${invoice.id}`);
    return { sent: true, phone: toNumber };
  } catch (err) {
    console.error(`[sms] Failed to send invoice SMS for invoice ${invoice.id}:`, err.message);
    return { sent: false, reason: 'send_error', error: err.message };
  }
}

module.exports = { sendPaymentSms, sendInvoiceSms };
