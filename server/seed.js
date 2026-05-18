#!/usr/bin/env node
/**
 * Seed Script - Populate database with sample data for testing
 * Run with: npm run seed
 */

'use strict';

const { runMigrations, close } = require('./db');
const sitesRepo = require('./db/repositories/sites');
const ledgerRepo = require('./db/repositories/ledger');

console.log('Seeding database with sample data...\n');

// Run migrations first
runMigrations();

// Sample sites
const sampleSites = [
  {
    id: 'chumba',
    name: 'Chumba Casino',
    url: 'https://www.chumbacasino.com',
    typical_sc: 0.30,
    typical_gc: 10000,
    reset_type: '24hr',
    active: true,
    bankroll: 125.50,
    pnl: 45.20
  },
  {
    id: 'luckyland',
    name: 'LuckyLand Slots',
    url: 'https://www.luckylandslots.com',
    typical_sc: 0.25,
    typical_gc: 5000,
    reset_type: '24hr',
    active: true,
    bankroll: 89.75,
    pnl: 12.30
  },
  {
    id: 'pulsz',
    name: 'Pulsz Casino',
    url: 'https://www.pulsz.com',
    typical_sc: 0.30,
    typical_gc: 8000,
    reset_type: '24hr',
    active: true,
    bankroll: 45.00,
    pnl: -15.50
  },
  {
    id: 'stake-us',
    name: 'Stake.us',
    url: 'https://stake.us',
    typical_sc: 1.00,
    typical_gc: 25000,
    reset_type: '24hr',
    active: true,
    bankroll: 250.00,
    pnl: 120.00
  },
  {
    id: 'wow-vegas',
    name: 'WOW Vegas',
    url: 'https://www.wowvegas.com',
    typical_sc: 0.50,
    typical_gc: 15000,
    reset_type: '24hr',
    active: true,
    bankroll: 175.25,
    pnl: 55.75
  }
];

// Sample ledger events
const today = new Date().toISOString().split('T')[0];
const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

const sampleEvents = [
  // Daily rewards (today)
  {
    type: 'daily_reward',
    occurred_at: `${today}T08:30:00.000Z`,
    site_id: 'chumba',
    site_name: 'Chumba Casino',
    coin_amount: 0.30,
    coin_type: 'SC',
    meta: { gc_amount: 10000, method: 'manual' }
  },
  {
    type: 'daily_reward',
    occurred_at: `${today}T09:15:00.000Z`,
    site_id: 'luckyland',
    site_name: 'LuckyLand Slots',
    coin_amount: 0.25,
    coin_type: 'SC',
    meta: { gc_amount: 5000, method: 'manual' }
  },
  {
    type: 'daily_reward',
    occurred_at: `${today}T10:00:00.000Z`,
    site_id: 'stake-us',
    site_name: 'Stake.us',
    coin_amount: 1.00,
    coin_type: 'SC',
    meta: { gc_amount: 25000, method: 'manual' }
  },

  // Daily rewards (yesterday)
  {
    type: 'daily_reward',
    occurred_at: `${yesterday}T08:00:00.000Z`,
    site_id: 'chumba',
    site_name: 'Chumba Casino',
    coin_amount: 0.30,
    coin_type: 'SC',
    meta: { gc_amount: 10000, method: 'manual' }
  },
  {
    type: 'daily_reward',
    occurred_at: `${yesterday}T09:00:00.000Z`,
    site_id: 'pulsz',
    site_name: 'Pulsz Casino',
    coin_amount: 0.30,
    coin_type: 'SC',
    meta: { gc_amount: 8000, method: 'manual' }
  },

  // Purchases
  {
    type: 'purchase',
    occurred_at: `${lastWeek}T14:00:00.000Z`,
    site_id: 'chumba',
    site_name: 'Chumba Casino',
    cash_amount: -9.99,
    coin_amount: 10,
    meta: { payment_method: 'credit_card' }
  },
  {
    type: 'purchase',
    occurred_at: `${lastMonth}T10:00:00.000Z`,
    site_id: 'stake-us',
    site_name: 'Stake.us',
    cash_amount: -19.99,
    coin_amount: 25,
    meta: { payment_method: 'credit_card' }
  },
  {
    type: 'purchase',
    occurred_at: `${lastMonth}T12:00:00.000Z`,
    site_id: 'pulsz',
    site_name: 'Pulsz Casino',
    cash_amount: -7.99,
    coin_amount: 8,
    meta: { payment_method: 'debit_card' }
  },

  // Redemptions - received
  {
    type: 'redemption_received',
    occurred_at: `${lastWeek}T16:00:00.000Z`,
    site_id: 'chumba',
    site_name: 'Chumba Casino',
    cash_amount: 50.00,
    coin_amount: 50,
    status: 'received',
    meta: { redemption_method: 'ACH' }
  },
  {
    type: 'redemption_received',
    occurred_at: `${yesterday}T14:00:00.000Z`,
    site_id: 'stake-us',
    site_name: 'Stake.us',
    cash_amount: 100.00,
    coin_amount: 100,
    status: 'received',
    meta: { redemption_method: 'crypto' }
  },

  // Redemptions - pending
  {
    type: 'redemption_requested',
    occurred_at: `${yesterday}T15:00:00.000Z`,
    site_id: 'luckyland',
    site_name: 'LuckyLand Slots',
    cash_amount: 75.00,
    coin_amount: 75,
    status: 'pending',
    meta: { redemption_method: 'ACH' }
  },
  {
    type: 'redemption_requested',
    occurred_at: `${today}T11:00:00.000Z`,
    site_id: 'wow-vegas',
    site_name: 'WOW Vegas',
    cash_amount: 125.00,
    coin_amount: 125,
    status: 'pending',
    meta: { redemption_method: 'ACH' }
  },

  // Sessions
  {
    type: 'session',
    occurred_at: `${lastWeek}T20:00:00.000Z`,
    site_id: 'chumba',
    site_name: 'Chumba Casino',
    cash_amount: 15.50, // P&L
    coin_amount: 50, // wagered
    meta: {
      game_name: 'Stampede Fury',
      starting_balance: 110.00,
      ending_balance: 125.50,
      amount_wagered: 50
    }
  },
  {
    type: 'session',
    occurred_at: `${yesterday}T21:00:00.000Z`,
    site_id: 'stake-us',
    site_name: 'Stake.us',
    cash_amount: -25.00, // P&L (loss)
    coin_amount: 100, // wagered
    meta: {
      game_name: 'Sugar Rush',
      starting_balance: 275.00,
      ending_balance: 250.00,
      amount_wagered: 100
    }
  }
];

// Insert sites
console.log('Creating sample sites...');
let sitesCreated = 0;
for (const site of sampleSites) {
  try {
    const existing = sitesRepo.getById(site.id);
    if (!existing) {
      sitesRepo.create(site);
      sitesCreated++;
      console.log(`  Created: ${site.name}`);
    } else {
      console.log(`  Exists: ${site.name}`);
    }
  } catch (err) {
    console.log(`  Error: ${site.name} - ${err.message}`);
  }
}

// Insert events
console.log('\nCreating sample ledger events...');
let eventsCreated = 0;
let eventsSkipped = 0;
for (const event of sampleEvents) {
  try {
    const fingerprint = ledgerRepo.generateFingerprint(event);
    if (!ledgerRepo.fingerprintExists(fingerprint)) {
      ledgerRepo.create(event, { skipAudit: true });
      eventsCreated++;
    } else {
      eventsSkipped++;
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

console.log(`  Created: ${eventsCreated} events`);
console.log(`  Skipped: ${eventsSkipped} duplicates`);

// Summary
console.log('\n========================================');
console.log('Seed Summary:');
console.log(`  Sites: ${sitesCreated} created`);
console.log(`  Events: ${eventsCreated} created, ${eventsSkipped} skipped`);
console.log('========================================\n');

// Print sample data summary
const allSites = sitesRepo.getAll();
const allEvents = ledgerRepo.query({});
const taxData = ledgerRepo.getTaxData({});

console.log('Database Contents:');
console.log(`  Total Sites: ${allSites.length}`);
console.log(`  Total Events: ${allEvents.length}`);
console.log(`  Purchases Total: $${taxData.purchasesTotal.toFixed(2)}`);
console.log(`  Redemptions Received: $${taxData.redemptionsReceived.toFixed(2)}`);
console.log(`  Redemptions Pending: $${taxData.redemptionsPending.toFixed(2)}`);
console.log('');

close();
console.log('Seed completed successfully!');
