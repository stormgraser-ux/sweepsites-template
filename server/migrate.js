#!/usr/bin/env node
/**
 * Migration Runner
 * Run with: npm run migrate
 */

'use strict';

const { runMigrations, close } = require('./db');

console.log('Running database migrations...\n');

try {
  runMigrations();
  console.log('\nMigrations completed successfully.');
} catch (err) {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
} finally {
  close();
}
