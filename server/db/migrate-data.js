/**
 * Data Migration Utility
 * Migrates existing JSON data to SQLite ledger
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { db, runMigrations } = require('./index');
const sitesRepo = require('./repositories/sites');
const ledgerRepo = require('./repositories/ledger');

const DATA_DIR = path.join(__dirname, '../../data');

/**
 * Read JSON file safely
 */
function readJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return [];
  }
  try {
    const data = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.warn(`  Warning: Could not read ${filename}: ${err.message}`);
    return [];
  }
}

/**
 * Migrate sites from JSON to SQLite
 */
function migrateSites() {
  console.log('\nMigrating sites...');

  const sites = readJSON('sites.json');
  if (sites.length === 0) {
    console.log('  No sites to migrate');
    return 0;
  }

  let migrated = 0;
  let updated = 0;
  for (const site of sites) {
    try {
      // Check if site already exists
      const existing = sitesRepo.getById(site.id);
      if (existing) {
        // Update existing site with JSON values (preserves real data over seed data)
        sitesRepo.update(site.id, {
          name: site.name,
          url: site.url,
          typical_sc: site.typical_sc || 0,
          typical_gc: site.typical_gc || 0,
          reset_type: site.reset_type || '24hr',
          active: site.active !== false,
          hidden: site.hidden || false,
          bankroll: site.bankroll || 0,
          pnl: site.pnl || 0,
          sort_order: site.sort_order || 0
        });
        updated++;
        continue;
      }

      sitesRepo.create({
        id: site.id,
        name: site.name,
        url: site.url,
        typical_sc: site.typical_sc || 0,
        typical_gc: site.typical_gc || 0,
        reset_type: site.reset_type || '24hr',
        active: site.active !== false,
        hidden: site.hidden || false,
        bankroll: site.bankroll || 0,
        pnl: site.pnl || 0,
        sort_order: site.sort_order || 0
      });
      migrated++;
    } catch (err) {
      console.warn(`  Warning: Could not migrate site ${site.id}: ${err.message}`);
    }
  }

  console.log(`  Migrated ${migrated} sites, updated ${updated} existing`);
  return migrated + updated;
}

/**
 * Migrate collections (daily rewards) to ledger
 */
function migrateCollections() {
  console.log('\nMigrating collections to ledger...');

  const collections = readJSON('collections.json');
  if (collections.length === 0) {
    console.log('  No collections to migrate');
    return 0;
  }

  let migrated = 0;
  let skipped = 0;

  for (const collection of collections) {
    try {
      // Get site info
      const site = sitesRepo.getById(collection.site_id);

      const event = {
        type: 'daily_reward',
        occurred_at: collection.timestamp || `${collection.date}T12:00:00.000Z`,
        site_id: collection.site_id,
        site_name: site ? site.name : collection.site_id,
        coin_amount: collection.sc_amount || 0,
        coin_type: 'SC',
        notes: collection.method === 'auto' ? 'Auto-collected' : null,
        meta: {
          gc_amount: collection.gc_amount || 0,
          method: collection.method || 'manual',
          legacy_id: collection.id
        }
      };

      // Check for duplicates
      const fingerprint = ledgerRepo.generateFingerprint(event);
      if (ledgerRepo.fingerprintExists(fingerprint)) {
        skipped++;
        continue;
      }

      ledgerRepo.create(event, { skipAudit: true });
      migrated++;
    } catch (err) {
      console.warn(`  Warning: Could not migrate collection: ${err.message}`);
    }
  }

  console.log(`  Migrated ${migrated} collections, skipped ${skipped} duplicates`);
  return migrated;
}

/**
 * Migrate purchases to ledger
 */
function migratePurchases() {
  console.log('\nMigrating purchases to ledger...');

  const purchases = readJSON('purchases.json');
  if (purchases.length === 0) {
    console.log('  No purchases to migrate');
    return 0;
  }

  let migrated = 0;
  let skipped = 0;

  for (const purchase of purchases) {
    try {
      // Find site by name
      const site = sitesRepo.getByName(purchase.casino_name);

      const event = {
        type: 'purchase',
        occurred_at: `${purchase.date}T12:00:00.000Z`,
        site_id: site ? site.id : null,
        site_name: purchase.casino_name,
        cash_amount: -(Math.abs(purchase.usd_spent || 0)), // Negative for purchases
        coin_amount: purchase.amount_coins || 0,
        notes: purchase.note || null,
        external_ref: purchase.tx_id || null,
        meta: {
          payment_method: purchase.payment_method || null
        }
      };

      // Check for duplicates
      const fingerprint = ledgerRepo.generateFingerprint(event);
      if (ledgerRepo.fingerprintExists(fingerprint)) {
        skipped++;
        continue;
      }

      ledgerRepo.create(event, { skipAudit: true });
      migrated++;
    } catch (err) {
      console.warn(`  Warning: Could not migrate purchase: ${err.message}`);
    }
  }

  console.log(`  Migrated ${migrated} purchases, skipped ${skipped} duplicates`);
  return migrated;
}

/**
 * Migrate redemptions to ledger
 */
function migrateRedemptions() {
  console.log('\nMigrating redemptions to ledger...');

  const redemptions = readJSON('redemptions.json');
  if (redemptions.length === 0) {
    console.log('  No redemptions to migrate');
    return 0;
  }

  let migrated = 0;
  let skipped = 0;

  for (const redemption of redemptions) {
    try {
      // Find site by name
      const site = sitesRepo.getByName(redemption.casino_name);

      // Determine event type based on status
      const isPending = redemption.status === 'pending';
      const type = isPending ? 'redemption_requested' : 'redemption_received';

      const event = {
        type,
        occurred_at: `${redemption.date}T12:00:00.000Z`,
        site_id: site ? site.id : null,
        site_name: redemption.casino_name,
        cash_amount: Math.abs(redemption.usd_received || 0), // Positive for redemptions
        coin_amount: redemption.amount_coins || 0,
        status: isPending ? 'pending' : 'received',
        notes: redemption.note || null,
        external_ref: redemption.tx_id || null,
        meta: {
          redemption_method: redemption.redemption_method || null
        }
      };

      // Check for duplicates
      const fingerprint = ledgerRepo.generateFingerprint(event);
      if (ledgerRepo.fingerprintExists(fingerprint)) {
        skipped++;
        continue;
      }

      ledgerRepo.create(event, { skipAudit: true });
      migrated++;
    } catch (err) {
      console.warn(`  Warning: Could not migrate redemption: ${err.message}`);
    }
  }

  console.log(`  Migrated ${migrated} redemptions, skipped ${skipped} duplicates`);
  return migrated;
}

/**
 * Migrate rewards to ledger
 */
function migrateRewards() {
  console.log('\nMigrating rewards to ledger...');

  const rewards = readJSON('rewards.json');
  if (rewards.length === 0) {
    console.log('  No rewards to migrate');
    return 0;
  }

  let migrated = 0;
  let skipped = 0;

  for (const reward of rewards) {
    try {
      // Find site by name
      const site = sitesRepo.getByName(reward.casino_name);

      const event = {
        type: 'daily_reward',
        occurred_at: `${reward.date}T12:00:00.000Z`,
        site_id: site ? site.id : null,
        site_name: reward.casino_name,
        coin_amount: reward.amount_coins || 0,
        coin_type: 'SC',
        notes: reward.note || null,
        meta: {
          reward_type: reward.reward_type || 'daily_reward'
        }
      };

      // Check for duplicates
      const fingerprint = ledgerRepo.generateFingerprint(event);
      if (ledgerRepo.fingerprintExists(fingerprint)) {
        skipped++;
        continue;
      }

      ledgerRepo.create(event, { skipAudit: true });
      migrated++;
    } catch (err) {
      console.warn(`  Warning: Could not migrate reward: ${err.message}`);
    }
  }

  console.log(`  Migrated ${migrated} rewards, skipped ${skipped} duplicates`);
  return migrated;
}

/**
 * Migrate sessions to ledger
 */
function migrateSessions() {
  console.log('\nMigrating sessions to ledger...');

  const sessions = readJSON('sessions.json');
  if (sessions.length === 0) {
    console.log('  No sessions to migrate');
    return 0;
  }

  let migrated = 0;
  let skipped = 0;

  for (const session of sessions) {
    try {
      // Find site by name
      const site = sitesRepo.getByName(session.casino_name);

      // Calculate P&L
      const pnl = (session.ending_balance || 0) - (session.starting_balance || 0);

      const event = {
        type: 'session',
        occurred_at: `${session.date}T12:00:00.000Z`,
        site_id: site ? site.id : null,
        site_name: session.casino_name,
        cash_amount: pnl, // P&L as cash amount
        coin_amount: session.amount_wagered || 0,
        notes: session.note || null,
        meta: {
          game_name: session.game_name || null,
          starting_balance: session.starting_balance || 0,
          ending_balance: session.ending_balance || 0,
          amount_wagered: session.amount_wagered || 0
        }
      };

      // Check for duplicates
      const fingerprint = ledgerRepo.generateFingerprint(event);
      if (ledgerRepo.fingerprintExists(fingerprint)) {
        skipped++;
        continue;
      }

      ledgerRepo.create(event, { skipAudit: true });
      migrated++;
    } catch (err) {
      console.warn(`  Warning: Could not migrate session: ${err.message}`);
    }
  }

  console.log(`  Migrated ${migrated} sessions, skipped ${skipped} duplicates`);
  return migrated;
}

/**
 * Run full data migration
 */
function migrateAll() {
  console.log('Starting data migration from JSON to SQLite...\n');

  // Run schema migrations first
  runMigrations();

  const results = {
    sites: migrateSites(),
    collections: migrateCollections(),
    purchases: migratePurchases(),
    redemptions: migrateRedemptions(),
    rewards: migrateRewards(),
    sessions: migrateSessions()
  };

  console.log('\n========================================');
  console.log('Migration Summary:');
  console.log(`  Sites: ${results.sites}`);
  console.log(`  Collections: ${results.collections}`);
  console.log(`  Purchases: ${results.purchases}`);
  console.log(`  Redemptions: ${results.redemptions}`);
  console.log(`  Rewards: ${results.rewards}`);
  console.log(`  Sessions: ${results.sessions}`);
  console.log('========================================\n');

  return results;
}

module.exports = {
  migrateAll,
  migrateSites,
  migrateCollections,
  migratePurchases,
  migrateRedemptions,
  migrateRewards,
  migrateSessions
};

// Run if called directly
if (require.main === module) {
  migrateAll();
}
