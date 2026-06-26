const path = require('path');

// Single source of truth for where call recordings live on disk.
//
// Every recording writer (Twilio webhook, iOS CallKit upload, manual upsheet
// audio) and the Express static route that serves them resolve this ONE value,
// so the write location and the serve location can never drift apart.
//
// In production these files MUST sit on the Railway persistent volume — the same
// mount that holds the SQLite DB at /data/leadflow.db. The container's own disk is
// EPHEMERAL: every redeploy wipes it, so recordings written there vanish while the
// DB still points at /uploads/recordings/twilio-<SID>.mp3 and the player 404s.
// Set RECORDINGS_DIR=/data/recordings in Railway to make recordings persist.
//
// When RECORDINGS_DIR is unset (local/dev), default to the repo's
// server/uploads/recordings so local behavior is unchanged. A RELATIVE
// RECORDINGS_DIR is anchored to the repo root — NOT process.cwd() — exactly like
// DATABASE_PATH in db/database.js, so launching the server from a subdirectory
// can't silently point at a different folder. This file lives at server/config/,
// so ../.. is the repo root and ../uploads is server/uploads.
function resolveRecordingsDir() {
  const raw = process.env.RECORDINGS_DIR;
  if (!raw) return path.join(__dirname, '../uploads/recordings');
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, '../..', raw);
}

const RECORDINGS_DIR = resolveRecordingsDir();

module.exports = { RECORDINGS_DIR };
