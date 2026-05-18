/**
 * Migration 003: Add last_checked timestamp to sites
 * Records when a collector last visited the site (regardless of outcome).
 * Used by the dashboard to suppress "ready to collect" for sites already
 * checked today.
 */

'use strict';

function up(db) {
  try {
    db.exec('ALTER TABLE sites ADD COLUMN last_checked TEXT DEFAULT NULL');
  } catch (err) {
    // Column already exists
  }
  console.log('  Added last_checked to sites');
}

function down(db) {
  db.exec('UPDATE sites SET last_checked = NULL');
}

module.exports = { up, down };
