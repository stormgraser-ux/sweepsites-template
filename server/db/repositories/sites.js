/**
 * Sites Repository
 * Manages casino site data in SQLite
 */

'use strict';

const { db } = require('../index');

/**
 * Get all sites (optionally filter by active status)
 */
function getAll(includeHidden = true) {
  const sql = includeHidden
    ? 'SELECT * FROM sites ORDER BY sort_order ASC, name ASC'
    : 'SELECT * FROM sites WHERE hidden = 0 ORDER BY sort_order ASC, name ASC';

  return db.prepare(sql).all().map(formatSite);
}

/**
 * Get all active (non-hidden) sites
 */
function getActive() {
  return db.prepare(
    'SELECT * FROM sites WHERE active = 1 AND hidden = 0 ORDER BY sort_order ASC, name ASC'
  ).all().map(formatSite);
}

/**
 * Get site by ID
 */
function getById(id) {
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  return row ? formatSite(row) : null;
}

/**
 * Get site by name (case-insensitive)
 */
function getByName(name) {
  const row = db.prepare(
    'SELECT * FROM sites WHERE LOWER(name) = LOWER(?)'
  ).get(name);
  return row ? formatSite(row) : null;
}

/**
 * Create a new site
 */
function create(site) {
  const id = site.id || generateId(site.name);
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO sites (id, name, url, typical_sc, typical_gc, reset_type, cooldown_minutes, active, hidden, bankroll, pnl, sort_order, meta, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    site.name,
    site.url || null,
    site.typical_sc || 0,
    site.typical_gc || 0,
    site.reset_type || '24hr',
    site.cooldown_minutes || null,
    site.active !== false ? 1 : 0,
    site.hidden ? 1 : 0,
    site.bankroll || 0,
    site.pnl || 0,
    site.sort_order || 0,
    site.meta ? JSON.stringify(site.meta) : null,
    now,
    now
  );

  return getById(id);
}

/**
 * Update a site
 */
function update(id, updates) {
  const existing = getById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const fields = [];
  const values = [];

  // Build dynamic update
  const allowedFields = ['name', 'url', 'typical_sc', 'typical_gc', 'reset_type', 'cooldown_minutes', 'active', 'hidden', 'bankroll', 'pnl', 'sort_order', 'meta', 'last_checked', 'cooldown_reason', 'cooldown_message', 'cooldown_since', 'pinned'];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      if (field === 'meta') {
        fields.push(`${field} = ?`);
        values.push(JSON.stringify(updates[field]));
      } else if (field === 'active' || field === 'hidden' || field === 'pinned') {
        fields.push(`${field} = ?`);
        values.push(updates[field] ? 1 : 0);
      } else {
        fields.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }
  }

  if (fields.length === 0) return existing;

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  const sql = `UPDATE sites SET ${fields.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);

  return getById(id);
}

/**
 * Delete a site
 */
function remove(id) {
  const result = db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Toggle site active status
 */
function toggleActive(id) {
  db.prepare('UPDATE sites SET active = NOT active, updated_at = datetime("now") WHERE id = ?').run(id);
  return getById(id);
}

/**
 * Toggle site hidden status
 */
function toggleHidden(id) {
  db.prepare('UPDATE sites SET hidden = NOT hidden, updated_at = datetime("now") WHERE id = ?').run(id);
  return getById(id);
}

/**
 * Bulk upsert sites
 */
function bulkUpsert(sites) {
  const upsert = db.transaction((sitesArray) => {
    const results = { inserted: 0, updated: 0 };

    for (const site of sitesArray) {
      const existing = getById(site.id) || getByName(site.name);

      if (existing) {
        update(existing.id, site);
        results.updated++;
      } else {
        create(site);
        results.inserted++;
      }
    }

    return results;
  });

  return upsert(sites);
}

/**
 * Get site count
 */
function count() {
  return db.prepare('SELECT COUNT(*) as count FROM sites').get().count;
}

/**
 * Check if any sites exist
 */
function isEmpty() {
  return count() === 0;
}

// Helper functions

function generateId(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatSite(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    typical_sc: row.typical_sc,
    typical_gc: row.typical_gc,
    reset_type: row.reset_type,
    cooldown_minutes: row.cooldown_minutes,
    active: row.active === 1,
    hidden: row.hidden === 1,
    bankroll: row.bankroll,
    pnl: row.pnl,
    sort_order: row.sort_order,
    meta: row.meta ? JSON.parse(row.meta) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_checked: row.last_checked || null,
    // Cooldown intelligence
    cooldown_reason: row.cooldown_reason || null,
    cooldown_message: row.cooldown_message || null,
    cooldown_since: row.cooldown_since || null,
    // Onboarding fields
    account_status: row.account_status || null,
    welcome_bonus_claimed: row.welcome_bonus_claimed === 1,
    is_starter: row.is_starter === 1,
    // Focus strip
    pinned: row.pinned === 1
  };
}

/**
 * Count currently pinned (active, non-hidden) sites.
 */
function countPinned() {
  return db.prepare(
    'SELECT COUNT(*) as c FROM sites WHERE pinned = 1 AND active = 1 AND hidden = 0'
  ).get().c;
}

/**
 * Get all pinned sites in pin order (by sort_order, then name).
 */
function getPinned() {
  return db.prepare(
    'SELECT * FROM sites WHERE pinned = 1 AND active = 1 AND hidden = 0 ORDER BY sort_order ASC, name ASC'
  ).all().map(formatSite);
}

/**
 * Get all sites with computed PnL from ledger events.
 * PnL = redemptions_received - purchases (cash only, not coin rewards).
 * Returns both all-time and YTD (current year) P&L.
 */
function getAllWithPnL(includeHidden = true) {
  const year = new Date().getUTCFullYear();
  const ytdStart = `${year}-01-01T00:00:00.000Z`;
  const sql = `
    SELECT s.*,
      COALESCE(SUM(CASE WHEN le.type = 'redemption_received' THEN le.cash_amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN le.type = 'purchase' THEN ABS(le.cash_amount) ELSE 0 END), 0)
      AS computed_pnl,
      COALESCE(SUM(CASE WHEN le.type = 'redemption_received' AND le.occurred_at >= '${ytdStart}' THEN le.cash_amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN le.type = 'purchase' AND le.occurred_at >= '${ytdStart}' THEN ABS(le.cash_amount) ELSE 0 END), 0)
      AS computed_pnl_ytd
    FROM sites s
    LEFT JOIN ledger_events le ON le.site_id = s.id AND le.is_deleted = 0
      AND le.type IN ('redemption_received', 'purchase')
    ${includeHidden ? '' : 'WHERE s.hidden = 0'}
    GROUP BY s.id
    ORDER BY s.sort_order ASC, s.name ASC
  `;

  return db.prepare(sql).all().map(row => ({
    ...formatSite(row),
    computed_pnl: row.computed_pnl || 0,
    computed_pnl_ytd: row.computed_pnl_ytd || 0
  }));
}

/**
 * Record cooldown state for a site. Preserves cooldown_since if already set
 * so the streak start date is not reset on repeated cooldown hits.
 */
function recordCooldown(siteId, reason, message) {
  const existing = getById(siteId);
  if (!existing) return null;
  // Preserve cooldown_since if already set (streak continues)
  const cooldownSince = existing.cooldown_since || new Date().toISOString();
  return update(siteId, {
    cooldown_reason: reason,
    cooldown_message: message,
    cooldown_since: cooldownSince,
    last_checked: new Date().toISOString()
  });
}

/**
 * Clear cooldown state for a site (successful collection or manual override).
 */
function clearCooldown(siteId) {
  return update(siteId, {
    cooldown_reason: null,
    cooldown_message: null,
    cooldown_since: null
  });
}

module.exports = {
  getAll,
  getAllWithPnL,
  getActive,
  getById,
  getByName,
  create,
  update,
  remove,
  toggleActive,
  toggleHidden,
  bulkUpsert,
  count,
  isEmpty,
  recordCooldown,
  clearCooldown,
  countPinned,
  getPinned
};
