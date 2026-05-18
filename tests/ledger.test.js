/**
 * Ledger System Unit Tests
 * Tests for unified ledger, imports, and health checks
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Use a test database
const TEST_DB_PATH = path.join(__dirname, '../data/test-sweepsites.sqlite');

// Clean up any existing test database
if (fs.existsSync(TEST_DB_PATH)) {
  fs.unlinkSync(TEST_DB_PATH);
}

// Set up test database path before requiring modules
process.env.SWEEPSITES_DB_PATH = TEST_DB_PATH;

// Now we need to create a test-specific database setup
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Create test database
const db = new Database(TEST_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run migrations manually for test
db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT,
    typical_sc REAL DEFAULT 0,
    typical_gc INTEGER DEFAULT 0,
    reset_type TEXT DEFAULT '24hr',
    active INTEGER DEFAULT 1,
    hidden INTEGER DEFAULT 0,
    bankroll REAL DEFAULT 0,
    pnl REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    meta TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ledger_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('purchase', 'redemption_requested', 'redemption_received', 'daily_reward', 'session', 'adjustment')),
    occurred_at TEXT NOT NULL,
    site_id TEXT,
    site_name TEXT,
    cash_amount REAL DEFAULT 0,
    coin_amount REAL DEFAULT 0,
    coin_type TEXT,
    status TEXT CHECK (status IN ('pending', 'received', 'voided', NULL)),
    external_ref TEXT,
    linked_event_id TEXT,
    notes TEXT,
    meta TEXT,
    fingerprint TEXT,
    import_id TEXT,
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger_events(type);
  CREATE INDEX IF NOT EXISTS idx_ledger_fingerprint ON ledger_events(fingerprint);
  CREATE INDEX IF NOT EXISTS idx_ledger_is_deleted ON ledger_events(is_deleted);

  CREATE TABLE IF NOT EXISTS ledger_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT DEFAULT 'local-user',
    before_data TEXT,
    after_data TEXT,
    changed_fields TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    filename TEXT,
    source TEXT,
    mapping TEXT,
    total_rows INTEGER DEFAULT 0,
    inserted_count INTEGER DEFAULT 0,
    skipped_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    errors TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
`);

// Test utilities
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('\u2713', name);
    passed++;
  } catch (e) {
    console.log('\u2717', name);
    console.log('  Error:', e.message);
    failed++;
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`Expected "${expected}", got "${actual}". ${message}`);
  }
}

function assertClose(actual, expected, tolerance = 0.01, message = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`Expected ${expected} \u00B1 ${tolerance}, got ${actual}. ${message}`);
  }
}

function assertTrue(value, message = '') {
  if (!value) {
    throw new Error(`Expected truthy value. ${message}`);
  }
}

function assertFalse(value, message = '') {
  if (value) {
    throw new Error(`Expected falsy value. ${message}`);
  }
}

// Inline repository functions for testing
function generateFingerprint(event) {
  const dateOnly = event.occurred_at ? event.occurred_at.split('T')[0] : '';
  const siteName = (event.site_name || event.site_id || '').toLowerCase().trim();
  const cashAmount = parseFloat(event.cash_amount || 0).toFixed(2);
  const coinAmount = parseFloat(event.coin_amount || 0).toFixed(2);
  const externalRef = (event.external_ref || '').trim();
  const data = `${event.type}|${dateOnly}|${siteName}|${cashAmount}|${coinAmount}|${externalRef}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

function createEvent(event) {
  const id = event.id || uuidv4();
  const now = new Date().toISOString();
  const fingerprint = generateFingerprint(event);

  db.prepare(`
    INSERT INTO ledger_events (
      id, type, occurred_at, site_id, site_name, cash_amount, coin_amount,
      coin_type, status, external_ref, notes, meta, fingerprint, is_deleted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id, event.type, event.occurred_at || now, event.site_id || null,
    event.site_name || null, event.cash_amount || 0, event.coin_amount || 0,
    event.coin_type || null, event.status || null, event.external_ref || null,
    event.notes || null, event.meta ? JSON.stringify(event.meta) : null,
    fingerprint, now, now
  );

  // Record audit
  db.prepare(`
    INSERT INTO ledger_audit (event_id, action, after_data)
    VALUES (?, 'create', ?)
  `).run(id, JSON.stringify(event));

  return { id, ...event, fingerprint };
}

function getEventById(id) {
  return db.prepare('SELECT * FROM ledger_events WHERE id = ? AND is_deleted = 0').get(id);
}

function softDelete(id) {
  const existing = getEventById(id);
  if (!existing) return false;

  const now = new Date().toISOString();
  db.prepare('UPDATE ledger_events SET is_deleted = 1, updated_at = ? WHERE id = ?').run(now, id);

  db.prepare(`
    INSERT INTO ledger_audit (event_id, action, before_data, changed_fields, created_at)
    VALUES (?, 'delete', ?, ?, ?)
  `).run(id, JSON.stringify(existing), JSON.stringify(['is_deleted']), now);

  return true;
}

function getAuditHistory(eventId) {
  return db.prepare('SELECT * FROM ledger_audit WHERE event_id = ? ORDER BY created_at DESC').all(eventId);
}

function fingerprintExists(fingerprint) {
  return !!db.prepare('SELECT 1 FROM ledger_events WHERE fingerprint = ? AND is_deleted = 0').get(fingerprint);
}

// Clear test data before each section
function clearTestData() {
  db.exec('DELETE FROM ledger_audit');
  db.exec('DELETE FROM ledger_events');
  db.exec('DELETE FROM sites');
  db.exec('DELETE FROM imports');
}

console.log('\n========================================');
console.log('Ledger System Unit Tests');
console.log('========================================\n');

// =============================================================================
// Test: Event Creation
// =============================================================================

console.log('Event Creation Tests');
clearTestData();

test('Create purchase event', () => {
  const event = createEvent({
    type: 'purchase',
    occurred_at: '2025-01-15T10:00:00.000Z',
    site_name: 'Chumba Casino',
    cash_amount: -9.99,
    coin_amount: 10
  });

  assertTrue(event.id, 'Event should have an ID');
  assertEqual(event.type, 'purchase');
  assertClose(event.cash_amount, -9.99);
});

test('Create daily_reward event', () => {
  const event = createEvent({
    type: 'daily_reward',
    occurred_at: '2025-01-15T08:00:00.000Z',
    site_name: 'Stake.us',
    coin_amount: 1.00,
    meta: { gc_amount: 25000 }
  });

  assertEqual(event.type, 'daily_reward');
  assertClose(event.coin_amount, 1.00);
});

test('Create redemption_received event', () => {
  const event = createEvent({
    type: 'redemption_received',
    occurred_at: '2025-01-15T14:00:00.000Z',
    site_name: 'LuckyLand Slots',
    cash_amount: 50.00,
    coin_amount: 50,
    status: 'received'
  });

  assertEqual(event.status, 'received');
  assertClose(event.cash_amount, 50.00);
});

test('Create redemption_requested (pending) event', () => {
  const event = createEvent({
    type: 'redemption_requested',
    occurred_at: '2025-01-15T15:00:00.000Z',
    site_name: 'WOW Vegas',
    cash_amount: 100.00,
    coin_amount: 100,
    status: 'pending'
  });

  assertEqual(event.status, 'pending');
  assertEqual(event.type, 'redemption_requested');
});

// =============================================================================
// Test: Fingerprint and Deduplication
// =============================================================================

console.log('\nFingerprint & Deduplication Tests');
clearTestData();

test('Fingerprint is consistent for same data', () => {
  const event1 = {
    type: 'purchase',
    occurred_at: '2025-01-20T10:00:00.000Z',
    site_name: 'Chumba Casino',
    cash_amount: -19.99,
    coin_amount: 20
  };

  const event2 = {
    type: 'purchase',
    occurred_at: '2025-01-20T15:30:00.000Z', // Different time, same day
    site_name: 'CHUMBA CASINO', // Different case
    cash_amount: -19.99,
    coin_amount: 20
  };

  const fp1 = generateFingerprint(event1);
  const fp2 = generateFingerprint(event2);

  assertEqual(fp1, fp2, 'Fingerprints should match for same-day same-amount events');
});

test('Fingerprint differs for different amounts', () => {
  const event1 = {
    type: 'purchase',
    occurred_at: '2025-01-20T10:00:00.000Z',
    site_name: 'Chumba Casino',
    cash_amount: -9.99,
    coin_amount: 10
  };

  const event2 = {
    type: 'purchase',
    occurred_at: '2025-01-20T10:00:00.000Z',
    site_name: 'Chumba Casino',
    cash_amount: -19.99, // Different amount
    coin_amount: 20
  };

  const fp1 = generateFingerprint(event1);
  const fp2 = generateFingerprint(event2);

  assertTrue(fp1 !== fp2, 'Fingerprints should differ for different amounts');
});

test('Duplicate detection works', () => {
  const event = {
    type: 'daily_reward',
    occurred_at: '2025-01-21T08:00:00.000Z',
    site_name: 'Pulsz',
    coin_amount: 0.30
  };

  const created = createEvent(event);
  assertTrue(fingerprintExists(created.fingerprint), 'Fingerprint should exist after creation');

  // Try to create duplicate
  const fp = generateFingerprint(event);
  assertTrue(fingerprintExists(fp), 'Should detect duplicate');
});

// =============================================================================
// Test: Soft Delete and Audit Trail
// =============================================================================

console.log('\nSoft Delete & Audit Trail Tests');
clearTestData();

test('Soft delete marks event as deleted', () => {
  const event = createEvent({
    type: 'purchase',
    occurred_at: '2025-01-22T10:00:00.000Z',
    site_name: 'Test Casino',
    cash_amount: -5.00
  });

  const deleted = softDelete(event.id);
  assertTrue(deleted, 'Delete should return true');

  const check = getEventById(event.id);
  assertEqual(check, undefined, 'Deleted event should not be found');
});

test('Audit trail records creation', () => {
  const event = createEvent({
    type: 'daily_reward',
    occurred_at: '2025-01-22T08:00:00.000Z',
    site_name: 'Audit Test Casino',
    coin_amount: 0.50
  });

  const audit = getAuditHistory(event.id);
  assertTrue(audit.length >= 1, 'Should have at least one audit record');
  assertEqual(audit[0].action, 'create');
});

test('Audit trail records deletion', () => {
  const event = createEvent({
    type: 'session',
    occurred_at: '2025-01-22T20:00:00.000Z',
    site_name: 'Session Casino',
    cash_amount: 10.00
  });

  softDelete(event.id);

  const audit = getAuditHistory(event.id);
  assertTrue(audit.length >= 2, 'Should have creation and deletion audit records');

  const deleteRecord = audit.find(a => a.action === 'delete');
  assertTrue(deleteRecord, 'Should have a delete audit record');
});

// =============================================================================
// Test: Query and Aggregation
// =============================================================================

console.log('\nQuery & Aggregation Tests');
clearTestData();

// Create test data set
const testEvents = [
  { type: 'purchase', occurred_at: '2025-01-01T10:00:00.000Z', site_name: 'Site A', cash_amount: -10.00 },
  { type: 'purchase', occurred_at: '2025-01-05T10:00:00.000Z', site_name: 'Site B', cash_amount: -20.00 },
  { type: 'redemption_received', occurred_at: '2025-01-10T10:00:00.000Z', site_name: 'Site A', cash_amount: 50.00, status: 'received' },
  { type: 'redemption_requested', occurred_at: '2025-01-15T10:00:00.000Z', site_name: 'Site B', cash_amount: 75.00, status: 'pending' },
  { type: 'daily_reward', occurred_at: '2025-01-01T08:00:00.000Z', site_name: 'Site A', coin_amount: 0.30 },
  { type: 'daily_reward', occurred_at: '2025-01-02T08:00:00.000Z', site_name: 'Site A', coin_amount: 0.30 },
  { type: 'daily_reward', occurred_at: '2025-01-01T08:00:00.000Z', site_name: 'Site B', coin_amount: 0.50 }
];

testEvents.forEach(e => createEvent(e));

test('Query by type returns correct count', () => {
  const purchases = db.prepare(
    'SELECT COUNT(*) as count FROM ledger_events WHERE type = ? AND is_deleted = 0'
  ).get('purchase');
  assertEqual(purchases.count, 2);
});

test('Query daily_reward count is correct', () => {
  const rewards = db.prepare(
    'SELECT COUNT(*) as count FROM ledger_events WHERE type = ? AND is_deleted = 0'
  ).get('daily_reward');
  assertEqual(rewards.count, 3);
});

test('Sum of purchases is correct', () => {
  const result = db.prepare(
    'SELECT SUM(ABS(cash_amount)) as total FROM ledger_events WHERE type = ? AND is_deleted = 0'
  ).get('purchase');
  assertClose(result.total, 30.00);
});

test('Sum of redemptions received is correct', () => {
  const result = db.prepare(
    'SELECT SUM(cash_amount) as total FROM ledger_events WHERE type = ? AND is_deleted = 0'
  ).get('redemption_received');
  assertClose(result.total, 50.00);
});

test('Pending redemptions count is correct', () => {
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM ledger_events WHERE status = ? AND is_deleted = 0'
  ).get('pending');
  assertEqual(result.count, 1);
});

// =============================================================================
// Test: Tax Data Calculation
// =============================================================================

console.log('\nTax Data Calculation Tests');
// Using the same test data from above

test('Tax data purchases total is correct', () => {
  const result = db.prepare(`
    SELECT SUM(CASE WHEN type = 'purchase' THEN ABS(cash_amount) ELSE 0 END) as purchases_total
    FROM ledger_events WHERE is_deleted = 0
  `).get();
  assertClose(result.purchases_total, 30.00);
});

test('Tax data redemptions received is correct', () => {
  const result = db.prepare(`
    SELECT SUM(CASE WHEN type = 'redemption_received' THEN cash_amount ELSE 0 END) as redemptions_received
    FROM ledger_events WHERE is_deleted = 0
  `).get();
  assertClose(result.redemptions_received, 50.00);
});

test('Tax data redemptions pending is correct', () => {
  const result = db.prepare(`
    SELECT SUM(CASE WHEN type = 'redemption_requested' AND status = 'pending' THEN cash_amount ELSE 0 END) as redemptions_pending
    FROM ledger_events WHERE is_deleted = 0
  `).get();
  assertClose(result.redemptions_pending, 75.00);
});

// =============================================================================
// Test: Import Mapping Logic
// =============================================================================

console.log('\nImport Mapping Tests');

function inferEventType(cashAmount, status) {
  if (cashAmount < 0) return 'purchase';
  if (status === 'pending') return 'redemption_requested';
  if (cashAmount > 0) return 'redemption_received';
  return 'daily_reward';
}

test('Infer purchase from negative amount', () => {
  assertEqual(inferEventType(-9.99, null), 'purchase');
});

test('Infer redemption_requested from pending status', () => {
  assertEqual(inferEventType(50.00, 'pending'), 'redemption_requested');
});

test('Infer redemption_received from positive amount', () => {
  assertEqual(inferEventType(100.00, 'received'), 'redemption_received');
});

test('Infer daily_reward from zero amount', () => {
  assertEqual(inferEventType(0, null), 'daily_reward');
});

// =============================================================================
// Test: Health Check Invariants
// =============================================================================

console.log('\nHealth Check Tests');
clearTestData();

test('Empty database passes health check', () => {
  const invalidDates = db.prepare(`
    SELECT COUNT(*) as count FROM ledger_events
    WHERE is_deleted = 0 AND (occurred_at IS NULL OR occurred_at = '')
  `).get();

  assertEqual(invalidDates.count, 0, 'Should have no invalid dates');
});

test('Duplicate fingerprints are detected', () => {
  // Create two events with same fingerprint manually
  const event = {
    type: 'purchase',
    occurred_at: '2025-02-01T10:00:00.000Z',
    site_name: 'Dupe Test',
    cash_amount: -5.00
  };

  createEvent(event);

  // Force insert duplicate
  const fp = generateFingerprint(event);
  db.prepare(`
    INSERT INTO ledger_events (id, type, occurred_at, site_name, cash_amount, fingerprint, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(uuidv4(), event.type, event.occurred_at, event.site_name, event.cash_amount, fp);

  const dupes = db.prepare(`
    SELECT fingerprint, COUNT(*) as count FROM ledger_events
    WHERE is_deleted = 0 GROUP BY fingerprint HAVING COUNT(*) > 1
  `).all();

  assertTrue(dupes.length > 0, 'Should detect duplicate fingerprints');
});

// =============================================================================
// Test: Sites Repository
// =============================================================================

console.log('\nSites Repository Tests');
clearTestData();

function createSite(site) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sites (id, name, url, typical_sc, typical_gc, active, bankroll, pnl, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(site.id, site.name, site.url || null, site.typical_sc || 0, site.typical_gc || 0,
         site.active !== false ? 1 : 0, site.bankroll || 0, site.pnl || 0, now, now);
  return site;
}

function getSiteById(id) {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
}

function getAllSites() {
  return db.prepare('SELECT * FROM sites ORDER BY name').all();
}

test('Create site', () => {
  const site = createSite({
    id: 'test-casino',
    name: 'Test Casino',
    url: 'https://test.com',
    typical_sc: 0.30,
    bankroll: 100.00
  });

  const found = getSiteById('test-casino');
  assertTrue(found, 'Site should be created');
  assertEqual(found.name, 'Test Casino');
});

test('Get all sites', () => {
  createSite({ id: 'site-a', name: 'Site A' });
  createSite({ id: 'site-b', name: 'Site B' });

  const sites = getAllSites();
  assertTrue(sites.length >= 2, 'Should have at least 2 sites');
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

// Cleanup
db.close();
if (fs.existsSync(TEST_DB_PATH)) {
  fs.unlinkSync(TEST_DB_PATH);
}

if (failed > 0) {
  process.exit(1);
}
console.log('All tests passed!');
