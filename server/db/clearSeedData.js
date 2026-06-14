// CLEANUP UTILITY — run with: node server/db/clearSeedData.js
//
// Deletes every fake seed lead created by seedTestData.js. Seed leads are
// tagged with a "_seed" marker in their vertical_data, so this only removes
// test data and never touches real/untagged leads.
//
// This script DOES NOT modify Auto Dealer leads, Twilio, recording, or caller ID.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const db = require('./database');
const { initDatabase } = require('./database');

function main() {
  initDatabase();

  const info = db
    .prepare(`DELETE FROM leads WHERE vertical_data LIKE ?`)
    .run('%_seed%');

  const deleted = Number(info.changes);
  console.log(`[clear-seed] Deleted ${deleted} seed lead(s).`);
  process.exit(0);
}

main();
