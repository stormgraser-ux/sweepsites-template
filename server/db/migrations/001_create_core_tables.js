/**
 * Migration 001: Create core tables
 * - sites: Casino site definitions
 * - ledger_events: Unified ledger for all financial events
 * - ledger_audit: Audit trail for ledger changes
 * - imports: Import batch metadata
 * - import_items: Individual import records
 */

'use strict';

function up(db) {
  // Sites table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT,
      typical_sc REAL DEFAULT 0,
      typical_gc INTEGER DEFAULT 0,
      reset_type TEXT DEFAULT '24hr',
      cooldown_minutes INTEGER DEFAULT 1440,
      active INTEGER DEFAULT 1,
      hidden INTEGER DEFAULT 0,
      bankroll REAL DEFAULT 0,
      pnl REAL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      meta TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add cooldown_minutes column if it doesn't exist (for existing databases)
  try {
    db.exec('ALTER TABLE sites ADD COLUMN cooldown_minutes INTEGER DEFAULT 1440');
  } catch (err) {
    // Column already exists, ignore
  }

  // Ledger events table - the one true ledger
  db.exec(`
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
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (site_id) REFERENCES sites(id),
      FOREIGN KEY (linked_event_id) REFERENCES ledger_events(id),
      FOREIGN KEY (import_id) REFERENCES imports(id)
    )
  `);

  // Indexes for ledger_events
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger_events(type);
    CREATE INDEX IF NOT EXISTS idx_ledger_occurred_at ON ledger_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_site_id ON ledger_events(site_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_fingerprint ON ledger_events(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger_events(status);
    CREATE INDEX IF NOT EXISTS idx_ledger_is_deleted ON ledger_events(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_ledger_type_date ON ledger_events(type, occurred_at);
  `);

  // Ledger audit table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
      actor TEXT DEFAULT 'local-user',
      before_data TEXT,
      after_data TEXT,
      changed_fields TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES ledger_events(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_id ON ledger_audit(event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON ledger_audit(created_at);
  `);

  // Imports table - batch metadata
  db.exec(`
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
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `);

  // Import items table - individual raw records (optional storage)
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id TEXT NOT NULL,
      row_number INTEGER,
      raw_data TEXT,
      mapped_data TEXT,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'inserted', 'skipped', 'error')),
      error_message TEXT,
      event_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (import_id) REFERENCES imports(id),
      FOREIGN KEY (event_id) REFERENCES ledger_events(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_import_items_import_id ON import_items(import_id);
  `);

  console.log('  Created tables: sites, ledger_events, ledger_audit, imports, import_items');
}

function down(db) {
  db.exec('DROP TABLE IF EXISTS import_items');
  db.exec('DROP TABLE IF EXISTS imports');
  db.exec('DROP TABLE IF EXISTS ledger_audit');
  db.exec('DROP TABLE IF EXISTS ledger_events');
  db.exec('DROP TABLE IF EXISTS sites');
}

module.exports = { up, down };
