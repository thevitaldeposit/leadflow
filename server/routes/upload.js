const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { transcribe } = require('../services/transcriptionService');
const { extractFromTranscriptVertical } = require('../services/verticalExtractionEngine');
const { sendToAll } = require('../services/apns');
const { emitToBusiness } = require('../socket');
const { enforceAutoBookAvailability } = require('../services/inventoryService');
const { logActivity } = require('../services/activityLog');
const { attachBusiness } = require('../middleware/auth');

// iOS CallKit uploads don't send a token yet — soft auth scopes the lead to the
// caller's business when a token is present, else to Valley Binz.
router.use(attachBusiness);

const { RECORDINGS_DIR } = require('../config/paths');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RECORDINGS_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `ios-${unique}${path.extname(file.originalname) || '.m4a'}`);
  },
});

const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /mp3|m4a|wav|ogg|webm|mp4|aac/i;
    const extname = path.extname(file.originalname).replace('.', '');
    if (allowed.test(extname) || file.mimetype.startsWith('audio/') || file.mimetype === 'video/mp4') {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

function getDeviceTokens(deviceToken, businessId) {
  if (deviceToken) return [deviceToken];
  try {
    const devices = db.prepare('SELECT device_token FROM devices WHERE business_id = ?').all(businessId);
    return devices.map(d => d.device_token);
  } catch {
    return [];
  }
}

function insertLead(data) {
  const fields = Object.keys(data);
  const placeholders = fields.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO leads (${fields.join(', ')}) VALUES (${placeholders})`
  );
  const result = stmt.run(...fields.map(f => data[f]));
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(result.lastInsertRowid));
}

// POST /api/upload/recording
router.post('/recording', uploadAudio.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }

  const audioPath = req.file.path;
  const audioPublicPath = `/uploads/recordings/${req.file.filename}`;
  const {
    callerNumber,
    callDirection,
    callDuration,
    timestamp,
    vertical = 'auto_dealer',
    capturedBy,
    deviceToken,
  } = req.body;

  const validVerticals = ['auto_dealer', 'insurance_agent', 'home_services'];
  const normalizedVertical = validVerticals.includes(vertical) ? vertical : 'auto_dealer';

  try {
    console.log(`[upload] Processing iOS recording for vertical: ${normalizedVertical}, caller: ${callerNumber || 'unknown'}`);

    const { transcript, provider, transcription_seconds } = await transcribe(audioPath);
    console.log(`[upload] Transcript length: ${transcript.length} chars via ${provider}`);

    const { commonFields, verticalData, confidence, businessRelevant } = await extractFromTranscriptVertical(transcript, normalizedVertical, null, { businessId: req.business.id });
    console.log(`[upload] Extraction complete, confidence: ${confidence}`);

    // Pre-populate phone from caller ID if not extracted
    if (!commonFields.phone && callerNumber) {
      const digits = callerNumber.replace(/\D/g, '');
      if (digits.length >= 10) {
        const local = digits.slice(-10);
        commonFields.phone = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
        commonFields.phone_confidence = 0.7;
      }
    }

    const leadData = {
      ...commonFields,
      extraction_type: 'ios_callkit',
      audio_file_path: audioPublicPath,
      transcription_provider: provider,
      transcription_duration_seconds: transcription_seconds || null,
      auto_captured: 1,
      raw_transcript: transcript,
      vertical: normalizedVertical,
      source: 'ios_callkit',
      caller_number: callerNumber || null,
      call_direction: callDirection || null,
      call_duration: callDuration ? parseInt(callDuration, 10) : null,
      captured_by: capturedBy || null,
      vertical_data: JSON.stringify(verticalData),
      confidence: confidence || 0,
      business_id: req.business.id,
    };

    let lead = insertLead(leadData);

    // Business-relevance gate — mirrors the Twilio path (webhook.js) exactly so
    // both capture paths behave identically. The AI flags calls with zero business
    // connection (wrong number, "call you back", purely personal); auto-discard so
    // they never become a live lead. Only an explicit false discards; undefined is
    // kept. The recording/transcript/extraction stay intact (discarded, not
    // deleted) — the existing `discarded` filtering (customerService reconcile /
    // getCustomerDetail, All Leads, Action Queue) keeps it out of every owner-facing
    // view. Skip the auto-booking, new_lead emit, and push, just as webhook.js
    // skips new_lead + SMS.
    if (businessRelevant === false) {
      db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
      logActivity(lead.id, 'note', 'Auto-discarded — call had no business relevance');
      console.log(`[upload] Auto-discarded non-business call (lead ${lead.id})`);
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
      return res.status(201).json(lead);
    }

    // Vertical prompt sets confidence to 0 for personal/non-business calls
    if (!confidence) {
      db.prepare('UPDATE leads SET discarded = 1 WHERE id = ?').run(lead.id);
      console.log(`[upload] Auto-discarded zero-confidence call (lead ${lead.id})`);
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
      return res.status(201).json(lead);
    }

    // Auto-booking: verify pool inventory is actually available for the requested
    // size over the rental window before finalizing. Inventory is pool-based — no
    // specific unit is assigned; availability is computed on demand from owned
    // quantity vs. overlapping active jobs of the same size. If no unit is free,
    // enforceAutoBookAvailability downgrades the booking to a flagged high-intent
    // opportunity (see helper) so it is never confirmed against missing inventory.
    const { blocked: bookingBlocked } = enforceAutoBookAvailability(lead, verticalData);
    if (verticalData.autoBooked === true || bookingBlocked) {
      // Re-fetch to include the persisted pickup date / conflict downgrade.
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    }
    if (bookingBlocked) {
      console.warn(`[upload] Auto-book BLOCKED for lead ${lead.id} — no ${verticalData.dumpsterSize || 'matching size'} available for ${lead.delivery_date}→${lead.pickup_date}; flagged as inventory conflict`);
    }

    emitToBusiness(lead.business_id, 'new_lead', lead);

    // Send push notification
    const tokens = getDeviceTokens(deviceToken, req.business.id);
    const customerName = [commonFields.customer_first_name, commonFields.customer_last_name]
      .filter(Boolean).join(' ') || 'Unknown Caller';
    const primaryField = verticalData.vehicleInterest || verticalData.coverageType || verticalData.serviceType;
    const notifBody = primaryField
      ? `${customerName} — ${primaryField}`
      : customerName;

    sendToAll(tokens, 'New lead captured', notifBody, { leadId: lead.id }).catch(err => {
      console.error('[upload] Push notification failed:', err.message);
    });

    console.log(`[upload] Lead ${lead.id} created from iOS recording`);
    res.status(201).json(lead);
  } catch (err) {
    console.error('[upload] Processing failed:', err);
    fs.unlink(audioPath, () => {});
    res.status(500).json({ error: err.message || 'Processing failed' });
  }
});

module.exports = router;
