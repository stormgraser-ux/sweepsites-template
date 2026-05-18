/**
 * Browser Utilities
 * Shared helpers for Playwright browser operations
 * Now with playwright-extra stealth plugin for anti-detection
 */

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const config = require('../config');
const { injectStealthPatches } = require('./humanize');

// Add stealth plugin with all evasions enabled
chromium.use(StealthPlugin());

// Track active CDP connections so batch runners can disconnect after each collector.
// Without this, 59 sequential collectors accumulate 59 open WebSocket connections
// and Chrome's debug protocol stops accepting new ones (CDP timeout cascade).
const _activeBrowsers = new Set();

// Shared CDP connection — reuse a single WebSocket across all browser.js functions
// within a collector cycle. Creating a new connectOverCDP per function call was the
// root cause of Chrome CDP exhaustion after ~40 sequential collectors.
let _sharedBrowser = null;

/**
 * Get or create a shared CDP connection to Chrome.
 * All browser.js functions use this instead of calling connectOverCDP directly.
 * disconnectAll() resets it so the next collector gets a fresh connection.
 */
async function _getConnection() {
  if (_sharedBrowser) {
    try {
      if (_sharedBrowser.isConnected()) return _sharedBrowser;
    } catch {}
    _sharedBrowser = null;
  }

  // Retry with backoff — CDP can be temporarily contended when Playwright MCP
  // or other clients hold a concurrent connection to the same Chrome instance.
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const browser = await chromium.connectOverCDP(config.chromeEndpoint);
      _sharedBrowser = browser;
      _activeBrowsers.add(browser);
      return browser;
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = attempt * 5000; // 5s, 10s
        console.log(`[browser] CDP connection attempt ${attempt}/${maxRetries} failed, retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Create a new page via Chrome's HTTP debug API + reconnect.
 * Workaround for Playwright 1.58 + Chrome 137 where context.newPage() is broken over CDP.
 * Uses PUT /json/new to create the tab, then navigates to the target URL.
 */
async function _createPageViaHttp(siteUrl, stealth = true) {
  const http = require('http');
  const ep = config.chromeEndpoint.replace(/^http:\/\//, '');
  const [hostname, port] = ep.split(':');
  const fullUrl = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`;

  // Create blank tab via HTTP PUT (Chrome 137 requires PUT for /json/new)
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname, port: parseInt(port), path: '/json/new?about:blank', method: 'PUT', timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });

  // Reconnect so Playwright sees the new tab
  _sharedBrowser = null;
  for (const b of _activeBrowsers) { try { b.disconnect(); } catch {} }
  _activeBrowsers.clear();
  const browser = await _getConnection();
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url() === 'about:blank');
  if (!page) throw new Error('Failed to find newly created blank tab after HTTP PUT');

  // Inject stealth patches before navigation
  if (stealth) {
    try {
      await injectStealthPatches(page);
      console.log('[browser] Stealth patches injected');
    } catch (e) {
      console.log(`[browser] Note: Could not inject stealth patches: ${e.message}`);
    }
  }

  // Navigate to the target site
  // ERR_ABORTED handling: some sites (Cloudflare-proxied, service-worker-heavy) abort
  // the initial navigation via JS redirect or SW fetch cancel. The page often loads fine
  // after the abort — Playwright just lost track of the navigation lifecycle.
  // Timeout handling: Cloudflare-protected sites can take >60s on the challenge page.
  // Retry with waitUntil:'commit' (less strict — page started loading) then settle.
  try {
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeout || 60000 });
  } catch (err) {
    if (err.message && err.message.includes('ERR_ABORTED')) {
      console.log(`[browser] ERR_ABORTED on initial goto — retrying with waitUntil:commit...`);
      try {
        await page.goto(fullUrl, { waitUntil: 'commit', timeout: 30000 });
        // Give the page time to finish loading after commit
        await new Promise(r => setTimeout(r, 3000));
      } catch (retryErr) {
        // Check if the page actually loaded despite the error
        const currentUrl = page.url();
        const domain = fullUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
        if (currentUrl.includes(domain)) {
          console.log(`[browser] Page loaded despite navigation error (at ${currentUrl.slice(0, 80)})`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          throw retryErr;
        }
      }
    } else if (err.message && (err.message.includes('Timeout') || err.message.includes('timeout'))) {
      console.log(`[browser] Timeout on initial goto — retrying with waitUntil:commit...`);
      try {
        await page.goto(fullUrl, { waitUntil: 'commit', timeout: 30000 });
        // Longer settle for timeout recovery — page was loading but slow
        console.log(`[browser] Commit succeeded — waiting 10s for page to settle...`);
        await new Promise(r => setTimeout(r, 10000));
      } catch (retryErr) {
        const currentUrl = page.url();
        const domain = fullUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
        if (currentUrl.includes(domain)) {
          console.log(`[browser] Page loaded despite timeout retry error (at ${currentUrl.slice(0, 80)})`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          throw err; // throw original timeout error for clearer diagnostics
        }
      }
    } else {
      throw err;
    }
  }
  return page;
}

/**
 * Get or create a page for a specific site
 * Reuses existing tabs to avoid multi-tab session conflicts
 *
 * @param {string} siteUrl - The site URL or domain to match (e.g., 'jefebet.com')
 * @param {object} options - Options
 * @param {boolean} options.refresh - Whether to refresh existing tab (default: true)
 * @param {boolean} options.stealth - Whether to inject stealth patches (default: true)
 *                                    Set to false for sites with Cloudflare Turnstile
 * @returns {Promise<{browser, context, page, reused: boolean}>}
 */
async function getOrCreatePage(siteUrl, options = {}) {
  const { refresh = true, stealth = true } = options;

  // Extract domain from URL for matching
  const domain = siteUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

  let browser = await _getConnection();
  let contexts = browser.contexts();
  let context = contexts[0] || await browser.newContext();

  // Auto-grant geolocation permission so "Know your location" prompts never appear
  // Uses both Playwright API and CDP Browser.setPermission for reliability with CDP connections
  await context.grantPermissions(['geolocation']).catch(() => {});
  try {
    const origin = siteUrl.startsWith('http') ? new URL(siteUrl).origin : `https://${siteUrl.split('/')[0]}`;
    const anyPage = context.pages()[0];
    if (anyPage) {
      const cdp = await context.newCDPSession(anyPage);
      await cdp.send('Browser.setPermission', {
        permission: { name: 'geolocation' },
        setting: 'granted',
        origin
      });
      await cdp.detach();
    }
  } catch {}

  // Check for existing tab with this site
  const existingPages = context.pages();
  let existingTab = null;

  for (const p of existingPages) {
    try {
      const url = p.url();
      if (url.includes(domain)) {
        existingTab = p;
        break;
      }
    } catch {}
  }

  let page;
  let reused = false;

  if (existingTab) {
    page = existingTab;
    reused = true;
    console.log(`[browser] Found existing tab for ${domain}, reusing it`);

    // Inject additional stealth patches before refresh (unless disabled)
    if (stealth) {
      try {
        await injectStealthPatches(page);
        console.log(`[browser] Stealth patches injected`);
      } catch (e) {
        console.log(`[browser] Note: Could not inject stealth patches: ${e.message}`);
      }
    }

    if (refresh) {
      console.log(`[browser] Refreshing existing tab...`);
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeout || 60000 });
      } catch (err) {
        if (err.message && err.message.includes('ERR_ABORTED')) {
          console.log(`[browser] ERR_ABORTED on reload — page may have redirected, waiting for settle...`);
          await new Promise(r => setTimeout(r, 3000));
        } else if (err.message && (err.message.includes('Timeout') || err.message.includes('timeout'))) {
          console.log(`[browser] Timeout on reload — retrying with waitUntil:commit...`);
          try {
            await page.reload({ waitUntil: 'commit', timeout: 30000 });
            console.log(`[browser] Commit succeeded on reload — waiting 10s for settle...`);
            await new Promise(r => setTimeout(r, 10000));
          } catch (retryErr) {
            // If page URL is still on the right domain, it probably loaded
            const currentUrl = page.url();
            if (currentUrl && currentUrl !== 'about:blank' && !currentUrl.includes('chrome://')) {
              console.log(`[browser] Reload settled despite error (at ${currentUrl.slice(0, 80)})`);
              await new Promise(r => setTimeout(r, 5000));
            } else {
              throw err;
            }
          }
        } else if (err.message && err.message.includes('has been closed')) {
          // Tab was closed externally (crash, manual close) — fall back to new tab
          console.log(`[browser] Stale tab detected (closed externally) — creating fresh tab`);
          page = await _createPageViaHttp(siteUrl, stealth);
          browser = _sharedBrowser;
          context = browser.contexts()[0];
          reused = false;
        } else {
          throw err;
        }
      }
    }
  } else {
    // Chrome 137 broke Playwright's context.newPage() over CDP — create via HTTP API instead
    page = await _createPageViaHttp(siteUrl, stealth);
    // _createPageViaHttp handles navigation + stealth injection
    // Re-read browser/context since _createPageViaHttp reconnects
    browser = _sharedBrowser;
    context = browser.contexts()[0];
    console.log(`[browser] Created new tab for ${domain}`);
  }

  // Blur the page so page-initiated window.focus() calls don't steal focus from the user's workspace.
  // Time-boxed (5s) — on SPAs that thrash the JS context (goldmachine.com GeoComply), evaluate can
  // hang indefinitely. Focus-guard is best-effort; skip it on timeout rather than wedge the collector.
  await Promise.race([
    page.evaluate(() => {
      try {
        window.blur();
        window.addEventListener('focus', () => window.blur(), { capture: true, passive: true });
      } catch {}
    }).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);

  // Dialog guard — when no listener is registered Playwright auto-dismisses, and
  // that auto-dismiss races with the page tearing down the dialog itself, which
  // throws "No dialog is showing" as an unhandled rejection that can kill the
  // runner (SpinSaga 2026-04-18). Registering our own listener lets us dismiss
  // safely with try/catch.
  page.on('dialog', async (dialog) => {
    try { await dialog.dismiss(); } catch {}
  });

  return { browser, context, page, reused };
}

/**
 * Close all tabs for a specific site
 * Useful for cleanup or resetting state
 *
 * @param {string} siteUrl - The site URL or domain to match
 * @returns {Promise<number>} Number of tabs closed
 */
async function closeAllTabsForSite(siteUrl) {
  const domain = siteUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

  try {
    const browser = await _getConnection();
    const contexts = browser.contexts();
    let closedCount = 0;

    for (const context of contexts) {
      const pages = context.pages();
      for (const page of pages) {
        try {
          const url = page.url();
          if (url.includes(domain)) {
            await page.close();
            closedCount++;
            console.log(`[browser] Closed tab for ${domain}`);
          }
        } catch {}
      }
    }

    return closedCount;
  } catch (err) {
    console.error(`[browser] Error closing tabs:`, err.message);
    return 0;
  }
}

/**
 * Find an existing page for a site without creating a new one
 *
 * @param {string} siteUrl - The site URL or domain to match
 * @returns {Promise<{browser, context, page} | null>}
 */
async function findExistingPage(siteUrl) {
  const domain = siteUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

  try {
    const browser = await _getConnection();
    const contexts = browser.contexts();

    for (const context of contexts) {
      const pages = context.pages();
      for (const page of pages) {
        try {
          const url = page.url();
          if (url.includes(domain)) {
            return { browser, context, page };
          }
        } catch {}
      }
    }

    return null;
  } catch (err) {
    console.error(`[browser] Error finding page:`, err.message);
    return null;
  }
}

/**
 * Close social media and OAuth tabs that get left open during login flows
 * Call this at the end of successful collections to clean up
 *
 * @returns {Promise<number>} Number of tabs closed
 */
async function closeSocialMediaTabs() {
  // Domains to close - social media and OAuth providers
  const socialDomains = [
    'facebook.com',
    'accounts.google.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'linkedin.com',
    'apple.com/auth',
    'appleid.apple.com'
  ];

  try {
    const browser = await _getConnection();
    const contexts = browser.contexts();
    let closedCount = 0;

    for (const context of contexts) {
      const pages = context.pages();
      for (const page of pages) {
        try {
          const url = page.url();
          const shouldClose = socialDomains.some(domain => url.includes(domain));
          if (shouldClose) {
            const title = await page.title().catch(() => 'unknown');
            await page.close();
            closedCount++;
            console.log(`[browser] Closed social tab: ${title.slice(0, 30)}`);
          }
        } catch {}
      }
    }

    if (closedCount > 0) {
      console.log(`[browser] Cleaned up ${closedCount} social media tab(s)`);
    }

    return closedCount;
  } catch (err) {
    console.error(`[browser] Error closing social tabs:`, err.message);
    return 0;
  }
}

/**
 * Take a screenshot with timeout protection
 * A failed debug screenshot should never kill a collection
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} filepath - Full path to save the screenshot
 * @param {number} timeout - Timeout in ms (default 10s)
 * @returns {Promise<string|null>} filepath on success, null on failure
 */
async function safeScreenshot(page, filepath, timeout = 10000) {
  try {
    await page.screenshot({ path: filepath, timeout });
    return filepath;
  } catch (err) {
    console.log(`[browser] Screenshot failed (${err.message.slice(0, 80)})`);
    return null;
  }
}

/**
 * Dismiss common overlays that block clicks
 * Conservative selectors — excludes daily/bonus/reward modals we WANT to interact with
 *
 * @param {import('playwright').Page} page - Playwright page
 */
async function dismissOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    const blockers = document.querySelectorAll(
      '.__btgPromoHolder, [class*="overlay"]:not([class*="daily"]), ' +
      '[class*="modal"]:not([class*="daily"]):not([class*="bonus"]):not([class*="reward"])'
    );
    blockers.forEach(el => { el.style.display = 'none'; });
  }).catch(() => {});
}

/**
 * Click an element with a 4-step retry ladder for resilience against overlays
 *
 * Retry ladder:
 * 1. Normal click
 * 2. Dismiss overlays + retry normal click
 * 3. Force click (bypasses actionability checks)
 * 4. JavaScript click (bypasses Playwright entirely)
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {string|import('playwright').ElementHandle} target - CSS selector or ElementHandle
 * @param {object} options
 * @param {number} options.timeout - Per-attempt timeout in ms (default 5s)
 * @param {string} options.label - Label for logging (e.g. "claim button")
 * @param {boolean} options.dismissOverlays - Try overlay dismissal before retrying (default true)
 * @returns {Promise<{success: boolean, method: string}>}
 */
async function resilientClick(page, target, options = {}) {
  const { timeout = 5000, label = 'element', dismissOverlays: shouldDismiss = true } = options;

  // Resolve to element handle if given a selector
  const getElement = async () => {
    if (typeof target === 'string') {
      return await page.$(target);
    }
    return target;
  };

  // Step 1: Normal click
  try {
    const el = await getElement();
    if (!el) return { success: false, method: 'not-found' };
    await el.click({ timeout });
    console.log(`[browser] Clicked ${label} (normal)`);
    return { success: true, method: 'normal' };
  } catch (err) {
    console.log(`[browser] Normal click failed for ${label}: ${err.message.slice(0, 60)}`);
  }

  // Step 2: Dismiss overlays + retry
  if (shouldDismiss) {
    try {
      await dismissOverlays(page);
      await page.waitForTimeout(500);
      const el = await getElement();
      if (el) {
        await el.click({ timeout });
        console.log(`[browser] Clicked ${label} (after overlay dismissal)`);
        return { success: true, method: 'dismiss-retry' };
      }
    } catch (err) {
      console.log(`[browser] Dismiss+retry failed for ${label}: ${err.message.slice(0, 60)}`);
    }
  }

  // Step 3: Coordinate-based mouse click (bypasses ALL Playwright actionability checks)
  // This is the fix for the recurring "element not visible/enabled" timeout class of bugs.
  // Real mouse event at element center — works when element is behind overlays, CSS-transformed,
  // or otherwise "not visible" to Playwright's checks.
  try {
    const el = await getElement();
    if (el) {
      const box = await el.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // Viewport bounds check — clicking offscreen coordinates is a silent no-op
        const vp = page.viewportSize() || { width: 1280, height: 720 };
        if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) {
          console.log(`[browser] Coordinate click SKIPPED for ${label} — offscreen (${Math.round(cx)},${Math.round(cy)}) vs viewport ${vp.width}x${vp.height}`);
        } else {
          await page.mouse.click(cx, cy);
          console.log(`[browser] Clicked ${label} (coordinate @ ${Math.round(cx)},${Math.round(cy)})`);
          return { success: true, method: 'coordinate' };
        }
      }
    }
  } catch (err) {
    console.log(`[browser] Coordinate click failed for ${label}: ${err.message.slice(0, 60)}`);
  }

  // Step 4: Force click
  try {
    const el = await getElement();
    if (el) {
      await el.click({ force: true, timeout });
      console.log(`[browser] Clicked ${label} (force)`);
      return { success: true, method: 'force' };
    }
  } catch (err) {
    console.log(`[browser] Force click failed for ${label}: ${err.message.slice(0, 60)}`);
  }

  // Step 5: JavaScript click
  try {
    const el = await getElement();
    if (el) {
      await el.evaluate(node => node.click());
      console.log(`[browser] Clicked ${label} (JS dispatch)`);
      return { success: true, method: 'js-dispatch' };
    }
  } catch (err) {
    console.log(`[browser] JS click failed for ${label}: ${err.message.slice(0, 60)}`);
  }

  console.log(`[browser] All click methods failed for ${label}`);
  return { success: false, method: 'all-failed' };
}

/**
 * Disconnect all tracked CDP browser connections.
 * Call this after each collector in batch runners to prevent connection accumulation.
 * Safe to call — only drops WebSocket connections, doesn't close Chrome or tabs.
 */
function disconnectAll() {
  _sharedBrowser = null;
  let count = 0;
  for (const browser of _activeBrowsers) {
    try {
      browser.disconnect();
      count++;
    } catch {}
  }
  _activeBrowsers.clear();
  if (count > 0) {
    console.log(`[browser] Disconnected ${count} CDP connection(s)`);
  }
}

/**
 * Close blank/empty tabs and social media leftovers via raw DevTools HTTP API.
 * Call between collectors in batch runs to prevent tab/service-worker bloat.
 * Uses raw HTTP (not Playwright CDP) so it works even when Chrome is under load.
 */
async function cleanupStaleTargets() {
  const http = require('http');
  const endpoint = config.chromeEndpoint.replace(/^http:\/\//, '');
  const [hostname, port] = endpoint.split(':');

  function httpGet(path) {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname, port: parseInt(port), path, timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  try {
    const { body } = await httpGet('/json');
    const targets = JSON.parse(body);
    const pages = targets.filter(t => t.type === 'page');

    // Close blank tabs (keep at most one) and social/OAuth leftovers
    const socialDomains = ['accounts.google.com', 'facebook.com', 'twitter.com', 'x.com', 'appleid.apple.com'];
    let keptBlank = false;
    let closed = 0;

    for (const page of pages) {
      const isBlank = page.url === 'about:blank' || page.url.includes('newtab') || page.url.includes('new-tab-page');
      const isSocial = socialDomains.some(d => page.url.includes(d));

      if (isBlank && !keptBlank) {
        keptBlank = true;
        continue;
      }

      if (isBlank || isSocial) {
        try {
          await httpGet(`/json/close/${page.id}`);
          closed++;
        } catch {}
      }
    }

    // Close accumulated service workers — each casino site registers one,
    // and 59 collectors can pile up 78+ service workers that overload Chrome.
    const workers = targets.filter(t => t.type === 'service_worker');
    for (const sw of workers) {
      try {
        await httpGet(`/json/close/${sw.id}`);
        closed++;
      } catch {}
    }

    if (closed > 0) {
      console.log(`[browser] Cleaned up ${closed} stale target(s) (${workers.length} service workers)`);
    }
  } catch (err) {
    // Non-fatal — just skip cleanup if Chrome isn't responding to HTTP
  }
}

/**
 * Aggressively close ALL page tabs, keeping only one blank tab.
 * Call this before batch runs to prevent Chrome from getting overwhelmed
 * by accumulated tabs from previous runs (especially failed collectors
 * that leave tabs open for inspection).
 */
async function closeAllTabs() {
  const http = require('http');
  const endpoint = config.chromeEndpoint.replace(/^http:\/\//, '');
  const [hostname, port] = endpoint.split(':');

  function httpGet(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname, port: parseInt(port), path: urlPath, timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  try {
    const { body } = await httpGet('/json');
    const targets = JSON.parse(body);
    const pages = targets.filter(t => t.type === 'page');

    if (pages.length <= 1) return;

    // Keep one blank tab (create one if needed via the first close, Chrome auto-creates)
    let closed = 0;
    let keptOne = false;

    for (const page of pages) {
      const isBlank = page.url === 'about:blank' || page.url.includes('newtab') || page.url.includes('new-tab-page');
      if (isBlank && !keptOne) {
        keptOne = true;
        continue;
      }
      try {
        await httpGet(`/json/close/${page.id}`);
        closed++;
      } catch {}
    }

    // Also close service workers — each casino site registers one,
    // and 90 collectors can pile up 100+ service workers that overload Chrome.
    const workers = targets.filter(t => t.type === 'service_worker');
    for (const sw of workers) {
      try {
        await httpGet(`/json/close/${sw.id}`);
        closed++;
      } catch {}
    }

    // If we didn't keep a blank tab, create one so Chrome never hits 0 tabs.
    // Playwright CDP can't call context.newPage() on a context with 0 pages.
    if (!keptOne) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.request({ hostname, port: parseInt(port), path: '/json/new?about:blank', method: 'PUT', timeout: 5000 }, (res) => {
            res.resume();
            res.on('end', resolve);
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });
        console.log('[browser] Created blank tab (none existed after cleanup)');
      } catch {}
    }

    if (closed > 0) {
      console.log(`[browser] Cleanup: closed ${closed} target(s) (${pages.length} tabs, ${workers.length} service workers)`);
    }
  } catch (err) {
    console.log(`[browser] Tab cleanup skipped: ${err.message}`);
  }
}

/**
 * Get the Chrome window ID via CDP (needed for minimize/restore).
 * Reuses the shared connection if available, otherwise connects briefly.
 */
async function _getChromeWindowId() {
  try {
    const browser = await _getConnection();
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) return null;
    const pages = context.pages();
    if (!pages.length) return null;
    const cdp = await context.newCDPSession(pages[0]);
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const pageTarget = targetInfos.find(t => t.type === 'page');
      if (!pageTarget) return null;
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pageTarget.targetId });
      return windowId;
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {
    return null;
  }
}

/**
 * Minimize the Chrome window so automation tabs don't steal focus from the user's workspace.
 * When minimized, Chrome's SetForegroundWindow calls only flash the taskbar — the window
 * stays hidden and doesn't pop over other applications.
 * Call at batch start. Chrome continues loading pages fine while minimized.
 */
async function minimizeChromeWindow() {
  const windowId = await _getChromeWindowId();
  if (windowId == null) return;
  try {
    const browser = await _getConnection();
    const context = browser.contexts()[0];
    const pages = context.pages();
    if (!pages.length) return;
    const cdp = await context.newCDPSession(pages[0]);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
    console.log('[browser] Chrome window minimized (focus-steal prevention)');
  } catch {}
}

/**
 * Restore the Chrome window to normal state.
 * Call when leaving a tab open for manual inspection after a failure.
 */
async function restoreChromeWindow() {
  const windowId = await _getChromeWindowId();
  if (windowId == null) return;
  try {
    const browser = await _getConnection();
    const context = browser.contexts()[0];
    const pages = context.pages();
    if (!pages.length) return;
    const cdp = await context.newCDPSession(pages[0]);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.detach().catch(() => {});
    console.log('[browser] Chrome window restored');
  } catch {}
}

module.exports = {
  getOrCreatePage,
  closeAllTabsForSite,
  findExistingPage,
  closeSocialMediaTabs,
  safeScreenshot,
  dismissOverlays,
  resilientClick,
  disconnectAll,
  cleanupStaleTargets,
  closeAllTabs,
  minimizeChromeWindow,
  restoreChromeWindow
};
