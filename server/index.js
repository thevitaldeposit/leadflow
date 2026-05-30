require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db/database');
const { init: initSocket } = require('./socket');

// Initialize DB and run migrations on startup
require('./db/migrations');

// ── Startup backup ───────────────────────────────────────────────────────────
// Best-effort JSON export written alongside the DB so a recoverable copy
// exists even if the DB file is accidentally overwritten.
// db.js already logged the resolved path; read it back via the module itself.
try {
  const _leadCount = db.prepare('SELECT COUNT(*) as n FROM leads').get().n;
  if (_leadCount > 0) {
    const _resolvedDb = process.env.DATABASE_PATH
      ? path.resolve(process.env.DATABASE_PATH)
      : path.join(__dirname, 'db/leadflow.db');
    const _backupPath = path.join(path.dirname(_resolvedDb), 'leadflow-backup.json');
    const _leads = db.prepare('SELECT * FROM leads').all();
    let _dumpsters = [];
    try { _dumpsters = db.prepare('SELECT * FROM dumpsters').all(); } catch { /* table may not exist yet */ }
    fs.writeFileSync(
      _backupPath,
      JSON.stringify({ exportedAt: new Date().toISOString(), leadCount: _leadCount, leads: _leads, dumpsters: _dumpsters }, null, 2)
    );
    console.log(`[startup] Backed up ${_leadCount} leads → ${_backupPath}`);
  }
} catch (_backupErr) {
  console.error('[startup] Backup failed (non-fatal):', _backupErr.message);
}

const _k = process.env.OPENAI_API_KEY || '';
console.log(
  `[startup] OPENAI_API_KEY ${_k ? `loaded (${_k.slice(0, 8)}...${_k.slice(-4)}, len ${_k.length})` : 'MISSING'}`
);

// Ensure recordings directory exists
const RECORDINGS_DIR = path.join(__dirname, 'uploads/recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

const leadsRouter = require('./routes/leads');
const extractRouter = require('./routes/extract');
const webhookRouter = require('./routes/webhook');
const uploadRouter = require('./routes/upload');
const devicesRouter = require('./routes/devices');
const dumpsterRouter = require('./routes/dumpsters');
const scheduleRouter = require('./routes/schedule');
const settingsRouter = require('./routes/settings');
const paymentRouter = require('./routes/payment');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust the Cloudflare/reverse-proxy X-Forwarded-Proto header so
// req.protocol returns 'https' when behind a tunnel, keeping Twilio
// callback URLs valid (Twilio rejects http:// callback URLs).
app.set('trust proxy', true);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Dashboard stats — must be registered before the /api/leads router
app.get('/api/dashboard/stats', (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const totalToday = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(todayStart);
    const totalWeek = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(weekStart);
    const totalMonth = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(monthStart);
    const totalAll = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE (discarded = 0 OR discarded IS NULL)'
    ).get();

    const byStatus = db.prepare(
      'SELECT status, COUNT(*) as count FROM leads WHERE (discarded = 0 OR discarded IS NULL) GROUP BY status'
    ).all();
    const byIntent = db.prepare(
      'SELECT customer_intent, COUNT(*) as count FROM leads WHERE (discarded = 0 OR discarded IS NULL) GROUP BY customer_intent'
    ).all();
    const bySource = db.prepare(
      'SELECT lead_source, COUNT(*) as count FROM leads WHERE lead_source IS NOT NULL AND (discarded = 0 OR discarded IS NULL) GROUP BY lead_source ORDER BY count DESC LIMIT 10'
    ).all();

    const appointmentsToday = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE appointment_set = 1 AND created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(todayStart);
    const appointmentsWeek = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE appointment_set = 1 AND created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(weekStart);

    const avgConfidence = db.prepare(`
      SELECT AVG(
        (COALESCE(customer_first_name_confidence,0) + COALESCE(customer_last_name_confidence,0) +
         COALESCE(phone_confidence,0) + COALESCE(voi_make_confidence,0) + COALESCE(voi_model_confidence,0)) / 5.0
      ) as avg_confidence FROM leads WHERE (discarded = 0 OR discarded IS NULL)
    `).get();

    res.json({
      totals: { today: totalToday.count, week: totalWeek.count, month: totalMonth.count, all: totalAll.count },
      appointments: { today: appointmentsToday.count, week: appointmentsWeek.count },
      byStatus,
      byIntent,
      bySource,
      avgConfidence: avgConfidence.avg_confidence ? Math.round(avgConfidence.avg_confidence * 100) : 0,
    });
  } catch (err) {
    console.error('GET /dashboard/stats error:', err);
    res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

app.use('/api/leads', leadsRouter);
app.use('/api/dumpsters', dumpsterRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/extract', extractRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/settings', settingsRouter);
// Public payment page — must be before the SPA catch-all
app.use('/pay', paymentRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve built React client (production)
const CLIENT_DIST = path.join(__dirname, '../client/dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = http.createServer(app);
initSocket(server);

// Schedule the 8am Morning Priorities push for Home Services devices.
require('./services/morningPriorities').start();

server.listen(PORT, () => {
  console.log(`LeadFlow server running on http://localhost:${PORT}`);
});
