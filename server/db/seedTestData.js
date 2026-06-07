// TEST DATA ONLY — run with: node server/db/seedTestData.js
//
// Populates the database with realistic fake Home Services (dumpster rental)
// leads + inventory for Valley Binz (business_id = 1) so the dashboard can be
// exercised end to end: Action Queue, Morning Brief, revenue tile, schedule,
// opportunities, and history.
//
// SAFE TO RE-RUN: every seeded lead is tagged with a marker in its
// vertical_data (_seed = "TEST_DATA_VALLEY_BINZ"). If any tagged lead already
// exists for the business the lead inserts are skipped. Inventory is upserted
// idempotently on every run. No real/untagged leads are ever touched.
//
// This script DOES NOT modify Auto Dealer leads, Twilio, recording, or caller ID.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const db = require('./database');
const { initDatabase } = require('./database');

const BUSINESS_ID = 1;
const SEED_TAG = 'TEST_DATA_VALLEY_BINZ';

// ── date helpers ────────────────────────────────────────────────────────────
const NOW = new Date();

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(base, n) {
  const c = new Date(base);
  c.setDate(c.getDate() + n);
  return c;
}
function addHours(base, n) {
  const c = new Date(base);
  c.setHours(c.getHours() + n);
  return c;
}
// Full ISO timestamp (UTC, with Z) — parsed unambiguously by the dashboard.
function ts(d) {
  return d.toISOString();
}
// Add N calendar days to a YYYY-MM-DD string → YYYY-MM-DD (mirrors inventoryService).
function addDaysISO(isoDateStr, days) {
  const d = new Date(isoDateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function rentalDays(str) {
  const s = String(str).toLowerCase();
  const num = parseFloat(s);
  if (Number.isNaN(num)) return 7;
  if (s.includes('week')) return Math.round(num * 7);
  if (s.includes('month')) return Math.round(num * 30);
  return Math.round(num);
}

const TODAY = isoDate(NOW);
const TOMORROW = isoDate(addDays(NOW, 1));
const IN_2_DAYS = isoDate(addDays(NOW, 2));
const IN_4_DAYS = isoDate(addDays(NOW, 4));
const NEXT_WEEK = isoDate(addDays(NOW, 7));

// ── lead builder ────────────────────────────────────────────────────────────
// Build a leads-row object. `vd` holds the camelCase vertical_data the Home
// Services dashboard reads (see client/src/utils/verticalConfig.js field packs).
function buildLead({
  firstName,
  phone,
  status = 'new',
  jobStatus = 'inquiry',
  callType = null,
  createdDaysAgo = 0,
  createdHoursAgo = 0,
  updatedDaysAgo = null,
  deliveryDate = null,
  pickupDate = null,
  estimatedRevenue = null,
  paidDaysAgo = null,
  paymentSmsSentDaysAgo = null,
  internalNotes = null,
  vd = {},
}) {
  const createdAt = createdHoursAgo
    ? addHours(NOW, -createdHoursAgo)
    : addDays(NOW, -createdDaysAgo);
  const updatedAt = updatedDaysAgo != null ? addDays(NOW, -updatedDaysAgo) : createdAt;

  const verticalData = {
    customerName: firstName,
    _seed: SEED_TAG,
    ...vd,
    job_status: jobStatus,
  };

  return {
    extraction_type: 'phone_auto',
    status,
    vertical: 'home_services',
    sub_vertical: 'dumpster_rental',
    source: 'phone',
    job_status: jobStatus,
    call_type: callType,
    auto_captured: 1,
    discarded: 0,
    confidence: 85,
    business_id: BUSINESS_ID,

    customer_first_name: firstName,
    phone,

    delivery_date: deliveryDate,
    pickup_date: pickupDate,
    estimated_revenue: estimatedRevenue,
    paid_at: paidDaysAgo != null ? ts(addDays(NOW, -paidDaysAgo)) : null,
    payment_sms_sent_at:
      paymentSmsSentDaysAgo != null ? ts(addDays(NOW, -paymentSmsSentDaysAgo)) : null,
    internal_notes: internalNotes,

    created_at: ts(createdAt),
    updated_at: ts(updatedAt),
    vertical_data: JSON.stringify(verticalData),
  };
}

// Convenience: build a booked/scheduled job with delivery + pickup + revenue.
function bookedJob(opts) {
  const { deliveryDate, rentalDuration, price } = opts;
  const pickupDate = addDaysISO(deliveryDate, rentalDays(rentalDuration));
  return buildLead({
    ...opts,
    deliveryDate,
    pickupDate,
    estimatedRevenue: price,
    vd: {
      dumpsterSize: opts.dumpsterSize,
      debrisType: opts.debrisType,
      deliveryDate,
      deliveryDateISO: deliveryDate,
      rawDeliveryDate: opts.rawDeliveryDate || deliveryDate,
      pickupDate,
      rentalDuration,
      deliveryAddress: opts.deliveryAddress,
      permitNeeded: opts.permitNeeded ?? false,
      quotedPrice: `$${price}`,
      paymentStatus: opts.paidDaysAgo != null ? 'paid' : 'awaiting payment',
      estimatedRevenue: price,
      intentLevel: opts.intentLevel || 'high',
      urgency: opts.urgency || 'This Week',
      outcome: 'booked',
      ...(opts.extraVd || {}),
    },
  });
}

// ── the seed leads ──────────────────────────────────────────────────────────
const LEADS = [
  // ───── ACTION QUEUE: inventory conflict ─────
  buildLead({
    firstName: 'Karen',
    phone: '815-555-0142',
    status: 'new',
    jobStatus: 'opportunity',
    createdHoursAgo: 2,
    internalNotes: `AUTO-BOOK BLOCKED: No 20 yard available for ${TOMORROW}. Customer needs to be contacted to reschedule.`,
    vd: {
      dumpsterSize: '20 yard',
      debrisType: 'construction debris',
      deliveryDate: TOMORROW,
      rawDeliveryDate: 'tomorrow',
      rentalDuration: '10 days',
      deliveryAddress: '745 First St, LaSalle, IL 61301',
      quotedPrice: '$545',
      paymentStatus: 'blocked',
      estimatedRevenue: 545,
      intentLevel: 'high',
      urgency: 'ASAP',
      outcome: 'quote_sent',
      autoBooked: false,
      bookingConfidence: 'possible',
      inventoryConflict: true,
      followUpDate: ts(NOW),
      followUpReason: 'Inventory conflict — call customer immediately to reschedule',
      aiRecommendation: `INVENTORY CONFLICT — Customer agreed to book a 20 yard dumpster for ${TOMORROW} but no units are available. Call customer immediately to reschedule.`,
    },
  }),

  // ───── ACTION QUEUE: voicemail awaiting callback ─────
  buildLead({
    firstName: 'Greg',
    phone: '815-555-0173',
    status: 'new',
    jobStatus: 'inquiry',
    callType: 'voicemail',
    createdHoursAgo: 6,
    vd: {
      dumpsterSize: '15 yard',
      debrisType: 'household junk',
      rawDeliveryDate: 'sometime next week',
      rentalDuration: '7 days',
      intentLevel: 'warm',
      urgency: 'Next Week',
    },
  }),

  // ───── BOOKED JOBS (spread across today → next week) ─────
  // Today — delivering today, payment still outstanding (at-risk action item).
  bookedJob({
    firstName: 'Mike',
    phone: '815-555-0108',
    status: 'booked',
    jobStatus: 'booked',
    createdDaysAgo: 5,
    updatedDaysAgo: 3,
    deliveryDate: TODAY,
    dumpsterSize: '20 yard',
    debrisType: 'construction debris',
    deliveryAddress: '1015 Marquette St, LaSalle, IL 61301',
    rentalDuration: '7 days',
    price: 545,
    paymentSmsSentDaysAgo: 1, // link sent, not yet paid
    intentLevel: 'high',
    urgency: 'ASAP',
    permitNeeded: false,
  }),
  // Tomorrow — paid.
  bookedJob({
    firstName: 'Sarah',
    phone: '815-555-0119',
    status: 'booked',
    jobStatus: 'scheduled',
    createdDaysAgo: 6,
    updatedDaysAgo: 4,
    deliveryDate: TOMORROW,
    dumpsterSize: '15 yard',
    debrisType: 'household junk',
    deliveryAddress: '1521 4th St, Peru, IL 61354',
    rentalDuration: '10 days',
    price: 475,
    paidDaysAgo: 4,
    intentLevel: 'high',
    urgency: 'This Week',
  }),
  // In 2 days — paid.
  bookedJob({
    firstName: 'Tom',
    phone: '815-555-0124',
    status: 'booked',
    jobStatus: 'booked',
    createdDaysAgo: 4,
    updatedDaysAgo: 2,
    deliveryDate: IN_2_DAYS,
    dumpsterSize: '10 yard',
    debrisType: 'yard waste',
    deliveryAddress: '200 E St Paul St, Spring Valley, IL 61362',
    rentalDuration: '7 days',
    price: 445,
    paidDaysAgo: 2,
    intentLevel: 'high',
    urgency: 'This Week',
  }),
  // In 4 days — payment pending.
  bookedJob({
    firstName: 'Jennifer',
    phone: '815-555-0137',
    status: 'booked',
    jobStatus: 'booked',
    createdDaysAgo: 3,
    updatedDaysAgo: 1,
    deliveryDate: IN_4_DAYS,
    dumpsterSize: '20 yard',
    debrisType: 'remodel debris',
    deliveryAddress: '411 La Salle St, Ottawa, IL 61350',
    rentalDuration: '14 days',
    price: 545,
    paymentSmsSentDaysAgo: 1,
    intentLevel: 'high',
    urgency: 'This Week',
  }),
  // Next week — paid.
  bookedJob({
    firstName: 'Dave',
    phone: '815-555-0151',
    status: 'booked',
    jobStatus: 'scheduled',
    createdDaysAgo: 2,
    updatedDaysAgo: 1,
    deliveryDate: NEXT_WEEK,
    dumpsterSize: '15 yard',
    debrisType: 'roofing shingles',
    deliveryAddress: '110 Mill St, Utica, IL 61373',
    rentalDuration: '1 week',
    price: 495,
    paidDaysAgo: 1,
    intentLevel: 'high',
    urgency: 'Next Week',
  }),

  // ───── TODAY'S SCHEDULE: drops, pickups, and an active rental ─────
  // These exercise the dashboard's "Today's Schedule" panel, which derives the
  // badge from dates + status (see HomeServicesDashboard.jsx):
  //   • DROP   = delivery_date === today      (time from vd.deliveryTime)
  //   • PICK   = pickup_date === today        (time from vd.pickupTime)
  //   • ACTIVE = delivered before today, picked up after today, AND
  //              job_status is 'delivered' / 'active_rental'
  // So PICK jobs carry a PAST delivery_date (else they'd also count as a DROP),
  // and the ACTIVE rental uses job_status 'active_rental' (a 'booked' mid-rental
  // job is never rendered as ACTIVE).

  // DROP #1 — delivering today at 8:00 AM.
  bookedJob({
    firstName: 'Carlos',
    phone: '815-555-0201',
    status: 'booked',
    jobStatus: 'booked',
    createdDaysAgo: 3,
    updatedDaysAgo: 2,
    deliveryDate: TODAY,
    dumpsterSize: '15 yard',
    debrisType: 'household junk',
    deliveryAddress: '525 Gooding St, LaSalle, IL 61301',
    rentalDuration: '7 days',
    price: 475,
    paidDaysAgo: 2,
    intentLevel: 'high',
    urgency: 'This Week',
    extraVd: { deliveryTime: '8:00 AM' },
  }),
  // DROP #2 — delivering today at 11:00 AM.
  bookedJob({
    firstName: 'Diane',
    phone: '815-555-0212',
    status: 'booked',
    jobStatus: 'booked',
    createdDaysAgo: 4,
    updatedDaysAgo: 2,
    deliveryDate: TODAY,
    dumpsterSize: '20 yard',
    debrisType: 'remodel debris',
    deliveryAddress: '415 W Dakota St, Spring Valley, IL 61362',
    rentalDuration: '14 days',
    price: 545,
    paymentSmsSentDaysAgo: 1,
    intentLevel: 'high',
    urgency: 'This Week',
    extraVd: { deliveryTime: '11:00 AM' },
  }),
  // PICK #1 — picked up today at 1:00 PM (delivered 7 days ago).
  bookedJob({
    firstName: 'Frank',
    phone: '815-555-0223',
    status: 'booked',
    jobStatus: 'booked',
    createdDaysAgo: 9,
    updatedDaysAgo: 7,
    deliveryDate: addDaysISO(TODAY, -7),
    dumpsterSize: '10 yard',
    debrisType: 'yard waste',
    deliveryAddress: '1015 Shooting Park Rd, Peru, IL 61354',
    rentalDuration: '7 days',
    price: 445,
    paidDaysAgo: 7,
    intentLevel: 'high',
    urgency: 'This Week',
    extraVd: { pickupTime: '1:00 PM' },
  }),
  // PICK #2 — picked up today at 3:30 PM (delivered 10 days ago).
  bookedJob({
    firstName: 'Wendy',
    phone: '815-555-0234',
    status: 'booked',
    jobStatus: 'booked',
    createdDaysAgo: 12,
    updatedDaysAgo: 10,
    deliveryDate: addDaysISO(TODAY, -10),
    dumpsterSize: '20 yard',
    debrisType: 'construction debris',
    deliveryAddress: '612 Columbus St, Ottawa, IL 61350',
    rentalDuration: '10 days',
    price: 525,
    paidDaysAgo: 10,
    intentLevel: 'high',
    urgency: 'This Week',
    extraVd: { pickupTime: '3:30 PM' },
  }),
  // ACTIVE rental — delivered yesterday, on-site today, picked up tomorrow.
  bookedJob({
    firstName: 'Hector',
    phone: '815-555-0245',
    status: 'booked',
    jobStatus: 'active_rental',
    createdDaysAgo: 3,
    updatedDaysAgo: 1,
    deliveryDate: addDaysISO(TODAY, -1),
    dumpsterSize: '10 yard',
    debrisType: 'household junk',
    deliveryAddress: '220 Church St, Utica, IL 61373',
    rentalDuration: '2 days',
    price: 455,
    paidDaysAgo: 1,
    intentLevel: 'high',
    urgency: 'This Week',
  }),

  // ───── HOT OPPORTUNITIES (high intent, quoted, not booked) ─────
  buildLead({
    firstName: 'Amanda',
    phone: '815-555-0160',
    status: 'new',
    jobStatus: 'opportunity',
    createdDaysAgo: 1,
    vd: {
      dumpsterSize: '15 yard',
      debrisType: 'household junk',
      rawDeliveryDate: 'this week',
      rentalDuration: '10 days',
      deliveryAddress: '2401 Marquette Rd, Peru, IL 61354',
      quotedPrice: '$495',
      paymentStatus: 'quote sent',
      intentLevel: 'high',
      urgency: 'This Week',
      outcome: 'quote_sent',
      followUpDate: TOMORROW,
      followUpReason: 'Confirm delivery date and lock in the booking',
      aiRecommendation: 'High intent — quoted $495 but no delivery date set. Call to confirm the date and book.',
    },
  }),
  buildLead({
    firstName: 'Steve',
    phone: '815-555-0166',
    status: 'new',
    jobStatus: 'opportunity',
    createdHoursAgo: 3,
    vd: {
      dumpsterSize: '20 yard',
      debrisType: 'construction debris',
      rawDeliveryDate: 'as soon as possible',
      rentalDuration: '14 days',
      deliveryAddress: '820 Clinton St, Ottawa, IL 61350',
      quotedPrice: '$525',
      paymentStatus: 'quote sent',
      intentLevel: 'high',
      urgency: 'ASAP',
      outcome: 'quote_sent',
      followUpDate: ts(NOW),
      followUpReason: 'Customer needs it ASAP — close the booking today',
      aiRecommendation: 'ASAP job quoted at $525 — call back today before the customer shops around.',
    },
  }),
  buildLead({
    firstName: 'Nicole',
    phone: '815-555-0178',
    status: 'new',
    jobStatus: 'opportunity',
    createdDaysAgo: 2,
    vd: {
      dumpsterSize: '10 yard',
      debrisType: 'yard waste',
      rawDeliveryDate: 'next week',
      rentalDuration: '7 days',
      deliveryAddress: 'Greenwood St, Spring Valley, IL 61362',
      quotedPrice: '$455',
      paymentStatus: 'quote sent',
      intentLevel: 'high',
      urgency: 'Next Week',
      outcome: 'quote_sent',
      followUpDate: TODAY,
      followUpReason: 'Scheduled callback due today',
      aiRecommendation: 'Follow-up due today — quoted $455, customer asked for a call back.',
    },
  }),

  // ───── WARM LEADS (called, need follow up) ─────
  buildLead({
    firstName: 'Jim',
    phone: '815-555-0183',
    status: 'needs_follow_up',
    jobStatus: 'opportunity',
    createdDaysAgo: 4,
    updatedDaysAgo: 3,
    vd: {
      dumpsterSize: '20 yard',
      debrisType: 'remodel debris',
      rentalDuration: '14 days',
      quotedPrice: '$535',
      paymentStatus: 'thinking it over',
      intentLevel: 'warm',
      urgency: 'Flexible',
      outcome: 'quote_sent',
      followUpDate: isoDate(addDays(NOW, 3)),
      followUpReason: 'Customer comparing quotes — check back in a few days',
    },
  }),
  buildLead({
    firstName: 'Patricia',
    phone: '815-555-0190',
    status: 'waiting_on_customer',
    jobStatus: 'opportunity',
    createdDaysAgo: 6,
    updatedDaysAgo: 4,
    vd: {
      dumpsterSize: '15 yard',
      debrisType: 'household junk',
      rentalDuration: '7 days',
      quotedPrice: '$475',
      paymentStatus: 'checking with spouse',
      intentLevel: 'warm',
      urgency: 'Flexible',
      outcome: 'quote_sent',
      followUpDate: isoDate(addDays(NOW, 5)),
      followUpReason: 'Waiting on customer to confirm dates',
    },
  }),
  buildLead({
    firstName: 'Rick',
    phone: '815-555-0195',
    status: 'needs_follow_up',
    jobStatus: 'opportunity',
    createdDaysAgo: 7,
    updatedDaysAgo: 5,
    vd: {
      dumpsterSize: '15 yard',
      debrisType: 'concrete',
      rentalDuration: '10 days',
      quotedPrice: '$510',
      paymentStatus: 'quote sent',
      intentLevel: 'warm',
      urgency: 'This Week',
      outcome: 'quote_sent',
      followUpDate: isoDate(addDays(NOW, 2)),
      followUpReason: 'Asked about weight limit for concrete — follow up with answer',
    },
  }),

  // ───── COMPLETED JOBS (history / revenue) ─────
  (() => {
    const delivery = isoDate(addDays(NOW, -10));
    const pickup = addDaysISO(delivery, 7);
    return buildLead({
      firstName: 'Linda',
      phone: '815-555-0102',
      status: 'booked',
      jobStatus: 'completed',
      createdDaysAgo: 14,
      updatedDaysAgo: 3,
      deliveryDate: delivery,
      pickupDate: pickup,
      estimatedRevenue: 545,
      paidDaysAgo: 11,
      vd: {
        dumpsterSize: '20 yard',
        debrisType: 'remodel debris',
        deliveryDate: delivery,
        deliveryDateISO: delivery,
        pickupDate: pickup,
        rentalDuration: '7 days',
        deliveryAddress: '230 Joliet St, LaSalle, IL 61301',
        quotedPrice: '$545',
        paymentStatus: 'paid',
        estimatedRevenue: 545,
        intentLevel: 'high',
        urgency: 'This Week',
        outcome: 'completed',
      },
    });
  })(),
  (() => {
    const delivery = isoDate(addDays(NOW, -14));
    const pickup = addDaysISO(delivery, 7);
    return buildLead({
      firstName: 'Brian',
      phone: '815-555-0114',
      status: 'booked',
      jobStatus: 'completed',
      createdDaysAgo: 18,
      updatedDaysAgo: 7,
      deliveryDate: delivery,
      pickupDate: pickup,
      estimatedRevenue: 445,
      paidDaysAgo: 15,
      vd: {
        dumpsterSize: '10 yard',
        debrisType: 'yard waste',
        deliveryDate: delivery,
        deliveryDateISO: delivery,
        pickupDate: pickup,
        rentalDuration: '7 days',
        deliveryAddress: 'Clark St, Utica, IL 61373',
        quotedPrice: '$445',
        paymentStatus: 'paid',
        estimatedRevenue: 445,
        intentLevel: 'high',
        urgency: 'Flexible',
        outcome: 'completed',
      },
    });
  })(),

  // ───── COLD LEAD (going stale — 12 days, never contacted) ─────
  buildLead({
    firstName: 'Megan',
    phone: '815-555-0188',
    status: 'new',
    jobStatus: 'inquiry',
    createdDaysAgo: 12,
    vd: {
      dumpsterSize: '10 yard',
      debrisType: 'household junk',
      rawDeliveryDate: 'no rush',
      rentalDuration: '7 days',
      intentLevel: 'cold',
      urgency: 'Flexible',
    },
  }),
];

// ── inventory pool ──────────────────────────────────────────────────────────
const INVENTORY = [
  { size: '10 yard', quantity: 1 },
  { size: '15 yard', quantity: 2 },
  { size: '20 yard', quantity: 2 },
];

function upsertInventory() {
  const stmt = db.prepare(`
    INSERT INTO inventory_pool (business_id, size, quantity, units_in_service, updated_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(business_id, size)
    DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at
  `);
  for (const item of INVENTORY) {
    stmt.run(BUSINESS_ID, item.size, item.quantity, ts(NOW));
  }
  const total = INVENTORY.reduce((n, i) => n + i.quantity, 0);
  console.log(`[seed] Inventory upserted for business ${BUSINESS_ID}: ` +
    INVENTORY.map((i) => `${i.quantity}× ${i.size}`).join(', ') + ` (${total} units total)`);
}

function insertLead(data) {
  const fields = Object.keys(data);
  const placeholders = fields.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO leads (${fields.join(', ')}) VALUES (${placeholders})`
  );
  const info = stmt.run(...fields.map((f) => data[f]));
  return Number(info.lastInsertRowid);
}

function logActivity(leadId, lead) {
  const type = lead.call_type === 'voicemail' ? 'voicemail' : 'inbound_call';
  const desc = type === 'voicemail' ? 'Voicemail received' : 'Inbound call received';
  db.prepare(
    'INSERT INTO activity_log (lead_id, activity_type, description, created_at) VALUES (?, ?, ?, ?)'
  ).run(leadId, type, desc, lead.created_at);
}

function main() {
  initDatabase();
  // Ensure all tables exist + Valley Binz (business 1) is seeded. Idempotent.
  require('./migrations');

  const business = db.prepare('SELECT id, name FROM businesses WHERE id = ?').get(BUSINESS_ID);
  if (!business) {
    console.error(`[seed] No business with id ${BUSINESS_ID} found — start the server once so migrations seed Valley Binz, then retry.`);
    process.exit(1);
  }

  // Inventory is idempotent — always reconcile it to the desired counts.
  upsertInventory();

  // Guard the lead inserts: bail if tagged test data is already present.
  const existing = db.prepare(
    `SELECT COUNT(*) AS n FROM leads WHERE business_id = ? AND vertical_data LIKE ?`
  ).get(BUSINESS_ID, `%${SEED_TAG}%`).n;

  if (existing > 0) {
    console.log(`[seed] ${existing} tagged test lead(s) already exist for "${business.name}" (business_id ${BUSINESS_ID}). Skipping lead inserts.`);
    console.log('[seed] Done — no duplicate leads created.');
    process.exit(0);
  }

  db.exec('BEGIN');
  try {
    let inserted = 0;
    for (const lead of LEADS) {
      const id = insertLead(lead);
      logActivity(id, lead);
      inserted++;
    }
    db.exec('COMMIT');
    console.log(`[seed] Inserted ${inserted} test lead(s) for "${business.name}" (business_id ${BUSINESS_ID}).`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Quick breakdown so the run output is self-documenting.
  const byStatus = db.prepare(
    `SELECT job_status, COUNT(*) AS n FROM leads
     WHERE business_id = ? AND vertical_data LIKE ?
     GROUP BY job_status ORDER BY n DESC`
  ).all(BUSINESS_ID, `%${SEED_TAG}%`);
  console.log('[seed] Breakdown by job_status:');
  for (const r of byStatus) console.log(`         ${r.job_status}: ${r.n}`);

  console.log('');
  console.log('[seed] Done. Delivery dates landed on:');
  console.log(`         today      ${TODAY}`);
  console.log(`         tomorrow   ${TOMORROW}`);
  console.log(`         +2 days    ${IN_2_DAYS}`);
  console.log(`         +4 days    ${IN_4_DAYS}`);
  console.log(`         next week  ${NEXT_WEEK}`);
  process.exit(0);
}

main();
