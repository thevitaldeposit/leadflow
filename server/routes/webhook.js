const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const https = require('https');
const db = require('../db/database');
const { extractFromTranscript } = require('../services/extractionEngine');
const { transcribe } = require('../services/transcriptionService');
const { getIO } = require('../socket');

const RECORDINGS_DIR = path.join(__dirname, '../uploads/recordings');

// Twilio's recordingStatusCallback often omits `From`, so /twilio/voice stashes
// the caller ID in call_sessions for /twilio/recording to recover.
function rememberCaller(callSid, from) {
  if (!callSid || !from) return;
  db.prepare(
    'INSERT OR REPLACE INTO call_sessions (call_sid, from_number) VALUES (?, ?)'
  ).run(callSid, from);
}

function recallCaller(callSid) {
  if (!callSid) return null;
  const row = db.prepare('SELECT from_number FROM call_sessions WHERE call_sid = ?').get(callSid);
  if (!row) return null;
  db.prepare('DELETE FROM call_sessions WHERE call_sid = ?').run(callSid);
  return row.from_number || null;
}

setInterval(() => {
  db.prepare("DELETE FROM call_sessions WHERE created_at < datetime('now', '-1 hour')").run();
}, 15 * 60 * 1000).unref();

function insertLead(data) {
  const fields = Object.keys(data);
  const placeholders = fields.map(() => '?').join(', ');
  const values = fields.map(f => data[f]);
  const stmt = db.prepare(
    `INSERT INTO leads (${fields.join(', ')}) VALUES (${placeholders})`
  );
  const result = stmt.run(...values);
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(result.lastInsertRowid));
}

function downloadFile(url, destPath, accountSid, authToken) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { Authorization: `Basic ${auth}` },
    };

    const file = fs.createWriteStream(destPath);
    https.get(options, (response) => {
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function isPersonalCall(lead) {
  if (lead.customer_intent !== 'other') return false;
  try {
    const notes = JSON.parse(lead.additional_notes || '[]');
    return Array.isArray(notes) && notes[0] === 'PERSONAL_CALL';
  } catch {
    return false;
  }
}

// Process recording asynchronously after responding 200 to Twilio
async function processRecording(payload) {
  const { RecordingUrl, RecordingSid, CallSid, CallDuration } = payload;
  const From = payload.From || recallCaller(CallSid);

  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }

  const filename = `twilio-${RecordingSid || Date.now()}.mp3`;
  const audioPath = path.join(RECORDINGS_DIR, filename);
  const audioPublicPath = `/uploads/recordings/${filename}`;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  try {
    const downloadUrl = RecordingUrl.endsWith('.mp3') ? RecordingUrl : `${RecordingUrl}.mp3`;
    console.log(`[webhook] Downloading recording ${RecordingSid} from Twilio...`);
    await downloadFile(downloadUrl, audioPath, accountSid, authToken);

    console.log(`[webhook] Transcribing recording ${RecordingSid}...`);
    const { transcript, provider, transcription_seconds } = await transcribe(audioPath);

    console.log(`[webhook] Extracting lead from recording ${RecordingSid}...`);
    const extracted = await extractFromTranscript(transcript);

    extracted.raw_transcript = transcript;
    extracted.extraction_type = 'phone_auto';
    extracted.audio_file_path = audioPublicPath;
    extracted.transcription_provider = provider;
    extracted.transcription_duration_seconds = transcription_seconds || null;
    extracted.auto_captured = 1;
    extracted.caller_phone_raw = From || null;

    // Pre-populate phone if not extracted and caller ID is available
    if (!extracted.phone && From) {
      const digits = From.replace(/\D/g, '');
      if (digits.length >= 10) {
        const local = digits.slice(-10);
        extracted.phone = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
      }
    }

    const lead = insertLead(extracted);

    // Auto-discard personal calls captured by webhook
    if (isPersonalCall(lead)) {
      db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
      console.log(`[webhook] Auto-discarded personal call (lead ${lead.id})`);
      return;
    }

    const io = getIO();
    if (io) io.emit('new_lead', lead);
    console.log(`[webhook] Lead ${lead.id} created from Twilio recording ${RecordingSid}`);
  } catch (err) {
    console.error(`[webhook] Failed to process recording ${RecordingSid}:`, err.message);
  }
}

// POST /api/webhook/twilio/recording
router.post('/twilio/recording', (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.sendStatus(200);

  const payload = req.body;
  if (!payload.RecordingUrl) {
    console.warn('[webhook] twilio/recording: missing RecordingUrl');
    return;
  }

  processRecording(payload).catch(err => {
    console.error('[webhook] Unhandled error in processRecording:', err);
  });
});

// POST /api/webhook/twilio/voice — TwiML response to forward and record calls
router.post('/twilio/voice', (req, res) => {
  try {
    const userPhone = (process.env.USER_PHONE_NUMBER || '').trim();
    const from = req.body.From || 'unknown';
    const to = (req.body.To || '').trim();
    const callSid = req.body.CallSid || 'unknown';

    rememberCaller(req.body.CallSid, req.body.From);

    console.log('[webhook/voice] ── inbound call ──────────────────────────');
    console.log(`[webhook/voice]   CallSid:   ${callSid}`);
    console.log(`[webhook/voice]   From:      ${from}`);
    console.log(`[webhook/voice]   To:        ${to || 'MISSING'}`);
    console.log(`[webhook/voice]   ForwardTo: ${userPhone || 'MISSING'}`);

    if (!userPhone) {
      console.error('[webhook/voice]   ✗ USER_PHONE_NUMBER not set — playing config message');
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">We're sorry, this number is not configured to receive calls at this time.</Say>
  <Hangup/>
</Response>`);
      return;
    }

    if (!/^\+\d{10,15}$/.test(userPhone)) {
      console.error(`[webhook/voice]   ✗ USER_PHONE_NUMBER "${userPhone}" is not E.164 (expected +<countrycode><number>) — Twilio will reject the Dial`);
    }

    // Behind a Cloudflare/ngrok tunnel the Host header is the local origin
    // (localhost:3001); the public hostname arrives in X-Forwarded-Host.
    // Twilio must reach the recording callback, so prefer the forwarded host.
    const publicHost = req.get('x-forwarded-host') || req.get('host');
    const callbackUrl = `${req.protocol}://${publicHost}/api/webhook/twilio/recording`;
    console.log(`[webhook/voice]   recording callback: ${callbackUrl}`);

    // Set callerId to an owned Twilio number on the forwarded leg. The dialed
    // number (To) is the Twilio number on a real inbound call; fall back to
    // TWILIO_PHONE_NUMBER. Without a valid owned caller ID some forwards fail
    // with Twilio error 13214.
    const envTwilio = (process.env.TWILIO_PHONE_NUMBER || '').trim();
    const callerId = /^\+\d{10,15}$/.test(to) ? to : (/^\+\d{10,15}$/.test(envTwilio) ? envTwilio : '');
    const callerIdAttr = callerId ? ` callerId="${callerId}"` : '';
    console.log(`[webhook/voice]   dial callerId: ${callerId || '(passthrough — original caller)'}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">This call may be recorded for quality assurance purposes.</Say>
  <Dial${callerIdAttr} record="record-from-answer-dual" recordingStatusCallback="${callbackUrl}" recordingStatusCallbackMethod="POST">
    <Number>${userPhone}</Number>
  </Dial>
</Response>`;

    console.log(`[webhook/voice]   ✓ returning TwiML — dialing ${userPhone}`);
    res.type('text/xml').send(twiml);
  } catch (err) {
    // Never return HTTP 500 to Twilio: that triggers "an application error has
    // occurred" and the call is dropped instantly. Always answer with TwiML.
    console.error('[webhook/voice]   ✗ handler error:', err);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">We're sorry, an error occurred connecting your call.</Say>
  <Hangup/>
</Response>`);
  }
});

module.exports = router;
