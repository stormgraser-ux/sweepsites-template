/**
 * Imports Repository
 * Manages import batches and tracks import history
 */

'use strict';

const { db } = require('../index');
const { v4: uuidv4 } = require('uuid');

/**
 * Create a new import batch
 */
function create(importData) {
  const id = uuidv4();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO imports (id, filename, source, mapping, total_rows, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `);

  stmt.run(
    id,
    importData.filename || null,
    importData.source || null,
    importData.mapping ? JSON.stringify(importData.mapping) : null,
    importData.total_rows || 0,
    now
  );

  return getById(id);
}

/**
 * Update import batch status and counts
 */
function update(id, updates) {
  const fields = [];
  const values = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (updates.total_rows !== undefined) {
    fields.push('total_rows = ?');
    values.push(updates.total_rows);
  }

  if (updates.inserted_count !== undefined) {
    fields.push('inserted_count = ?');
    values.push(updates.inserted_count);
  }

  if (updates.skipped_count !== undefined) {
    fields.push('skipped_count = ?');
    values.push(updates.skipped_count);
  }

  if (updates.error_count !== undefined) {
    fields.push('error_count = ?');
    values.push(updates.error_count);
  }

  if (updates.errors !== undefined) {
    fields.push('errors = ?');
    values.push(JSON.stringify(updates.errors));
  }

  if (updates.status === 'completed' || updates.status === 'failed') {
    fields.push('completed_at = datetime("now")');
  }

  if (fields.length === 0) return getById(id);

  values.push(id);
  const sql = `UPDATE imports SET ${fields.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);

  return getById(id);
}

/**
 * Get import by ID
 */
function getById(id) {
  const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
  return row ? formatImport(row) : null;
}

/**
 * Get all imports
 */
function getAll(limit = 100) {
  return db.prepare(
    'SELECT * FROM imports ORDER BY created_at DESC LIMIT ?'
  ).all(limit).map(formatImport);
}

/**
 * Get recent imports
 */
function getRecent(days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return db.prepare(
    'SELECT * FROM imports WHERE created_at >= ? ORDER BY created_at DESC'
  ).all(cutoff.toISOString()).map(formatImport);
}

/**
 * Add import item (raw row record)
 */
function addItem(importId, item) {
  const stmt = db.prepare(`
    INSERT INTO import_items (import_id, row_number, raw_data, mapped_data, status, error_message, event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    importId,
    item.row_number || null,
    item.raw_data ? JSON.stringify(item.raw_data) : null,
    item.mapped_data ? JSON.stringify(item.mapped_data) : null,
    item.status || 'pending',
    item.error_message || null,
    item.event_id || null
  );
}

/**
 * Get items for an import
 */
function getItems(importId, status = null) {
  let sql = 'SELECT * FROM import_items WHERE import_id = ?';
  const params = [importId];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY row_number';

  return db.prepare(sql).all(...params).map(row => ({
    id: row.id,
    import_id: row.import_id,
    row_number: row.row_number,
    raw_data: row.raw_data ? JSON.parse(row.raw_data) : null,
    mapped_data: row.mapped_data ? JSON.parse(row.mapped_data) : null,
    status: row.status,
    error_message: row.error_message,
    event_id: row.event_id,
    created_at: row.created_at
  }));
}

/**
 * Delete an import and its items
 */
function remove(id) {
  const deleteTransaction = db.transaction(() => {
    db.prepare('DELETE FROM import_items WHERE import_id = ?').run(id);
    db.prepare('DELETE FROM imports WHERE id = ?').run(id);
  });

  deleteTransaction();
  return true;
}

// Helper function to format import row
function formatImport(row) {
  return {
    id: row.id,
    filename: row.filename,
    source: row.source,
    mapping: row.mapping ? JSON.parse(row.mapping) : null,
    total_rows: row.total_rows,
    inserted_count: row.inserted_count,
    skipped_count: row.skipped_count,
    error_count: row.error_count,
    errors: row.errors ? JSON.parse(row.errors) : null,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at
  };
}

module.exports = {
  create,
  update,
  getById,
  getAll,
  getRecent,
  addItem,
  getItems,
  remove
};
