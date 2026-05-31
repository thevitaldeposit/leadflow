// Daily job that deletes Twilio call recordings older than 30 days.
// Runs at 2:00 AM server time using setTimeout (same pattern as morningPriorities.js).
// Uses the built-in https module — no extra dependencies.

const https = require('https');
const db = require('../db/database');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Extract the Twilio Recording SID from audio_file_path.
// Stored as "/uploads/recordings/twilio-{SID}.mp3" by the webhook.
function extractSid(audioFilePath) {
  if (!audioFilePath) return null;
  const m = /twilio-([A-Za-z0-9]+)\.mp3$/.exec(audioFilePath);
  return m ? m[1] : null;
}

function twilioDelete(accountSid, authToken, recordingSid) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const req = https.request(
      {
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.json`,
        method: 'DELETE',
        headers: { Authorization: `Basic ${auth}` },
      },
      (res) => {
        // Twilio returns 204 No Content on success
        if (res.statusCode === 204 || res.statusCode === 404) {
          resolve(res.statusCode);
        } else {
          let body = '';
          res.on('data', d => { body += d; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
        }
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runCleanup() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.log('[recording-cleanup] Skipped — TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set');
    return;
  }

  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  const candidates = db.prepare(`
    SELECT id, audio_file_path
    FROM leads
    WHERE audio_file_path IS NOT NULL
      AND audio_file_path LIKE '%twilio-%'
      AND created_at < ?
      AND (recording_deleted_at IS NULL)
  `).all(cutoff);

  if (candidates.length === 0) {
    console.log('[recording-cleanup] No recordings eligible for deletion');
    return;
  }

  console.log(`[recording-cleanup] ${candidates.length} recording(s) eligible for deletion`);

  let deleted = 0;
  let failed = 0;

  for (const lead of candidates) {
    const sid = extractSid(lead.audio_file_path);
    if (!sid) {
      console.warn(`[recording-cleanup] Could not extract SID from: ${lead.audio_file_path} (lead ${lead.id})`);
      failed++;
      continue;
    }

    try {
      await twilioDelete(accountSid, authToken, sid);
      db.prepare('UPDATE leads SET recording_deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), lead.id);
      deleted++;
    } catch (err) {
      console.error(`[recording-cleanup] Failed to delete ${sid} (lead ${lead.id}):`, err.message);
      failed++;
    }
  }

  console.log(`[recording-cleanup] Done — ${deleted} deleted, ${failed} failed`);
}

function scheduleNext2am() {
  const now = new Date();
  const next2am = new Date(now);
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);

  const delay = next2am - now;
  const timer = setTimeout(async () => {
    try {
      await runCleanup();
    } catch (err) {
      console.error('[recording-cleanup] Unexpected error:', err);
    }
    scheduleNext2am();
  }, delay);
  timer.unref();

  const h = Math.floor(delay / 3600000);
  const m = Math.floor((delay % 3600000) / 60000);
  console.log(`[recording-cleanup] Next run in ${h}h ${m}m (${next2am.toLocaleString()})`);
}

function start() {
  scheduleNext2am();
}

module.exports = { start, runCleanup };
