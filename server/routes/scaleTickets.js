const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { RECORDINGS_DIR } = require('../config/paths');
const { readScaleTicket } = require('../services/scaleTicketReader');

// Scale-ticket photos: the camera shortcut behind the weight box, and the evidence
// kept for an overage the customer later disputes.
//
// WHERE THEY LIVE: under RECORDINGS_DIR — the SAME persistent mount as the call
// recordings (/data/recordings in prod, served at /uploads/recordings). The bare
// server/uploads directory is on the container's ephemeral disk and is WIPED on every
// redeploy, so a ticket photo stored there would 404 the moment the app redeploys —
// exactly when an owner needs it to defend a bill. Sub-folder `scale-tickets/` keeps
// them out of the twilio-*.mp3 namespace the recording cleanup job matches on.
//
// Web-dashboard only → hard auth.
router.use(requireAuth);

const SCALE_TICKETS_DIR = path.join(RECORDINGS_DIR, 'scale-tickets');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      // Created lazily: the volume may not be mounted at require-time on a cold boot.
      if (!fs.existsSync(SCALE_TICKETS_DIR)) fs.mkdirSync(SCALE_TICKETS_DIR, { recursive: true });
      cb(null, SCALE_TICKETS_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `scale-ticket-${unique}${ext}`);
  },
});

const uploadPhoto = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|heic|heif/i;
    const extOk = allowed.test(path.extname(file.originalname));
    const mimeOk = allowed.test(file.mimetype) || file.mimetype === 'image/heic';
    if (extOk || mimeOk) cb(null, true);
    else cb(new Error('Only image files are allowed (jpg, png, heic, gif, webp)'));
  },
});

// POST /api/scale-tickets/read — upload a photographed scale ticket, get back where it
// was stored plus the weight read off it.
//
// The reading is a SUGGESTION: it pre-fills the owner's pounds box and is never
// submitted on its own. A failed or unconfigured read is NOT an error for the caller —
// the photo is still stored and still attached to the ticket, and the owner types the
// weight as they always could. That's why a reader failure returns 200 with
// reading:null rather than a 5xx that would throw away the upload.
router.post('/read', uploadPhoto.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

  const photoPath = `/uploads/recordings/scale-tickets/${req.file.filename}`;

  try {
    const reading = await readScaleTicket(req.file.path);
    res.json({ photoPath, reading });
  } catch (err) {
    console.error('POST /scale-tickets/read error:', err);
    res.json({
      photoPath,
      reading: null,
      readError: 'Could not read the ticket automatically — enter the weight below.',
    });
  }
});

module.exports = router;
