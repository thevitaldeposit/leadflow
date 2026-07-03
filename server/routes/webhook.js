const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const https = require('https');
const db = require('../db/database');
const { extractFromTranscript } = require('../services/extractionEngine');
const { extractFromTranscriptVertical, VERTICAL_CONFIGS } = require('../services/verticalExtractionEngine');
const { transcribe } = require('../services/transcriptionService');
const { emitToBusiness } = require('../socket');
const { resolveDeliveryDate, parseRentalDays, addDaysToISO, resolvePickupPhrase, enforceAutoBookAvailability } = require('../services/inventoryService');
const { sendPaymentSms } = require('../services/smsService');
const { sendPaymentLinkEmail } = require('../services/emailService');
const { logActivity, formatDuration } = require('../services/activityLog');
const { getTimezone } = require('../services/settingsService');
const { getBusinessIdByTwilioNumber, getDefaultBusinessId } = require('../services/businesses');

const { RECORDINGS_DIR } = require('../config/paths');

// Ring timeouts (seconds) for the inbound <Dial>. The owner-cell value is the
// original eSIM behavior, unchanged; the app-client value is a touch longer to
// absorb VoIP push wake + CallKit presentation before the caller is sent to
// voicemail.
const OWNER_DIAL_TIMEOUT = 20;
const CLIENT_DIAL_TIMEOUT = 25;

// Twilio's recordingStatusCallback often omits `From` (and the called number),
// so /twilio/voice stashes both the caller ID and the resolved business_id in
// call_sessions for the recording/voicemail callbacks to recover.
function rememberCaller(callSid, from, businessId) {
  if (!callSid) return;
  db.prepare(
    'INSERT OR REPLACE INTO call_sessions (call_sid, from_number, business_id) VALUES (?, ?, ?)'
  ).run(callSid, from || null, businessId || null);
}

// Recover { from, businessId } stashed at /twilio/voice time, then clear the row.
function recallSession(callSid) {
  if (!callSid) return { from: null, businessId: null };
  const row = db.prepare('SELECT from_number, business_id FROM call_sessions WHERE call_sid = ?').get(callSid);
  if (!row) return { from: null, businessId: null };
  db.prepare('DELETE FROM call_sessions WHERE call_sid = ?').run(callSid);
  return { from: row.from_number || null, businessId: row.business_id || null };
}

// Non-destructive variant of recallSession: read the stashed caller/business
// WITHOUT deleting the row. The dial-status callback fires mid-call (when the
// forwarded leg ends) and must leave the session intact for the later
// recording/voicemail callback that consumes it via recallSession.
function peekSession(callSid) {
  if (!callSid) return { from: null, businessId: null };
  const row = db.prepare('SELECT from_number, business_id FROM call_sessions WHERE call_sid = ?').get(callSid);
  if (!row) return { from: null, businessId: null };
  return { from: row.from_number || null, businessId: row.business_id || null };
}

// Resolve the Twilio Voice client identity to ring for this business's iOS app,
// or null when the business has no usable app-client registration (→ forward to
// the owner's cell instead, the original behavior). A device row qualifies only
// when it carries BOTH a voice identity AND a VoIP push token — i.e. a device
// that actually completed incoming-call registration — and was refreshed
// recently: the iOS app re-syncs this row on every launch/foreground, so a
// long-stale row means an abandoned/uninstalled app and we prefer the eSIM.
// (Today every device for a business registers under the same `business_<id>`
// identity, so dialing this one identity rings all of them.) Scoped to the
// business. ANY failure returns null so a DB hiccup or malformed row can never
// black-hole an inbound call — it simply falls back to the USER_PHONE_NUMBER dial.
function getActiveAppClientIdentity(businessId) {
  try {
    if (!businessId) return null;
    const staleDays = Math.max(1, Number(process.env.LEADFLOW_VOICE_CLIENT_STALE_DAYS) || 30);
    const row = db.prepare(`
      SELECT voice_identity FROM devices
      WHERE business_id = ?
        AND voice_identity IS NOT NULL AND TRIM(voice_identity) != ''
        AND voip_token IS NOT NULL AND TRIM(voip_token) != ''
        AND updated_at >= datetime('now', ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(businessId, `-${staleDays} days`);
    const identity = row && row.voice_identity ? row.voice_identity.trim() : null;
    // Identities are sanitized to [A-Za-z0-9_.-] at registration (voiceIdentityFor);
    // reject anything else rather than emit malformed/injectable TwiML.
    return identity && /^[A-Za-z0-9_.-]+$/.test(identity) ? identity : null;
  } catch (err) {
    console.error('[webhook/voice] getActiveAppClientIdentity error:', err.message);
    return null;
  }
}

// Format a raw caller ID ("+15551234567") to the dashboard's "555-123-4567".
// Returns null when there aren't enough digits to be a real number.
function formatCallerPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 10) return null;
  const local = digits.slice(-10);
  return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
}

// When a real lead (an answered conversation or a voicemail) arrives from a
// number that recently produced a missed-call placeholder, fold the placeholder
// into the new lead rather than leaving a duplicate in the Action Queue. Covers
// both the same call (no-answer → caller then leaves a voicemail) and a separate
// callback within 30 minutes. caller_number / caller_phone_raw store the raw
// E.164 caller ID, so a last-10-digits LIKE match is reliable.
function mergeRecentMissedCall(businessId, fromNumber, supersedingLead) {
  try {
    if (!fromNumber || !supersedingLead) return;
    const digits = String(fromNumber).replace(/\D/g, '');
    if (digits.length < 10) return;
    const local = digits.slice(-10);
    const missed = db.prepare(`
      SELECT * FROM leads
      WHERE call_type = 'missed_call'
        AND (discarded = 0 OR discarded IS NULL)
        AND business_id IS ?
        AND id != ?
        AND created_at >= datetime('now', '-30 minutes')
        AND (caller_number LIKE ? OR caller_phone_raw LIKE ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(businessId, supersedingLead.id, `%${local}%`, `%${local}%`);
    if (!missed) return;
    db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(missed.id);
    logActivity(supersedingLead.id, 'note', 'Merged an earlier missed call from this number into this lead');
    emitToBusiness(businessId, 'lead_removed', { id: missed.id, business_id: businessId });
    console.log(`[webhook] Merged missed-call lead ${missed.id} into lead ${supersedingLead.id}`);
  } catch (err) {
    console.error('[webhook] mergeRecentMissedCall error:', err.message);
  }
}

// Detect and record a missed call from the dialed-leg status callback. Twilio
// posts here when the dialed leg (owner cell or app client) ends; if it was
// never answered (no-answer / busy / failed / canceled, including an app
// decline) the inbound caller reached no one, so we create a missed-call lead.
// Answered legs are ignored — /twilio/recording handles those. If the caller
// goes on to leave a voicemail, processVoicemail merges this placeholder away
// via mergeRecentMissedCall.
async function handleDialStatus(payload) {
  const parentSid = payload.ParentCallSid || payload.CallSid;
  const session = peekSession(parentSid);
  const from = session.from || payload.From || null;
  const businessId = session.businessId || getDefaultBusinessId();

  // Only the dialed (owner) leg matters here. A 'completed'/'answered' status
  // means the owner picked up — the call was handled live, not missed.
  const status = String(payload.DialCallStatus || payload.CallStatus || '').toLowerCase();
  if (status === 'completed' || status === 'answered' || status === 'in-progress') {
    console.log(`[webhook/dial-status] owner answered (${status}) for ${parentSid} — not a missed call`);
    return;
  }

  // Guard against duplicates from Twilio retries or rapid repeat calls: if a
  // missed-call placeholder for this number already exists in the last few
  // minutes, keep that one instead of stacking another.
  if (from) {
    const digits = from.replace(/\D/g, '');
    if (digits.length >= 10) {
      const local = digits.slice(-10);
      const recent = db.prepare(`
        SELECT id FROM leads
        WHERE call_type = 'missed_call'
          AND (discarded = 0 OR discarded IS NULL)
          AND created_at >= datetime('now', '-5 minutes')
          AND (caller_number LIKE ? OR caller_phone_raw LIKE ?)
        LIMIT 1
      `).get(`%${local}%`, `%${local}%`);
      if (recent) {
        console.log(`[webhook/dial-status] missed-call placeholder already exists for ${from} — skipping`);
        return;
      }
    }
  }

  const defaultVertical = process.env.LEADFLOW_DEFAULT_VERTICAL || 'auto_dealer';
  const isHomeServices = defaultVertical === 'home_services';
  const phone = formatCallerPhone(from);
  const displayName = phone || 'the caller';

  const verticalData = {
    notes: 'Missed call — no voicemail left',
    aiRecommendation: `Call back ${displayName} — missed call, no voicemail`,
    missedCall: true,
  };

  const leadData = {
    extraction_type: 'phone_auto',
    call_type: 'missed_call',
    job_status: 'inquiry',
    status: 'new',
    auto_captured: 1,
    caller_phone_raw: from || null,
    caller_number: from || null,
    phone: phone || null,
    phone_confidence: phone ? 0.7 : 0,
    follow_up_date: new Date().toISOString(),
    source: 'twilio_missed_call',
    vertical: defaultVertical,
    sub_vertical: isHomeServices ? 'dumpster_rental' : null,
    vertical_data: JSON.stringify(verticalData),
    business_id: businessId,
  };

  const lead = insertLead(leadData);
  logActivity(lead.id, 'missed_call', 'Missed call received — no voicemail');
  emitToBusiness(lead.business_id, 'new_lead', lead);
  console.log(`[webhook/dial-status] Missed-call lead ${lead.id} created for ${from || 'unknown'} (status: ${status || 'none'})`);
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
  const session = recallSession(CallSid);
  const From = payload.From || session.from;
  const businessId = session.businessId || getBusinessIdByTwilioNumber(payload.To) || getDefaultBusinessId();

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
      const { commonFields, verticalData, confidence, subVertical, businessRelevant } = await extractFromTranscriptVertical(
        transcript,
        defaultVertical,
        defaultSubVertical,
        { businessId }
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

        const resolvedISO = resolveDeliveryDate(rawDateStr, new Date(), getTimezone(businessId));
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

        // Resolve the pickup date and normalize rental duration to a day count.
        // Node date math is authoritative here: the AI routinely miscalculates
        // the ISO date for a named weekday (e.g. resolving "Friday" to the
        // following Saturday), so we recompute the rental end from the
        // customer's own phrasing rather than trusting the AI's pickupDate.
        const deliveryISO = commonFields.delivery_date || null;
        if (deliveryISO) {
          const durationDays = parseRentalDays(verticalData.rentalDuration);
          let pickupISO = null;

          if (durationDays) {
            // Numeric duration ("7 days", "1 week") → derive pickup from it.
            pickupISO = addDaysToISO(deliveryISO, durationDays);
          } else if (verticalData.rentalDuration) {
            // Prose like "tomorrow until friday" → resolve the end weekday/date
            // with the (correct) Node weekday logic instead of the AI's value.
            pickupISO = resolvePickupPhrase(verticalData.rentalDuration, new Date(), getTimezone(businessId));
          }

          if (pickupISO && pickupISO > deliveryISO) {
            commonFields.pickup_date = pickupISO;
            verticalData.pickupDate = pickupISO;
            // Replace vague prose with a concrete day count so the UI and
            // availability math have a real number to work with.
            const spanDays = Math.round(
              (Date.parse(`${pickupISO}T00:00:00Z`) - Date.parse(`${deliveryISO}T00:00:00Z`)) / 86400000
            );
            if (spanDays > 0) verticalData.rentalDuration = `${spanDays} days`;
            console.log(`[webhook] Resolved pickup date → ${pickupISO} (rental ${verticalData.rentalDuration})`);
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
        business_id: businessId,
      };

      let lead = insertLead(leadData);

      // Business-relevance gate: the AI flags calls with zero business connection
      // (wrong number, "call you back", purely personal) — auto-discard so they
      // never become a lead. Only an explicit false discards; undefined is kept.
      if (businessRelevant === false) {
        db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
        logActivity(lead.id, 'note', 'Auto-discarded — call had no business relevance');
        console.log(`[webhook] Auto-discarded non-business call (lead ${lead.id})`);
        return;
      }

      // Vertical prompt sets confidence to 0 for personal/non-business calls
      if (!confidence) {
        db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
        console.log(`[webhook] Auto-discarded zero-confidence call (lead ${lead.id})`);
        return;
      }

      const inboundDur = formatDuration(CallDuration || transcription_seconds);
      logActivity(lead.id, 'inbound_call', `Inbound call received${inboundDur ? ` (${inboundDur})` : ''}`);

      // A real conversation supersedes any missed-call placeholder from this
      // number in the last 30 minutes (e.g. caller back after a missed call).
      mergeRecentMissedCall(lead.business_id, From, lead);

      // Auto-booking: when the AI detected a confirmed booking, verify pool
      // inventory is actually available for the requested size over the rental
      // window BEFORE confirming and sending a payment link. Inventory is
      // pool-based — no specific unit is assigned; availability is computed on
      // demand from owned quantity vs. overlapping active jobs of the same size,
      // using the same logic as the booking modal and schedule page.
      //
      // If a unit is free, the booking proceeds (payment link below). If none is
      // available, enforceAutoBookAvailability blocks it: the lead is downgraded
      // to a flagged high-intent opportunity, clears verticalData.autoBooked, and
      // the payment link is suppressed.
      const { blocked: bookingBlocked } = enforceAutoBookAvailability(lead, verticalData);
      if (verticalData.autoBooked === true || bookingBlocked) {
        lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
      }
      if (bookingBlocked) {
        logActivity(
          lead.id,
          'note',
          `AUTO-BOOK BLOCKED — no ${verticalData.dumpsterSize || 'matching'} dumpster available for ${lead.delivery_date}→${lead.pickup_date}. Customer must be contacted to reschedule.`
        );
        console.warn(`[webhook] Auto-book BLOCKED for lead ${lead.id} — no ${verticalData.dumpsterSize || 'matching size'} available for ${lead.delivery_date}→${lead.pickup_date}; flagged as inventory conflict, no payment link sent`);
      }

      // Auto-book now INITIATES booking (→ pending_payment) and EMAILS the payment
      // link — payment is what reserves the dumpster. Nothing is reserved or put on
      // the schedule until the customer pays (pending_payment is not an occupying
      // status). SMS is retired for this while A2P approval is pending — sendPaymentSms
      // stays defined but unused here. Auto-book's TRIGGER threshold is unchanged;
      // only the resulting status and the notify channel (SMS → email) change. A
      // blocked booking has had verticalData.autoBooked cleared above.
      if (verticalData.autoBooked === true && !bookingBlocked) {
        db.prepare("UPDATE leads SET job_status = 'pending_payment', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), lead.id);
        lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
        // Suggested booking amount now comes from the configured pricing model
        // (size + duration + any delivery fee), not the model's estimate. Prefill it
        // (owner-overridable afterward) so the payment link + /pay page show the
        // computed price. Additive + best-effort: leaves the existing estimate when the
        // size isn't priceable. Does NOT change auto-book's trigger threshold or routing.
        try {
          const suggested = require('../services/pricingService').suggestedBookingRevenue(lead.business_id, lead);
          if (suggested != null) {
            let avd = {};
            try { avd = lead.vertical_data ? JSON.parse(lead.vertical_data) : {}; } catch { avd = {}; }
            avd.quotedPrice = `$${suggested}`;
            db.prepare('UPDATE leads SET estimated_revenue = ?, vertical_data = ?, updated_at = ? WHERE id = ?')
              .run(suggested, JSON.stringify(avd), new Date().toISOString(), lead.id);
            lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
          }
        } catch (e) { console.error('[webhook] auto-book price prefill error:', e.message); }
        logActivity(lead.id, 'status_change', 'Auto-booked — payment link emailed (payment reserves the dumpster)');
        sendPaymentLinkEmail(lead).then((result) => {
          if (result.sent) {
            lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
          }
          emitToBusiness(lead.business_id, 'new_lead', lead);
        }).catch((err) => {
          console.error('[webhook] payment email error:', err);
          emitToBusiness(lead.business_id, 'new_lead', lead);
        });
      } else {
        emitToBusiness(lead.business_id, 'new_lead', lead);
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
    extracted.business_id = businessId;

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

    const legacyInboundDur = formatDuration(CallDuration || transcription_seconds);
    logActivity(lead.id, 'inbound_call', `Inbound call received${legacyInboundDur ? ` (${legacyInboundDur})` : ''}`);

    mergeRecentMissedCall(lead.business_id, From, lead);

    emitToBusiness(lead.business_id, 'new_lead', lead);
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
  const session = recallSession(CallSid);
  const From = payload.From || session.from;
  const businessId = session.businessId || getBusinessIdByTwilioNumber(payload.To) || getDefaultBusinessId();

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
      const { commonFields, verticalData, confidence, subVertical, businessRelevant } = await extractFromTranscriptVertical(
        transcript,
        defaultVertical,
        defaultSubVertical,
        { voicemail: true, businessId }
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
        const resolvedISO = resolveDeliveryDate(rawDateStr, new Date(), getTimezone(businessId));
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

        // Resolve the pickup date and normalize rental duration to a day count,
        // matching the recording path. Node date math is authoritative: the AI
        // routinely lands a named weekday one day late, so we recompute the
        // rental end from the customer's own phrasing.
        const deliveryISO = commonFields.delivery_date || null;
        if (deliveryISO) {
          const durationDays = parseRentalDays(verticalData.rentalDuration);
          let pickupISO = null;

          if (durationDays) {
            pickupISO = addDaysToISO(deliveryISO, durationDays);
          } else if (verticalData.rentalDuration) {
            pickupISO = resolvePickupPhrase(verticalData.rentalDuration, new Date(), getTimezone(businessId));
          }

          if (pickupISO && pickupISO > deliveryISO) {
            commonFields.pickup_date = pickupISO;
            verticalData.pickupDate = pickupISO;
            const spanDays = Math.round(
              (Date.parse(`${pickupISO}T00:00:00Z`) - Date.parse(`${deliveryISO}T00:00:00Z`)) / 86400000
            );
            if (spanDays > 0) verticalData.rentalDuration = `${spanDays} days`;
          }
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
        business_id: businessId,
      };

      const lead = insertLead(leadData);

      // Business-relevance gate — same as answered calls. A voicemail with zero
      // business connection is auto-discarded so it never becomes a lead.
      if (businessRelevant === false) {
        db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
        logActivity(lead.id, 'note', 'Auto-discarded — voicemail had no business relevance');
        console.log(`[webhook] Auto-discarded non-business voicemail (lead ${lead.id})`);
        return;
      }

      // Zero confidence = personal/non-business message — auto-discard like answered calls.
      if (!confidence) {
        db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
        console.log(`[webhook] Auto-discarded zero-confidence voicemail (lead ${lead.id})`);
        return;
      }

      const vmDur = formatDuration(transcription_seconds);
      logActivity(lead.id, 'voicemail', `Voicemail received${vmDur ? ` (${vmDur})` : ''}`);

      // A left voicemail supersedes the missed-call placeholder for this call
      // (or an earlier missed call from the same number) — remove the duplicate.
      mergeRecentMissedCall(lead.business_id, From, lead);

      emitToBusiness(lead.business_id, 'new_lead', lead);
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
    extracted.business_id = businessId;

    if (!extracted.phone && From) {
      const digits = From.replace(/\D/g, '');
      if (digits.length >= 10) {
        const local = digits.slice(-10);
        extracted.phone = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
      }
    }

    const lead = insertLead(extracted);

    const legacyVmDur = formatDuration(transcription_seconds);
    logActivity(lead.id, 'voicemail', `Voicemail received${legacyVmDur ? ` (${legacyVmDur})` : ''}`);

    mergeRecentMissedCall(lead.business_id, From, lead);

    emitToBusiness(lead.business_id, 'new_lead', lead);
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

// POST /api/webhook/twilio/dial-status — status callback for the dialed leg
// (attached to the <Number> or <Client> in /twilio/voice). Fires when that leg
// ends; an unanswered leg means the inbound caller reached no one (cell missed,
// or the app declined / didn't pick up), so we record a missed call. Purely
// additive — it does not affect routing, recording, caller ID passthrough, or
// the voicemail fall-through.
router.post('/twilio/dial-status', (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.sendStatus(200);

  handleDialStatus(req.body).catch(err => {
    console.error('[webhook] Unhandled error in handleDialStatus:', err);
  });
});

// Build the voicemail fallback TwiML (greeting + record). Shared by the <Dial>
// action handler so a genuinely unanswered call still reaches voicemail. The
// callback URLs are recomputed from the request so they resolve to the public
// tunnel host (see the host note in /twilio/voice).
function buildVoicemailTwiml(req) {
  const publicHost = req.get('x-forwarded-host') || req.get('host');
  const greetingUrl = `${req.protocol}://${publicHost}/Valley_Binz_Voicemail.mp3`;
  const voicemailCallbackUrl = `${req.protocol}://${publicHost}/api/webhook/twilio/voicemail-recording`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${greetingUrl}</Play>
  <Record maxLength="120" playBeep="true" recordingStatusCallback="${voicemailCallbackUrl}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>
  <Say voice="Polly.Joanna" language="en-US">Thank you. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

// POST /api/webhook/twilio/dial-action — the <Dial> action callback. Twilio
// posts here when the dialed leg (owner cell or app client) ends, with a
// DialCallStatus telling us why. If it was ANSWERED and the call then ended
// ('completed'/'answered'), hang up immediately so the caller is NOT dumped into
// voicemail. Only fall through to the voicemail greeting when it was never
// picked up ('no-answer' / 'busy' / 'failed' / 'canceled' — e.g. an app decline).
// Recording + transcription run independently off the <Dial>
// recordingStatusCallback and are unaffected.
router.post('/twilio/dial-action', (req, res) => {
  const status = String(req.body.DialCallStatus || '').toLowerCase();
  console.log(`[webhook/dial-action] DialCallStatus=${status || 'none'} for ${req.body.CallSid || 'unknown'}`);

  if (status === 'completed' || status === 'answered') {
    console.log('[webhook/dial-action]   owner answered then hung up — ending call (no voicemail)');
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
    return;
  }

  console.log(`[webhook/dial-action]   owner did not answer (${status || 'none'}) — playing voicemail greeting`);
  res.type('text/xml').send(buildVoicemailTwiml(req));
});

// POST /api/webhook/twilio/voice — TwiML response to forward and record calls
router.post('/twilio/voice', (req, res) => {
  try {
    const userPhone = (process.env.USER_PHONE_NUMBER || '').trim();
    const from = req.body.From || 'unknown';
    const to = (req.body.To || '').trim();
    const callSid = req.body.CallSid || 'unknown';

    // Resolve which business owns the dialed Twilio number so the eventual
    // recording/voicemail lead is attributed to the right tenant. Falls back to
    // the default business when the number isn't registered yet.
    const businessId = getBusinessIdByTwilioNumber(to) || getDefaultBusinessId();
    rememberCaller(req.body.CallSid, req.body.From, businessId);

    // Prefer ringing the business's iOS app natively (Twilio Voice <Client>) when
    // it has a live VoIP registration; otherwise forward to the owner's cell
    // exactly as before. Best-effort and business-scoped — any failure returns
    // null and the eSIM path runs, so a broken/stale registration can never drop
    // an inbound call.
    const appClientIdentity = getActiveAppClientIdentity(businessId);

    console.log('[webhook/voice] ── inbound call ──────────────────────────');
    console.log(`[webhook/voice]   CallSid:   ${callSid}`);
    console.log(`[webhook/voice]   From:      ${from}`);
    console.log(`[webhook/voice]   To:        ${to || 'MISSING'}`);
    console.log(`[webhook/voice]   Business:  ${businessId}`);
    console.log(`[webhook/voice]   Target:    ${appClientIdentity ? `app client <${appClientIdentity}>` : (userPhone || 'MISSING')}`);

    // Need at least one destination: a registered app client OR the owner's cell.
    // A registered client lets calls ring even when USER_PHONE_NUMBER is unset.
    if (!appClientIdentity && !userPhone) {
      console.error('[webhook/voice]   ✗ No app client registered and USER_PHONE_NUMBER not set — playing config message');
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">We're sorry, this number is not configured to receive calls at this time.</Say>
  <Hangup/>
</Response>`);
      return;
    }

    if (!appClientIdentity && !/^\+\d{10,15}$/.test(userPhone)) {
      console.error(`[webhook/voice]   ✗ USER_PHONE_NUMBER "${userPhone}" is not E.164 (expected +<countrycode><number>) — Twilio will reject the Dial`);
    }

    // Behind a Cloudflare/ngrok tunnel the Host header is the local origin
    // (localhost:3001); the public hostname arrives in X-Forwarded-Host.
    // Twilio must reach the recording callback, so prefer the forwarded host.
    const publicHost = req.get('x-forwarded-host') || req.get('host');
    const callbackUrl = `${req.protocol}://${publicHost}/api/webhook/twilio/recording`;
    console.log(`[webhook/voice]   recording callback: ${callbackUrl}`);

    // Voicemail fallback assets: the recording notice plays before dialing; the
    // greeting + voicemail recording live in the <Dial> action handler
    // (/twilio/dial-action), which decides whether voicemail should play at all.
    const recordingNoticeUrl = `${req.protocol}://${publicHost}/call_recording_notice_bella.mp3`;

    // The <Dial> action callback. Twilio posts the DialCallStatus here when the
    // dialed leg (owner cell or app client) ends; the handler hangs up on an
    // answered call and only plays voicemail when it was never answered.
    const dialActionUrl = `${req.protocol}://${publicHost}/api/webhook/twilio/dial-action`;
    console.log(`[webhook/voice]   dial action callback: ${dialActionUrl}`);

    // Status callback for the dialed leg. Fires when that leg ends so an
    // unanswered call (no-answer/busy/canceled, including an app decline) can be
    // logged as a missed call. Attached to the dialed noun, so it does not alter
    // the dial or the voicemail fall-through.
    const dialStatusUrl = `${req.protocol}://${publicHost}/api/webhook/twilio/dial-status`;
    console.log(`[webhook/voice]   dial status callback: ${dialStatusUrl}`);

    // Omit callerId so Twilio passes the original caller's number through to the
    // dialed leg with its original STIR/SHAKEN attestation intact. Identical for
    // <Number> (the cell) and <Client> (the iOS app reads it as callInvite.from) —
    // the app relies on this same passthrough to display the real caller.
    console.log(`[webhook/voice]   dial callerId: (passthrough — original caller ${from})`);

    // The dialed noun: ring the iOS app <Client> when registered, else the
    // owner's <Number>. BOTH carry the same dial-status callback (missed-call
    // detection) and sit under the SAME <Dial> (record-from-answer-dual +
    // dial-action voicemail fall-through), so recording, transcription, AI
    // extraction, the voicemail greeting, and the missed-call/Action-Queue path
    // are identical regardless of which leg is dialed — only the destination and
    // ring timeout change.
    const dialNoun = appClientIdentity
      ? `<Client statusCallback="${dialStatusUrl}" statusCallbackEvent="completed" statusCallbackMethod="POST">${appClientIdentity}</Client>`
      : `<Number statusCallback="${dialStatusUrl}" statusCallbackEvent="completed" statusCallbackMethod="POST">${userPhone}</Number>`;
    const dialTimeout = appClientIdentity ? CLIENT_DIAL_TIMEOUT : OWNER_DIAL_TIMEOUT;

    // When the <Dial> ends, Twilio posts the DialCallStatus to the action URL and
    // continues with whatever TwiML it returns (verbs after </Dial> are never
    // reached). /twilio/dial-action hangs up on an answered call and only plays
    // the voicemail greeting + recording when the leg was never answered.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${recordingNoticeUrl}</Play>
  <Pause length="2"/>
  <Dial timeout="${dialTimeout}" action="${dialActionUrl}" method="POST" record="record-from-answer-dual" recordingStatusCallback="${callbackUrl}" recordingStatusCallbackMethod="POST">
    ${dialNoun}
  </Dial>
</Response>`;

    console.log(`[webhook/voice]   ✓ returning TwiML — ${appClientIdentity ? `ringing app client <${appClientIdentity}>` : `dialing ${userPhone}`}`);
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
