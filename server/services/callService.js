const https = require('https');
const { URLSearchParams } = require('url');

// Outbound click-to-call ("call me first, then connect the customer").
//
// Twilio calls Austin's cell (USER_PHONE_NUMBER) first. When he answers, the
// inline TwiML plays a short whisper and then <Dial>s the lead, presenting the
// Valley Binz Twilio number (TWILIO_PHONE_NUMBER) as the caller ID the customer
// sees. This is entirely separate from inbound call routing / caller-ID
// passthrough handled in routes/webhook.js — do not conflate the two.

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (String(phone).trim().startsWith('+')) return String(phone).trim();
  return null;
}

function escapeXml(str) {
  return String(str || '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

function twilioCallPost(accountSid, authToken, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Calls.json`,
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

// Initiates the click-to-call. Returns { success, callSid?, reason?, error?, customerPhone? }.
async function initiateClickToCall(lead, customerName) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const callerId = process.env.TWILIO_PHONE_NUMBER;
  const userNumber = normalizePhone(process.env.USER_PHONE_NUMBER);

  if (!accountSid || !authToken || !callerId) {
    return { success: false, reason: 'no_credentials' };
  }
  if (!userNumber) {
    return { success: false, reason: 'no_user_number' };
  }

  const customerPhone = normalizePhone(lead.phone);
  if (!customerPhone) {
    return { success: false, reason: 'no_phone' };
  }

  const whisper = customerName
    ? `Connecting you to ${customerName}`
    : 'Connecting you to the customer';

  // Inline TwiML executes when Austin answers: whisper first, then dial the
  // customer with the Twilio number as the presented caller ID.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Response>`
    + `<Say voice="alice">${escapeXml(whisper)}</Say>`
    + `<Dial callerId="${escapeXml(callerId)}">${escapeXml(customerPhone)}</Dial>`
    + `</Response>`;

  try {
    const result = await twilioCallPost(accountSid, authToken, {
      To: userNumber,
      From: callerId,
      Twiml: twiml,
    });
    console.log(`[call] Click-to-call started for lead ${lead.id} → ${customerPhone} (sid ${result.sid})`);
    return { success: true, callSid: result.sid, customerPhone };
  } catch (err) {
    console.error(`[call] Click-to-call failed for lead ${lead.id}:`, err.message);
    return { success: false, reason: 'call_error', error: err.message };
  }
}

module.exports = { initiateClickToCall };
