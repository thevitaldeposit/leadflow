const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { extractFromTranscript, extractFromImage } = require('../services/extractionEngine');
const { UPLOADS_DIR } = require('../services/imageProcessor');
const { transcribe } = require('../services/transcriptionService');
const { emitToBusiness } = require('../socket');
const { requireAuth } = require('../middleware/auth');

// Manual lead capture is a web-dashboard feature — every route requires auth.
router.use(requireAuth);

// Upsheet image uploads
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `upsheet-${unique}${path.extname(file.originalname)}`);
  },
});

const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|heic|heif/i;
    const extOk = allowed.test(path.extname(file.originalname));
    const mimeOk = allowed.test(file.mimetype) || file.mimetype === 'image/heic';
    if (extOk || mimeOk) cb(null, true);
    else cb(new Error('Only image files are allowed (jpg, png, heic, gif, webp)'));
  },
});

// Audio uploads
const { RECORDINGS_DIR } = require('../config/paths');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RECORDINGS_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `recording-${unique}${path.extname(file.originalname)}`);
  },
});

const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /mp3|m4a|wav|ogg|webm|mp4/i;
    const extOk = allowed.test(path.extname(file.originalname).replace('.', ''));
    const mimeOk = file.mimetype.startsWith('audio/') || file.mimetype === 'video/mp4' || file.mimetype === 'video/webm';
    if (extOk || mimeOk) cb(null, true);
    else cb(new Error('Only audio files are allowed (mp3, m4a, wav, ogg, webm, mp4)'));
  },
});

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

function emitNewLead(lead) {
  emitToBusiness(lead.business_id, 'new_lead', lead);
}

// POST /api/extract/transcript
router.post('/transcript', async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'transcript field is required' });
    }

    const extracted = await extractFromTranscript(transcript);
    extracted.raw_transcript = transcript;
    extracted.business_id = req.business.id;

    const lead = insertLead(extracted);
    emitNewLead(lead);
    res.status(201).json(lead);
  } catch (err) {
    console.error('POST /extract/transcript error:', err);
    res.status(500).json({ error: err.message || 'Extraction failed' });
  }
});

// POST /api/extract/upsheet
router.post('/upsheet', uploadImage.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  try {
    const imagePath = req.file.path;
    const extracted = await extractFromImage(imagePath);
    extracted.raw_image_path = `/uploads/${req.file.filename}`;
    extracted.extraction_type = 'upsheet_image';
    extracted.business_id = req.business.id;

    const lead = insertLead(extracted);
    emitNewLead(lead);
    res.status(201).json(lead);
  } catch (err) {
    console.error('POST /extract/upsheet error:', err);
    res.status(500).json({ error: err.message || 'Image extraction failed' });
  }
});

// POST /api/extract/audio
router.post('/audio', uploadAudio.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }

  const audioPath = req.file.path;
  const audioPublicPath = `/uploads/recordings/${req.file.filename}`;

  try {
    // Transcribe
    const { transcript, provider, transcription_seconds } = await transcribe(audioPath);

    // Extract lead data from transcript
    const extracted = await extractFromTranscript(transcript);
    extracted.raw_transcript = transcript;
    extracted.extraction_type = 'audio_upload';
    extracted.audio_file_path = audioPublicPath;
    extracted.transcription_provider = provider;
    extracted.transcription_duration_seconds = transcription_seconds || null;
    extracted.business_id = req.business.id;

    const lead = insertLead(extracted);
    emitNewLead(lead);
    res.status(201).json(lead);
  } catch (err) {
    console.error('POST /extract/audio error:', err);
    // Clean up the uploaded file on failure
    fs.unlink(audioPath, () => {});
    res.status(500).json({ error: err.message || 'Audio extraction failed' });
  }
});

module.exports = router;
