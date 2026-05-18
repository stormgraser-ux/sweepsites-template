/**
 * Sweepsites Tracker Server
 * Express API with SQLite-backed unified ledger
 */

'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const multer = require('multer');
const { spawn } = require('child_process');

// Database and repositories
const { runMigrations, db } = require('./db');
const sitesRepo = require('./db/repositories/sites');
const ledgerRepo = require('./db/repositories/ledger');
const importsRepo = require('./db/repositories/imports');
const { migrateAll } = require('./db/migrate-data');

const app = express();
const PORT = process.env.PORT || 3050;

// Multer setup for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const EXPORTS_DIR = path.join(__dirname, '..', 'exports');

// Legacy JSON file paths (for backwards compatibility during migration)
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const COLLECTIONS_FILE = path.join(DATA_DIR, 'collections.json');

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'app')));

// Ensure directories exist
function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }
}

// Legacy JSON helpers (for backwards compatibility)
function readJSON(filepath) {
  try {
    if (!fs.existsSync(filepath)) return [];
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    return [];
  }
}

function getTodayDate() {
  // Use Pacific Time for "today" — collections count as "today" until
  // midnight Pacific, not midnight UTC. Change this to your timezone.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function roundToCents(value) {
  return Math.round((value || 0) * 100) / 100;
}

/**
 * Classify a cooldown report by comparing against expected reset window.
 * Returns: 'expected' | 'suspicious' | 'stale' | 'suspended'
 */
function classifyCooldown(site, message, lastCollectionTime) {
  // Check for suspended keywords first
  if (message && /not available|suspended|paused|disabled/i.test(message)) {
    return 'suspended';
  }

  // Check if cooldown_since indicates a stale streak (>48h of consecutive cooldowns)
  if (site.cooldown_since) {
    const streakMs = Date.now() - new Date(site.cooldown_since).getTime();
    if (streakMs > 48 * 3600000) return 'stale';
  }

  if (!lastCollectionTime) {
    // Never collected — can't reason about window
    return 'suspicious';
  }

  const lastTime = new Date(lastCollectionTime).getTime();
  const now = Date.now();

  // Fixed wall-clock reset
  const meta = typeof site.meta === 'string' ? JSON.parse(site.meta || '{}') : (site.meta || {});
  const resetHour = meta.reset_hour_utc;
  if (resetHour != null) {
    const nowDate = new Date(now);
    const todayReset = new Date(Date.UTC(
      nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate(), resetHour, 0, 0
    ));
    const mostRecentReset = todayReset.getTime() <= now
      ? todayReset
      : new Date(todayReset.getTime() - 86400000);
    if (lastTime >= mostRecentReset.getTime()) return 'expected';
    return 'suspicious';
  }

  // Rolling cooldown (24hr default)
  const cooldownMs = (site.cooldown_minutes || 1440) * 60000;
  if ((now - lastTime) < cooldownMs) return 'expected';

  return 'suspicious';
}

// ============ SITES API ============

// Get all sites
app.get('/api/sites', (req, res) => {
  try {
    const sites = sitesRepo.getAllWithPnL();

    // Build collection count map per site (for KYC nudge threshold)
    const collectionCounts = db.prepare(`
      SELECT site_id, COUNT(*) as count
      FROM ledger_events
      WHERE type = 'daily_reward' AND is_deleted = 0
      GROUP BY site_id
    `).all();
    const countMap = {};
    for (const row of collectionCounts) {
      countMap[row.site_id] = row.count;
    }

    // Build last collection time map per site (for staleness detection)
    const lastCollections = db.prepare(`
      SELECT site_id, MAX(occurred_at) as last_collected
      FROM ledger_events
      WHERE type = 'daily_reward' AND is_deleted = 0
      GROUP BY site_id
    `).all();
    const lastCollectedMap = {};
    const now = Date.now();
    for (const row of lastCollections) {
      lastCollectedMap[row.site_id] = {
        last_collected: row.last_collected,
        days_since_collection: Math.floor((now - new Date(row.last_collected).getTime()) / 86400000)
      };
    }

    // Format for backwards compatibility + new onboarding fields
    const formatted = sites.map(s => ({
      id: s.id,
      name: s.name,
      url: s.url,
      typical_sc: s.typical_sc,
      typical_gc: s.typical_gc,
      reset_type: s.reset_type,
      cooldown_minutes: s.cooldown_minutes,
      active: s.active,
      bankroll: s.bankroll,
      pnl: s.computed_pnl,
      pnl_ytd: s.computed_pnl_ytd,
      meta: s.meta || null,
      last_checked: s.last_checked || null,
      // Onboarding fields (repo returns booleans for is_starter and welcome_bonus_claimed)
      account_status: s.account_status || null,
      welcome_bonus_claimed: !!s.welcome_bonus_claimed,
      is_starter: !!s.is_starter,
      collection_count: countMap[s.id] || 0,
      last_collected: lastCollectedMap[s.id]?.last_collected || null,
      days_since_collection: lastCollectedMap[s.id]?.days_since_collection ?? null,
      cooldown_reason: s.cooldown_reason || null,
      cooldown_message: s.cooldown_message || null,
      cooldown_since: s.cooldown_since || null,
      // Focus strip
      pinned: !!s.pinned
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new site
app.post('/api/sites', (req, res) => {
  try {
    const newSite = sitesRepo.create({
      id: req.body.id || req.body.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      name: req.body.name,
      url: req.body.url || '',
      typical_sc: parseFloat(req.body.typical_sc) || 0,
      typical_gc: parseInt(req.body.typical_gc) || 0,
      reset_type: req.body.reset_type || '24hr',
      active: req.body.active !== false
    });
    res.json({
      id: newSite.id,
      name: newSite.name,
      url: newSite.url,
      typical_sc: newSite.typical_sc,
      typical_gc: newSite.typical_gc,
      reset_type: newSite.reset_type,
      active: newSite.active
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a site
app.put('/api/sites/:id', (req, res) => {
  try {
    const updated = sitesRepo.update(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Site not found' });
    }
    res.json({
      id: updated.id,
      name: updated.name,
      url: updated.url,
      typical_sc: updated.typical_sc,
      typical_gc: updated.typical_gc,
      reset_type: updated.reset_type,
      active: updated.active,
      bankroll: updated.bankroll,
      pnl: updated.pnl,
      meta: updated.meta || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a cooldown report with classification
app.post('/api/sites/:id/cooldown', (req, res) => {
  try {
    const site = sitesRepo.getById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const message = req.body.message || 'On cooldown';

    // Get last collection time for classification
    const lastRow = db.prepare(
      "SELECT MAX(occurred_at) as last_collected FROM ledger_events WHERE site_id = ? AND type = 'daily_reward' AND is_deleted = 0"
    ).get(req.params.id);

    const reason = classifyCooldown(site, message, lastRow?.last_collected);
    sitesRepo.recordCooldown(req.params.id, reason, message);

    res.json({ id: req.params.id, cooldown_reason: reason, cooldown_message: message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a site
app.delete('/api/sites/:id', (req, res) => {
  try {
    sitesRepo.remove(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk import sites
app.post('/api/sites/bulk', (req, res) => {
  try {
    const sites = req.body.sites || [];
    const results = sitesRepo.bulkUpsert(sites);
    res.json({ imported: results.inserted + results.updated, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ COLLECTIONS API (writes to ledger) ============

// Get all collections (optionally filter by date)
app.get('/api/collections', (req, res) => {
  try {
    const dateFilter = req.query.date;
    const events = ledgerRepo.query({
      type: 'daily_reward',
      startDate: dateFilter,
      endDate: dateFilter,
      orderBy: 'occurred_at',
      orderDir: 'DESC'
    });

    // Format for backwards compatibility
    const collections = events.map(e => ({
      id: e.id,
      site_id: e.site_id,
      date: e.occurred_at.split('T')[0],
      timestamp: e.occurred_at,
      sc_amount: e.coin_amount,
      gc_amount: e.meta?.gc_amount || 0,
      method: e.meta?.method || 'manual'
    }));

    res.json(collections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get today's collections
app.get('/api/collections/today', (req, res) => {
  try {
    const today = getTodayDate();
    const events = ledgerRepo.getDailyRewards(today);

    // Format for backwards compatibility
    const collections = events.map(e => ({
      id: e.id,
      site_id: e.site_id,
      date: e.occurred_at.split('T')[0],
      timestamp: e.occurred_at,
      sc_amount: e.coin_amount,
      gc_amount: e.meta?.gc_amount || 0,
      method: e.meta?.method || 'manual'
    }));

    res.json(collections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get last collection time for each site (for runner cooldown calculation).
// This must stay ledger-only: cooldown_since is a diagnostic/check timestamp,
// not proof that a daily reward was collected.
app.get('/api/collections/last', (req, res) => {
  try {
    const sql = `
      SELECT site_id, MAX(occurred_at) as occurred_at
      FROM ledger_events
      WHERE type = 'daily_reward' AND is_deleted = 0
      GROUP BY site_id
    `;
    const results = db.prepare(sql).all();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a collection (creates ledger event)
app.post('/api/collections', (req, res) => {
  try {
    const site = sitesRepo.getById(req.body.site_id);

    // If site_id is provided but site doesn't exist, return error
    if (req.body.site_id && !site) {
      return res.status(400).json({
        error: `Site not found: ${req.body.site_id}`,
        details: 'The specified site_id does not exist in the database'
      });
    }

    const now = new Date().toISOString();
    const date = req.body.date || getTodayDate();

    const event = ledgerRepo.create({
      type: 'daily_reward',
      occurred_at: now,
      site_id: site ? site.id : req.body.site_id,  // Use DB id or fallback to request id
      site_name: site ? site.name : req.body.site_id,
      coin_amount: parseFloat(req.body.sc_amount) || 0,
      coin_type: 'SC',
      meta: {
        gc_amount: parseInt(req.body.gc_amount) || 0,
        method: req.body.method || 'manual'
      }
    });

    // Clear any cooldown state — site just collected successfully
    if (site) sitesRepo.clearCooldown(site.id);

    // Format response for backwards compatibility
    res.json({
      id: event.id,
      site_id: event.site_id,
      date: date,
      timestamp: event.occurred_at,
      sc_amount: event.coin_amount,
      gc_amount: event.meta?.gc_amount || 0,
      method: event.meta?.method || 'manual'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a collection
app.delete('/api/collections/:id', (req, res) => {
  try {
    ledgerRepo.softDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ONBOARDING / ACCOUNT STATUS API ============

// Count total collection events ever (for empty-state banner)
app.get('/api/collections/count', (req, res) => {
  try {
    const row = db.prepare(
      "SELECT COUNT(*) as count FROM ledger_events WHERE type = 'daily_reward' AND is_deleted = 0"
    ).get();
    res.json({ count: row.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update account status for a site
app.patch('/api/sites/:id/account-status', (req, res) => {
  try {
    const { status } = req.body;
    const allowed = [null, 'registered', 'kyc_done'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be null, "registered", or "kyc_done".' });
    }
    const site = sitesRepo.getById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    db.prepare("UPDATE sites SET account_status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, req.params.id);

    res.json({ id: req.params.id, account_status: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pin / unpin a site for the focus strip (hard cap of 4 pinned)
app.patch('/api/sites/:id/pin', (req, res) => {
  try {
    const { pinned } = req.body;
    const site = sitesRepo.getById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const PIN_CAP = 4;
    if (pinned && !site.pinned) {
      const current = sitesRepo.countPinned();
      if (current >= PIN_CAP) {
        return res.status(400).json({
          error: `Focus strip is full (${PIN_CAP} pinned). Unpin one first.`,
          cap: PIN_CAP,
          current
        });
      }
    }

    const updated = sitesRepo.update(req.params.id, { pinned: !!pinned });
    res.json({ id: updated.id, pinned: updated.pinned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark welcome bonus claimed for a site
app.patch('/api/sites/:id/welcome-bonus', (req, res) => {
  try {
    const { claimed } = req.body;
    const site = sitesRepo.getById(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    db.prepare("UPDATE sites SET welcome_bonus_claimed = ?, updated_at = datetime('now') WHERE id = ?")
      .run(claimed ? 1 : 0, req.params.id);

    res.json({ id: req.params.id, welcome_bonus_claimed: !!claimed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get daily summary stats
app.get('/api/stats/daily', (req, res) => {
  try {
    const date = req.query.date || getTodayDate();
    const sites = sitesRepo.getAll().filter(s => s.active && !s.hidden);
    const collections = ledgerRepo.getDailyRewards(date);

    const collectedSiteIds = new Set(collections.map(c => c.site_id));

    const stats = {
      date,
      total_sites: sites.length,
      collected: collections.length,
      pending: sites.filter(s => !collectedSiteIds.has(s.id)).length,
      total_sc: collections.reduce((sum, c) => sum + (c.coin_amount || 0), 0),
      total_gc: collections.reduce((sum, c) => sum + (c.meta?.gc_amount || 0), 0)
    };

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ GAME SESSION STATS API ============

// GET /api/game-stats — aggregate realized RTP & volatility across playthrough sessions
app.get('/api/game-stats', (req, res) => {
  try {
    const allEvents = ledgerRepo.query({ limit: 10000 });
    const sessions = allEvents.filter(e => e.type === 'session' && e.meta?.realized_rtp);

    // Group by game name
    const byGame = {};
    for (const s of sessions) {
      const key = `${s.site_name}|${s.meta.game}`;
      if (!byGame[key]) byGame[key] = { site: s.site_name, game: s.meta.game, provider: s.meta.provider, sessions: [] };
      byGame[key].sessions.push(s);
    }

    const stats = Object.values(byGame).map(g => {
      const rtps = g.sessions.map(s => s.meta.realized_rtp);
      const totalSpins = g.sessions.reduce((sum, s) => sum + (s.meta.spins || 0), 0);
      const totalWagered = g.sessions.reduce((sum, s) => sum + (s.meta.total_wagered || 0), 0);
      const totalReturned = g.sessions.reduce((sum, s) => sum + (s.meta.total_returned || 0), 0);
      const avgRtp = totalWagered > 0 ? (totalReturned / totalWagered) * 100 : 0;
      const advertisedRtp = g.sessions.find(s => s.meta.advertised_rtp)?.meta.advertised_rtp || null;

      // Volatility: std dev of per-session RTPs (needs 2+ sessions)
      let volatility = null;
      if (rtps.length >= 2) {
        const mean = rtps.reduce((a, b) => a + b, 0) / rtps.length;
        const variance = rtps.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (rtps.length - 1);
        volatility = Math.sqrt(variance);
      }

      return {
        site: g.site,
        game: g.game,
        provider: g.provider,
        session_count: g.sessions.length,
        total_spins: totalSpins,
        total_wagered: Math.round(totalWagered * 100) / 100,
        realized_rtp: Math.round(avgRtp * 100) / 100,
        advertised_rtp: advertisedRtp,
        rtp_delta: advertisedRtp ? Math.round((avgRtp - advertisedRtp) * 100) / 100 : null,
        volatility: volatility !== null ? Math.round(volatility * 100) / 100 : 'need 2+ sessions',
        last_session: g.sessions[g.sessions.length - 1].occurred_at,
      };
    });

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ HISTORY/REPORTS API (reads from ledger) ============

// Helper to build date filters
function buildDateFilters(start, end) {
  const filters = {};
  if (start) filters.startDate = start;
  if (end) filters.endDate = end;
  return filters;
}

// Get purchases with date range
app.get('/api/history/purchases', (req, res) => {
  try {
    const { start, end, casino } = req.query;

    const events = ledgerRepo.query({
      type: 'purchase',
      ...buildDateFilters(start, end),
      orderBy: 'occurred_at',
      orderDir: 'DESC'
    });

    // Filter by casino name if provided
    let data = events;
    if (casino) {
      data = data.filter(e =>
        (e.site_name || '').toLowerCase().includes(casino.toLowerCase())
      );
    }

    // Format for backwards compatibility
    const formatted = data.map(e => ({
      date: e.occurred_at.split('T')[0],
      casino_name: e.site_name || '',
      usd_spent: Math.abs(e.cash_amount || 0),
      amount_coins: e.coin_amount || 0,
      payment_method: e.meta?.payment_method || '',
      tx_id: e.external_ref || '',
      note: e.notes || ''
    }));

    const summary = {
      count: formatted.length,
      total_usd: roundToCents(formatted.reduce((sum, d) => sum + d.usd_spent, 0)),
      total_coins: formatted.reduce((sum, d) => sum + d.amount_coins, 0)
    };

    res.json({ summary, data: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get redemptions with date range
app.get('/api/history/redemptions', (req, res) => {
  try {
    const { start, end, casino, status } = req.query;

    // Get both requested and received
    const events = ledgerRepo.query({
      types: ['redemption_requested', 'redemption_received'],
      ...buildDateFilters(start, end),
      orderBy: 'occurred_at',
      orderDir: 'DESC'
    });

    // Filter by casino name if provided
    let data = events;
    if (casino) {
      data = data.filter(e =>
        (e.site_name || '').toLowerCase().includes(casino.toLowerCase())
      );
    }

    // Filter by status if provided
    if (status) {
      data = data.filter(e => e.status === status);
    }

    // Format for backwards compatibility
    const formatted = data.map(e => ({
      date: e.occurred_at.split('T')[0],
      casino_name: e.site_name || '',
      amount_coins: e.coin_amount || 0,
      usd_received: e.cash_amount || 0,
      redemption_method: e.meta?.redemption_method || '',
      status: e.status || 'received',
      tx_id: e.external_ref || '',
      note: e.notes || ''
    }));

    const summary = {
      count: formatted.length,
      total_usd: roundToCents(formatted.reduce((sum, d) => sum + d.usd_received, 0)),
      total_coins: formatted.reduce((sum, d) => sum + d.amount_coins, 0),
      pending: formatted.filter(d => d.status === 'pending').length
    };

    res.json({ summary, data: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get rewards with date range
app.get('/api/history/rewards', (req, res) => {
  try {
    const { start, end, casino } = req.query;

    const events = ledgerRepo.query({
      type: 'daily_reward',
      ...buildDateFilters(start, end),
      orderBy: 'occurred_at',
      orderDir: 'DESC'
    });

    // Filter by casino name if provided
    let data = events;
    if (casino) {
      data = data.filter(e =>
        (e.site_name || '').toLowerCase().includes(casino.toLowerCase())
      );
    }

    // Format for backwards compatibility
    const formatted = data.map(e => ({
      date: e.occurred_at.split('T')[0],
      casino_name: e.site_name || '',
      reward_type: e.meta?.reward_type || 'daily_reward',
      amount_coins: e.coin_amount || 0,
      note: e.notes || ''
    }));

    const summary = {
      count: formatted.length,
      total_coins: roundToCents(formatted.reduce((sum, d) => sum + d.amount_coins, 0))
    };

    res.json({ summary, data: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get sessions with date range
app.get('/api/history/sessions', (req, res) => {
  try {
    const { start, end, casino } = req.query;

    const events = ledgerRepo.query({
      type: 'session',
      ...buildDateFilters(start, end),
      orderBy: 'occurred_at',
      orderDir: 'DESC'
    });

    // Filter by casino name if provided
    let data = events;
    if (casino) {
      data = data.filter(e =>
        (e.site_name || '').toLowerCase().includes(casino.toLowerCase())
      );
    }

    // Format for backwards compatibility
    const formatted = data.map(e => ({
      date: e.occurred_at.split('T')[0],
      casino_name: e.site_name || '',
      game_name: e.meta?.game_name || '',
      starting_balance: e.meta?.starting_balance || 0,
      ending_balance: e.meta?.ending_balance || 0,
      amount_wagered: e.meta?.amount_wagered || e.coin_amount || 0,
      note: e.notes || ''
    }));

    const summary = {
      count: formatted.length,
      total_wagered: roundToCents(formatted.reduce((sum, d) => sum + d.amount_wagered, 0)),
      net_pnl: roundToCents(formatted.reduce((sum, d) => sum + (d.ending_balance - d.starting_balance), 0))
    };

    res.json({ summary, data: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full tax report for a date range
app.get('/api/history/tax-report', (req, res) => {
  try {
    const { start, end } = req.query;

    const totals = ledgerRepo.getTotalsBySite({
      startDate: start,
      endDate: end,
      types: ['purchase', 'redemption_requested', 'redemption_received', 'daily_reward']
    });

    // Build byCasino format
    const byCasino = {};
    totals.forEach(t => {
      byCasino[t.site_name] = {
        purchases: roundToCents(t.purchases_usd || 0),
        redemptions: roundToCents(t.redemptions_received_usd || 0),
        rewards: t.daily_rewards_sc || 0,
        pnl: roundToCents((t.redemptions_received_usd || 0) - (t.purchases_usd || 0))
      };
    });

    // Calculate overall totals
    const overallTotals = {
      purchases: roundToCents(totals.reduce((sum, t) => sum + (t.purchases_usd || 0), 0)),
      redemptions: roundToCents(totals.reduce((sum, t) => sum + (t.redemptions_received_usd || 0), 0)),
      rewards_count: totals.reduce((sum, t) => sum + (t.event_count || 0), 0),
      rewards_coins: roundToCents(totals.reduce((sum, t) => sum + (t.daily_rewards_sc || 0), 0))
    };
    overallTotals.net_pnl = roundToCents(overallTotals.redemptions - overallTotals.purchases);

    res.json({ totals: overallTotals, byCasino, dateRange: { start, end } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export history data to CSV
app.get('/api/history/export/:type', (req, res) => {
  try {
    const { type } = req.params;
    const { start, end } = req.query;

    const typeMapping = {
      purchases: 'purchase',
      redemptions: ['redemption_requested', 'redemption_received'],
      rewards: 'daily_reward',
      sessions: 'session'
    };

    if (!typeMapping[type]) {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const eventType = typeMapping[type];
    const events = ledgerRepo.query({
      ...(Array.isArray(eventType) ? { types: eventType } : { type: eventType }),
      ...buildDateFilters(start, end),
      orderBy: 'occurred_at',
      orderDir: 'ASC'
    });

    // Format based on type
    let data;
    if (type === 'purchases') {
      data = events.map(e => ({
        date: e.occurred_at.split('T')[0],
        casino_name: e.site_name,
        usd_spent: Math.abs(e.cash_amount),
        amount_coins: e.coin_amount,
        payment_method: e.meta?.payment_method || '',
        note: e.notes || ''
      }));
    } else if (type === 'redemptions') {
      data = events.map(e => ({
        date: e.occurred_at.split('T')[0],
        casino_name: e.site_name,
        amount_coins: e.coin_amount,
        usd_received: e.cash_amount,
        redemption_method: e.meta?.redemption_method || '',
        status: e.status,
        note: e.notes || ''
      }));
    } else if (type === 'rewards') {
      data = events.map(e => ({
        date: e.occurred_at.split('T')[0],
        casino_name: e.site_name,
        reward_type: e.meta?.reward_type || 'daily_reward',
        amount_coins: e.coin_amount,
        note: e.notes || ''
      }));
    } else {
      data = events.map(e => ({
        date: e.occurred_at.split('T')[0],
        casino_name: e.site_name,
        game_name: e.meta?.game_name || '',
        starting_balance: e.meta?.starting_balance || 0,
        ending_balance: e.meta?.ending_balance || 0,
        amount_wagered: e.meta?.amount_wagered || 0,
        note: e.notes || ''
      }));
    }

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, type);

    const filename = `${type}-${start || 'all'}-to-${end || 'all'}.csv`;
    const filepath = path.join(EXPORTS_DIR, filename);
    XLSX.writeFile(workbook, filepath, { bookType: 'csv' });

    res.download(filepath, filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CSV EXPORT SUMMARIES ============

// Export collections to CSV
app.get('/api/export/csv', (req, res) => {
  try {
    const events = ledgerRepo.query({
      type: 'daily_reward',
      orderBy: 'occurred_at',
      orderDir: 'ASC'
    });

    const data = events.map(e => ({
      Date: e.occurred_at.split('T')[0],
      Time: e.occurred_at,
      Site: e.site_name || e.site_id,
      'SC Amount': e.coin_amount,
      'GC Amount': e.meta?.gc_amount || 0,
      Method: e.meta?.method || 'manual'
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Collections');

    const filename = `collections-${getTodayDate()}.csv`;
    const filepath = path.join(EXPORTS_DIR, filename);
    XLSX.writeFile(workbook, filepath, { bookType: 'csv' });

    res.download(filepath, filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export today's collections
app.get('/api/export/today', (req, res) => {
  try {
    const today = getTodayDate();
    const events = ledgerRepo.getDailyRewards(today);

    const data = events.map(e => ({
      Time: e.occurred_at,
      Site: e.site_name || e.site_id,
      'SC Amount': e.coin_amount,
      'GC Amount': e.meta?.gc_amount || 0
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Today');

    const filename = `today-${today}.csv`;
    const filepath = path.join(EXPORTS_DIR, filename);
    XLSX.writeFile(workbook, filepath, { bookType: 'csv' });

    res.download(filepath, filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export Ledger CSV - combined purchases and redemptions
app.get('/api/export/ledger', (req, res) => {
  try {
    const { year, start, end } = req.query;
    let startDate, endDate;

    if (start && end) {
      startDate = start;
      endDate = end;
    } else {
      const targetYear = year || new Date().getFullYear().toString();
      startDate = `${targetYear}-01-01`;
      endDate = `${targetYear}-12-31`;
    }

    const events = ledgerRepo.query({
      types: ['purchase', 'redemption_requested', 'redemption_received'],
      startDate,
      endDate,
      orderBy: 'occurred_at',
      orderDir: 'ASC'
    });

    const ledger = events.map(e => ({
      date: e.occurred_at.split('T')[0],
      type: e.type === 'purchase' ? 'purchase' : 'redemption',
      site: e.site_name || '',
      amount_usd: roundToCents(e.type === 'purchase' ? Math.abs(e.cash_amount) : e.cash_amount),
      status: e.status || 'completed',
      method: e.meta?.payment_method || e.meta?.redemption_method || '',
      tx_id: e.external_ref || '',
      notes: e.notes || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(ledger);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Ledger');

    const filename = `ledger_${year || 'export'}.csv`;
    const filepath = path.join(EXPORTS_DIR, filename);
    XLSX.writeFile(workbook, filepath, { bookType: 'csv' });

    res.download(filepath, filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export Totals by Site CSV
app.get('/api/export/by-site', (req, res) => {
  try {
    const { year, start, end } = req.query;
    let startDate, endDate;

    if (start && end) {
      startDate = start;
      endDate = end;
    } else {
      const targetYear = year || new Date().getFullYear().toString();
      startDate = `${targetYear}-01-01`;
      endDate = `${targetYear}-12-31`;
    }

    const totals = ledgerRepo.getTotalsBySite({
      startDate,
      endDate,
      types: ['purchase', 'redemption_requested', 'redemption_received']
    });

    const data = totals.map(t => ({
      site: t.site_name,
      redemptions_received_usd: roundToCents(t.redemptions_received_usd || 0),
      redemptions_pending_usd: roundToCents(t.redemptions_pending_usd || 0),
      purchases_usd: roundToCents(t.purchases_usd || 0),
      net_received_minus_purchases: roundToCents((t.redemptions_received_usd || 0) - (t.purchases_usd || 0))
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'By Site');

    const filename = `by_site_totals_${year || 'export'}.csv`;
    const filepath = path.join(EXPORTS_DIR, filename);
    XLSX.writeFile(workbook, filepath, { bookType: 'csv' });

    res.download(filepath, filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export Tax Inputs Summary CSV
app.get('/api/export/tax-inputs', (req, res) => {
  try {
    const { year, filing_status, treatment, include_pending, start, end } = req.query;
    let startDate, endDate;

    if (start && end) {
      startDate = start;
      endDate = end;
    } else {
      const targetYear = year || new Date().getFullYear().toString();
      startDate = `${targetYear}-01-01`;
      endDate = `${targetYear}-12-31`;
    }

    const taxData = ledgerRepo.getTaxData({
      startDate,
      endDate,
      includePending: include_pending === 'true'
    });

    const includePendingBool = include_pending === 'true';
    const grossIncome = roundToCents(taxData.redemptionsReceived + (includePendingBool ? taxData.redemptionsPending : 0));

    // Build CSV with disclaimer row first
    const disclaimerRow = {
      informational_only: 'TRUE - This is an informational summary only. Not a tax form.',
      filing_status: '',
      treatment: '',
      include_pending: '',
      gross_income: '',
      purchases_total: '',
      redemptions_received: '',
      redemptions_pending: ''
    };

    const dataRow = {
      informational_only: 'true',
      filing_status: filing_status || 'single',
      treatment: treatment || 'sweepstakes',
      include_pending: includePendingBool ? 'yes' : 'no',
      gross_income: roundToCents(grossIncome),
      purchases_total: roundToCents(taxData.purchasesTotal),
      redemptions_received: roundToCents(taxData.redemptionsReceived),
      redemptions_pending: roundToCents(taxData.redemptionsPending)
    };

    const worksheet = XLSX.utils.json_to_sheet([disclaimerRow, dataRow]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Tax Inputs');

    const filename = `tax_inputs_summary_${year || 'export'}.csv`;
    const filepath = path.join(EXPORTS_DIR, filename);
    XLSX.writeFile(workbook, filepath, { bookType: 'csv' });

    res.download(filepath, filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export current view (generic endpoint for any filtered view)
app.get('/api/export/current-view', (req, res) => {
  try {
    const { tab, start, end, sort, dir } = req.query;

    const typeMapping = {
      purchases: 'purchase',
      redemptions: ['redemption_requested', 'redemption_received'],
      rewards: 'daily_reward',
      sessions: 'session'
    };

    const eventType = typeMapping[tab] || 'purchase';
    const events = ledgerRepo.query({
      ...(Array.isArray(eventType) ? { types: eventType } : { type: eventType }),
      ...buildDateFilters(start, end),
      orderBy: sort || 'occurred_at',
      orderDir: dir || 'DESC'
    });

    // Format based on tab type
    let data;
    if (tab === 'purchases') {
      data = events.map(e => ({
        Date: e.occurred_at.split('T')[0],
        Casino: e.site_name,
        'USD Spent': roundToCents(Math.abs(e.cash_amount)),
        Coins: e.coin_amount,
        Note: e.notes || ''
      }));
    } else if (tab === 'redemptions') {
      data = events.map(e => ({
        Date: e.occurred_at.split('T')[0],
        Casino: e.site_name,
        Coins: e.coin_amount,
        'USD Received': roundToCents(e.cash_amount),
        Method: e.meta?.redemption_method || '',
        Status: e.status || 'received',
        Note: e.notes || ''
      }));
    } else if (tab === 'rewards') {
      data = events.map(e => ({
        Date: e.occurred_at.split('T')[0],
        Casino: e.site_name,
        Type: e.meta?.reward_type || 'daily_reward',
        Amount: e.coin_amount,
        Note: e.notes || ''
      }));
    } else {
      data = events.map(e => ({
        Date: e.occurred_at.split('T')[0],
        Casino: e.site_name,
        Game: e.meta?.game_name || '',
        'Start Balance': e.meta?.starting_balance || 0,
        'End Balance': e.meta?.ending_balance || 0,
        'P&L': roundToCents((e.meta?.ending_balance || 0) - (e.meta?.starting_balance || 0)),
        Note: e.notes || ''
      }));
    }

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, tab || 'Export');

    const filename = `${tab || 'export'}-${start || 'all'}-to-${end || 'all'}.csv`;
    const filepath = path.join(EXPORTS_DIR, filename);
    XLSX.writeFile(workbook, filepath, { bookType: 'csv' });

    res.download(filepath, filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get export data as JSON (for client-side usage)
app.get('/api/export/data', (req, res) => {
  try {
    const { year, start, end } = req.query;
    let startDate, endDate;

    if (start && end) {
      startDate = start;
      endDate = end;
    } else {
      const targetYear = year || new Date().getFullYear().toString();
      startDate = `${targetYear}-01-01`;
      endDate = `${targetYear}-12-31`;
    }

    const taxData = ledgerRepo.getTaxData({ startDate, endDate, includePending: true });
    const totals = ledgerRepo.getTotalsBySite({
      startDate,
      endDate,
      types: ['purchase', 'redemption_requested', 'redemption_received']
    });

    // Build site map
    const bySite = {};
    totals.forEach(t => {
      bySite[t.site_name] = {
        received: roundToCents(t.redemptions_received_usd || 0),
        pending: roundToCents(t.redemptions_pending_usd || 0),
        purchases: roundToCents(t.purchases_usd || 0)
      };
    });

    // Get raw events for detailed export
    const purchases = ledgerRepo.query({
      type: 'purchase',
      startDate,
      endDate,
      orderBy: 'occurred_at'
    }).map(e => ({
      date: e.occurred_at.split('T')[0],
      casino_name: e.site_name,
      usd_spent: Math.abs(e.cash_amount),
      amount_coins: e.coin_amount,
      note: e.notes || ''
    }));

    const redemptions = ledgerRepo.query({
      types: ['redemption_requested', 'redemption_received'],
      startDate,
      endDate,
      orderBy: 'occurred_at'
    }).map(e => ({
      date: e.occurred_at.split('T')[0],
      casino_name: e.site_name,
      amount_coins: e.coin_amount,
      usd_received: e.cash_amount,
      status: e.status || 'received',
      note: e.notes || ''
    }));

    res.json({
      year: year || new Date().getFullYear().toString(),
      totals: {
        redemptionsReceived: roundToCents(taxData.redemptionsReceived),
        redemptionsPending: roundToCents(taxData.redemptionsPending),
        purchasesTotal: roundToCents(taxData.purchasesTotal)
      },
      bySite,
      purchases,
      redemptions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ LEDGER API (direct access) ============

// Get ledger events with filters
app.get('/api/ledger', (req, res) => {
  try {
    const { type, types, site, status, start, end, limit, offset, sort, dir } = req.query;

    const events = ledgerRepo.query({
      type,
      types: types ? types.split(',') : undefined,
      siteId: site,
      status,
      startDate: start,
      endDate: end,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : 0,
      orderBy: sort || 'occurred_at',
      orderDir: dir || 'DESC'
    });

    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single ledger event
app.get('/api/ledger/:id', (req, res) => {
  try {
    const event = ledgerRepo.getById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create ledger event
app.post('/api/ledger', (req, res) => {
  try {
    const event = ledgerRepo.create(req.body);
    if (!event) {
      return res.status(422).json({ error: 'Event rejected by validation (e.g. negative daily_reward)' });
    }

    // When a redemption is requested, deduct from site bankroll immediately
    // (SC leaves the casino account at request time, not when received)
    if (event.type === 'redemption_requested' && event.site_id && event.cash_amount > 0) {
      const site = sitesRepo.getById(event.site_id);
      if (site) {
        const newBankroll = Math.max(0, (site.bankroll || 0) - event.cash_amount);
        sitesRepo.update(event.site_id, { bankroll: newBankroll });
      }
    }

    res.json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update ledger event
app.patch('/api/ledger/:id', (req, res) => {
  try {
    const event = ledgerRepo.update(req.params.id, req.body, {
      notes: req.body._audit_notes
    });
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete ledger event (soft delete)
app.delete('/api/ledger/:id', (req, res) => {
  try {
    const success = ledgerRepo.softDelete(req.params.id, {
      notes: req.body?._audit_notes
    });
    if (!success) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get audit history for event
app.get('/api/ledger/:id/audit', (req, res) => {
  try {
    const history = ledgerRepo.getAuditHistory(req.params.id);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ IMPORT API ============

// Import CSV with mapping
app.post('/api/import/csv', upload.single('file'), (req, res) => {
  try {
    let csvText;
    if (req.file) {
      csvText = req.file.buffer.toString('utf8');
    } else if (req.body.csv) {
      csvText = req.body.csv;
    } else {
      return res.status(400).json({ error: 'No CSV data provided' });
    }

    const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : null;
    const mode = req.body.mode || 'skip'; // skip, upsert, force_insert
    const filename = req.file?.originalname || 'paste';

    // Parse CSV
    const workbook = XLSX.read(csvText, { type: 'string' });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No data rows found in CSV' });
    }

    // If no mapping provided, return preview
    if (!mapping) {
      const headers = Object.keys(rows[0]);
      return res.json({
        preview: true,
        headers,
        sampleRows: rows.slice(0, 5),
        totalRows: rows.length
      });
    }

    // Create import batch
    const importBatch = importsRepo.create({
      filename,
      source: 'csv_upload',
      mapping,
      total_rows: rows.length
    });

    // Map rows to events
    const events = [];
    const errors = [];

    rows.forEach((row, index) => {
      try {
        const event = mapRowToEvent(row, mapping);
        if (event) {
          events.push(event);
        }
      } catch (err) {
        errors.push({ row: index + 1, error: err.message });
      }
    });

    // Bulk create events
    const results = ledgerRepo.bulkCreate(events, {
      mode,
      importId: importBatch.id
    });

    // Update import batch
    importsRepo.update(importBatch.id, {
      status: 'completed',
      inserted_count: results.inserted,
      skipped_count: results.skipped,
      error_count: errors.length + results.errors.length,
      errors: [...errors, ...results.errors]
    });

    res.json({
      success: true,
      import_id: importBatch.id,
      total_rows: rows.length,
      inserted: results.inserted,
      skipped: results.skipped,
      updated: results.updated,
      errors: errors.length + results.errors.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to map CSV row to ledger event
function mapRowToEvent(row, mapping) {
  const getValue = (field) => {
    const column = mapping[field];
    return column ? row[column] : null;
  };

  // Get type - infer if not provided
  let type = getValue('type');
  const cashAmount = parseFloat(getValue('cash_amount')) || 0;
  const status = getValue('status');

  if (!type) {
    // Infer type from data
    if (cashAmount < 0) {
      type = 'purchase';
    } else if (status === 'pending') {
      type = 'redemption_requested';
    } else if (cashAmount > 0) {
      type = 'redemption_received';
    } else {
      type = 'daily_reward';
    }
  }

  // Normalize type names
  const typeMap = {
    'purchase': 'purchase',
    'buy': 'purchase',
    'redemption': 'redemption_received',
    'redeem': 'redemption_received',
    'redemption_received': 'redemption_received',
    'redemption_requested': 'redemption_requested',
    'pending': 'redemption_requested',
    'daily_reward': 'daily_reward',
    'reward': 'daily_reward',
    'session': 'session',
    'adjustment': 'adjustment'
  };
  type = typeMap[type.toLowerCase()] || type;

  // Parse date
  let occurredAt = getValue('date') || getValue('occurred_at');
  if (occurredAt) {
    // Try to parse various date formats
    const parsed = new Date(occurredAt);
    if (!isNaN(parsed.getTime())) {
      occurredAt = parsed.toISOString();
    } else {
      occurredAt = new Date().toISOString();
    }
  } else {
    occurredAt = new Date().toISOString();
  }

  // Build event
  const event = {
    type,
    occurred_at: occurredAt,
    site_name: getValue('site') || getValue('casino_name') || getValue('site_name'),
    cash_amount: type === 'purchase' ? -Math.abs(cashAmount) : Math.abs(cashAmount),
    coin_amount: parseFloat(getValue('coin_amount') || getValue('coins') || getValue('amount_coins')) || 0,
    status: status || (type === 'redemption_requested' ? 'pending' : null),
    external_ref: getValue('external_ref') || getValue('tx_id'),
    notes: getValue('notes') || getValue('note')
  };

  // Try to match site by name
  if (event.site_name) {
    const site = sitesRepo.getByName(event.site_name);
    if (site) {
      event.site_id = site.id;
    }
  }

  return event;
}

// Get import history
app.get('/api/imports', (req, res) => {
  try {
    const imports = importsRepo.getAll();
    res.json(imports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get import details
app.get('/api/imports/:id', (req, res) => {
  try {
    const importBatch = importsRepo.getById(req.params.id);
    if (!importBatch) {
      return res.status(404).json({ error: 'Import not found' });
    }
    res.json(importBatch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ AUTOMATION API ============

// Track running automation job
let automationJob = {
  running: false,
  stopping: false,
  startTime: null,
  output: [],       // Raw log lines
  events: [],       // Structured JSON events
  siteStatuses: {}, // Current status of each site
  stats: null,      // Final stats
  results: null,
  error: null
};

// Start collect-all automation
app.post('/api/automation/collect-all', (req, res) => {
  if (automationJob.running) {
    return res.status(409).json({
      error: 'Automation already running',
      startTime: automationJob.startTime
    });
  }

  const dryRun = req.query.dryRun === 'true';
  const scriptPath = path.join(__dirname, '..', 'automation', 'collect-all.js');

  // Reset job state
  automationJob = {
    running: true,
    stopping: false,
    startTime: new Date().toISOString(),
    output: [],
    events: [],
    siteStatuses: {},
    stats: null,
    results: null,
    error: null
  };

  const args = dryRun ? ['--dry-run'] : [];
  const child = spawn('node', [scriptPath, ...args], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, FORCE_COLOR: '0' }
  });

  // Store process ref so we can stop it
  automationJob.process = child;

  // Parse output, extracting JSON events
  const processOutput = (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (line.startsWith('__JSON__')) {
        try {
          const event = JSON.parse(line.substring(8));
          automationJob.events.push(event);

          // Update site statuses based on event type
          if (event.type === 'start' && event.sites) {
            for (const site of event.sites) {
              automationJob.siteStatuses[site.id] = {
                id: site.id,
                name: site.name,
                status: site.status,
                cooldownRemaining: site.cooldownRemaining
              };
            }
          } else if (event.type === 'site_start') {
            automationJob.siteStatuses[event.id] = {
              ...automationJob.siteStatuses[event.id],
              status: 'running'
            };
          } else if (event.type === 'site_result') {
            automationJob.siteStatuses[event.id] = {
              ...automationJob.siteStatuses[event.id],
              status: event.status,
              sc: event.sc,
              gc: event.gc,
              errorCode: event.errorCode,
              error: event.error,
              cooldownRemaining: event.cooldownRemaining
            };
          } else if (event.type === 'complete') {
            automationJob.stats = event.stats;
          }
        } catch (e) {
          // Invalid JSON, treat as regular line
          automationJob.output.push(line);
        }
      } else {
        automationJob.output.push(line);
      }
    }
    // Keep only last 200 lines to prevent memory issues
    if (automationJob.output.length > 200) {
      automationJob.output = automationJob.output.slice(-200);
    }
  };

  child.stdout.on('data', processOutput);
  child.stderr.on('data', processOutput);

  child.on('close', (code) => {
    automationJob.running = false;
    automationJob.stopping = false;
    automationJob.exitCode = automationJob.error === 'Stopped by user' ? -1 : code;
    automationJob.endTime = new Date().toISOString();
    if (code !== 0 && !automationJob.error) {
      automationJob.error = `Process exited with code ${code}`;
    }
  });

  child.on('error', (err) => {
    automationJob.running = false;
    automationJob.stopping = false;
    automationJob.error = err.message;
    automationJob.endTime = new Date().toISOString();
  });

  res.json({
    success: true,
    message: 'Automation started',
    dryRun,
    startTime: automationJob.startTime
  });
});

// Stop running automation
app.post('/api/automation/stop', (req, res) => {
  if (automationJob.stopping) {
    return res.json({ success: true, message: 'Already stopping' });
  }
  if (!automationJob.running || !automationJob.process) {
    return res.status(409).json({ error: 'No automation running' });
  }

  try {
    automationJob.process.kill('SIGTERM');
    // Force kill after 2s if SIGTERM didn't finish it
    const killTimer = setTimeout(() => {
      try {
        if (automationJob.process && !automationJob.process.killed) {
          console.log('[server] SIGTERM timeout — sending SIGKILL');
          automationJob.process.kill('SIGKILL');
        }
      } catch (e) { /* already dead */ }
    }, 2000);
    killTimer.unref(); // don't keep server alive for this

    // Mark as stopping for UI, but don't clear `running` until process actually dies.
    // The `close` handler (line ~1581) will set running=false when the process exits.
    automationJob.error = 'Stopped by user';
    automationJob.stopping = true;

    res.json({ success: true, message: 'Automation stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get last run timestamps from report files
app.get('/api/automation/last-runs', (req, res) => {
  const reportsDir = path.join(__dirname, '..', 'data', 'run-reports');
  const result = {};
  for (const type of ['collect-all', '24hr', 'fixed-time']) {
    try {
      const raw = fs.readFileSync(path.join(reportsDir, `${type}-latest.json`), 'utf8');
      const report = JSON.parse(raw);
      result[type] = { timestamp: report.timestamp, duration_ms: report.duration_ms, stats: report.stats };
    } catch {
      result[type] = null;
    }
  }
  res.json(result);
});

// ============ AUTORUN DASHBOARD TAB ============
// Aggregates today's scheduler state + collect-all results + /autorun fix output
// into a single payload for app/autorun.html. Dates are Pacific — file rolls
// over at midnight PT naturally, so the tab is blank every morning.

function pacificDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function parseSchedulerLog(logPath) {
  // Lines look like: [2026-04-20 07:46:31 PDT] Target: 2026-04-20 16:40:00 PDT (delay 32009s, mode=drift, skip_collect=0)
  const out = { target: null, target_readable: null, mode: null, events: [] };
  let raw;
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return out; }
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^\[(.+?)\]\s+(.*)$/);
    if (!m) continue;
    const [, ts, msg] = m;
    if (!out.target) {
      const tm = msg.match(/^Target:\s+(.+?)\s+\(delay\s+\d+s,\s+mode=(\w+)/);
      if (tm) {
        out.target_readable = tm[1];
        out.mode = tm[2];
        // Convert "2026-04-20 16:40:00 PDT" to ISO. Keep readable form as fallback.
        const parsed = new Date(tm[1].replace(/ (PDT|PST)$/, (_, tz) => tz === 'PDT' ? '-07:00' : '-08:00'));
        if (!Number.isNaN(parsed.getTime())) out.target = parsed.toISOString();
      }
    }
    // Keep only meaningful events, drop the "still waiting" spam
    if (!/still waiting/.test(msg)) {
      out.events.push({ ts, msg });
    }
  }
  // Last 20 meaningful events
  out.events = out.events.slice(-20);
  return out;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

app.get('/api/autorun/today', (req, res) => {
  const pacificDate = pacificDateStr();
  const yyyymmdd = pacificDate.replace(/-/g, '');
  const dataDir = path.join(__dirname, '..', 'data');

  // 1. Scheduler state
  const lastRun = readJsonSafe(path.join(dataDir, 'last-run-time.json'));
  const sched = parseSchedulerLog(path.join(dataDir, 'autorun-logs', `scheduler-${yyyymmdd}.log`));

  let status = 'idle';
  if (lastRun?.run_started_at) {
    const startedToday = pacificDateStr(new Date(lastRun.run_started_at)) === pacificDate;
    if (startedToday) {
      status = lastRun.status === 'finished' ? 'finished' : 'running';
    }
  }
  if (status === 'idle' && sched.target) {
    status = new Date(sched.target).getTime() > Date.now() ? 'waiting' : 'idle';
  }

  // 2. Collect-all results (only if from today)
  const collectLatest = readJsonSafe(path.join(dataDir, 'run-reports', 'collect-all-latest.json'));
  let collect = null;
  if (collectLatest && pacificDateStr(new Date(collectLatest.timestamp)) === pacificDate) {
    const collectedSites = (collectLatest.sites || []).filter(s => s.status === 'collected');
    collect = {
      timestamp: collectLatest.timestamp,
      duration_ms: collectLatest.duration_ms,
      stats: collectLatest.stats,
      totals: collectLatest.totals,
      failures: (collectLatest.sites || [])
        .filter(s => s.status === 'failed' || s.status === 'unverified')
        .map(s => ({
          id: s.id,
          name: s.name,
          status: s.status,
          error: s.error,
          errorCode: s.errorCode,
          screenshot: s.screenshot,
        })),
      collected: collectedSites.length,
      zeroDelta: collectedSites
        .filter(s => s.sc === 0 && s.gc === 0)
        .map(s => ({ id: s.id, name: s.name, confidence: s.confidence })),
      unknownDelta: collectedSites
        .filter(s => s.confidence !== 'verified')
        .map(s => ({ id: s.id, name: s.name, sc: s.sc, gc: s.gc, confidence: s.confidence })),
    };
  }

  // 3. Autorun sidecar (the /autorun fix-loop output)
  const autorun = readJsonSafe(path.join(dataDir, 'run-reports', `autorun-${pacificDate}.json`));

  res.json({
    pacific_date: pacificDate,
    now: new Date().toISOString(),
    scheduler: {
      status,
      target: sched.target,
      target_readable: sched.target_readable,
      mode: sched.mode,
      run_started_at: lastRun?.run_started_at || null,
      run_finished_at: lastRun?.run_finished_at || null,
      runner: lastRun?.runner || null,
      events: sched.events,
    },
    collect,
    autorun,
  });
});

// Get automation status
app.get('/api/automation/status', (req, res) => {
  res.json({
    running: automationJob.running,
    stopping: automationJob.stopping || false,
    startTime: automationJob.startTime,
    endTime: automationJob.endTime || null,
    output: automationJob.output,
    error: automationJob.error,
    exitCode: automationJob.exitCode
  });
});

// Server-Sent Events stream for real-time updates
app.get('/api/automation/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let lastOutputIndex = 0;
  let lastEventIndex = 0;
  let lastSiteStatusHash = '';

  const sendUpdate = () => {
    // Send new raw output lines
    const newLines = automationJob.output.slice(lastOutputIndex);
    if (newLines.length > 0) {
      res.write(`data: ${JSON.stringify({
        type: 'output',
        lines: newLines,
        running: automationJob.running
      })}\n\n`);
      lastOutputIndex = automationJob.output.length;
    }

    // Send site status updates (send full status object when it changes)
    const currentHash = JSON.stringify(automationJob.siteStatuses);
    if (currentHash !== lastSiteStatusHash) {
      res.write(`data: ${JSON.stringify({
        type: 'sites',
        sites: Object.values(automationJob.siteStatuses),
        stats: automationJob.stats,
        running: automationJob.running
      })}\n\n`);
      lastSiteStatusHash = currentHash;
    }

    if (!automationJob.running && lastOutputIndex >= automationJob.output.length) {
      res.write(`data: ${JSON.stringify({
        type: 'complete',
        exitCode: automationJob.exitCode,
        error: automationJob.error,
        stats: automationJob.stats,
        sites: Object.values(automationJob.siteStatuses)
      })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  };

  // Send initial state with any existing site statuses
  res.write(`data: ${JSON.stringify({
    type: 'status',
    running: automationJob.running,
    startTime: automationJob.startTime,
    sites: Object.values(automationJob.siteStatuses),
    stats: automationJob.stats
  })}\n\n`);

  const interval = setInterval(sendUpdate, 500);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// Start Chrome with remote debugging
app.post('/api/automation/start-chrome', async (req, res) => {
  try {
    const { isChromeReachable, ensureChrome } = require('../automation/utils/ensure-chrome');
    if (await isChromeReachable()) {
      return res.json({ success: true, message: 'Chrome already running', alreadyRunning: true });
    }
    const ok = await ensureChrome();
    if (ok) {
      res.json({ success: true, message: 'Chrome started' });
    } else {
      res.status(500).json({ success: false, error: 'Chrome failed to start after 60s' });
    }
  } catch (err) {
    console.error('Failed to start Chrome:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check Chrome debug status
app.get('/api/automation/chrome-status', async (req, res) => {
  try {
    const { isChromeReachable } = require('../automation/utils/ensure-chrome');
    const running = await isChromeReachable();
    res.json({ running, port: 9222 });
  } catch {
    res.json({ running: false, port: 9222, error: 'ensure-chrome module not available' });
  }
});

// ============ HEALTH CHECK / RECONCILIATION ============

app.get('/api/health/ledger', (req, res) => {
  try {
    const warnings = [];
    let invariantsOk = true;

    // Check for orphaned redemption_received without matching request
    const received = ledgerRepo.query({ type: 'redemption_received' });
    const requested = ledgerRepo.query({ type: 'redemption_requested' });
    const requestedByRef = new Map();
    requested.forEach(r => {
      if (r.external_ref) requestedByRef.set(r.external_ref, r);
    });

    const orphanedReceived = received.filter(r =>
      r.linked_event_id === null && r.external_ref && !requestedByRef.has(r.external_ref)
    );
    if (orphanedReceived.length > 0) {
      warnings.push({
        type: 'orphaned_redemption_received',
        message: `${orphanedReceived.length} redemption_received events without matching request`,
        count: orphanedReceived.length
      });
    }

    // Check for stale pending redemptions (>14 days)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 14);
    const stalePending = requested.filter(r =>
      r.status === 'pending' && new Date(r.occurred_at) < cutoffDate
    );
    if (stalePending.length > 0) {
      warnings.push({
        type: 'stale_pending_redemptions',
        message: `${stalePending.length} pending redemptions older than 14 days`,
        count: stalePending.length
      });
    }

    // Check for duplicate fingerprints
    const fingerprints = db.prepare(`
      SELECT fingerprint, COUNT(*) as count
      FROM ledger_events
      WHERE is_deleted = 0
      GROUP BY fingerprint
      HAVING COUNT(*) > 1
    `).all();
    if (fingerprints.length > 0) {
      const totalDupes = fingerprints.reduce((sum, f) => sum + f.count - 1, 0);
      warnings.push({
        type: 'duplicate_fingerprints',
        message: `${totalDupes} duplicate events detected`,
        count: totalDupes
      });
    }

    // Check for invalid dates
    const invalidDates = db.prepare(`
      SELECT COUNT(*) as count
      FROM ledger_events
      WHERE is_deleted = 0 AND (occurred_at IS NULL OR occurred_at = '')
    `).get();
    if (invalidDates.count > 0) {
      warnings.push({
        type: 'invalid_dates',
        message: `${invalidDates.count} events with invalid dates`,
        count: invalidDates.count
      });
      invariantsOk = false;
    }

    // Check for NaN amounts
    const nanAmounts = db.prepare(`
      SELECT COUNT(*) as count
      FROM ledger_events
      WHERE is_deleted = 0 AND (
        typeof(cash_amount) != 'real' AND typeof(cash_amount) != 'integer'
        OR typeof(coin_amount) != 'real' AND typeof(coin_amount) != 'integer'
      )
    `).get();
    if (nanAmounts.count > 0) {
      warnings.push({
        type: 'invalid_amounts',
        message: `${nanAmounts.count} events with invalid amounts`,
        count: nanAmounts.count
      });
      invariantsOk = false;
    }

    // Check for orphaned events (NULL site_id)
    const orphanedEvents = db.prepare(`
      SELECT COUNT(*) as count
      FROM ledger_events
      WHERE site_id IS NULL AND is_deleted = 0
    `).get();
    if (orphanedEvents.count > 0) {
      warnings.push({
        type: 'orphaned_events',
        message: `${orphanedEvents.count} events with no site_id`,
        count: orphanedEvents.count
      });
    }

    // Check for bad daily_reward deltas (coin_amount wildly above typical_sc or negative)
    // Threshold is 50x typical — streak sites regularly hit 20x on Day 7, wheel spins vary widely.
    const badDeltas = db.prepare(`
      SELECT COUNT(*) as count
      FROM ledger_events le
      JOIN sites s ON le.site_id = s.id
      WHERE le.type = 'daily_reward'
      AND le.is_deleted = 0
      AND s.typical_sc > 0
      AND (le.coin_amount > s.typical_sc * 50 OR le.coin_amount < 0)
    `).get();
    if (badDeltas.count > 0) {
      warnings.push({
        type: 'bad_reward_deltas',
        message: `${badDeltas.count} daily_reward entries with suspicious amounts`,
        count: badDeltas.count
      });
    }

    // Check for stale bankroll (active sites not checked in 48h)
    const staleBankroll = db.prepare(`
      SELECT COUNT(*) as count
      FROM sites
      WHERE active = 1 AND hidden = 0
      AND (last_checked IS NULL OR last_checked < datetime('now', '-48 hours'))
    `).get();
    if (staleBankroll.count > 0) {
      warnings.push({
        type: 'stale_bankroll',
        message: `${staleBankroll.count} active sites not checked in 48+ hours`,
        count: staleBankroll.count
      });
    }

    res.json({
      invariants_ok: invariantsOk,
      warnings,
      checked_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reconciliation endpoint
app.get('/api/reconcile', (req, res) => {
  try {
    // Get pending redemptions
    const pendingRedemptions = ledgerRepo.query({
      type: 'redemption_requested',
      status: 'pending'
    });

    // Get received without linked request
    const received = ledgerRepo.query({ type: 'redemption_received' });
    const unlinkedReceived = received.filter(r => !r.linked_event_id);

    // Group pending by site
    const pendingBySite = {};
    pendingRedemptions.forEach(r => {
      const site = r.site_name || 'Unknown';
      if (!pendingBySite[site]) pendingBySite[site] = [];
      pendingBySite[site].push(r);
    });

    // Calculate aging
    const now = new Date();
    const agingBuckets = {
      '0-7_days': 0,
      '8-14_days': 0,
      '15-30_days': 0,
      'over_30_days': 0
    };

    pendingRedemptions.forEach(r => {
      const age = Math.floor((now - new Date(r.occurred_at)) / (1000 * 60 * 60 * 24));
      if (age <= 7) agingBuckets['0-7_days']++;
      else if (age <= 14) agingBuckets['8-14_days']++;
      else if (age <= 30) agingBuckets['15-30_days']++;
      else agingBuckets['over_30_days']++;
    });

    res.json({
      pending_redemptions: {
        total: pendingRedemptions.length,
        total_amount: roundToCents(pendingRedemptions.reduce((sum, r) => sum + r.cash_amount, 0)),
        by_site: pendingBySite,
        aging: agingBuckets
      },
      unlinked_received: {
        total: unlinkedReceived.length,
        events: unlinkedReceived.slice(0, 50) // Limit to 50 for response size
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ STARTUP ============

// Initialize
ensureDirectories();

// Run database migrations
console.log('Running database migrations...');
runMigrations();

// Check if we need to migrate existing JSON data
if (sitesRepo.isEmpty()) {
  console.log('Database is empty, checking for existing JSON data to migrate...');
  const sitesFile = path.join(DATA_DIR, 'sites.json');
  if (fs.existsSync(sitesFile)) {
    console.log('Found existing JSON data, migrating...');
    migrateAll();
  }
}

app.listen(PORT, () => {
  console.log(`\n Sweepsites Tracker running at http://localhost:${PORT}\n`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API:       http://localhost:${PORT}/api/sites`);
  console.log(`   Ledger:    http://localhost:${PORT}/api/ledger`);
  console.log(`   Health:    http://localhost:${PORT}/api/health/ledger`);
  console.log(`\nPress Ctrl+C to stop\n`);
});
