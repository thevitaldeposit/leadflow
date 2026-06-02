const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const https = require('https');
const db = require('../db/database');
const { extractFromTranscript } = require('../services/extractionEngine');
const { extractFromTranscriptVertical, VERTICAL_CONFIGS } = require('../services/verticalExtractionEngine');
const { transcribe } = require('../services/transcriptionService');
const { getIO } = require('../socket');
const { getAvailabilityForSize, parseRentalDays, addDaysToISO, resolveDeliveryDate, calculatePickupDate } = require('../services/inventoryService');
const { sendPaymentSms } = require('../services/smsService');

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

    const defaultVertical = process.env.LEADFLOW_DEFAULT_VERTICAL || 'auto_dealer';
    const defaultSubVertical = process.env.LEADFLOW_DEFAULT_SUB_VERTICAL || null;
    const isHomeServices = defaultVertical === 'home_services';
    const useVerticalEngine = defaultVertical !== 'auto_dealer'
      && (isHomeServices || VERTICAL_CONFIGS[defaultVertical]);

    if (useVerticalEngine) {
      console.log(`[webhook] Extracting lead from recording ${RecordingSid} via vertical engine (${defaultVertical}${defaultSubVertical ? '/' + defaultSubVertical : ''})...`);
      const { commonFields, verticalData, confidence, subVertical } = await extractFromTranscriptVertical(
        transcript,
        defaultVertical,
        defaultSubVertical
      );

      if (!commonFields.phone && From) {
        const digits = From.replace(/\D/g, '');
        if (digits.length >= 10) {
          const local = digits.slice(-10);
          commonFields.phone = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
          commonFields.phone_confidence = 0.7;
        }
      }

      // Post-extraction date resolution for home_services.
      // Node.js date math is more reliable than asking the AI to compute ISO dates.
      if (isHomeServices) {
        // Prefer rawDeliveryDate; fall back to deliveryDate if it looks like a phrase not an ISO
        const rawDateStr = verticalData.rawDeliveryDate
          || (verticalData.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(verticalData.deliveryDate)
              ? verticalData.deliveryDate : null);

        const resolvedISO = resolveDeliveryDate(rawDateStr, new Date());
        if (resolvedISO) {
          verticalData.deliveryDateISO = resolvedISO;
          verticalData.deliveryDate = resolvedISO;
          commonFields.delivery_date = resolvedISO;
          // Preserve the original phrase so the UI can show "Customer said: Monday"
          if (rawDateStr && !commonFields.raw_delivery_date) {
            commonFields.raw_delivery_date = rawDateStr;
            verticalData.rawDeliveryDate = rawDateStr;
          }
          console.log(`[webhook] Resolved delivery date "${rawDateStr}" → ${resolvedISO}`);
        } else if (rawDateStr) {
          // Ambiguous or unresolvable phrase — store what the customer said but leave
          // delivery_date null so it never shows as plain text on the detail page.
          commonFields.raw_delivery_date = rawDateStr;
          verticalData.rawDeliveryDate = rawDateStr;
          verticalData.deliveryDate = null;
          verticalData.deliveryDateISO = null;
          // Pickup date is meaningless without a confirmed delivery date.
          verticalData.pickupDate = null;
          commonFields.pickup_date = null;
          console.log(`[webhook] Ambiguous delivery date "${rawDateStr}" — stored as raw_delivery_date, delivery_date left null`);
        }

        // Auto-calculate pickup date when it's missing but delivery + duration are known
        const deliveryISO = commonFields.delivery_date || null;
        if (deliveryISO && verticalData.rentalDuration && !commonFields.pickup_date) {
          const pickupISO = calculatePickupDate(deliveryISO, verticalData.rentalDuration);
          if (pickupISO) {
            commonFields.pickup_date = pickupISO;
            verticalData.pickupDate = pickupISO;
            console.log(`[webhook] Calculated pickup date from "${verticalData.rentalDuration}" → ${pickupISO}`);
          }
        }
      }

      const leadData = {
        ...commonFields,
        extraction_type: 'phone_auto',
        audio_file_path: audioPublicPath,
        transcription_provider: provider,
        transcription_duration_seconds: transcription_seconds || null,
        auto_captured: 1,
        caller_phone_raw: From || null,
        caller_number: From || null,
        raw_transcript: transcript,
        vertical: defaultVertical,
        sub_vertical: subVertical || (isHomeServices ? 'dumpster_rental' : null),
        source: 'twilio_recording',
        vertical_data: JSON.stringify(verticalData),
        confidence: confidence || 0,
      };

      let lead = insertLead(leadData);

      // Vertical prompt sets confidence to 0 for personal/non-business calls
      if (!confidence) {
        db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
        console.log(`[webhook] Auto-discarded zero-confidence call (lead ${lead.id})`);
        return;
      }

      // Auto-booking: when the AI detected a confirmed booking, persist the
      // computed pickup date. Inventory is pool-based — no specific unit is
      // assigned; availability is computed on demand from owned quantity vs.
      // active jobs of the same size. We only check availability here for logging.
      if (verticalData.autoBooked === true && lead.delivery_date) {
        let pickupDate = lead.pickup_date;
        if (!pickupDate && verticalData.rentalDuration) {
          const days = parseRentalDays(verticalData.rentalDuration);
          if (days) pickupDate = addDaysToISO(lead.delivery_date, days);
        }
        if (pickupDate) {
          if (!lead.pickup_date) {
            db.prepare('UPDATE leads SET pickup_date = ?, updated_at = ? WHERE id = ?')
              .run(pickupDate, new Date().toISOString(), lead.id);
          }
          const avail = getAvailabilityForSize(verticalData.dumpsterSize, lead.delivery_date, pickupDate, lead.id);
          if (!avail || avail.available <= 0) {
            console.log(`[webhook] Auto-booked lead ${lead.id} — no ${verticalData.dumpsterSize || 'matching size'} available for ${lead.delivery_date}→${pickupDate}`);
          }
        }
        lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
      }

      // Send payment SMS for auto-booked home services jobs
      if (verticalData.autoBooked === true) {
        sendPaymentSms(lead).then((smsResult) => {
          if (smsResult.sent) {
            lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
          }
          const io = getIO();
          if (io) io.emit('new_lead', lead);
        }).catch((err) => {
          console.error('[webhook] SMS error:', err);
          const io = getIO();
          if (io) io.emit('new_lead', lead);
        });
      } else {
        const io = getIO();
        if (io) io.emit('new_lead', lead);
      }
      console.log(`[webhook] Lead ${lead.id} created from Twilio recording ${RecordingSid} (vertical: ${defaultVertical})`);
      return;
    }

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

// Process a voicemail recording asynchronously after responding 200 to Twilio.
// A voicemail is a single-speaker message left after an unanswered call: it is
// never auto-booked and intent is capped at Warm (enforced in the extraction
// engine via the { voicemail: true } option). The recording is named
// twilio-{SID}.mp3 like answered calls, so the 30-day auto-delete applies.
async function processVoicemail(payload) {
  const { RecordingUrl, RecordingSid, CallSid } = payload;
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
    console.log(`[webhook] Downloading voicemail ${RecordingSid} from Twilio...`);
    await downloadFile(downloadUrl, audioPath, accountSid, authToken);

    console.log(`[webhook] Transcribing voicemail ${RecordingSid}...`);
    const { transcript, provider, transcription_seconds } = await transcribe(audioPath);

    const defaultVertical = process.env.LEADFLOW_DEFAULT_VERTICAL || 'auto_dealer';
    const defaultSubVertical = process.env.LEADFLOW_DEFAULT_SUB_VERTICAL || null;
    const isHomeServices = defaultVertical === 'home_services';
    const useVerticalEngine = defaultVertical !== 'auto_dealer'
      && (isHomeServices || VERTICAL_CONFIGS[defaultVertical]);

    if (useVerticalEngine) {
      console.log(`[webhook] Extracting voicemail ${RecordingSid} via vertical engine (${defaultVertical}${defaultSubVertical ? '/' + defaultSubVertical : ''})...`);
      const { commonFields, verticalData, confidence, subVertical } = await extractFromTranscriptVertical(
        transcript,
        defaultVertical,
        defaultSubVertical,
        { voicemail: true }
      );

      if (!commonFields.phone && From) {
        const digits = From.replace(/\D/g, '');
        if (digits.length >= 10) {
          const local = digits.slice(-10);
          commonFields.phone = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
          commonFields.phone_confidence = 0.7;
        }
      }

      // Resolve any timeline the caller mentioned to an ISO date — this only
      // parses what the customer said; it never books anything.
      if (isHomeServices) {
        const rawDateStr = verticalData.rawDeliveryDate
          || (verticalData.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(verticalData.deliveryDate)
              ? verticalData.deliveryDate : null);
        const resolvedISO = resolveDeliveryDate(rawDateStr, new Date());
        if (resolvedISO) {
          verticalData.deliveryDateISO = resolvedISO;
          verticalData.deliveryDate = resolvedISO;
          commonFields.delivery_date = resolvedISO;
          if (rawDateStr && !commonFields.raw_delivery_date) {
            commonFields.raw_delivery_date = rawDateStr;
            verticalData.rawDeliveryDate = rawDateStr;
          }
        } else if (rawDateStr) {
          commonFields.raw_delivery_date = rawDateStr;
          verticalData.rawDeliveryDate = rawDateStr;
          verticalData.deliveryDate = null;
          verticalData.deliveryDateISO = null;
        }
      }

      // Recommendation always points the owner at the callback.
      const vmName = verticalData.customerName
        || [commonFields.customer_first_name, commonFields.customer_last_name].filter(Boolean).join(' ')
        || 'the caller';
      verticalData.aiRecommendation = `Call back ${vmName} — came in via voicemail`;

      // Internal note flagging the source for the dashboard's Notes section.
      const existingNote = verticalData.notes ? `${verticalData.notes} ` : '';
      verticalData.notes = `${existingNote}Lead captured from voicemail`.trim();

      const leadData = {
        ...commonFields,
        extraction_type: 'phone_auto',
        call_type: 'voicemail',
        job_status: 'inquiry',
        audio_file_path: audioPublicPath,
        transcription_provider: provider,
        transcription_duration_seconds: transcription_seconds || null,
        auto_captured: 1,
        caller_phone_raw: From || null,
        caller_number: From || null,
        raw_transcript: transcript,
        vertical: defaultVertical,
        sub_vertical: subVertical || (isHomeServices ? 'dumpster_rental' : null),
        source: 'twilio_voicemail',
        vertical_data: JSON.stringify(verticalData),
        confidence: confidence || 0,
      };

      const lead = insertLead(leadData);

      // Zero confidence = personal/non-business message — auto-discard like answered calls.
      if (!confidence) {
        db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
        console.log(`[webhook] Auto-discarded zero-confidence voicemail (lead ${lead.id})`);
        return;
      }

      const io = getIO();
      if (io) io.emit('new_lead', lead);
      console.log(`[webhook] Voicemail lead ${lead.id} created from Twilio recording ${RecordingSid} (vertical: ${defaultVertical})`);
      return;
    }

    console.log(`[webhook] Extracting voicemail ${RecordingSid}...`);
    const extracted = await extractFromTranscript(transcript);

    extracted.raw_transcript = transcript;
    extracted.extraction_type = 'phone_auto';
    extracted.call_type = 'voicemail';
    extracted.job_status = 'inquiry';
    extracted.audio_file_path = audioPublicPath;
    extracted.transcription_provider = provider;
    extracted.transcription_duration_seconds = transcription_seconds || null;
    extracted.auto_captured = 1;
    extracted.caller_phone_raw = From || null;
    extracted.source = 'twilio_voicemail';

    if (!extracted.phone && From) {
      const digits = From.replace(/\D/g, '');
      if (digits.length >= 10) {
        const local = digits.slice(-10);
        extracted.phone = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
      }
    }

    const lead = insertLead(extracted);

    const io = getIO();
    if (io) io.emit('new_lead', lead);
    console.log(`[webhook] Voicemail lead ${lead.id} created from Twilio recording ${RecordingSid}`);
  } catch (err) {
    console.error(`[webhook] Failed to process voicemail ${RecordingSid}:`, err.message);
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

// POST /api/webhook/twilio/voicemail-recording — fired when an unanswered call's
// voicemail message finishes recording.
router.post('/twilio/voicemail-recording', (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.sendStatus(200);

  const payload = req.body;
  if (!payload.RecordingUrl) {
    console.warn('[webhook] twilio/voicemail-recording: missing RecordingUrl');
    return;
  }

  processVoicemail(payload).catch(err => {
    console.error('[webhook] Unhandled error in processVoicemail:', err);
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

    // Voicemail fallback assets: the greeting is served statically from
    // server/public, and the recorded message posts to a dedicated endpoint.
    const greetingUrl = `${req.protocol}://${publicHost}/Valley_Binz_Voicemail.mp3`;
    const voicemailCallbackUrl = `${req.protocol}://${publicHost}/api/webhook/twilio/voicemail-recording`;
    console.log(`[webhook/voice]   voicemail greeting: ${greetingUrl}`);
    console.log(`[webhook/voice]   voicemail callback: ${voicemailCallbackUrl}`);

    // Omit callerId so Twilio passes the original caller's number through to
    // the forwarded leg with its original STIR/SHAKEN attestation intact.
    console.log(`[webhook/voice]   dial callerId: (passthrough — original caller ${from})`);

    // If the owner doesn't pick up within 20s, the <Dial> ends and TwiML execution
    // falls through to the voicemail greeting + recording. Answered-call recording
    // (record-from-answer-dual → /twilio/recording) is unchanged.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">This call may be recorded.</Say>
  <Dial timeout="20" record="record-from-answer-dual" recordingStatusCallback="${callbackUrl}" recordingStatusCallbackMethod="POST">
    <Number>${userPhone}</Number>
  </Dial>
  <Play>${greetingUrl}</Play>
  <Record maxLength="120" playBeep="true" recordingStatusCallback="${voicemailCallbackUrl}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>
  <Say voice="Polly.Joanna" language="en-US">Thank you. Goodbye.</Say>
  <Hangup/>
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
