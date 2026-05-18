/**
 * Database Module - SQLite connection and initialization
 * Uses better-sqlite3 for synchronous, high-performance SQLite access
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Database file path
const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'sweepsites.sqlite');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create database connection with WAL mode for better concurrency
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Run all pending migrations
 */
function runMigrations() {
  // Create migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');

  // Get list of applied migrations
  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map(r => r.name)
  );

  // Get migration files
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  // Run pending migrations
  for (const file of migrationFiles) {
    if (!applied.has(file)) {
      console.log(`Running migration: ${file}`);
      const migration = require(path.join(migrationsDir, file));

      const runMigration = db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
      });

      runMigration();
      console.log(`  Completed: ${file}`);
    }
  }
}

/**
 * Close database connection
 */
function close() {
  db.close();
}

/**
 * Get database instance for direct queries
 */
function getDb() {
  return db;
}

module.exports = {
  db,
  getDb,
  runMigrations,
  close,
  DB_PATH
};
