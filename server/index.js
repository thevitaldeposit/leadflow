require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// Importing the DB proxy is safe at load time — it holds no open connection yet.
// Routes also import it at their load time; the proxy forwards calls to the real
// db only after initDatabase() resolves, which happens before app.listen().
const db = require('./db/database');
const { initDatabase } = require('./db/database');
const { init: initSocket } = require('./socket');
const { requireAuth } = require('./middleware/auth');

// Route modules register handlers; they do not call the DB at require time.
const leadsRouter = require('./routes/leads');
const extractRouter = require('./routes/extract');
const webhookRouter = require('./routes/webhook');
const uploadRouter = require('./routes/upload');
const devicesRouter = require('./routes/devices');
const dumpsterRouter = require('./routes/inventory');
const scheduleRouter = require('./routes/schedule');
const settingsRouter = require('./routes/settings');
const paymentRouter = require('./routes/payment');
const authRouter = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust the Cloudflare/reverse-proxy X-Forwarded-Proto header so
// req.protocol returns 'https' when behind a tunnel, keeping Twilio
// callback URLs valid (Twilio rejects http:// callback URLs).
app.set('trust proxy', true);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ensure recordings directory exists
const RECORDINGS_DIR = path.join(__dirname, 'uploads/recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve static public assets (e.g. the Twilio voicemail greeting) from the web
// root so TwiML <Play> can reach them at https://<host>/<filename>.
app.use(express.static(path.join(__dirname, 'public')));

// Dashboard stats — must be registered before the /api/leads router
app.get('/api/dashboard/stats', requireAuth, (req, res) => {
  try {
    const businessId = req.business.id;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const totalToday = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE business_id = ? AND created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(businessId, todayStart);
    const totalWeek = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE business_id = ? AND created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(businessId, weekStart);
    const totalMonth = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE business_id = ? AND created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(businessId, monthStart);
    const totalAll = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE business_id = ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(businessId);

    const byStatus = db.prepare(
      'SELECT status, COUNT(*) as count FROM leads WHERE business_id = ? AND (discarded = 0 OR discarded IS NULL) GROUP BY status'
    ).all(businessId);
    const byIntent = db.prepare(
      'SELECT customer_intent, COUNT(*) as count FROM leads WHERE business_id = ? AND (discarded = 0 OR discarded IS NULL) GROUP BY customer_intent'
    ).all(businessId);
    const bySource = db.prepare(
      'SELECT lead_source, COUNT(*) as count FROM leads WHERE business_id = ? AND lead_source IS NOT NULL AND (discarded = 0 OR discarded IS NULL) GROUP BY lead_source ORDER BY count DESC LIMIT 10'
    ).all(businessId);

    const appointmentsToday = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE business_id = ? AND appointment_set = 1 AND created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(businessId, todayStart);
    const appointmentsWeek = db.prepare(
      'SELECT COUNT(*) as count FROM leads WHERE business_id = ? AND appointment_set = 1 AND created_at >= ? AND (discarded = 0 OR discarded IS NULL)'
    ).get(businessId, weekStart);

    const avgConfidence = db.prepare(`
      SELECT AVG(
        (COALESCE(customer_first_name_confidence,0) + COALESCE(customer_last_name_confidence,0) +
         COALESCE(phone_confidence,0) + COALESCE(voi_make_confidence,0) + COALESCE(voi_model_confidence,0)) / 5.0
      ) as avg_confidence FROM leads WHERE business_id = ? AND (discarded = 0 OR discarded IS NULL)
    `).get(businessId);

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
app.use('/api/auth', authRouter);
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

async function startServer() {
  const maxRetries = 10;
  const retryDelay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      initDatabase();
      console.log('[db] Database ready');
      break;
    } catch (err) {
      if (attempt === maxRetries) {
        console.error('[db] Failed to initialize after', maxRetries, 'attempts:', err.message);
        process.exit(1);
      }
      console.log(`[db] Volume not ready, waiting ${retryDelay / 1000}s... (attempt ${attempt}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }

  // Run schema migrations now that the DB is confirmed open.
  require('./db/migrations');

  // Best-effort JSON export alongside the DB so a recoverable copy exists even
  // if the DB file is accidentally overwritten on redeploy.
  try {
    const leadCount = db.prepare('SELECT COUNT(*) as n FROM leads').get().n;
    if (leadCount > 0) {
      const resolvedDb = process.env.DATABASE_PATH
        ? path.resolve(process.env.DATABASE_PATH)
        : path.join(__dirname, 'db/leadflow.db');
      const backupPath = path.join(path.dirname(resolvedDb), 'leadflow-backup.json');
      const leads = db.prepare('SELECT * FROM leads').all();
      let inventory = [];
      try { inventory = db.prepare('SELECT * FROM inventory_pool').all(); } catch { /* table may not exist yet */ }
      fs.writeFileSync(
        backupPath,
        JSON.stringify({ exportedAt: new Date().toISOString(), leadCount, leads, inventory }, null, 2)
      );
      console.log(`[startup] Backed up ${leadCount} leads → ${backupPath}`);
    }
  } catch (backupErr) {
    console.error('[startup] Backup failed (non-fatal):', backupErr.message);
  }

  const k = process.env.OPENAI_API_KEY || '';
  console.log(
    `[startup] OPENAI_API_KEY ${k ? `loaded (${k.slice(0, 8)}...${k.slice(-4)}, len ${k.length})` : 'MISSING'}`
  );

  // Schedule the 8am Morning Priorities push for Home Services devices.
  require('./services/morningPriorities').start();

  // Schedule daily 2am deletion of Twilio recordings older than 30 days.
  require('./services/recordingCleanup').start();

  server.listen(PORT, () => {
    console.log(`LeadFlow server running on http://localhost:${PORT}`);
  });
}

startServer();
