/**
 * Migration 004: Add pinned flag to sites
 * Marks a site as "pinned" so the tracker surfaces it in the focus strip.
 * Hard cap of 4 pinned sites enforced at the API layer.
 */

'use strict';

function up(db) {
  try {
    db.prepare('ALTER TABLE sites ADD COLUMN pinned INTEGER DEFAULT 0').run();
  } catch (err) {
    // Column already exists
  }
  console.log('  Added pinned to sites');
}

function down(db) {
  db.prepare('UPDATE sites SET pinned = 0').run();
}

module.exports = { up, down };
