/**
 * Google OAuth Utility
 * Shared account selection and OAuth flow handling for all collectors
 *
 * Composable functions:
 * - selectGoogleAccount(page) — 3-fallback account picker
 * - handleConsentScreen(page) — clicks Continue/Allow if present
 * - handleGoogleOAuthPopup(popup) — full popup lifecycle
 * - handleGoogleOAuthRedirect(page, returnDomain, options) — redirect flow
 * - performGoogleOAuth(page, context, options) — auto-detects popup vs redirect
 */

'use strict';

const TARGET_EMAIL = process.env.GOOGLE_OAUTH_EMAIL || process.env.SWEEPSITES_EMAIL || 'your-email@gmail.com';

const GOOGLE_BUTTON_SELECTORS = [
  'button:has-text("Login with Google")',
  'button:has-text("Continue with Google")',
  'button:has-text("Sign in with Google")',
  'button:has-text("Google")',
  'a.btn-social.google',
  '[class*="google"]:not([class*="facebook"])',
  '[aria-label*="Google"]',
];

async function waitIfOpen(page, ms) {
  try {
    if (!page.isClosed()) {
      await page.waitForTimeout(ms);
    }
  } catch {}
}

async function selectGoogleAccount(page) {
  // Strategy 1: data-email attribute
  try {
    const btn = await page.$(`[data-email="${TARGET_EMAIL}"]`);
    if (btn) {
      await btn.click();
      console.log(`[google-oauth] Selected account via data-email`);
      return { success: true, method: 'data-email' };
    }
  } catch {}

  // Strategy 2: data-identifier attribute
  try {
    const btn = await page.$(`[data-identifier="${TARGET_EMAIL}"]`);
    if (btn) {
      await btn.click();
      console.log(`[google-oauth] Selected account via data-identifier`);
      return { success: true, method: 'data-identifier' };
    }
  } catch {}

  // Strategy 3: JS evaluation — find email text and click its clickable parent
  try {
    const clicked = await page.evaluate((email) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent.trim() === email) {
          let parent = node.parentElement;
          for (let i = 0; i < 8 && parent; i++) {
            const tag = parent.tagName.toLowerCase();
            const role = parent.getAttribute('role');
            if (tag === 'li' || tag === 'a' || tag === 'button' || role === 'link') {
              parent.click();
              return 'text-walk';
            }
            const rect = parent.getBoundingClientRect();
            if (rect.width > 200 && rect.height > 40) {
              parent.click();
              return 'text-walk-div';
            }
            parent = parent.parentElement;
          }
        }
      }
      return null;
    }, TARGET_EMAIL);

    if (clicked) {
      console.log(`[google-oauth] Selected account via ${clicked}`);
      return { success: true, method: clicked };
    }
  } catch {}

  console.log(`[google-oauth] Could not find account ${TARGET_EMAIL}`);
  return { success: false, error: 'Account not found on chooser page' };
}

async function handleConsentScreen(page) {
  try {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.innerText || '').trim();
        if (text === 'Continue' || text === 'Allow' || text === 'Approve') {
          btn.click();
          return text;
        }
      }
      return null;
    });

    if (clicked) {
      console.log(`[google-oauth] Clicked "${clicked}" on consent screen`);
      return true;
    }
  } catch {}

  return false;
}

async function handleGoogleOAuthPopup(popup) {
  console.log(`[google-oauth] Handling OAuth popup...`);

  try {
    await popup.waitForLoadState('domcontentloaded');
  } catch {}
  await waitIfOpen(popup, 2000);

  if (popup.isClosed()) {
    console.log(`[google-oauth] Popup closed before account selection — assuming auto-auth`);
    return { success: true, method: 'popup/auto-closed' };
  }

  const selectResult = await selectGoogleAccount(popup);

  if (!selectResult.success) {
    if (popup.isClosed()) {
      console.log(`[google-oauth] Popup closed during account selection — assuming auto-auth`);
      return { success: true, method: 'popup/auto-closed' };
    }
    return selectResult;
  }

  await waitIfOpen(popup, 2000);

  try {
    if (!popup.isClosed()) {
      await handleConsentScreen(popup);
    }
  } catch {}

  try {
    if (!popup.isClosed()) {
      await popup.waitForEvent('close', { timeout: 15000 });
    }
  } catch {
    try { if (!popup.isClosed()) await popup.close(); } catch {}
  }

  console.log(`[google-oauth] Popup flow complete`);
  return { success: true, method: `popup/${selectResult.method}` };
}

async function handleGoogleOAuthRedirect(page, returnDomain, options = {}) {
  const { timeout = 30000, settleDelay = 5000 } = options;

  console.log(`[google-oauth] Handling redirect flow...`);

  const selectResult = await selectGoogleAccount(page);

  await page.waitForTimeout(2000);
  await handleConsentScreen(page);

  if (returnDomain) {
    try {
      await page.waitForURL(`**/${returnDomain}/**`, { timeout });
      console.log(`[google-oauth] Redirected back to ${returnDomain}`);
    } catch {
      console.log(`[google-oauth] Redirect timeout — may already be on site or SPA processing`);
    }
  }

  await page.waitForTimeout(settleDelay);

  console.log(`[google-oauth] Redirect flow complete`);
  return { success: selectResult.success, method: `redirect/${selectResult.method || 'unknown'}` };
}

async function performGoogleOAuth(page, context, options = {}) {
  const {
    googleButtonSelector,
    returnDomain,
    popupTimeout = 5000,
    settleDelay = 5000
  } = options;

  let googleBtn = null;

  if (googleButtonSelector) {
    try {
      googleBtn = await page.waitForSelector(googleButtonSelector, { timeout: 5000, state: 'visible' });
    } catch {}
  }

  if (!googleBtn) {
    for (const sel of GOOGLE_BUTTON_SELECTORS) {
      try {
        googleBtn = await page.waitForSelector(sel, { timeout: 3000, state: 'visible' });
        if (googleBtn) {
          console.log(`[google-oauth] Found Google button: ${sel}`);
          break;
        }
      } catch {}
    }
  }

  if (!googleBtn) {
    return { success: false, method: 'none', error: 'Google button not found' };
  }

  const urlBefore = page.url();

  const box = await googleBtn.boundingBox();
  const clickFn = box
    ? () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    : () => googleBtn.click();

  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: popupTimeout }).catch(() => null),
    clickFn()
  ]);

  if (popup) {
    const result = await handleGoogleOAuthPopup(popup);
    await page.waitForTimeout(settleDelay);
    return { ...result, method: result.method || 'popup' };
  }

  const urlAfterWait = page.url();
  if (urlAfterWait !== urlBefore) {
    if (urlAfterWait.includes('accounts.google.com')) {
      const domain = returnDomain || new URL(urlBefore).hostname;
      console.log(`[google-oauth] Fast redirect to Google detected — handling redirect flow`);
      const result = await handleGoogleOAuthRedirect(page, domain, { settleDelay });
      return { ...result, method: 'redirect-fast' };
    } else {
      console.log(`[google-oauth] URL changed after click (fast OAuth roundtrip): ${urlAfterWait.slice(0, 80)}`);
      await page.waitForTimeout(settleDelay);
      return { success: true, method: 'redirect-completed' };
    }
  }

  await page.waitForTimeout(2000);
  if (page.url().includes('accounts.google.com')) {
    const domain = returnDomain || new URL(urlBefore).hostname;
    const result = await handleGoogleOAuthRedirect(page, domain, { settleDelay });
    return { ...result, method: result.method || 'redirect' };
  }

  // CDP popup fallback — check Chrome's HTTP debug API
  console.log(`[google-oauth] Playwright missed popup — checking Chrome HTTP API...`);
  const googleTab = await _findGoogleTabViaHttp();

  if (googleTab) {
    console.log(`[google-oauth] Found Google popup via HTTP API: ${googleTab.url.slice(0, 80)}`);

    const { chromium } = require('playwright-extra');
    const config = require('../config');
    let tempBrowser;
    try {
      tempBrowser = await chromium.connectOverCDP(config.chromeEndpoint);
      const tempCtx = tempBrowser.contexts()[0];
      const allPages = tempCtx.pages();
      const popupPage = allPages.find(p => {
        try { return p.url().includes('accounts.google.com'); } catch { return false; }
      });

      if (popupPage) {
        console.log(`[google-oauth] Handling popup via reconnect fallback...`);
        const result = await handleGoogleOAuthPopup(popupPage);
        await page.waitForTimeout(settleDelay);
        try { tempBrowser.disconnect(); } catch {}
        return { ...result, method: `http-fallback/${result.method || 'unknown'}` };
      }
    } catch (err) {
      console.log(`[google-oauth] Reconnect fallback failed: ${err.message}`);
    }
    try { if (tempBrowser) tempBrowser.disconnect(); } catch {}

    console.log(`[google-oauth] Waiting for Google popup to auto-close...`);
    const closed = await _waitForGoogleTabClose(8000);
    if (closed) {
      console.log(`[google-oauth] Google popup closed — checking login state...`);
      await page.waitForTimeout(settleDelay);
      return { success: true, method: 'http-fallback/auto-closed' };
    }
  }

  // Re-click fallback
  console.log(`[google-oauth] No popup detected — retrying click with alternative methods...`);

  try {
    await googleBtn.click({ timeout: 3000 });
    console.log(`[google-oauth] Re-clicked via locator.click()`);
    await page.waitForTimeout(3000);

    if (page.url().includes('accounts.google.com')) {
      const domain = returnDomain || new URL(urlBefore).hostname;
      const result = await handleGoogleOAuthRedirect(page, domain, { settleDelay });
      return { ...result, method: 'reclick-redirect' };
    }

    const retryTab = await _findGoogleTabViaHttp(3000);
    if (retryTab) {
      console.log(`[google-oauth] Popup appeared after re-click — handling via reconnect...`);
      const { chromium: chromiumRetry } = require('playwright-extra');
      const configRetry = require('../config');
      let retryBrowser;
      try {
        retryBrowser = await chromiumRetry.connectOverCDP(configRetry.chromeEndpoint);
        const retryCtx = retryBrowser.contexts()[0];
        const retryPages = retryCtx.pages();
        const retryPopup = retryPages.find(p => {
          try { return p.url().includes('accounts.google.com'); } catch { return false; }
        });

        if (retryPopup) {
          console.log(`[google-oauth] Handling re-click popup via reconnect...`);
          const result = await handleGoogleOAuthPopup(retryPopup);
          await page.waitForTimeout(settleDelay);
          try { retryBrowser.disconnect(); } catch {}
          return { ...result, method: `reclick/${result.method || 'unknown'}` };
        }
      } catch (err) {
        console.log(`[google-oauth] Re-click reconnect failed: ${err.message}`);
      }
      try { if (retryBrowser) retryBrowser.disconnect(); } catch {}

      const closed = await _waitForGoogleTabClose(10000);
      if (closed) {
        await page.waitForTimeout(settleDelay);
        return { success: true, method: 'reclick-popup/auto-closed' };
      }
      return { success: false, method: 'reclick-popup', error: 'Popup did not close — account selection may be required' };
    }
  } catch {}

  try {
    await googleBtn.evaluate(el => el.click());
    console.log(`[google-oauth] Re-clicked via JS dispatch`);
    await page.waitForTimeout(3000);

    if (page.url().includes('accounts.google.com')) {
      const domain = returnDomain || new URL(urlBefore).hostname;
      const result = await handleGoogleOAuthRedirect(page, domain, { settleDelay });
      return { ...result, method: 'jsclick-redirect' };
    }
  } catch {}

  console.log(`[google-oauth] All click methods failed — OAuth did not trigger`);
  return { success: false, method: 'none', error: 'OAuth flow did not trigger after multiple click attempts' };
}

async function _findGoogleTabViaHttp(maxWaitMs = 5000) {
  const http = require('http');
  const config = require('../config');
  const ep = config.chromeEndpoint.replace(/^http:\/\//, '');
  const [hostname, port] = ep.split(':');

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const tab = await new Promise(resolve => {
      http.get({ hostname, port: parseInt(port), path: '/json', timeout: 2000 }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const tabs = JSON.parse(data);
            resolve(tabs.find(t => t.type === 'page' && t.url.includes('accounts.google.com')) || null);
          } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
    if (tab) return tab;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function _waitForGoogleTabClose(maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const tab = await _findGoogleTabViaHttp(0);
    if (!tab) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function extractDomain(page) {
  try {
    const url = new URL(page.url());
    return url.hostname;
  } catch {
    return null;
  }
}

module.exports = {
  selectGoogleAccount,
  handleConsentScreen,
  handleGoogleOAuthPopup,
  handleGoogleOAuthRedirect,
  performGoogleOAuth,
  GOOGLE_BUTTON_SELECTORS,
  TARGET_EMAIL
};
