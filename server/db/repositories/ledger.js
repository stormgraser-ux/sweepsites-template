/**
 * Ledger Repository
 * The One True Ledger - manages all financial events
 */

'use strict';

const { db } = require('../index');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Event types
const EVENT_TYPES = [
  'purchase',
  'redemption_requested',
  'redemption_received',
  'daily_reward',
  'session',
  'adjustment'
];

// Status values
const STATUSES = ['pending', 'received', 'voided', null];

/**
 * Generate a stable fingerprint for deduplication
 * Based on: type, date (day only), site name (normalized), cash_amount, coin_amount, external_ref
 */
function generateFingerprint(event) {
  const dateOnly = event.occurred_at ? event.occurred_at.split('T')[0] : '';
  const siteName = (event.site_name || event.site_id || '').toLowerCase().trim();
  const cashAmount = parseFloat(event.cash_amount || 0).toFixed(2);
  const coinAmount = parseFloat(event.coin_amount || 0).toFixed(2);
  const externalRef = (event.external_ref || '').trim();

  const data = `${event.type}|${dateOnly}|${siteName}|${cashAmount}|${coinAmount}|${externalRef}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

/**
 * Create a new ledger event
 */
function create(event, options = {}) {
  const { skipAudit = false, importId = null } = options;

  const id = event.id || uuidv4();
  const now = new Date().toISOString();

  // Validate type
  if (!EVENT_TYPES.includes(event.type)) {
    throw new Error(`Invalid event type: ${event.type}`);
  }

  // Validate site_id is present for non-adjustment events
  if (!event.site_id && event.type !== 'adjustment') {
    throw new Error(`Missing site_id for ${event.type} event`);
  }

  // Reject negative coin_amount for daily_reward (balance drops are not rewards)
  if (event.type === 'daily_reward' && event.coin_amount < 0) {
    console.log(`[ledger] Rejecting negative daily_reward (${event.coin_amount} SC) for ${event.site_id}`);
    return null;
  }

  // Generate fingerprint and check for duplicates
  const fingerprint = generateFingerprint(event);
  if (fingerprintExists(fingerprint)) {
    const existing = getByFingerprint(fingerprint)[0];
    console.log(`[ledger] Duplicate fingerprint detected for ${event.type}/${event.site_id} — returning existing event ${existing.id}`);
    return existing;
  }

  const stmt = db.prepare(`
    INSERT INTO ledger_events (
      id, type, occurred_at, site_id, site_name, cash_amount, coin_amount,
      coin_type, status, external_ref, linked_event_id, notes, meta,
      fingerprint, import_id, is_deleted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);

  stmt.run(
    id,
    event.type,
    event.occurred_at || now,
    event.site_id || null,
    event.site_name || null,
    event.cash_amount || 0,
    event.coin_amount || 0,
    event.coin_type || null,
    event.status || null,
    event.external_ref || null,
    event.linked_event_id || null,
    event.notes || null,
    event.meta ? JSON.stringify(event.meta) : null,
    fingerprint,
    importId,
    now,
    now
  );

  const created = getById(id);

  // Record audit trail
  if (!skipAudit) {
    recordAudit(id, 'create', null, created);
  }

  return created;
}

/**
 * Update a ledger event
 */
function update(id, updates, options = {}) {
  const { skipAudit = false, notes = null } = options;

  const existing = getById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const fields = [];
  const values = [];
  const changedFields = [];

  // Allowed update fields
  const allowedFields = [
    'type', 'occurred_at', 'site_id', 'site_name', 'cash_amount', 'coin_amount',
    'coin_type', 'status', 'external_ref', 'linked_event_id', 'notes', 'meta'
  ];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      changedFields.push(field);
      if (field === 'meta') {
        fields.push(`${field} = ?`);
        values.push(JSON.stringify(updates[field]));
      } else {
        fields.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }
  }

  if (fields.length === 0) return existing;

  // Recalculate fingerprint if relevant fields changed
  const fingerprintFields = ['type', 'occurred_at', 'site_name', 'site_id', 'cash_amount', 'coin_amount', 'external_ref'];
  if (changedFields.some(f => fingerprintFields.includes(f))) {
    const merged = { ...existing, ...updates };
    fields.push('fingerprint = ?');
    values.push(generateFingerprint(merged));
  }

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  const sql = `UPDATE ledger_events SET ${fields.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);

  const updated = getById(id);

  // Record audit trail
  if (!skipAudit) {
    recordAudit(id, 'update', existing, updated, changedFields, notes);
  }

  return updated;
}

/**
 * Soft delete a ledger event
 */
function softDelete(id, options = {}) {
  const { skipAudit = false, notes = null } = options;

  const existing = getById(id);
  if (!existing) return false;

  db.prepare(
    "UPDATE ledger_events SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?"
  ).run(id);

  // Record audit trail
  if (!skipAudit) {
    recordAudit(id, 'delete', existing, { ...existing, is_deleted: true }, ['is_deleted'], notes);
  }

  return true;
}

/**
 * Restore a soft-deleted event
 */
function restore(id, options = {}) {
  const { skipAudit = false, notes = null } = options;

  const existing = getById(id, true); // Include deleted
  if (!existing || !existing.is_deleted) return false;

  db.prepare(
    "UPDATE ledger_events SET is_deleted = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(id);

  // Record audit trail
  if (!skipAudit) {
    recordAudit(id, 'restore', existing, { ...existing, is_deleted: false }, ['is_deleted'], notes);
  }

  return true;
}

/**
 * Get event by ID
 */
function getById(id, includeDeleted = false) {
  const sql = includeDeleted
    ? 'SELECT * FROM ledger_events WHERE id = ?'
    : 'SELECT * FROM ledger_events WHERE id = ? AND is_deleted = 0';

  const row = db.prepare(sql).get(id);
  return row ? formatEvent(row) : null;
}

/**
 * Get events by fingerprint (for deduplication)
 */
function getByFingerprint(fingerprint, includeDeleted = false) {
  const sql = includeDeleted
    ? 'SELECT * FROM ledger_events WHERE fingerprint = ?'
    : 'SELECT * FROM ledger_events WHERE fingerprint = ? AND is_deleted = 0';

  return db.prepare(sql).all(fingerprint).map(formatEvent);
}

/**
 * Check if fingerprint exists
 */
function fingerprintExists(fingerprint) {
  const row = db.prepare(
    'SELECT 1 FROM ledger_events WHERE fingerprint = ? AND is_deleted = 0 LIMIT 1'
  ).get(fingerprint);
  return !!row;
}

/**
 * Query events with filters
 */
function query(filters = {}) {
  const {
    type,
    types,
    siteId,
    siteName,
    status,
    startDate,
    endDate,
    includeDeleted = false,
    limit,
    offset = 0,
    orderBy = 'occurred_at',
    orderDir = 'DESC'
  } = filters;

  const conditions = [];
  const params = [];

  if (!includeDeleted) {
    conditions.push('is_deleted = 0');
  }

  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }

  if (types && types.length > 0) {
    conditions.push(`type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }

  if (siteId) {
    conditions.push('site_id = ?');
    params.push(siteId);
  }

  if (siteName) {
    conditions.push('LOWER(site_name) = LOWER(?)');
    params.push(siteName);
  }

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (startDate) {
    conditions.push('occurred_at >= ?');
    params.push(startDate);
  }

  if (endDate) {
    conditions.push('occurred_at < ?');
    // Add one day to end date for inclusive range
    const endDateObj = new Date(endDate);
    endDateObj.setDate(endDateObj.getDate() + 1);
    params.push(endDateObj.toISOString().split('T')[0]);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Validate order direction
  const dir = orderDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  // Validate order by column
  const validColumns = ['occurred_at', 'created_at', 'updated_at', 'cash_amount', 'site_name', 'type'];
  const orderColumn = validColumns.includes(orderBy) ? orderBy : 'occurred_at';

  let sql = `SELECT * FROM ledger_events ${whereClause} ORDER BY ${orderColumn} ${dir}`;

  if (limit) {
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);
  }

  return db.prepare(sql).all(...params).map(formatEvent);
}

/**
 * Get summary statistics for events
 */
function getSummary(filters = {}) {
  const {
    type,
    types,
    siteId,
    startDate,
    endDate
  } = filters;

  const conditions = ['is_deleted = 0'];
  const params = [];

  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }

  if (types && types.length > 0) {
    conditions.push(`type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }

  if (siteId) {
    conditions.push('site_id = ?');
    params.push(siteId);
  }

  if (startDate) {
    conditions.push('occurred_at >= ?');
    params.push(startDate);
  }

  if (endDate) {
    conditions.push('occurred_at < ?');
    const endDateObj = new Date(endDate);
    endDateObj.setDate(endDateObj.getDate() + 1);
    params.push(endDateObj.toISOString().split('T')[0]);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const sql = `
    SELECT
      COUNT(*) as count,
      SUM(CASE WHEN cash_amount > 0 THEN cash_amount ELSE 0 END) as total_cash_in,
      SUM(CASE WHEN cash_amount < 0 THEN ABS(cash_amount) ELSE 0 END) as total_cash_out,
      SUM(cash_amount) as net_cash,
      SUM(coin_amount) as total_coins,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
      SUM(CASE WHEN status = 'pending' THEN cash_amount ELSE 0 END) as pending_amount
    FROM ledger_events ${whereClause}
  `;

  return db.prepare(sql).get(...params);
}

/**
 * Get totals grouped by site
 */
function getTotalsBySite(filters = {}) {
  const { startDate, endDate, types } = filters;

  const conditions = ['is_deleted = 0'];
  const params = [];

  if (types && types.length > 0) {
    conditions.push(`type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }

  if (startDate) {
    conditions.push('occurred_at >= ?');
    params.push(startDate);
  }

  if (endDate) {
    conditions.push('occurred_at < ?');
    const endDateObj = new Date(endDate);
    endDateObj.setDate(endDateObj.getDate() + 1);
    params.push(endDateObj.toISOString().split('T')[0]);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const sql = `
    SELECT
      COALESCE(site_name, site_id, 'Unknown') as site_name,
      COUNT(*) as event_count,
      SUM(CASE WHEN type = 'purchase' THEN ABS(cash_amount) ELSE 0 END) as purchases_usd,
      SUM(CASE WHEN type = 'redemption_received' THEN cash_amount ELSE 0 END) as redemptions_received_usd,
      SUM(CASE WHEN type = 'redemption_requested' AND status = 'pending' THEN cash_amount ELSE 0 END) as redemptions_pending_usd,
      SUM(CASE WHEN type = 'daily_reward' THEN coin_amount ELSE 0 END) as daily_rewards_sc,
      SUM(coin_amount) as total_coins
    FROM ledger_events ${whereClause}
    GROUP BY COALESCE(site_name, site_id, 'Unknown')
    ORDER BY site_name
  `;

  return db.prepare(sql).all(...params);
}

/**
 * Get daily rewards for a specific date
 */
function getDailyRewards(date, siteId = null) {
  let sql = `
    SELECT * FROM ledger_events
    WHERE type = 'daily_reward'
    AND is_deleted = 0
    AND DATE(occurred_at) = DATE(?)
  `;
  const params = [date];

  if (siteId) {
    sql += ' AND site_id = ?';
    params.push(siteId);
  }

  return db.prepare(sql).all(...params).map(formatEvent);
}

/**
 * Get collections summary for a date (for tracker compatibility)
 */
function getCollectionsSummary(date) {
  const sql = `
    SELECT
      site_id,
      site_name,
      SUM(coin_amount) as sc_amount,
      SUM(CASE WHEN coin_type = 'GC' THEN coin_amount ELSE 0 END) as gc_amount,
      MAX(occurred_at) as last_collected
    FROM ledger_events
    WHERE type = 'daily_reward'
    AND is_deleted = 0
    AND DATE(occurred_at) = DATE(?)
    GROUP BY site_id, site_name
  `;

  return db.prepare(sql).all(date);
}

/**
 * Record audit trail entry
 */
function recordAudit(eventId, action, before, after, changedFields = null, notes = null) {
  const stmt = db.prepare(`
    INSERT INTO ledger_audit (event_id, action, before_data, after_data, changed_fields, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    eventId,
    action,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    changedFields ? JSON.stringify(changedFields) : null,
    notes
  );
}

/**
 * Get audit history for an event
 */
function getAuditHistory(eventId) {
  const sql = `
    SELECT * FROM ledger_audit
    WHERE event_id = ?
    ORDER BY created_at DESC
  `;

  return db.prepare(sql).all(eventId).map(row => ({
    id: row.id,
    event_id: row.event_id,
    action: row.action,
    actor: row.actor,
    before_data: row.before_data ? JSON.parse(row.before_data) : null,
    after_data: row.after_data ? JSON.parse(row.after_data) : null,
    changed_fields: row.changed_fields ? JSON.parse(row.changed_fields) : null,
    notes: row.notes,
    created_at: row.created_at
  }));
}

/**
 * Bulk create events (for imports)
 */
function bulkCreate(events, options = {}) {
  const { mode = 'skip', importId = null } = options;

  const results = {
    inserted: 0,
    skipped: 0,
    updated: 0,
    errors: []
  };

  const insertTransaction = db.transaction((eventsArray) => {
    for (const event of eventsArray) {
      try {
        const fingerprint = generateFingerprint(event);

        if (mode === 'skip' && fingerprintExists(fingerprint)) {
          results.skipped++;
          continue;
        }

        if (mode === 'upsert') {
          const existing = getByFingerprint(fingerprint);
          if (existing.length > 0) {
            update(existing[0].id, event, { skipAudit: true });
            results.updated++;
            continue;
          }
        }

        create(event, { skipAudit: true, importId });
        results.inserted++;
      } catch (err) {
        results.errors.push({ event, error: err.message });
      }
    }
  });

  insertTransaction(events);
  return results;
}

/**
 * Get tax-relevant data (purchases and redemptions)
 */
function getTaxData(filters = {}) {
  const { startDate, endDate, includePending = false } = filters;

  const conditions = ['is_deleted = 0'];
  const params = [];

  // Only include tax-relevant types
  const types = ['purchase', 'redemption_received'];
  if (includePending) {
    types.push('redemption_requested');
  }
  conditions.push(`type IN (${types.map(() => '?').join(', ')})`);
  params.push(...types);

  if (startDate) {
    conditions.push('occurred_at >= ?');
    params.push(startDate);
  }

  if (endDate) {
    conditions.push('occurred_at < ?');
    const endDateObj = new Date(endDate);
    endDateObj.setDate(endDateObj.getDate() + 1);
    params.push(endDateObj.toISOString().split('T')[0]);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // Get summary
  const summarySQL = `
    SELECT
      SUM(CASE WHEN type = 'purchase' THEN ABS(cash_amount) ELSE 0 END) as purchases_total,
      SUM(CASE WHEN type = 'redemption_received' THEN cash_amount ELSE 0 END) as redemptions_received,
      SUM(CASE WHEN type = 'redemption_requested' AND status = 'pending' THEN cash_amount ELSE 0 END) as redemptions_pending
    FROM ledger_events ${whereClause}
  `;

  const summary = db.prepare(summarySQL).get(...params);

  return {
    purchasesTotal: summary.purchases_total || 0,
    redemptionsReceived: summary.redemptions_received || 0,
    redemptionsPending: summary.redemptions_pending || 0
  };
}

// Helper function to format database row to event object
function formatEvent(row) {
  return {
    id: row.id,
    type: row.type,
    occurred_at: row.occurred_at,
    site_id: row.site_id,
    site_name: row.site_name,
    cash_amount: row.cash_amount,
    coin_amount: row.coin_amount,
    coin_type: row.coin_type,
    status: row.status,
    external_ref: row.external_ref,
    linked_event_id: row.linked_event_id,
    notes: row.notes,
    meta: row.meta ? JSON.parse(row.meta) : null,
    fingerprint: row.fingerprint,
    import_id: row.import_id,
    is_deleted: row.is_deleted === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

module.exports = {
  // Constants
  EVENT_TYPES,
  STATUSES,

  // CRUD operations
  create,
  update,
  softDelete,
  restore,
  getById,

  // Query operations
  query,
  getSummary,
  getTotalsBySite,
  getDailyRewards,
  getCollectionsSummary,
  getTaxData,

  // Deduplication
  generateFingerprint,
  getByFingerprint,
  fingerprintExists,

  // Bulk operations
  bulkCreate,

  // Audit
  recordAudit,
  getAuditHistory
};
