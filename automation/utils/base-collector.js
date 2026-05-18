/**
 * Base Collector Factory
 * createCollector(config) extracts ~150 lines of shared boilerplate from every collector.
 * Migrated collectors become ~30-80 lines of pure site-specific logic.
 *
 * Export shape is identical to legacy collectors — runners don't change.
 */

'use strict';

const path = require('path');
const config = require('../config');
const { notifyFailure, notifyFreeSpins } = require('../notify');
const { getOrCreatePage, safeScreenshot, dismissOverlays, resilientClick, restoreChromeWindow } = require('./browser');
const { humanDelay } = require('./humanize');
const { performGoogleOAuth } = require('./google-oauth');
const { findByIntent, clickByIntent } = require('./find-by-intent');
const { startFocusGuard, stopFocusGuard } = require('./focus-guard');

const TRACKER_API = 'http://localhost:3050';

// ─── safeEval: Context-Destruction-Resilient page.evaluate ──────────────────
// SPA frameworks (Vue, React, Next.js) destroy JS execution contexts during
// client-side navigation. Any page.evaluate() during that window throws
// "Execution context was destroyed." This wrapper retries automatically.
// Exported so collectors can use it instead of writing their own wrappers.
async function safeEval(page, fn, ...args) {
  const HANG_TIMEOUT_MS = 10000;  // SPAs with chronic context-thrash can hang evaluate indefinitely (goldmachine).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await Promise.race([
        page.evaluate(fn, ...args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('safeEval timeout (context destroyed?)')), HANG_TIMEOUT_MS)),
      ]);
    } catch (err) {
      const msg = err.message || '';
      const isRetryable = msg.includes('Execution context') || msg.includes('navigation') ||
                          msg.includes('destroyed') || msg.includes('safeEval timeout');
      if (isRetryable && attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

// ─── Direct SQLite Fallback ─────────────────────────────────────────────────
// When the web server isn't running, write directly to the DB so collections
// are still tracked for cooldown purposes. Only used on connection errors —
// HTTP errors (400, 500) from a running server are NOT suppressed.

let _db = null;
function getDb() {
  if (!_db) {
    try {
      const Database = require('better-sqlite3');
      const dbPath = path.join(__dirname, '../../data/sweepsites.sqlite');
      _db = new Database(dbPath);
      _db.pragma('journal_mode = WAL');
    } catch (err) {
      console.error('[fallback-db] Could not open SQLite:', err.message);
      return null;
    }
  }
  return _db;
}

function isConnectionError(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('econnrefused') || msg.includes('fetch failed') ||
         msg.includes('enotfound') || msg.includes('etimedout') ||
         msg.includes('econnreset') || msg.includes('network');
}

function directRecordCollection(siteId, scAmount, gcAmount) {
  const db = getDb();
  if (!db) return false;

  try {
    const { v4: uuidv4 } = require('uuid');
    const crypto = require('crypto');

    const id = uuidv4();
    const now = new Date().toISOString();
    const siteName = siteId; // best we have without the sites table lookup

    // Look up site name from sites table
    let resolvedName = siteName;
    try {
      const site = db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId);
      if (site) resolvedName = site.name;
    } catch {}

    // Generate fingerprint matching ledger repo logic
    const dateOnly = now.split('T')[0];
    const normName = resolvedName.toLowerCase().trim();
    const data = `daily_reward|${dateOnly}|${normName}|0.00|${parseFloat(scAmount || 0).toFixed(2)}|`;
    const fingerprint = crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);

    // Check for duplicate fingerprint before inserting
    const existing = db.prepare('SELECT id FROM ledger_events WHERE fingerprint = ? AND is_deleted = 0').get(fingerprint);
    if (existing) {
      console.log(`[${siteId}] FALLBACK: Duplicate fingerprint — collection already recorded (${existing.id})`);
      return true;
    }

    const meta = JSON.stringify({ gc_amount: parseInt(gcAmount) || 0, method: 'automated' });

    db.prepare(`
      INSERT INTO ledger_events (
        id, type, occurred_at, site_id, site_name, cash_amount, coin_amount,
        coin_type, status, external_ref, linked_event_id, notes, meta,
        fingerprint, import_id, is_deleted, created_at, updated_at
      ) VALUES (?, 'daily_reward', ?, ?, ?, 0, ?, 'SC', NULL, NULL, NULL, NULL, ?, ?, NULL, 0, ?, ?)
    `).run(id, now, siteId, resolvedName, parseFloat(scAmount) || 0, meta, fingerprint, now, now);

    console.log(`[${siteId}] FALLBACK: Recorded collection directly to SQLite (+${scAmount} SC, +${gcAmount} GC)`);
    return true;
  } catch (err) {
    console.error(`[${siteId}] FALLBACK: SQLite write failed:`, err.message);
    return false;
  }
}

function directUpdateBankroll(siteId, bankroll) {
  const db = getDb();
  if (!db) return false;
  try {
    const now = new Date().toISOString();
    db.prepare('UPDATE sites SET bankroll = ?, updated_at = ? WHERE id = ?').run(bankroll, now, siteId);
    console.log(`[${siteId}] FALLBACK: Updated bankroll to ${bankroll} directly in SQLite`);
    return true;
  } catch (err) {
    console.error(`[${siteId}] FALLBACK: Bankroll update failed:`, err.message);
    return false;
  }
}

// ─── Shared Tracker Utilities ───────────────────────────────────────────────

async function getTrackerBankroll(siteId) {
  try {
    const response = await fetch(`${TRACKER_API}/api/sites`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const sites = await response.json();
    const site = sites.find(s => s.id === siteId);
    if (site) {
      console.log(`[${siteId}] Tracker bankroll: ${site.bankroll}`);
      return site.bankroll || 0;
    }
    console.log(`[${siteId}] Site not found in tracker`);
    return 0;
  } catch (err) {
    if (isConnectionError(err)) {
      // Try direct SQLite read
      const db = getDb();
      if (db) {
        try {
          const site = db.prepare('SELECT bankroll FROM sites WHERE id = ?').get(siteId);
          if (site) {
            console.log(`[${siteId}] FALLBACK: Tracker bankroll from SQLite: ${site.bankroll}`);
            return site.bankroll || 0;
          }
        } catch {}
      }
    }
    console.error(`[${siteId}] Error fetching tracker bankroll:`, err.message);
    return null;
  }
}

async function updateTrackerFull(siteId, actualBalance, scCollected, gcCollected) {
  try {
    const updateResponse = await fetch(`${TRACKER_API}/api/sites/${siteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankroll: actualBalance })
    });

    if (!updateResponse.ok) {
      console.error(`[${siteId}] Failed to update bankroll: ${updateResponse.status}`);
    } else {
      console.log(`[${siteId}] Updated tracker bankroll to ${actualBalance}`);
    }

    const collectionResponse = await fetch(`${TRACKER_API}/api/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        sc_amount: scCollected,
        gc_amount: gcCollected,
        method: 'automated'
      })
    });

    if (!collectionResponse.ok) {
      console.error(`[${siteId}] Failed to record collection: ${collectionResponse.status}`);
      return false;
    }

    console.log(`[${siteId}] Recorded collection: +${scCollected} SC, +${gcCollected} GC`);
    return true;
  } catch (err) {
    if (isConnectionError(err)) {
      console.log(`[${siteId}] Server unreachable — falling back to direct SQLite`);
      directUpdateBankroll(siteId, actualBalance);
      return directRecordCollection(siteId, scCollected, gcCollected);
    }
    console.error(`[${siteId}] Error updating tracker:`, err.message);
    return false;
  }
}

async function recordCollection(siteId, scAmount, gcAmount) {
  try {
    const response = await fetch(`${TRACKER_API}/api/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        sc_amount: scAmount,
        gc_amount: gcAmount,
        method: 'automated'
      })
    });

    if (!response.ok) {
      console.error(`[${siteId}] Failed to record collection: ${response.status}`);
      return false;
    }

    console.log(`[${siteId}] Recorded collection: +${scAmount} SC, +${gcAmount} GC`);
    return true;
  } catch (err) {
    if (isConnectionError(err)) {
      console.log(`[${siteId}] Server unreachable — falling back to direct SQLite`);
      return directRecordCollection(siteId, scAmount, gcAmount);
    }
    console.error(`[${siteId}] Error recording collection:`, err.message);
    return false;
  }
}

function screenshotPath(siteId, label) {
  return path.join(__dirname, '..', '..', 'data', `${siteId}-${label}-${Date.now()}.png`);
}

// ─── Helpers Object Builder ─────────────────────────────────────────────────

function buildHelpers(page, siteId, siteName) {
  const log = (msg) => console.log(`[${siteId}] ${msg}`);

  return {
    click: (target, opts) => resilientClick(page, target, { label: siteId, ...opts }),
    // Pure coordinate-based click. Resolves element → boundingBox → page.mouse.click().
    // Use this instead of raw el.click() when elements may be behind overlays or "not visible".
    mouseClick: async (target) => {
      const el = typeof target === 'string' ? await page.$(target) : target;
      if (!el) throw new Error(`mouseClick: element not found`);
      const box = await el.boundingBox();
      if (!box || box.width === 0 || box.height === 0) throw new Error(`mouseClick: no bounding box`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      log(`mouseClick @ ${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`);
    },
    dismiss: () => dismissOverlays(page),
    screenshot: (label) => safeScreenshot(page, screenshotPath(siteId, label)),
    delay: (ms) => humanDelay(page, ms),
    log,
    waitFor: (sel, opts) => page.waitForSelector(sel, { timeout: 10000, state: 'visible', ...opts }),
    findFirst: async (selectors, opts = {}) => {
      const { timeout = 3000, state = 'visible' } = opts;
      for (const sel of selectors) {
        try {
          const el = await page.waitForSelector(sel, { timeout, state });
          if (el) return { el, selector: sel };
        } catch {}
      }
      return null;
    },
    findByIntent: (intent, opts) => findByIntent(page, intent, { siteSlug: siteId, siteName, ...opts }),
    clickByIntent: (intent, opts) => clickByIntent(page, intent, { siteSlug: siteId, siteName, ...opts }),
  };
}

// ─── Auto-Generated Login ───────────────────────────────────────────────────

function buildAutoLogin(cfg) {
  if (cfg.performLogin) return cfg.performLogin;
  if (cfg.oauth !== 'google') return null;

  // Auto-generate Google OAuth login
  return async (page, context) => {
    const tag = `[${cfg.siteId}]`;
    const baseUrl = cfg.siteUrl.replace(/\/$/, '');
    const loginPaths = ['/login', '/signin', '/sign-in', '/login/'];

    // ─── Helpers ────────────────────────────────────────────────────

    // Dismiss consent banner on current page
    async function dismissConsent(label) {
      try {
        const onetrust = await page.$('#onetrust-accept-btn-handler');
        if (onetrust) {
          const box = await onetrust.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            console.log(`${tag} Dismissed OneTrust consent`);
            await humanDelay(page, 1000);
            return;
          }
        }
        const consent = await clickByIntent(page, 'consent', { label, siteSlug: cfg.siteId, siteName: cfg.siteName, minScore: 25, postClickDelay: 1000 });
        if (consent) console.log(`${tag} Dismissed cookie consent: "${consent.text}"`);
      } catch {}
    }

    // Run Google OAuth and poll isLoggedIn for up to 15s.
    // SPAs can take several seconds to hydrate after OAuth redirects.
    // Returns true if login confirmed within the window.
    async function oauthAndVerify(settleDelay = 5000, label = 'oauth') {
      const result = await performGoogleOAuth(page, context, {
        googleButtonSelector: cfg.googleButtonSelector || null,
        returnDomain: cfg.returnDomain || null,
        settleDelay,
      });

      if (result.method === 'none') {
        // No Google button found — but the login-button click might have navigated
        // to an already-logged-in lobby (valid session cookie). Check before failing.
        const alreadyIn = await cfg.isLoggedIn(page);
        if (alreadyIn) {
          console.log(`${tag} Already logged in — session cookie still valid (no OAuth needed)`);
          return true;
        }
        return false;
      }

      console.log(`${tag} OAuth [${label}]: ${result.method}`);

      // Poll — 5 × 3s = 15s window for SPA hydration / slow OAuth callbacks
      for (let i = 0; i < 5; i++) {
        const ok = await cfg.isLoggedIn(page);
        if (ok) {
          if (i > 0) console.log(`${tag} Login confirmed after ${i * 3}s OAuth settle`);
          return true;
        }
        if (i < 4) await humanDelay(page, 3000);
      }
      return false;
    }

    // Clear site cookies then retry OAuth from the given URL.
    // Used when "auto-complete" silently fails — stale site cookies can
    // block proper OAuth token exchange. Clearing forces a real flow.
    // Skip if cfg.skipCookieClear is true — sites where clearing destroys
    // manually-established sessions without helping (e.g. expired OAuth grants).
    async function cookieClearRetry(loginUrl, label) {
      if (cfg.skipCookieClear) {
        console.log(`${tag} Skipping cookie-clear retry (skipCookieClear=true)`);
        return false;
      }
      console.log(`${tag} Cookie-clear retry: clearing site session for fresh OAuth...`);
      try {
        const urlObj = new URL(cfg.siteUrl);
        const apex = urlObj.hostname.replace(/^www\./, '');

        // Preserve Cloudflare cookies during login retry too
        let cfCookies = [];
        try {
          const allCookies = await context.cookies([cfg.siteUrl]);
          cfCookies = allCookies.filter(c =>
            c.name === 'cf_clearance' || c.name.startsWith('__cf') || c.name === 'cf_chl_rc_m'
          );
        } catch {}

        await context.clearCookies({ domain: '.' + apex });
        await context.clearCookies({ domain: urlObj.hostname });
        if (cfCookies.length > 0) await context.addCookies(cfCookies).catch(() => {});

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await humanDelay(page, 2000);
        await dismissConsent(`${cfg.siteId}/${label}-consent`);

        // Longer settle — real OAuth flow (not auto-complete) takes more time
        if (await oauthAndVerify(10000, label)) {
          console.log(`${tag} Login confirmed after cookie-clear retry`);
          return true;
        }
      } catch (err) {
        console.log(`${tag} Cookie-clear retry error: ${err.message.slice(0, 80)}`);
      }
      return false;
    }

    // ─── Step 0: Dismiss cookie consent ─────────────────────────────
    await dismissConsent(`${cfg.siteId}/login-consent`);

    // ─── Step 1: Try direct login page URLs first ───────────────────
    let triedLoginUrl = null;

    for (const loginPath of loginPaths) {
      try {
        const loginUrl = baseUrl + loginPath;
        const resp = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        const status = resp ? resp.status() : 0;
        const currentUrl = page.url();

        const isHomepage = currentUrl === cfg.siteUrl || currentUrl === cfg.siteUrl + '/';
        if (status >= 400 || isHomepage) continue;

        console.log(`${tag} Navigated to login page: ${loginPath} (${currentUrl.slice(0, 80)})`);
        await humanDelay(page, 2000);
        await dismissConsent(`${cfg.siteId}/login-page-consent`);

        if (await oauthAndVerify(5000, 'login-page')) return true;

        // OAuth didn't confirm login — try cookie-clear + fresh attempt
        triedLoginUrl = loginUrl;
        if (await cookieClearRetry(loginUrl, 'login-page-retry')) return true;

        break; // Tried this path, fall through to homepage
      } catch {
        // Navigation failed — try next path
      }
    }

    // ─── Step 2: Homepage fallback — find login button ──────────────
    try {
      await page.goto(cfg.siteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await humanDelay(page, 2000);
    } catch {}

    const loginResult = await clickByIntent(page, 'login', {
      label: `${cfg.siteId}/homepage-login`,
      siteSlug: cfg.siteId,
      siteName: cfg.siteName,
      minScore: 25,
      postClickDelay: 2000
    });

    if (!loginResult) {
      console.log(`${tag} No login button found on homepage either`);
      return false;
    }

    console.log(`${tag} Found & clicked login button: "${loginResult.text}"`);

    if (await oauthAndVerify(5000, 'homepage')) return true;

    // Final escape hatch: cookie-clear on homepage path too
    const homepageLoginUrl = triedLoginUrl || (baseUrl + '/login');
    if (await cookieClearRetry(homepageLoginUrl, 'homepage-retry')) return true;

    return false;
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

function createCollector(cfg) {
  // Validate required fields
  for (const key of ['siteId', 'siteName', 'siteUrl', 'isLoggedIn', 'navigateToReward', 'collect']) {
    if (!cfg[key]) throw new Error(`createCollector: missing required config '${key}'`);
  }

  // Defaults
  const {
    siteId, siteName, siteUrl,
    rewardSC = 0, rewardGC = 0,
    stealth = true, refresh = true,
    oauth = null,
  } = cfg;

  const loginFn = buildAutoLogin(cfg);

  // ─── Generated collect() ───────────────────────────────────────────

  async function collect(options = {}) {
    const { dryRun = false, _cookieRetried = false } = options;

    let page = null;
    let context = null;

    const result = {
      success: false,
      site: siteId,
      siteName,
      timestamp: new Date().toISOString()
    };

    // ─── RESPONSE INTERCEPTION STATE (hoisted for catch-block access) ──
    let interceptedResponses = [];
    let interceptedBalance = null;
    let _dealsProcessed = false;
    let midRunReloginAttempts = 0;
    const isLoginErrorMessage = (msg = '') =>
      /needslogin|not logged in|session expired|login required|logged out/i.test(msg);
    const processDeals = async () => {
      if (_dealsProcessed || !cfg.dealPatterns || interceptedResponses.length === 0) return;
      _dealsProcessed = true;
      try {
        const { extractDeals, evaluateDeal, postDealsToDiscord, isDealNew, markDealSeen } = require('./deals');
        const platform = cfg.platform || 'unknown';
        const allDeals = extractDeals(interceptedResponses, siteId, platform);
        const profitableNew = allDeals.filter(d => {
          const ev = evaluateDeal(d);
          return ev.profitable && isDealNew(d, siteId);
        });
        if (profitableNew.length > 0) {
          console.log(`[${siteId}] Found ${profitableNew.length} new profitable deal(s)`);
          await postDealsToDiscord(profitableNew, siteId, siteName);
          profitableNew.forEach(d => markDealSeen(d, siteId));
        } else if (allDeals.length > 0) {
          console.log(`[${siteId}] ${allDeals.length} deal(s) found, none new+profitable`);
        }
      } catch (err) {
        console.log(`[${siteId}] Deals processing error (non-fatal): ${err.message}`);
      }
    };

    let balanceBefore = null;

    try {
      // 1. CONNECT
      console.log(`[${siteId}] Connecting to Chrome...`);
      const browserResult = await getOrCreatePage(siteUrl, { stealth, refresh });
      context = browserResult.context;
      page = browserResult.page;
      result.page = page;

      // ─── EARLY PAGE HOOK (opt-in) ───────────────────────────────────────
      // Lets collectors attach custom response listeners BEFORE the interception
      // reload, so they capture data (cooldown, auth tokens, etc.) on first load.
      if (cfg.onPageReady) {
        cfg.onPageReady(page);
      }

      // ─── RESPONSE INTERCEPTION (opt-in) ────────────────────────────────
      // Attach BEFORE any navigation so we capture API calls during page load.
      // Then reload to trigger fresh API calls that the listener will catch.
      const hasInterception = !!(cfg.dealPatterns || cfg.apiBalanceConfig);
      if (hasInterception) {
        page.on('response', async (response) => {
          try {
            const url = response.url();
            const ct = response.headers()['content-type'] || '';
            if (!ct.includes('json')) return;

            const isDealUrl = cfg.dealPatterns?.some(p => url.includes(p));
            const isBalanceUrl = cfg.apiBalanceConfig && url.includes(cfg.apiBalanceConfig.urlPattern);

            if (isDealUrl || isBalanceUrl) {
              const body = await response.json();
              if (isDealUrl) interceptedResponses.push({ url, body, timestamp: Date.now() });
              if (isBalanceUrl) {
                try { interceptedBalance = cfg.apiBalanceConfig.extract(body); } catch {}
              }
            }
          } catch {}
        });
        // Reload to trigger API calls now that the listener is active
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        console.log(`[${siteId}] API interception active`);
      }

      await humanDelay(page, browserResult.reused ? 2000 : 3000);

      const helpers = buildHelpers(page, siteId, siteName);
      const isBrowserAlive = async () => {
        try {
          await page.evaluate(() => document.readyState);
          return true;
        } catch {
          return false;
        }
      };
      const ensureLoggedInState = async (reason) => {
        let loggedInNow = false;
        try {
          loggedInNow = await cfg.isLoggedIn(page);
        } catch (err) {
          console.log(`[${siteId}] isLoggedIn probe failed during ${reason}: ${err.message}`);
        }

        if (loggedInNow) return { ok: true };
        if (!loginFn) return { ok: false, browserAlive: await isBrowserAlive() };

        const suffix = reason ? ` (${reason})` : '';
        console.log(`[${siteId}] Not logged in${suffix}, attempting login (attempt 1)...`);
        let loginSuccess = await loginFn(page, context, helpers);

        if (!loginSuccess) {
          console.log(`[${siteId}] Login attempt 1 failed — retrying after fresh navigation...`);
          try {
            await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await humanDelay(page, 3000);
          } catch {}
          console.log(`[${siteId}] Login attempt 2...`);
          loginSuccess = await loginFn(page, context, helpers);
        }

        return { ok: !!loginSuccess, browserAlive: await isBrowserAlive() };
      };
      const tryMidRunRelogin = async (reason) => {
        if (!loginFn || midRunReloginAttempts >= 2) return false;
        midRunReloginAttempts += 1;
        console.log(`[${siteId}] Session recovery ${midRunReloginAttempts}/2 — ${reason}`);
        const recovery = await ensureLoggedInState(reason);
        return recovery.ok;
      };

      // 1b. CLOUDFLARE BLOCK DETECTION + AUTO-CLEAR
      // Recurring bug class: Cloudflare WAF blocks the debug Chrome browser.
      // Previously fixed manually on McLuck, SpinBlitz, Hello Millions — now framework-level.
      // Detection: title contains "Cloudflare" or "Attention Required", body contains "you have been blocked".
      // Fix: Clear domain-specific cookies → reload → check again.
      try {
        const cfBlocked = await safeEval(page, () => {
          const title = document.title || '';
          const body = (document.body && document.body.innerText) || '';
          return title.includes('Cloudflare') || title.includes('Attention Required') ||
                 body.includes('you have been blocked') || body.includes('Sorry, you have been blocked');
        });
        if (cfBlocked) {
          console.log(`[${siteId}] Cloudflare block detected — clearing cookies and retrying...`);
          // Extract domain from siteUrl for targeted cookie clear
          const urlObj = new URL(siteUrl);
          const domain = '.' + urlObj.hostname.replace(/^www\./, '');
          await context.clearCookies({ domain });
          // Also clear www variant
          await context.clearCookies({ domain: urlObj.hostname });
          await humanDelay(page, 1000);
          await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await humanDelay(page, 3000);
          // Check if still blocked
          const stillBlocked = await safeEval(page, () => {
            const title = document.title || '';
            return title.includes('Cloudflare') || title.includes('Attention Required');
          });
          if (stillBlocked) {
            console.log(`[${siteId}] Still Cloudflare blocked after cookie clear`);
          } else {
            console.log(`[${siteId}] Cloudflare block cleared!`);
          }
        }
      } catch {}

      // 2. LOGIN CHECK
      const loginState = await ensureLoggedInState('startup');

      // 3. AUTO-LOGIN (with retry)
      if (!loginState.ok && loginFn) {
        // 4. FAIL: needsLogin (both attempts failed)
        if (!loginState.browserAlive) {
          result.error = 'Browser crashed or page closed during login';
          result.errorCode = 'BROWSER_ERROR';
          console.log(`[${siteId}] ERROR: ${result.error} (NOT a login issue)`);
          await notifyFailure(siteName, result.error, null);
          return result;
        }

        result.error = 'Not logged in - manual login required';
        result.needsLogin = true;
        console.log(`[${siteId}] ERROR: ${result.error}`);
        result.screenshot = await safeScreenshot(page, screenshotPath(siteId, 'login-required'));
        await notifyFailure(siteName, result.error, result.screenshot);
        console.log(`[${siteId}] Tab left open for manual login`);
        return result;
      } else if (!loginState.ok) {
        // No login function configured — can't auto-recover, notify immediately
        // Same browser health check — don't blame login if Chrome is dead
        if (!loginState.browserAlive) {
          result.error = 'Browser crashed or page closed during login check';
          result.errorCode = 'BROWSER_ERROR';
          console.log(`[${siteId}] ERROR: ${result.error} (NOT a login issue)`);
          await notifyFailure(siteName, result.error, null);
          return result;
        }

        result.error = 'Not logged in - manual login required';
        result.needsLogin = true;
        console.log(`[${siteId}] ERROR: ${result.error}`);
        result.screenshot = await safeScreenshot(page, screenshotPath(siteId, 'login-required'));
        await notifyFailure(siteName, result.error, result.screenshot);
        return result;
      }
      console.log(`[${siteId}] Logged in!`);

      // 5. DISMISS POPUPS (smart default: consent → dismiss loop → Escape)
      if (cfg.dismissPopups) {
        await cfg.dismissPopups(page, helpers);
      } else {
        // Step A: Cookie consent — high priority, one shot
        try {
          await clickByIntent(page, 'consent', { label: `${siteId}/consent`, siteSlug: siteId, siteName, minScore: 25, postClickDelay: 1000 });
        } catch {}

        // Step B: Up to 3 rounds of dismiss (modals, promos, popups)
        for (let round = 0; round < 3; round++) {
          const dismissed = await clickByIntent(page, 'dismiss', { label: `${siteId}/dismiss-${round}`, siteSlug: siteId, siteName, minScore: 25, postClickDelay: 800 });
          if (!dismissed) break;
          // If the dismiss click killed the page (e.g. promo banner navigation), re-navigate
          if (dismissed.pageCrashed) {
            console.log(`[${siteId}] Page crashed during dismiss — re-navigating to ${cfg.siteUrl}`);
            await page.goto(cfg.siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));
            break;
          }
        }

        // Step C: Escape fallback for anything left
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise(r => setTimeout(r, 300));
      }

      // 6. BALANCE BEFORE
      if (cfg.apiBalanceConfig && interceptedBalance !== null) {
        balanceBefore = interceptedBalance;
        console.log(`[${siteId}] Balance before (API): ${balanceBefore} SC`);
      } else if (cfg.scrapeBalance) {
        try {
          balanceBefore = await cfg.scrapeBalance(page, helpers);
          if (balanceBefore !== null) {
            console.log(`[${siteId}] Balance before: ${balanceBefore} SC`);
          }
        } catch (err) {
          console.log(`[${siteId}] Could not scrape balance before: ${err.message}`);
        }
      }

      // 6b. PERSIST BALANCE + LAST-CHECKED — update tracker on live runs only
      // Dry-runs should NOT stamp last_checked — it causes "Checked today" on the
      // dashboard for sites the 24hr runner hasn't actually touched yet.
      {
        const payload = {};
        if (!dryRun) payload.last_checked = new Date().toISOString();
        if (balanceBefore !== null) payload.bankroll = balanceBefore;
        if (Object.keys(payload).length > 0) {
          try {
            const updateRes = await fetch(`${TRACKER_API}/api/sites/${siteId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            if (updateRes.ok) {
              if (balanceBefore !== null) {
                console.log(`[${siteId}] Tracker synced: bankroll=${balanceBefore}${dryRun ? '' : ', last_checked=now'}`);
              }
            }
          } catch (err) {
            console.log(`[${siteId}] Could not sync tracker: ${err.message}`);
          }
        }
      }

      // 7. NAVIGATE (with one retry for transient page-load failures)
      try {
        await cfg.navigateToReward(page, helpers);
      } catch (navErr) {
        // If navigateToReward signaled cooldown, propagate immediately — no retry
        if (navErr.onCooldown) throw navErr;
        if (isLoginErrorMessage(navErr.message) && await tryMidRunRelogin(`during navigateToReward: ${navErr.message}`)) {
          await cfg.navigateToReward(page, helpers);
        } else {
          console.log(`[${siteId}] navigateToReward failed: ${navErr.message} — retrying after re-dismiss...`);
          await new Promise(r => setTimeout(r, 3000));
          // Re-dismiss popups (late-appearing modals are a common cause)
          if (cfg.dismissPopups) {
            await cfg.dismissPopups(page, helpers).catch(() => {});
          } else {
            try { await clickByIntent(page, 'dismiss', { label: `${siteId}/retry-dismiss`, siteSlug: siteId, siteName, minScore: 25, postClickDelay: 800 }); } catch {}
            await page.keyboard.press('Escape').catch(() => {});
          }
          await new Promise(r => setTimeout(r, 1000));
          await cfg.navigateToReward(page, helpers); // second failure = real failure
        }
      }

      // 8. COOLDOWN CHECK
      if (cfg.checkCooldown) {
        const cooldownResult = await cfg.checkCooldown(page);
        if (cooldownResult && cooldownResult.onCooldown) {
          result.error = cooldownResult.message || 'On cooldown';
          result.onCooldown = true;
          console.log(`[${siteId}] ${result.error}`);
          // afterCooldown hook: run pending tasks (rewards, spins) even on cooldown
          if (cfg.afterCooldown && page) {
            try { await cfg.afterCooldown(page, helpers); }
            catch (e) { console.log(`[${siteId}] afterCooldown error (non-fatal): ${e.message?.slice(0, 80)}`); }
          }
          await processDeals();
          if (page) await page.close();
          return result;
        }
      }

      // 9. DRY RUN GATE
      if (dryRun) {
        console.log(`[${siteId}] DRY RUN - stopping before collection`);
        await processDeals();
        result.success = true;
        result.dryRun = true;
        if (page) await page.close();
        return result;
      }

      // 10. COLLECT
      try {
        await cfg.collect(page, helpers);
      } catch (collectErr) {
        if (collectErr.onCooldown) throw collectErr;
        if (isLoginErrorMessage(collectErr.message) && await tryMidRunRelogin(`during collect: ${collectErr.message}`)) {
          await cfg.navigateToReward(page, helpers);
          await cfg.collect(page, helpers);
        } else {
          throw collectErr;
        }
      }

      // 10b. AUTO-CONFIRM — click OK/Got it/Continue after collection
      // Many sites show a "Congratulations!" modal that must be dismissed
      // before balance scraping works. Only fires if collector doesn't override.
      if (!cfg.afterCollect) {
        try {
          await helpers.delay(1000);
          await clickByIntent(page, 'confirm', { label: `${siteId}/auto-confirm`, siteSlug: siteId, siteName, minScore: 35, postClickDelay: 1000 });
        } catch {}
      }

      // 11. AFTER-COLLECT
      if (cfg.afterCollect) {
        await cfg.afterCollect(page, helpers);
      }

      // ─── VERIFICATION LAYER ─────────────────────────────────────────

      // 12. LOGIN RE-CHECK
      console.log(`[${siteId}] Verifying still logged in after collection...`);
      let stillLoggedIn = await cfg.isLoggedIn(page);
      if (!stillLoggedIn && await tryMidRunRelogin('after collection verification')) {
        stillLoggedIn = await cfg.isLoggedIn(page);
      }
      if (!stillLoggedIn) {
        result.error = 'Logged out during collection';
        result.needsLogin = true;
        console.log(`[${siteId}] ERROR: ${result.error}`);
        result.screenshot = await safeScreenshot(page, screenshotPath(siteId, 'logged-out-after'));
        await notifyFailure(siteName, result.error, result.screenshot);
        console.log(`[${siteId}] Tab left open for manual login`);
        return result;
      }
      console.log(`[${siteId}] Still logged in after collection`);

      // 13. PAGE SIGNAL SCAN
      let negativeSignals = [];
      let positiveSignals = [];
      try {
        const pageText = await safeEval(page, () => document.body.innerText.toLowerCase());
        const negPhrases = [
          'something went wrong', 'try again later', 'an error occurred',
          'request failed', 'session expired', 'please try again'
        ];
        const posPhrases = [
          'congratulations', 'successfully claimed', 'reward added',
          'bonus claimed', 'collected'
        ];
        negativeSignals = negPhrases.filter(p => pageText.includes(p));
        positiveSignals = posPhrases.filter(p => pageText.includes(p));
        if (negativeSignals.length) console.log(`[${siteId}] Negative signals: ${negativeSignals.join(', ')}`);
        if (positiveSignals.length) console.log(`[${siteId}] Positive signals: ${positiveSignals.join(', ')}`);
      } catch (err) {
        console.log(`[${siteId}] Could not scan page signals: ${err.message}`);
      }

      // 14. BALANCE AFTER
      let balanceAfter = null;
      if (cfg.scrapeBalance || cfg.apiBalanceConfig) {
        try {
          if (cfg.skipPostCollectNav) {
            // Skip navigation — scrape from current page (saves time on slow-loading sites)
            console.log(`[${siteId}] Scraping balance from current page (skipPostCollectNav)...`);
            if (cfg.scrapeBalance) {
              balanceAfter = await cfg.scrapeBalance(page, helpers);
              if (balanceAfter !== null) {
                console.log(`[${siteId}] Balance after: ${balanceAfter} SC`);
              }
            }
          } else {
            console.log(`[${siteId}] Navigating home to scrape balance after collection...`);
            interceptedBalance = null; // Reset to capture fresh data
            await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await humanDelay(page, 3000);

            // Try API balance first
            if (cfg.apiBalanceConfig && interceptedBalance !== null) {
              balanceAfter = interceptedBalance;
              console.log(`[${siteId}] Balance after (API): ${balanceAfter} SC`);
            } else if (cfg.scrapeBalance) {
              balanceAfter = await cfg.scrapeBalance(page, helpers);
              if (balanceAfter !== null) {
                console.log(`[${siteId}] Balance after: ${balanceAfter} SC`);
              }
            }
          }
        } catch (err) {
          console.log(`[${siteId}] Could not scrape balance after: ${err.message}`);
        }
      }

      // 15. DELTA VERIFICATION
      let confidence = 'assumed'; // default
      let verifyReason = '';
      let deltaRejected = false;

      if (cfg.scrapeBalance) {
        if (balanceBefore !== null && balanceAfter !== null) {
          const delta = balanceAfter - balanceBefore;
          console.log(`[${siteId}] Balance delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} SC`);

          // ── Delta sanity check ──────────────────────────────────────
          // Reject deltas that are obviously wrong before they corrupt bankroll.
          // Negative deltas: daily rewards never decrease balance — always a scrape error.
          // Oversized deltas: wildly disproportionate to expected reward — GC/SC confusion.
          const maxReasonableDelta = Math.max((rewardSC || 1) * 50, 10);
          if (delta < 0) {
            deltaRejected = true;
            console.warn(`[${siteId}] DELTA REJECTED: negative delta ${delta.toFixed(2)} — balance went DOWN during collection (scrape error)`);
          } else if (delta > maxReasonableDelta) {
            deltaRejected = true;
            console.warn(`[${siteId}] DELTA REJECTED: delta ${delta.toFixed(2)} exceeds ${maxReasonableDelta} (likely GC/SC confusion)`);
          }

          if (deltaRejected) {
            confidence = 'assumed';
            verifyReason = `delta rejected (${delta.toFixed(2)}), using hardcoded reward`;
            balanceAfter = null; // prevent bankroll corruption
            try {
              const rejErr = new Error(`Delta rejected: ${delta.toFixed(2)} SC (expected ~${rewardSC}). balanceBefore=${balanceBefore}, raw balanceAfter=${balanceBefore + delta}`);
              await notifyFailure(siteName, rejErr, null);
            } catch (notifErr) {
              console.warn(`[${siteId}] Delta rejection notification failed: ${notifErr.message}`);
            }
          } else if (delta !== 0) {
            // Non-zero delta = hard proof something changed
            confidence = 'verified';
            verifyReason = `balance delta ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;
          } else if (rewardSC === 0) {
            // GC-only sites — zero SC delta is expected and not suspicious.
            // Skip the expensive re-navigation + cooldown check that burns
            // the remaining site timeout budget (Yotta 300s regression 2026-04-25).
            confidence = 'assumed';
            verifyReason = 'zero delta expected (rewardSC: 0, GC-only site)';
            console.log(`[${siteId}] ${verifyReason}`);
          } else {
            // Zero delta — re-navigate to check for cooldown evidence
            console.log(`[${siteId}] Zero delta — checking for cooldown evidence...`);
            let cooldownFound = false;

            try {
              await cfg.navigateToReward(page, helpers);
              await humanDelay(page, 2000);

              if (cfg.checkCooldown) {
                const cdResult = await cfg.checkCooldown(page);
                if (cdResult && cdResult.onCooldown) {
                  cooldownFound = true;
                  verifyReason = `cooldown detected: ${cdResult.message || 'on cooldown'}`;
                }
              }

              if (!cooldownFound) {
                // Scan page for common cooldown keywords
                try {
                  const rewardText = await safeEval(page, () => document.body.innerText.toLowerCase());
                  const cooldownKeywords = ['cooldown', 'come back', 'already claimed', 'hours left', 'tomorrow', 'claimed', 'next spin', 'resets in'];
                  const foundKeyword = cooldownKeywords.find(kw => rewardText.includes(kw));
                  if (foundKeyword) {
                    cooldownFound = true;
                    verifyReason = `cooldown keyword found: "${foundKeyword}"`;
                  }
                } catch {}
              }
            } catch (navErr) {
              // If navigateToReward threw onCooldown, that IS the cooldown evidence
              if (navErr.onCooldown) {
                cooldownFound = true;
                verifyReason = `cooldown on re-navigation: ${navErr.message}`;
              } else {
                console.log(`[${siteId}] Re-navigation failed: ${navErr.message} — scanning current page...`);
                // Even if nav failed, check current page for cooldown keywords
                try {
                  const currentText = await safeEval(page, () => document.body.innerText.toLowerCase());
                  const cooldownKeywords = ['cooldown', 'come back', 'already claimed', 'hours left', 'tomorrow', 'claimed', 'next spin', 'resets in'];
                  const foundKeyword = cooldownKeywords.find(kw => currentText.includes(kw));
                  if (foundKeyword) {
                    cooldownFound = true;
                    verifyReason = `cooldown keyword found: "${foundKeyword}"`;
                  }
                } catch {}
              }
            }

            if (cooldownFound) {
              confidence = 'verified';
              console.log(`[${siteId}] Verified via cooldown: ${verifyReason}`);
            } else {
              confidence = 'unverified';
              verifyReason = 'balance unchanged, no cooldown detected';
              console.log(`[${siteId}] UNVERIFIED: ${verifyReason}`);
            }

            // ── Balance canary — alert on zero delta when SC was expected ─────────
            // If we're here: delta=0, not cooldown → the click likely landed on the wrong element.
            // This is alert-only — surfaces false positives for calibration.
            if (!cooldownFound && rewardSC > 0) {
              console.warn(`[${siteId}] CANARY: expected ${rewardSC} SC but delta=0 and no cooldown found — possible false-positive click`);
              try {
                const anomalyErr = new Error(`Balance canary: expected ${rewardSC} SC, got delta=0, no cooldown evidence`);
                await notifyFailure(siteName, anomalyErr, null);
              } catch (canaryErr) {
                console.warn(`[${siteId}] Canary notification failed: ${canaryErr.message}`);
              }
            }
          }
        } else {
          // One or both scrapes failed — can't verify via balance
          confidence = 'assumed';
          verifyReason = 'balance scrape incomplete';
          console.log(`[${siteId}] Balance scrape incomplete — assuming success`);
        }
      } else {
        // No scrapeBalance at all
        confidence = 'assumed';
        verifyReason = 'no balance scraping configured';
      }

      // Log signal reinforcement
      if (confidence === 'assumed' && positiveSignals.length) {
        console.log(`[${siteId}] Positive signals reinforce assumed success: ${positiveSignals.join(', ')}`);
      }
      if (confidence === 'assumed' && negativeSignals.length && !positiveSignals.length) {
        console.log(`[${siteId}] WARNING: negative signals with no positive signals (keeping assumed)`);
      }

      result.confidence = confidence;

      // Gate on unverified
      if (confidence === 'unverified') {
        result.success = false;
        result.unverified = true;
        result.error = `Collection unverified: ${verifyReason}`;
        console.log(`[${siteId}] UNVERIFIED — not updating tracker`);
        result.screenshot = await safeScreenshot(page, screenshotPath(siteId, 'unverified'));
        await notifyFailure(siteName, result.error, result.screenshot);
        console.log(`[${siteId}] Tab left open for inspection`);
        return result;
      }

      console.log(`[${siteId}] Confidence: ${confidence} (${verifyReason || 'collect returned without error'})`);

      // ─── END VERIFICATION LAYER ─────────────────────────────────────

      // 15b. DEALS PROCESSING (silent — never fails the collection)
      await processDeals();

      // 16. CALC REWARD
      let wonSC = rewardSC;
      let wonGC = rewardGC;

      if (cfg.parseReward) {
        try {
          const parsed = await cfg.parseReward(page, balanceBefore, balanceAfter);
          if (parsed) {
            wonSC = parsed.sc ?? wonSC;
            wonGC = parsed.gc ?? wonGC;
          }
        } catch (err) {
          console.log(`[${siteId}] Could not parse reward: ${err.message}`);
        }
      } else if (balanceBefore !== null && balanceAfter !== null && !deltaRejected) {
        wonSC = balanceAfter - balanceBefore;
        console.log(`[${siteId}] SC gained (balance diff): ${wonSC.toFixed(2)}`);
      }

      result.success = true;
      result.sc = wonSC;
      result.gc = wonGC;
      if (deltaRejected) {
        console.log(`[${siteId}] SUCCESS (delta rejected — using hardcoded reward ${wonSC} SC)`);
      } else {
        console.log(`[${siteId}] SUCCESS! Collected ${wonGC} GC & ${wonSC} SC`);
      }

      // 17. UPDATE TRACKER
      result.screenshot = await safeScreenshot(page, screenshotPath(siteId, 'success'));

      if (balanceAfter !== null) {
        // Full mode: scrape-based tracker update
        const trackerBankroll = await getTrackerBankroll(siteId);
        if (trackerBankroll !== null) {
          const scCollected = balanceAfter - trackerBankroll;
          result.scCollected = scCollected;
          result.trackerBankroll = trackerBankroll;
          result.actualBalance = balanceAfter;

          console.log(`[${siteId}] Balance comparison:`);
          console.log(`[${siteId}]   Balance after:  ${balanceAfter} SC`);
          console.log(`[${siteId}]   Tracker had:    ${trackerBankroll} SC`);
          console.log(`[${siteId}]   Difference:     ${scCollected >= 0 ? '+' : ''}${scCollected.toFixed(2)} SC`);

          result.trackerUpdated = await updateTrackerFull(siteId, balanceAfter, wonSC, wonGC);
        }
      } else {
        // Minimal mode: just record the collection with hardcoded rewards
        console.log(`[${siteId}] No balance data — recording collection with defaults`);
        result.trackerUpdated = await recordCollection(siteId, wonSC, wonGC);
      }

      // 17b. FREE SPINS CHECK (silent — never fails the collection)
      if (cfg.freeSpinCheck) {
        try {
          const spins = await cfg.freeSpinCheck(page, buildHelpers(page, siteId, siteName));
          if (spins && spins.count) {
            result.freeSpins = spins;
            console.log(`[${siteId}] 🎰 FREE SPINS DETECTED: ${spins.count} spins${spins.game ? ` on ${spins.game}` : ''}`);
            await notifyFreeSpins(siteName, spins).catch(() => {});
          }
        } catch (err) {
          console.log(`[${siteId}] Free spin check error (non-fatal): ${err.message}`);
        }
      }

      // 18. CLEANUP
      if (cfg.cleanup) {
        await cfg.cleanup(page, buildHelpers(page, siteId, siteName));
      }

      // 19. CLOSE TAB on success
      if (page) {
        console.log(`[${siteId}] Closing tab (success)`);
        await page.close();
      }

    } catch (err) {
      result.error = err.message;
      console.error(`[${siteId}] Error:`, err.message);

      // Detect cooldown signaled from collect()
      if (err.onCooldown) {
        result.onCooldown = true;
        console.log(`[${siteId}] On cooldown (signaled from collect)`);

        // bankrollSyncOnCooldown: record a 0/0 collection to sync balance and reset staleness
        if (cfg.bankrollSyncOnCooldown && balanceBefore !== null) {
          console.log(`[${siteId}] Bankroll sync on cooldown: ${balanceBefore} SC`);
          result.success = true;
          result.sc = 0;
          result.gc = 0;
          result.confidence = 'verified';
          await updateTrackerFull(siteId, balanceBefore, 0, 0);
        }

        // afterCooldown hook: run pending tasks (rewards, spins) even on cooldown
        if (cfg.afterCooldown && page) {
          const cdHelpers = buildHelpers(page, siteId, siteName);
          try { await cfg.afterCooldown(page, cdHelpers); }
          catch (e) { console.log(`[${siteId}] afterCooldown error (non-fatal): ${e.message?.slice(0, 80)}`); }
        }

        await processDeals();
        if (page) await page.close().catch(() => {});
        return result;
      }

      if (err.message.includes('ECONNREFUSED')) {
        result.error = 'Chrome not running with debug mode';
        console.log(`[${siteId}] Run start-debug-chrome.bat first!`);
      }

      // Detect login-related errors
      const isLoginError = isLoginErrorMessage(err.message);
      if (isLoginError) {
        result.needsLogin = true;
      }

      // ─── COOKIE NUKE + RETRY ────────────────────────────────────────
      // Universal fallback: on ANY first failure, nuke cookies and retry.
      // Stale cookies cause a wide range of symptoms beyond login/block errors:
      // geo-blocks, GC-only mode, stripped views, stale SPA state.
      // Nuking is cheap and catches the whole class. _cookieRetried prevents loops.
      // Exclude infrastructure errors where cookie nuke can't help:
      const isInfraError = /ECONNREFUSED|Chrome not running|connectOverCDP|Target page.*closed|browser has been closed|socket hang up/i.test(err.message);
      // Also exclude manual-action gates (phone/SMS/identity verification). Cookie nuke
      // re-logs-in and hits the same gate — wastes the timeout budget AND replaces the
      // diagnostic error message with a generic "Timed out" that hides the real cause.
      const isManualActionError = /Phone Verification|Verification Needed|Veriff|SMS verification|identity verification|manual login required/i.test(err.message);
      const shouldRetry = !_cookieRetried && !isInfraError && !isManualActionError && !cfg.skipCookieClear;

      if (shouldRetry && context) {
        console.log(`[${siteId}] Cookie-nuke retry: clearing cookies and retrying full flow...`);
        try {
          const urlObj = new URL(siteUrl);
          const domain = '.' + urlObj.hostname.replace(/^www\./, '');

          // Preserve Cloudflare cookies — nuking cf_clearance/cf_bm causes blank pages
          // on Cloudflare-protected sites (especially stealth:false Turnstile sites).
          // These tokens are never the problem; killing them makes retries harder.
          let cfCookies = [];
          try {
            const allCookies = await context.cookies([siteUrl]);
            cfCookies = allCookies.filter(c =>
              c.name === 'cf_clearance' || c.name.startsWith('__cf') || c.name === 'cf_chl_rc_m'
            );
          } catch {} // Non-fatal — just means no CF cookies to save

          await context.clearCookies({ domain });
          await context.clearCookies({ domain: urlObj.hostname });
          await context.clearCookies({ domain: 'www.' + urlObj.hostname.replace(/^www\./, '') });

          // Restore Cloudflare cookies
          if (cfCookies.length > 0) {
            await context.addCookies(cfCookies).catch(() => {});
            console.log(`[${siteId}] Cookies cleared for ${domain} (preserved ${cfCookies.length} CF cookies)`);
          } else {
            console.log(`[${siteId}] Cookies cleared for ${domain}`);
          }
        } catch (cookieErr) {
          console.log(`[${siteId}] Cookie clear failed: ${cookieErr.message}`);
        }

        // Also clear localStorage/sessionStorage — stale geo state and SPA caches
        // can survive cookie clears (e.g. StormRush onlyCoinsMode, SpinPals geo cache)
        if (page) {
          try {
            await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
            console.log(`[${siteId}] localStorage + sessionStorage cleared`);
          } catch {} // Page may already be destroyed — non-fatal
        }

        // Close the stale page
        if (page) await page.close().catch(() => {});

        // Retry the full collect flow with _cookieRetried flag
        console.log(`[${siteId}] Retrying collect after cookie nuke...`);
        const retryResult = await collect({ dryRun, _cookieRetried: true });
        if (retryResult.success || retryResult.onCooldown) {
          console.log(`[${siteId}] Cookie-nuke retry succeeded!`);
        } else {
          console.log(`[${siteId}] Cookie-nuke retry also failed: ${retryResult.error}`);
        }
        return retryResult;
      }

      if (page) {
        try {
          result.screenshot = await safeScreenshot(page, screenshotPath(siteId, 'error'));
        } catch {}
      }

      await notifyFailure(siteName, result.error, result.screenshot);
      // Restore Chrome window so user can inspect the failed tab
      await restoreChromeWindow().catch(() => {});
      console.log(`[${siteId}] Tab left open for inspection (failure)`);
    }

    return result;
  }

  // ─── CLI Runner ─────────────────────────────────────────────────────

  async function runCLI() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');

    console.log('='.repeat(50));
    console.log(`${siteName} Collector`);
    console.log('='.repeat(50));
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log('');

    // Prevent Chrome from stealing focus during single-site runs (dry-run or live).
    await startFocusGuard().catch(() => {});

    const result = await collect({ dryRun });

    stopFocusGuard();

    console.log('\n' + '='.repeat(50));
    if (result.success) {
      const tier = result.confidence || 'assumed';
      console.log(`RESULT: SUCCESS (${tier})`);
      if (result.sc !== undefined) console.log(`  SC Reward: +${result.sc}`);
      if (result.gc !== undefined) console.log(`  GC Reward: +${result.gc}`);
      if (result.actualBalance !== undefined) {
        console.log('');
        console.log('BALANCE COMPARISON:');
        console.log(`  Site Balance:   ${result.actualBalance} SC`);
        if (result.trackerBankroll !== undefined) {
          console.log(`  Tracker Had:    ${result.trackerBankroll} SC`);
        }
        if (result.scCollected !== undefined) {
          console.log(`  Difference:     ${result.scCollected >= 0 ? '+' : ''}${result.scCollected.toFixed(2)} SC`);
        }
        console.log(`  Tracker Updated: ${result.trackerUpdated ? 'YES' : 'NO'}`);
      }
    } else if (result.unverified) {
      console.log('RESULT: UNVERIFIED — balance unchanged, no cooldown detected');
      console.log(`  Error: ${result.error}`);
    } else if (result.onCooldown) {
      console.log('RESULT: ON COOLDOWN');
    } else {
      console.log('RESULT: FAILED');
      console.log(`  Error: ${result.error}`);
    }
    console.log('='.repeat(50));

    process.exit(result.success || result.onCooldown ? 0 : 1);
  }

  // ─── Export ─────────────────────────────────────────────────────────

  const loginMethod = cfg.oauth === 'google' ? 'google' : (cfg.loginMethod || null);

  const exported = {
    collect,
    runCLI,
    SITE_ID: siteId,
    SITE_NAME: siteName,
    SITE_URL: siteUrl,
    REWARD_SC: rewardSC,
    REWARD_GC: rewardGC,
    ...(loginMethod && { LOGIN_METHOD: loginMethod }),
  };

  // Attach performLogin if the collector has login capability
  if (loginFn) {
    exported.performLogin = loginFn;
  }

  return exported;
}

module.exports = { createCollector, safeEval };
