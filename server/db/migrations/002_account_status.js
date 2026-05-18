/**
 * Migration 002: Add per-site account state columns
 * - account_status: null | 'registered' | 'kyc_done'
 * - welcome_bonus_claimed: 0 | 1
 * - is_starter: 0 | 1 (high daily earner, shown in onboarding wizard)
 */

'use strict';

function up(db) {
  // Add new columns (safe with try/catch -- column may exist if re-running)
  const columns = [
    'ALTER TABLE sites ADD COLUMN account_status TEXT DEFAULT NULL',
    'ALTER TABLE sites ADD COLUMN welcome_bonus_claimed INTEGER DEFAULT 0',
    'ALTER TABLE sites ADD COLUMN is_starter INTEGER DEFAULT 0',
  ];

  for (const sql of columns) {
    try {
      db.exec(sql);
    } catch (err) {
      // Column already exists -- fine
    }
  }

  // Mark starter sites by canonical ID slugs
  const starterIds = [
    'spinblitz',
    'spinquest',
    'stake',
    'luckyland',
    'chumba',
    'mcluck',
    'crown-coins',
  ];

  const markStarter = db.prepare('UPDATE sites SET is_starter = 1 WHERE id = ?');
  for (const id of starterIds) {
    markStarter.run(id);
  }

  // Also check by name variants in case slugs differ
  const nameVariants = [
    'SpinBlitz',
    'SpinQuest',
    'Stake',
    'Stake.us',
    'LuckyLand',
    'LuckyLand Slots',
    'Chumba',
    'McLuck',
    'Crown Coins',
    'SweepJungle',
  ];

  const markByName = db.prepare(
    'UPDATE sites SET is_starter = 1 WHERE LOWER(name) = LOWER(?)'
  );
  for (const name of nameVariants) {
    markByName.run(name);
  }

  console.log('  Added account_status, welcome_bonus_claimed, is_starter to sites');
  console.log('  Marked starter sites');
}

function down(db) {
  // SQLite does not support DROP COLUMN -- just zero out the data
  db.exec('UPDATE sites SET account_status = NULL, welcome_bonus_claimed = 0, is_starter = 0');
}

module.exports = { up, down };
