#!/usr/bin/env node
/**
 * One-off recovery utility — re-download call recordings that were wiped from the
 * container's EPHEMERAL disk back onto the persistent volume, using the Twilio
 * Recording SIDs already stored in the database.
 *
 * WHY: recordings used to be written to server/uploads/recordings on the
 * container's ephemeral disk, so every Railway redeploy wiped them while the DB
 * still pointed at /uploads/recordings/twilio-<SID>.mp3 (the player then 404s).
 * Twilio keeps its own copy of each recording for ~30 days, so any SID Twilio
 * still has can be re-fetched and written to RECORDINGS_DIR (the /data volume).
 *
 * SAFETY — hard guarantees:
 *   - READ-ONLY on the database. Only SELECT / PRAGMA. Never INSERT/UPDATE/DELETE,
 *     never runs migrations. The DB is used purely to discover which recording
 *     files are referenced; the stored paths are already correct.
 *   - Never deletes a file. A recording is buffered fully in memory and written to
 *     disk ONLY after a complete, successful HTTP 200 download — a failed/partial
 *     download writes nothing. There is no unlink/rm anywhere in this script.
 *   - Idempotent: if RECORDINGS_DIR/<filename> already exists, it is skipped (no
 *     re-download). Safe to run repeatedly.
 *   - Per-file error isolation: one missing/failed recording is logged and the run
 *     continues — it never aborts the whole run.
 *
 * Reuses the app's own wiring so it targets prod correctly with no hardcoded paths:
 *   - RECORDINGS_DIR from server/config/paths.js (→ /data/recordings in prod)
 *   - the app's DB module server/db/database.js (→ /data/leadflow.db in prod)
 *   - Twilio creds from the same env vars the app uses: TWILIO_ACCOUNT_SID /
 *     TWILIO_AUTH_TOKEN.
 *
 * Typical run (temporary Railway start command, backgrounded next to the server so
 * there is zero downtime):
 *   node server/scripts/recover-recordings.js & node server/index.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const db = require('../db/database');
const { RECORDINGS_DIR } = require('../config/paths');

const REQUEST_TIMEOUT_MS = 30000; // per HTTP request (Twilio + any CDN redirect)
const MAX_REDIRECTS = 5; // Twilio media may 302 to its storage CDN

// Recording paths are stored as URL paths under this prefix, e.g.
//   /uploads/recordings/twilio-RE....mp3   (Twilio-captured)
//   /uploads/recordings/ios-....m4a        (iOS CallKit upload)
//   /uploads/recordings/recording-....mp3  (manual upsheet audio)
const RECORDINGS_URL_PREFIX = '/uploads/recordings/';
// Pull every recordings filename out of a stored value. Works whether the column
// holds a bare path (the normal case) or a path embedded inside a JSON blob.
const FILENAME_RE = /\/uploads\/recordings\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g;
// A Twilio-origin filename: twilio-<SID>.mp3 — same shape the webhook and
// recordingCleanup.js use. Only these can be re-fetched from Twilio.
const TWILIO_FILE_RE = /^twilio-([A-Za-z0-9]+)\.mp3$/;

function quoteId(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

// Every /uploads/recordings/<file> filename referenced inside a single stored value.
function extractFilenames(value) {
  if (value == null) return [];
  const s = String(value);
  const out = [];
  let m;
  FILENAME_RE.lastIndex = 0;
  while ((m = FILENAME_RE.exec(s)) !== null) out.push(m[1]);
  return out;
}

// Classify a recording filename by whether Twilio can serve it.
function classifyFile(filename) {
  const m = TWILIO_FILE_RE.exec(filename);
  return m ? { kind: 'twilio', sid: m[1] } : { kind: 'non_twilio' };
}

// Decide what to do for one unique file, given whether it already exists on disk.
function planForFile(filename, fileExists) {
  const cls = classifyFile(filename);
  if (cls.kind !== 'twilio') return { action: 'unrecoverable' };
  if (fileExists) return { action: 'present', sid: cls.sid };
  return { action: 'download', sid: cls.sid };
}

// Schema-introspect: scan every text column of every table for stored recording
// paths. This recovers EVERY reference — including earlier calls in an engagement,
// which are their own lead rows — without hardcoding a single column, and stays
// correct if a future column ever holds a recording path too.
function discoverReferences() {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  const refs = []; // { table, column, rid, filename }
  const scannedColumns = []; // "table.column" actually scanned (coverage log)
  const likePattern = `%${RECORDINGS_URL_PREFIX}%`;

  for (const table of tables) {
    let cols;
    try {
      cols = db.prepare(`PRAGMA table_info(${quoteId(table)})`).all();
    } catch {
      continue;
    }
    for (const col of cols) {
      const type = (col.type || '').toUpperCase();
      // Recording paths only ever live in text-affinity columns.
      const textAffinity = type === '' || /CHAR|CLOB|TEXT/.test(type);
      if (!textAffinity) continue;
      scannedColumns.push(`${table}.${col.name}`);

      let rows;
      try {
        rows = db
          .prepare(
            `SELECT rowid AS rid, ${quoteId(col.name)} AS val FROM ${quoteId(table)} WHERE ${quoteId(col.name)} LIKE ?`
          )
          .all(likePattern);
      } catch {
        // Fallback for the (not used in this schema) WITHOUT ROWID case.
        try {
          rows = db
            .prepare(`SELECT ${quoteId(col.name)} AS val FROM ${quoteId(table)} WHERE ${quoteId(col.name)} LIKE ?`)
            .all(likePattern)
            .map((r) => ({ rid: null, val: r.val }));
        } catch {
          continue;
        }
      }

      for (const row of rows) {
        for (const filename of extractFilenames(row.val)) {
          refs.push({ table, column: col.name, rid: row.rid, filename });
        }
      }
    }
  }
  return { refs, scannedColumns };
}

// Download a recording fully into memory. Resolves { status:'ok', buffer } on a
// complete 200, { status:'gone', code } on 404/410, follows redirects, and rejects
// on any other status / network error / timeout. Nothing is written here, so a
// failure can never leave a partial file on disk.
function fetchRecording(urlStr, accountSid, authToken, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const headers = {};
    // Only send Twilio basic auth to Twilio — never forward it across a redirect
    // to Twilio's CDN host.
    if (u.hostname === 'api.twilio.com') {
      headers.Authorization = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    }

    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const code = res.statusCode;

        if ([301, 302, 303, 307, 308].includes(code)) {
          res.resume(); // discard redirect body
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`redirect ${code} without Location`));
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          let next;
          try {
            next = new URL(loc, urlStr).toString();
          } catch (e) {
            return reject(e);
          }
          return resolve(fetchRecording(next, accountSid, authToken, redirectsLeft - 1));
        }

        if (code === 404 || code === 410) {
          res.resume();
          return resolve({ status: 'gone', code });
        }

        if (code !== 200) {
          let body = '';
          res.on('data', (d) => {
            if (body.length < 500) body += d.toString();
          });
          res.on('error', reject);
          res.on('end', () => reject(new Error(`HTTP ${code}: ${body.slice(0, 200)}`)));
          return;
        }

        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('aborted', () => reject(new Error('response aborted (truncated download)')));
        res.on('error', reject);
        res.on('end', () => resolve({ status: 'ok', buffer: Buffer.concat(chunks) }));
      }
    );

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`)));
    req.end();
  });
}

async function main() {
  console.log('[recover] Recording recovery utility starting');
  console.log('[recover] RECORDINGS_DIR:', RECORDINGS_DIR);

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    console.error(
      '[recover] FATAL: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — cannot fetch from Twilio. Aborting (no changes made).'
    );
    process.exit(1);
  }

  // Opens the SAME database the app uses (logs the resolved path, e.g.
  // /data/leadflow.db in prod). Read-only from here on.
  db.initDatabase();
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  const { refs, scannedColumns } = discoverReferences();

  // Coverage + per-column breakdown so the operator can confirm nothing was missed.
  const byColumn = {};
  for (const r of refs) {
    const key = `${r.table}.${r.column}`;
    byColumn[key] = (byColumn[key] || 0) + 1;
  }
  console.log(`[recover] Scanned ${scannedColumns.length} text column(s) across ${new Set(scannedColumns.map((c) => c.split('.')[0])).size} table(s)`);
  console.log(`[recover] Found ${refs.length} recording reference(s) in: ${Object.keys(byColumn).map((k) => `${k}=${byColumn[k]}`).join(', ') || '(none)'}`);

  // Group references by filename → unique physical files to act on (one DB file may
  // be referenced by several rows, e.g. a merged missed-call placeholder).
  const byFile = new Map(); // filename -> [{ table, column, rid }]
  for (const r of refs) {
    if (!byFile.has(r.filename)) byFile.set(r.filename, []);
    byFile.get(r.filename).push({ table: r.table, column: r.column, rid: r.rid });
  }
  const uniqueFiles = [...byFile.keys()];
  console.log(`[recover] ${uniqueFiles.length} unique recording file(s) referenced\n`);

  const counts = { downloaded: 0, present: 0, gone: 0, unrecoverable: 0, errors: 0 };
  const goneList = [];
  const unrecoverableList = [];
  const errorList = [];

  let i = 0;
  for (const filename of uniqueFiles) {
    i++;
    const first = byFile.get(filename)[0];
    const refLabel = `${first.table}#${first.rid}`;
    const targetPath = path.join(RECORDINGS_DIR, filename);

    const plan = planForFile(filename, fs.existsSync(targetPath));

    if (plan.action === 'unrecoverable') {
      counts.unrecoverable++;
      unrecoverableList.push(filename);
      console.log(`[recover] ⊘ unrecoverable (non-Twilio origin): ${filename}  [${refLabel}]`);
      continue;
    }
    if (plan.action === 'present') {
      counts.present++;
      continue; // idempotent skip — quiet; counted in the summary
    }

    // plan.action === 'download'
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${plan.sid}.mp3`;
    try {
      const result = await fetchRecording(url, accountSid, authToken, MAX_REDIRECTS);
      if (result.status === 'gone') {
        counts.gone++;
        goneList.push(plan.sid);
        console.log(`[recover] ✗ gone (Twilio HTTP ${result.code}): ${filename}  [${refLabel}]`);
      } else {
        fs.writeFileSync(targetPath, result.buffer);
        counts.downloaded++;
        console.log(`[recover] ↓ restored: ${filename} (${(result.buffer.length / 1024).toFixed(0)} KB)  [${refLabel}]`);
      }
    } catch (err) {
      counts.errors++;
      errorList.push({ sid: plan.sid, ref: refLabel, error: err.message });
      console.error(`[recover] ! error: ${filename}  [${refLabel}] — ${err.message}`);
    }

    if (i % 25 === 0) console.log(`[recover] …progress ${i}/${uniqueFiles.length}`);
  }

  console.log('\n[recover] ===== RECOVERY SUMMARY =====');
  console.log(`[recover] total recording references found : ${refs.length}`);
  console.log(`[recover] unique recording files           : ${uniqueFiles.length}`);
  console.log(`[recover] downloaded (restored)            : ${counts.downloaded}`);
  console.log(`[recover] already present (skipped)        : ${counts.present}`);
  console.log(`[recover] gone (Twilio no longer has SID)  : ${counts.gone}`);
  if (goneList.length) console.log(`[recover]   gone SIDs: ${goneList.join(', ')}`);
  console.log(`[recover] unrecoverable (non-Twilio origin): ${counts.unrecoverable}`);
  if (unrecoverableList.length) console.log(`[recover]   non-Twilio files: ${unrecoverableList.join(', ')}`);
  console.log(`[recover] errors                           : ${counts.errors}`);
  for (const e of errorList) console.log(`[recover]   error sid=${e.sid} ref=${e.ref}: ${e.error}`);
  console.log('[recover] ============================');
  console.log('[recover] Done. (DB untouched; no files deleted.)');
  process.exit(0);
}

module.exports = { discoverReferences, extractFilenames, classifyFile, planForFile, fetchRecording };

if (require.main === module) {
  main().catch((err) => {
    console.error('[recover] FATAL unexpected error:', err);
    process.exit(1);
  });
}
