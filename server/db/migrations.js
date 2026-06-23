const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const db = require('./database');

const NEW_COLUMNS = [
  'ALTER TABLE leads ADD COLUMN audio_file_path TEXT',
  'ALTER TABLE leads ADD COLUMN transcription_provider TEXT',
  'ALTER TABLE leads ADD COLUMN transcription_duration_seconds REAL',
  'ALTER TABLE leads ADD COLUMN auto_captured INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN discarded INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN caller_phone_raw TEXT',
  'ALTER TABLE leads ADD COLUMN raw_transcript TEXT',
  // iOS CallKit columns
  'ALTER TABLE leads ADD COLUMN vertical TEXT DEFAULT \'auto_dealer\'',
  'ALTER TABLE leads ADD COLUMN source TEXT',
  'ALTER TABLE leads ADD COLUMN caller_number TEXT',
  'ALTER TABLE leads ADD COLUMN call_direction TEXT',
  'ALTER TABLE leads ADD COLUMN call_duration INTEGER',
  'ALTER TABLE leads ADD COLUMN captured_by TEXT',
  'ALTER TABLE leads ADD COLUMN vertical_data TEXT',
  'ALTER TABLE leads ADD COLUMN confidence INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN sub_vertical TEXT',
  // Home Services Phase 1 redesign
  'ALTER TABLE leads ADD COLUMN outcome TEXT',
  // Phase 2: full job lifecycle model
  'ALTER TABLE leads ADD COLUMN job_status TEXT DEFAULT \'inquiry\'',
  'ALTER TABLE leads ADD COLUMN assigned_dumpster_id INTEGER',
  'ALTER TABLE leads ADD COLUMN raw_delivery_date TEXT',
  'ALTER TABLE leads ADD COLUMN delivery_date TEXT',
  // Specific delivery/pickup time of day, stored as "HH:MM" 24-hour. Null = no
  // specific time set ("Flexible" on the schedule).
  'ALTER TABLE leads ADD COLUMN scheduled_time TEXT',
  'ALTER TABLE leads ADD COLUMN pickup_date TEXT',
  'ALTER TABLE leads ADD COLUMN estimated_revenue REAL',
  // Phase 2: auto-booking detection
  'ALTER TABLE leads ADD COLUMN auto_booked INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN needs_dumpster_assignment INTEGER DEFAULT 0',
  // Payment system
  'ALTER TABLE leads ADD COLUMN paid_at TEXT',
  'ALTER TABLE leads ADD COLUMN payment_sms_sent_at TEXT',
  // Recording lifecycle
  'ALTER TABLE leads ADD COLUMN recording_deleted_at TEXT',
  // Voicemail capture: distinguishes voicemail leads from answered calls
  // (also carries 'missed_call' for unanswered calls with no voicemail).
  'ALTER TABLE leads ADD COLUMN call_type TEXT',
  // Free-text internal log (outbound click-to-call attempts, etc.)
  'ALTER TABLE leads ADD COLUMN internal_notes TEXT',
  // When a follow-up is due. Set to capture time for missed calls (immediate).
  'ALTER TABLE leads ADD COLUMN follow_up_date TEXT',
];

// ── Multi-tenancy: per-business unique constraints ──────────────────────────
// Phase 1 attached business_id to settings and inventory_pool but left their
// UNIQUE constraints global (settings UNIQUE(key) via its PK, inventory_pool
// UNIQUE(size)). Those collide the moment a second tenant exists — two
// businesses can't both have a `businessName` setting or a 20-yard pool. Each
// table must instead be UNIQUE(business_id, <col>). SQLite can't alter a
// constraint in place, so the table is rebuilt with the documented
// create-new / copy / drop-old / rename recipe.

// True once `table` has a UNIQUE constraint that includes business_id — i.e. the
// composite-key migration has already run. Inspecting the actual unique indexes
// (rather than matching CREATE-TABLE text) keeps the check robust to formatting.
function hasBusinessScopedUnique(table) {
  for (const idx of db.prepare(`PRAGMA index_list(${table})`).all()) {
    if (!idx.unique) continue;
    const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all().map((c) => c.name);
    if (cols.includes('business_id')) return true;
  }
  return false;
}

// Rebuild `table` in place using `createNewSql` (which must create
// `${table}_new`) and copy `columns` across. Follows SQLite's documented safe
// schema-change procedure: foreign keys are disabled around the swap, the work
// runs inside a single transaction, and FK integrity is verified before commit.
function rebuildTableInPlace(table, createNewSql, columns) {
  const cols = columns.join(', ');
  // PRAGMA foreign_keys is a no-op inside a transaction, so toggle it outside.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      db.exec(createNewSql);
      db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      const violations = db.prepare(`PRAGMA foreign_key_check(${table})`).all();
      if (violations.length > 0) {
        throw new Error(
          `foreign_key_check failed after rebuilding ${table}: ${JSON.stringify(violations)}`
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    // Restore the connection-level setting database.js opened with, even on error.
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigrations() {
  console.log('[migrations] Starting schema migrations…');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  for (const stmt of NEW_COLUMNS) {
    try {
      db.exec(stmt);
    } catch (e) {
      // Column already exists — safe to ignore
      if (!e.message.includes('duplicate column name')) {
        throw e;
      }
    }
  }

  // Backfill: any existing home_services lead without a sub_vertical defaults to
  // dumpster_rental so the field-pack-driven detail view has something to render.
  db.prepare(
    "UPDATE leads SET sub_vertical = 'dumpster_rental' WHERE vertical = 'home_services' AND (sub_vertical IS NULL OR sub_vertical = '')"
  ).run();

  // Devices table for APNs tokens
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_token TEXT NOT NULL UNIQUE,
      user_name TEXT,
      business_name TEXT,
      vertical TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Twilio Voice (incoming call) columns on devices. Additive — same
  // attempt-and-swallow-duplicate pattern as NEW_COLUMNS. voip_token holds the
  // PushKit VoIP push token (distinct from the APNs alert token in
  // device_token); voice_identity is the Twilio Voice client identity the device
  // registered under, so a business's inbound TwiML can later dial those clients.
  const DEVICE_COLUMNS = [
    'ALTER TABLE devices ADD COLUMN voip_token TEXT',
    'ALTER TABLE devices ADD COLUMN voice_identity TEXT',
  ];
  for (const stmt of DEVICE_COLUMNS) {
    try {
      db.exec(stmt);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Caller ID stashed by /twilio/voice for later lookup in /twilio/recording,
  // which doesn't reliably include the From field.
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_sessions (
      call_sid TEXT PRIMARY KEY,
      from_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Pool-based inventory (replaces the legacy per-asset `dumpsters` table).
  // Inventory is tracked as a count of units per size; availability for a date
  // range is computed by comparing owned quantity against jobs of that size that
  // are active during the range. `units_in_service` temporarily reduces the
  // available count for units that are down for maintenance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      size TEXT NOT NULL UNIQUE,
      quantity INTEGER NOT NULL DEFAULT 0,
      units_in_service INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // One-time migration from the legacy per-asset `dumpsters` table: group assets
  // by size, with quantity = unit count and units_in_service = count of units that
  // were flagged needs_service. Retired (out_of_service) units are excluded from
  // owned quantity. Runs only while the old table still exists and the pool is
  // empty, then drops the old table.
  const dumpstersExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='dumpsters'"
  ).get();
  if (dumpstersExists) {
    const poolCount = db.prepare('SELECT COUNT(*) AS n FROM inventory_pool').get().n;
    if (poolCount === 0) {
      const grouped = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(size), ''), 'Unspecified') AS size,
               COUNT(*) AS quantity,
               SUM(CASE WHEN status = 'needs_service' THEN 1 ELSE 0 END) AS units_in_service
        FROM dumpsters
        WHERE status != 'out_of_service'
        GROUP BY COALESCE(NULLIF(TRIM(size), ''), 'Unspecified')
      `).all();
      const insertPool = db.prepare(
        'INSERT INTO inventory_pool (size, quantity, units_in_service) VALUES (?, ?, ?)'
      );
      for (const row of grouped) {
        insertPool.run(row.size, row.quantity, row.units_in_service || 0);
      }
      console.log(`[migrations] Migrated ${grouped.length} size group(s) from dumpsters → inventory_pool`);
    }
    db.exec('DROP TABLE dumpsters');
    console.log('[migrations] Dropped legacy dumpsters table');
  }

  // Settings key-value store (used by payment page and SMS service)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Activity timeline — one row per lead touchpoint (calls, SMS, status changes,
  // voicemails, notes). Rows are removed with their lead via ON DELETE CASCADE.
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_lead ON activity_log(lead_id)');

  // One-time backfill from existing leads: each lead gets an inbound_call (or
  // voicemail) entry at its created_at, plus an sms_sent entry for any lead that
  // already had a payment link sent. Guarded on an empty table so re-running
  // migrations never duplicates rows.
  const activityCount = db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
  if (activityCount === 0) {
    const fmtDur = (sec) => {
      const s = Math.round(Number(sec));
      if (!s || s <= 0) return '';
      if (s < 60) return ` (${s}s)`;
      const m = Math.floor(s / 60);
      const r = s % 60;
      return r ? ` (${m}m ${r}s)` : ` (${m}m)`;
    };
    const existingLeads = db.prepare(
      'SELECT id, created_at, call_type, call_duration, transcription_duration_seconds, payment_sms_sent_at FROM leads'
    ).all();
    const insertActivity = db.prepare(
      'INSERT INTO activity_log (lead_id, activity_type, description, created_at) VALUES (?, ?, ?, ?)'
    );
    for (const lead of existingLeads) {
      const dur = fmtDur(lead.call_duration || lead.transcription_duration_seconds);
      if (lead.call_type === 'voicemail') {
        insertActivity.run(lead.id, 'voicemail', `Voicemail received${dur}`, lead.created_at);
      } else {
        insertActivity.run(lead.id, 'inbound_call', `Inbound call received${dur}`, lead.created_at);
      }
      if (lead.payment_sms_sent_at) {
        insertActivity.run(lead.id, 'sms_sent', 'Payment link sent via SMS', lead.payment_sms_sent_at);
      }
    }
    console.log(`[migrations] Backfilled activity_log for ${existingLeads.length} lead(s)`);
  }

  // Stream signups — public lead capture from the joinstream.app marketing site.
  // Rows are inserted unauthenticated by POST /api/signups and read back by the
  // Stream admin dashboard. Intentionally NOT scoped to a business_id: these are
  // top-of-funnel prospects who don't have a tenant yet.
  db.exec(`
    CREATE TABLE IF NOT EXISTS signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT,
      business_name TEXT,
      business_type TEXT,
      phone TEXT,
      email TEXT,
      call_booked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Multi-tenancy foundation (Phase 1) ────────────────────────────────────
  // Purely additive: add a businesses table and a users table, then attach a
  // business_id to every pre-existing table so each row is scoped to a tenant.
  // No existing column is dropped or renamed and no existing route changes.
  // Auth middleware is NOT applied to any route in this phase.

  // One row per tenant. Valley Binz is seeded as row 1 below so all of the
  // existing single-tenant data has a home.
  db.exec(`
    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      owner_first_name TEXT,
      slug TEXT UNIQUE,
      twilio_phone_number TEXT,
      user_phone_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Login accounts, each belonging to one business. password_hash stores a
  // bcrypt hash — never a plaintext password.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id),
      email TEXT UNIQUE,
      password_hash TEXT,
      role TEXT DEFAULT 'owner',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Password-reset columns on users. Additive — same attempt-and-swallow-
  // duplicate pattern as the column blocks below. A reset token is a random hex
  // string with a short expiry; both are cleared once the password is reset.
  const USER_COLUMNS = [
    'ALTER TABLE users ADD COLUMN password_reset_token TEXT',
    'ALTER TABLE users ADD COLUMN password_reset_expires DATETIME',
  ];
  for (const stmt of USER_COLUMNS) {
    try {
      db.exec(stmt);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Stripe subscription billing columns on businesses. Additive — same
  // attempt-and-swallow-duplicate pattern as NEW_COLUMNS. subscription_status
  // values: inactive (default), trialing, active, past_due, canceled.
  // trial_days is set manually by an admin to grant a beta customer a free trial.
  const BILLING_COLUMNS = [
    'ALTER TABLE businesses ADD COLUMN stripe_customer_id TEXT',
    'ALTER TABLE businesses ADD COLUMN stripe_subscription_id TEXT',
    "ALTER TABLE businesses ADD COLUMN subscription_status TEXT DEFAULT 'inactive'",
    'ALTER TABLE businesses ADD COLUMN trial_days INTEGER',
    // When an admin-granted free trial ends (now + trial_days). Nullable; set by
    // the admin panel's "Set Trial" action alongside subscription_status='trialing'.
    'ALTER TABLE businesses ADD COLUMN trial_end_date DATETIME',
  ];
  for (const stmt of BILLING_COLUMNS) {
    try {
      db.exec(stmt);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Signup-flow columns on businesses. Additive — same attempt-and-swallow
  // pattern. industry_type stores the vertical chosen at signup (Dumpster
  // Rental, HVAC, …). owner_last_name carries the last name collected on the
  // signup form. onboarding_complete gates the post-signup dashboard banner
  // (1 once the setup call is done; the banner hides as soon as it flips).
  const SIGNUP_COLUMNS = [
    'ALTER TABLE businesses ADD COLUMN industry_type TEXT',
    'ALTER TABLE businesses ADD COLUMN owner_last_name TEXT',
    'ALTER TABLE businesses ADD COLUMN onboarding_complete INTEGER DEFAULT 0',
  ];
  for (const stmt of SIGNUP_COLUMNS) {
    try {
      db.exec(stmt);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Stripe Connect (Express) columns on businesses — the per-business payments
  // layer that lets a customer pay an invoice on the business's OWN connected
  // account. This is entirely separate from the $149/mo platform SUBSCRIPTION
  // billing above (stripe_customer_id / stripe_subscription_id): different Stripe
  // objects, different code paths (services/connectService.js), different webhook.
  // Additive — same attempt-and-swallow-duplicate pattern.
  //   stripe_connect_account_id  the Express connected account id (acct_…)
  //   connect_charges_enabled    1 once the account can accept charges (gates Pay)
  //   connect_details_submitted  1 once onboarding info was submitted (→ "pending")
  //   connect_payouts_enabled    1 once Stripe will pay out to the bank
  // The three booleans mirror the Stripe Account object and are refreshed from the
  // account.updated webhook and the live status sync.
  const CONNECT_COLUMNS = [
    'ALTER TABLE businesses ADD COLUMN stripe_connect_account_id TEXT',
    'ALTER TABLE businesses ADD COLUMN connect_charges_enabled INTEGER DEFAULT 0',
    'ALTER TABLE businesses ADD COLUMN connect_details_submitted INTEGER DEFAULT 0',
    'ALTER TABLE businesses ADD COLUMN connect_payouts_enabled INTEGER DEFAULT 0',
  ];
  for (const stmt of CONNECT_COLUMNS) {
    try {
      db.exec(stmt);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Attach business_id to every pre-existing table. SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so we reuse the NEW_COLUMNS pattern above:
  // attempt the ALTER and swallow only the "duplicate column name" error, which
  // makes this idempotent across restarts. A column-level REFERENCES is allowed
  // by ALTER TABLE ADD COLUMN because the implicit default is NULL.
  const TENANT_TABLES = ['leads', 'inventory_pool', 'activity_log', 'call_sessions', 'devices', 'settings'];
  for (const table of TENANT_TABLES) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN business_id INTEGER REFERENCES businesses(id)`);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Seed Valley Binz as the first business (business_id = 1) if no matching
  // business exists yet, so all pre-existing data can be attributed to it.
  // Name/owner come from the settings store (values are JSON-encoded) with
  // sensible fallbacks; phone numbers come from the Twilio env vars.
  const readSetting = (key) => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return row.value; }
    } catch {
      return null;
    }
  };

  let valleyBinz = db.prepare("SELECT id FROM businesses WHERE slug = 'valley-binz'").get();
  if (!valleyBinz) {
    const businessName = readSetting('businessName') || 'Valley Binz';
    const ownerFirstName = readSetting('ownerFirstName') || 'Austin';
    const info = db.prepare(`
      INSERT INTO businesses (name, owner_first_name, slug, twilio_phone_number, user_phone_number)
      VALUES (?, ?, 'valley-binz', ?, ?)
    `).run(
      String(businessName),
      String(ownerFirstName),
      process.env.TWILIO_PHONE_NUMBER || null,
      process.env.USER_PHONE_NUMBER || null
    );
    valleyBinz = { id: Number(info.lastInsertRowid) };
    console.log(`[migrations] Seeded business "${businessName}" (slug "valley-binz") as business_id = ${valleyBinz.id}`);
  }
  const valleyBinzId = valleyBinz.id;

  // Backfill: attribute every pre-existing row to Valley Binz. Idempotent —
  // only rows not yet assigned a business_id are touched.
  for (const table of TENANT_TABLES) {
    const result = db.prepare(
      `UPDATE ${table} SET business_id = ? WHERE business_id IS NULL`
    ).run(valleyBinzId);
    console.log(`[migrations] Migration complete — ${Number(result.changes)} rows in "${table}" updated to business_id = ${valleyBinzId}`);
  }

  // ── Multi-tenancy (Phase 2.1): per-business unique constraints ─────────────
  // Swap the global UNIQUE constraints on settings(key) and inventory_pool(size)
  // for composite UNIQUE(business_id, …) so a second tenant's settings keys and
  // inventory sizes no longer collide with Valley Binz's. Each rebuild runs once
  // per database (guarded by hasBusinessScopedUnique) and preserves every
  // existing row — including the business_id values backfilled just above. See
  // the rebuildTableInPlace / hasBusinessScopedUnique helpers above for the
  // safe-rebuild mechanics.
  if (!hasBusinessScopedUnique('settings')) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
    rebuildTableInPlace(
      'settings',
      `CREATE TABLE settings_new (
        key TEXT NOT NULL,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        business_id INTEGER REFERENCES businesses(id),
        UNIQUE(business_id, key)
      )`,
      ['key', 'value', 'updated_at', 'business_id']
    );
    const after = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
    console.log(`[migrations] Rebuilt settings with UNIQUE(business_id, key) — ${after}/${before} rows preserved`);
  }

  if (!hasBusinessScopedUnique('inventory_pool')) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM inventory_pool').get().n;
    // `id` is copied verbatim so leads.assigned_dumpster_id keeps pointing at the
    // same pool rows after the rebuild.
    rebuildTableInPlace(
      'inventory_pool',
      `CREATE TABLE inventory_pool_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        size TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        units_in_service INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        business_id INTEGER REFERENCES businesses(id),
        UNIQUE(business_id, size)
      )`,
      ['id', 'size', 'quantity', 'units_in_service', 'notes', 'created_at', 'updated_at', 'business_id']
    );
    const after = db.prepare('SELECT COUNT(*) AS n FROM inventory_pool').get().n;
    console.log(`[migrations] Rebuilt inventory_pool with UNIQUE(business_id, size) — ${after}/${before} rows preserved`);
  }

  // ── Action Queue cleanup: clear follow-up dates on dead-end leads ──────────
  // Leads the AI flagged as dead ends — "no follow-up needed", "not interested",
  // customer declined — should never carry a follow-up date, or they linger in
  // the dashboard Action Queue. Clear the follow-up date (both the
  // vertical_data.followUpDate that drives the queue and the flat column) and
  // stamp requiresFollowUp=false so the queue's dead-lead filter catches them.
  // They stay in All Leads for the record. Idempotent: only rows that still
  // carry a follow-up date are rewritten, so re-runs are no-ops.
  const DEAD_END_RE = /no follow.?up|not interested|customer declined|\bdeclined\b|went with another|going elsewhere|no further action|won'?t proceed/i;
  const deadCandidates = db.prepare(
    "SELECT id, vertical_data, follow_up_date FROM leads WHERE vertical = 'home_services' AND vertical_data IS NOT NULL"
  ).all();
  const clearDeadFollowUp = db.prepare(
    'UPDATE leads SET vertical_data = ?, follow_up_date = NULL WHERE id = ?'
  );
  let deadCleaned = 0;
  for (const row of deadCandidates) {
    let vd;
    try { vd = JSON.parse(row.vertical_data); } catch { continue; }
    const hasFollowUp = vd.followUpDate != null || row.follow_up_date != null;
    if (!hasFollowUp) continue;
    const isDeadEnd = vd.requiresFollowUp === false || DEAD_END_RE.test(String(vd.aiRecommendation || ''));
    if (!isDeadEnd) continue;
    vd.followUpDate = null;
    vd.requiresFollowUp = false;
    if (!vd.followUpReason) vd.followUpReason = 'Customer not interested — no follow-up needed';
    clearDeadFollowUp.run(JSON.stringify(vd), row.id);
    deadCleaned++;
  }
  if (deadCleaned > 0) {
    console.log(`[migrations] Cleared follow-up date on ${deadCleaned} dead-end home_services lead(s)`);
  }

  // ── Customers: unified person-level record ─────────────────────────────────
  // The system has no customers/opportunities tables — `leads` is the only
  // entity, and "Opportunities"/"Booked"/"Completed" are just filtered views over
  // it. Each call inserts a NEW lead row, so the same person calling twice yields
  // two leads. This block adds a durable person-level record (one row per person
  // per business, deduped by normalized phone) to consolidate those per-call
  // leads into a single customer with a lifecycle status, profile, notes, and a
  // per-client pricing layer.
  //
  // leads stay exactly as they are (the Twilio pipeline that inserts them is
  // untouched). Each lead links to its customer via the new leads.customer_id;
  // customerService.reconcileCustomersForBusiness() keeps new pipeline-inserted
  // leads linked at read time, so no INSERT path — including the off-limits
  // webhook — has to change. Tables are created first so the leads.customer_id
  // foreign key and the backfill below have something to reference.

  // One row per customer (person) per business. normalized_phone (digits only,
  // US-normalized) is the dedupe key; multiple NULLs are allowed (SQLite treats
  // them as distinct), so anonymous/no-phone leads each get their own record
  // rather than collapsing into one. status is derived from the customer's jobs
  // but can be overridden by the owner (status_overridden = 1 freezes it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id),
      first_name TEXT,
      last_name TEXT,
      display_name TEXT,
      company TEXT,
      phone TEXT,
      normalized_phone TEXT,
      email TEXT,
      address TEXT,
      status TEXT DEFAULT 'lead',
      status_overridden INTEGER DEFAULT 0,
      discount_group_id INTEGER,
      contract_terms TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_business_phone ON customers(business_id, normalized_phone)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id)');

  // Per-client pricing layer (all business_id-scoped, ready for quotes/invoices
  // to consume later — invoicing itself is out of scope here):
  //   price_list_items  — the business's default/retail price list, keyed by a
  //                        free-form service_key (e.g. a dumpster size "20yd").
  //   discount_groups   — named groups (Contractor, Commercial) with a percent
  //                        discount + optional default net terms.
  //   customer_pricing  — per-customer rate overrides that win over the default.
  // A customer references a discount_group via customers.discount_group_id and
  // carries free-text contract_terms that auto-apply to its quotes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id),
      service_key TEXT NOT NULL,
      label TEXT,
      unit TEXT,
      unit_price REAL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_price_list_business_key ON price_list_items(business_id, service_key)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS discount_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id),
      name TEXT NOT NULL,
      discount_percent REAL NOT NULL DEFAULT 0,
      default_net_terms TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_discount_groups_business ON discount_groups(business_id)');

  // customer_pricing rows are removed with their customer (ON DELETE CASCADE).
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      service_key TEXT NOT NULL,
      label TEXT,
      unit TEXT,
      custom_price REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_pricing_unique ON customer_pricing(customer_id, service_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_customer_pricing_business ON customer_pricing(business_id)');

  // Link column on leads. Additive — same attempt-and-swallow-duplicate pattern.
  // ON DELETE SET NULL so deleting a customer never deletes its call records; the
  // orphaned leads simply get re-linked (or re-create the customer) on the next
  // reconcile pass.
  try {
    db.exec('ALTER TABLE leads ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL');
  } catch (e) {
    if (!e.message.includes('duplicate column name')) throw e;
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads(customer_id)');

  // Backfill: group every existing lead into a customer record by normalized
  // phone and set leads.customer_id. Idempotent — reconcile only touches leads
  // that aren't linked yet — so re-running migrations never duplicates customers.
  // Delegated to customerService so the migration backfill and the runtime
  // reconcile share one implementation. Required lazily, after the tables exist.
  try {
    const { backfillAllCustomers } = require('../services/customerService');
    const linked = backfillAllCustomers();
    if (linked > 0) {
      console.log(`[migrations] Linked ${linked} lead(s) to customer records`);
    }
  } catch (e) {
    console.error('[migrations] Customer backfill failed (non-fatal):', e.message);
  }

  // ── Invoices: customer-facing invoice + contract + e-signature ─────────────
  // A generic invoice entity (business_id-scoped) layered over the customers/leads
  // model. Line items are deliberately generic — description + qty + unit + rate +
  // amount with a free-form line_type — so the same schema serves any service
  // business; dumpster-specific concepts (e.g. a weight overage) are just a
  // line_type, never a column. Default rates are pulled from the per-client pricing
  // layer when an invoice is drafted (see invoiceService.prefill) and COPIED onto
  // the line item, so an issued invoice is an immutable snapshot. The customer
  // reviews + signs via a tokenized public link (public_token) with no login; the
  // captured signature + full name + timestamp + IP/User-Agent are stored on the
  // invoice as dispute evidence, alongside a snapshot of the exact terms signed.
  // Payment collection is a separate, later task — paid_at / payment_method /
  // payment_reference are the placeholder columns and stay null until then.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id),
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      invoice_number TEXT,
      status TEXT DEFAULT 'draft',
      public_token TEXT UNIQUE,
      issue_date TEXT,
      due_date TEXT,
      currency TEXT DEFAULT 'USD',
      subtotal REAL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      amount_paid REAL DEFAULT 0,
      notes TEXT,
      terms TEXT,
      bill_to_name TEXT,
      bill_to_email TEXT,
      bill_to_phone TEXT,
      bill_to_address TEXT,
      sent_at TEXT,
      viewed_at TEXT,
      signed_at TEXT,
      signer_name TEXT,
      signature_type TEXT,
      signature_data TEXT,
      signed_terms TEXT,
      signer_ip TEXT,
      signer_user_agent TEXT,
      paid_at TEXT,
      payment_method TEXT,
      payment_reference TEXT,
      stripe_payment_intent_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Online payment (Stripe Connect direct charge) correlation id. Stored when the
  // customer starts a card payment so the Connect webhook / confirm endpoint can
  // find this exact invoice from a PaymentIntent and flip it to paid idempotently.
  // Additive ALTER for DBs created before online payments existed.
  try {
    db.exec('ALTER TABLE invoices ADD COLUMN stripe_payment_intent_id TEXT');
  } catch (e) {
    if (!e.message.includes('duplicate column name')) throw e;
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_business ON invoices(business_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_lead ON invoices(lead_id)');
  // SQLite treats NULLs as distinct in a UNIQUE index, but every invoice is issued
  // with a token, so this enforces a single owner per public link.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_token ON invoices(public_token)');

  // Line items belong to one invoice and are removed with it (ON DELETE CASCADE).
  // business_id is denormalized for scoping convenience / defense-in-depth.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      business_id INTEGER REFERENCES businesses(id),
      description TEXT,
      service_key TEXT,
      line_type TEXT DEFAULT 'service',
      quantity REAL DEFAULT 1,
      unit TEXT,
      unit_rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice ON invoice_line_items(invoice_id)');

  // ── SMS compliance pages: per-customer policy fields ───────────────────────
  // Public privacy + SMS terms pages (served at /c/:slug/privacy and /c/:slug/terms
  // by routes/policyPages.js) render every customer from their `businesses` row for
  // A2P 10DLC carrier review. The slug already lives on businesses; these columns
  // add the remaining fields the templates need. Additive — same
  // attempt-and-swallow-duplicate pattern as the column blocks above.
  //   service               plain lowercase noun phrase, e.g. "dumpster rental"
  //   contact_email         public contact email shown on the policy pages
  //   contact_phone         public display phone, e.g. "(815) 503-0701"
  //   policy_effective_date ISO date the policy took effect (stored at signup)
  //   state                 governing-law state for the Terms, e.g. "Illinois"
  //   processor             payment processor named in the copy, e.g. "Stripe"
  const POLICY_COLUMNS = [
    'ALTER TABLE businesses ADD COLUMN service TEXT',
    'ALTER TABLE businesses ADD COLUMN contact_email TEXT',
    'ALTER TABLE businesses ADD COLUMN contact_phone TEXT',
    'ALTER TABLE businesses ADD COLUMN policy_effective_date TEXT',
    'ALTER TABLE businesses ADD COLUMN state TEXT',
    'ALTER TABLE businesses ADD COLUMN processor TEXT',
  ];
  for (const stmt of POLICY_COLUMNS) {
    try {
      db.exec(stmt);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Every Stream customer is billed through Stripe, so default the processor for
  // any business that doesn't have one set. COALESCE keeps it idempotent and never
  // overwrites a value an owner has customized.
  db.prepare("UPDATE businesses SET processor = COALESCE(processor, 'Stripe')").run();

  // Seed Valley Binz's policy fields (the first customer). COALESCE so this only
  // fills values that are still NULL — idempotent across restarts and never
  // clobbers a value the owner later edits.
  db.prepare(`
    UPDATE businesses SET
      service = COALESCE(service, 'dumpster rental'),
      contact_email = COALESCE(contact_email, 'valleybinz@gmail.com'),
      contact_phone = COALESCE(contact_phone, '(815) 503-0701'),
      policy_effective_date = COALESCE(policy_effective_date, '2026-06-23'),
      state = COALESCE(state, 'Illinois'),
      processor = COALESCE(processor, 'Stripe')
    WHERE slug = 'valley-binz'
  `).run();

  console.log('Database migrations completed successfully.');
}

try {
  runMigrations();
} catch (err) {
  console.error('[migrations] Migration failed:', err.message);
  throw err;
}

module.exports = { runMigrations };
