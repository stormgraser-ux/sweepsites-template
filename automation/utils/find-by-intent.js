/**
 * Heuristic Element Finder — Intent-Based
 *
 * Instead of hardcoding CSS selectors that break when sites update,
 * describe WHAT you want ('claim', 'dismiss', 'login') and let the
 * scoring engine find the best match.
 *
 * Returns coordinates ready for page.mouse.click() — no stale handles.
 *
 * Usage:
 *   const result = await findByIntent(page, 'claim');
 *   if (result) await page.mouse.click(result.x, result.y);
 *
 *   // Or the sugar version:
 *   await clickByIntent(page, 'claim');
 */

'use strict';

const config = require('../config');
const { getCachedSelector, incrementSuccess, evictSidecar, writeSidecar } = require('./sidecar-cache');
const { consultOracle } = require('./llm-oracle');

// ─── Built-in Intents ──────────────────────────────────────────────────────

const INTENTS = {
  claim: {
    textPatterns: [
      'claim', 'collect', 'get coins', 'get bonus', 'redeem',
      'spin', 'daily bonus', 'free coins', 'get free', 'grab',
      'receive', 'open', 'get reward', 'daily reward'
    ],
    positionBias: 'center',
    excludeText: [
      'buy', 'purchase', 'upgrade', 'subscribe', '$', 'deposit',
      'accept cookie', 'cookie', 'privacy'
    ]
  },

  dismiss: {
    textPatterns: [
      'close', '×', '✕', '✖', 'x', 'no thanks', 'no, thanks',
      'maybe later', 'skip', 'not now', 'dismiss', 'cancel',
      'i don\'t want', 'remind me later'
    ],
    positionBias: null,
    excludeText: ['logout', 'sign out', 'delete'],
    // Dismiss buttons are often tiny X buttons — relax size requirements
    minWidth: 15,
    minHeight: 15
  },

  login: {
    textPatterns: [
      'log in', 'login', 'sign in', 'signin',
      'continue with google', 'sign in with google',
      'get started', 'join now', 'create account'
    ],
    positionBias: 'top',
    excludeText: ['logout', 'log out', 'sign out']
  },

  confirm: {
    textPatterns: [
      'ok', 'okay', 'got it', 'continue', 'confirm', 'awesome',
      'thanks', 'great', 'done', 'accept', 'agree', 'understood',
      'alright', 'sweet', 'nice', 'let\'s go', 'start'
    ],
    positionBias: 'center',
    excludeText: [
      'accept cookie', 'cookie policy', 'privacy', 'terms',
      'buy', 'purchase', '$', 'deposit'
    ]
  },

  cooldown: {
    textPatterns: [
      'claim', 'collect', 'come back', 'tomorrow',
      'already claimed', 'next bonus', 'hours left',
      'cooldown', 'resets in', 'next spin', 'wait'
    ],
    positionBias: 'center',
    excludeText: [],
    // For cooldown detection, disabled elements are what we WANT
    invertDisabled: true
  },

  consent: {
    textPatterns: [
      'accept all', 'accept cookies', 'allow all', 'allow cookies',
      'i accept', 'accept all cookies', 'agree', 'got it',
      'i agree', 'accept & continue'
    ],
    positionBias: null,
    excludeText: ['decline', 'reject', 'manage']
  }
};

// ─── Browser-Side Scoring Function ─────────────────────────────────────────
// This entire function is serialized into page.evaluate(). Keep it
// self-contained with zero external dependencies.

function scoreElementsInBrowser(args) {
  // Playwright page.evaluate() only accepts a single argument.
  // Caller merges intentConfig + options into one object.
  const {
    textPatterns,
    positionBias,
    excludeText = [],
    invertDisabled = false,
    minWidth = 30,
    minHeight = 15,
    maxElements = 500,
    minScore = 30,
    extraPatterns = [],
    extraExclude = [],
    customRegex = null
  } = args;

  const allPatterns = [...textPatterns, ...extraPatterns].map(p => p.toLowerCase());
  const allExclude = [...excludeText, ...extraExclude].map(e => e.toLowerCase());
  const compiledRegex = customRegex ? new RegExp(customRegex, 'i') : null;

  const viewW = window.innerWidth || document.documentElement.clientWidth;
  const viewH = window.innerHeight || document.documentElement.clientHeight;

  // Collect candidate elements — cast a wide net
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], ' +
    'div[onclick], span[onclick], div[class*="btn"], div[class*="button"], span[class*="btn"]'
  );

  const results = [];
  const seen = candidates.length > maxElements ? maxElements : candidates.length;

  for (let i = 0; i < seen; i++) {
    const el = candidates[i];

    // ── Gate 1: Visibility ──
    const rect = el.getBoundingClientRect();
    if (rect.width < minWidth || rect.height < minHeight) continue;
    if (rect.right < 0 || rect.bottom < 0 || rect.left > viewW || rect.top > viewH) continue;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    // ── Gate 2: Text ──
    // Use innerText for visible text, fall back to aria-label/title/value
    let rawText = (el.innerText || '').trim();
    if (!rawText) rawText = el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '';
    rawText = rawText.trim();
    if (!rawText || rawText.length > 200) continue;

    const text = rawText.toLowerCase();

    // ── Gate 3: Exclusion check ──
    let excluded = false;
    for (const ex of allExclude) {
      if (text.includes(ex)) { excluded = true; break; }
    }
    if (excluded) continue;

    // Also exclude elements inside nav/header if we're looking for CTAs
    if (positionBias === 'center') {
      const inNav = el.closest('nav, header:not([class*="modal"]):not([class*="dialog"])');
      if (inNav && !el.closest('[class*="modal"], [class*="popup"], [class*="dialog"], [role="dialog"]')) {
        // Element is in nav/header but NOT in a modal — light penalty applied below
      }
    }

    // ─── SCORING ───

    let score = 0;

    // 1. Text match (0-50)
    let bestTextScore = 0;
    for (const pattern of allPatterns) {
      let s = 0;
      if (text === pattern) {
        s = 50;
      } else if (text.startsWith(pattern)) {
        // "Claim Now" matches "claim" — slight penalty for extra text
        s = 45 - Math.min(10, (text.length - pattern.length) * 0.5);
      } else if (pattern.length > 2 && text.includes(pattern)) {
        // "Daily Claim Bonus" contains "claim"
        // Short patterns (1-2 chars like "x") only match exactly — too many false positives otherwise
        const ratio = pattern.length / text.length;
        s = 25 + (ratio * 10);
      }
      if (s > bestTextScore) bestTextScore = s;
    }
    if (compiledRegex && compiledRegex.test(text)) {
      bestTextScore = Math.max(bestTextScore, 40);
    }
    if (bestTextScore === 0) continue; // No text match at all — skip
    score += bestTextScore;

    // 2. Tag type (0-15)
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'input') score += 15;
    else if (tag === 'a') score += 11;
    else if (tag === 'div') score += 8;
    else if (tag === 'span') score += 6;

    // 3. Size score (0-10) — button-sized is ideal
    const w = rect.width;
    const h = rect.height;
    if (w >= 80 && w <= 300 && h >= 30 && h <= 60) {
      score += 10; // ideal button size
    } else if (w >= 40 && w <= 500 && h >= 20 && h <= 100) {
      score += 6; // acceptable
    } else if (w > 500 || h > 100) {
      score += 2; // probably a container, not a button
    } else {
      score += 4; // small but visible
    }

    // 4. Position score (0-10)
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    if (positionBias === 'center') {
      // Prefer vertically centered elements (modal CTAs)
      const vy = cy / viewH;
      if (vy >= 0.3 && vy <= 0.7) score += 10;
      else if (vy >= 0.2 && vy <= 0.8) score += 6;
      else score += 3;
    } else if (positionBias === 'top') {
      const vy = cy / viewH;
      if (vy <= 0.3) score += 10;
      else if (vy <= 0.5) score += 6;
      else score += 2;
    } else {
      score += 5; // no bias — flat score
    }

    // 5. Interactivity signals (0-10)
    if (style.cursor === 'pointer') score += 4;
    if (el.getAttribute('role') === 'button') score += 3;
    if (tag === 'button' || tag === 'a') score += 3;
    else if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) score += 2;

    // 6. Modal/overlay bonus (0-5)
    const pos = style.position;
    if (pos === 'fixed' || pos === 'absolute') {
      const z = parseInt(style.zIndex) || 0;
      if (z > 100) score += 5;
      else if (z > 10) score += 3;
    }
    // Also check if inside a modal container
    const modalParent = el.closest('[class*="modal"], [class*="popup"], [class*="dialog"], [role="dialog"]');
    if (modalParent) score += 4;

    // 7. Disabled penalty (-20 or inverted)
    const isDisabled = el.disabled ||
      el.classList.contains('disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      style.pointerEvents === 'none';

    if (isDisabled) {
      if (invertDisabled) {
        score += 15; // For cooldown detection, disabled = what we want
      } else {
        score -= 20;
      }
    }

    // 8. Nav/header penalty for CTA intents
    const inNav = el.closest('nav, header');
    if (inNav && positionBias === 'center' && !modalParent) {
      score -= 10;
    }

    results.push({
      x: Math.round(cx),
      y: Math.round(cy),
      width: Math.round(w),
      height: Math.round(h),
      text: rawText.substring(0, 60),
      score: Math.round(score),
      tag,
      disabled: !!isDisabled
    });
  }

  // Sort by score descending, apply minimum threshold
  return results
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); // Return top 10 for logging, caller uses [0]
}

// ─── Tier 2: Oracle Escalation Helper ──────────────────────────────────────

async function escalateToOracle(page, tag, cacheKey, siteSlug, siteName, confidenceThreshold, reason) {
  console.log(`[findByIntent:${tag}] Tier 2 oracle — ${reason}`);
  const oracle = await consultOracle(page, cacheKey, siteSlug, siteName || siteSlug);
  if (!oracle) return null; // Oracle failed — caller will return null (normal failure)

  if (oracle.notFound) {
    // Oracle confirmed nothing claimable (cooldown etc) — clean signal
    return { x: 0, y: 0, text: '', score: 0, tag: 'oracle-not-found', disabled: true, notFound: true };
  }

  // Oracle found something — validate selector before caching
  if (oracle.selector) {
    let validSelector = null;
    try {
      await page.$(oracle.selector); // throws SyntaxError on invalid CSS
      validSelector = oracle.selector;
    } catch (_) {
      console.log(`[findByIntent:${tag}] Tier 2 — selector is invalid CSS, skipping cache: "${oracle.selector}"`);
    }
    if (validSelector) {
      writeSidecar(siteSlug, cacheKey, { selector: validSelector, description: oracle.description, increment: false });
      console.log(`[findByIntent:${tag}] Tier 2 — cached selector "${validSelector}" for future runs`);
    }
  }
  return { x: oracle.x, y: oracle.y, text: oracle.description, score: 99, tag: 'oracle', disabled: false };
}

// ─── Main Finder ───────────────────────────────────────────────────────────

/**
 * Find an element by intent — describes WHAT you want, not WHERE.
 *
 * @param {import('playwright').Page} page
 * @param {string|object} intent - Built-in intent name or custom config
 * @param {object} [options]
 * @param {number} [options.timeout=8000] - Promise.race timeout for evaluate
 * @param {number} [options.minScore=30] - Minimum score threshold
 * @param {string[]} [options.extraPatterns] - Additional text patterns to match
 * @param {string[]} [options.extraExclude] - Additional text patterns to exclude
 * @param {string} [options.customRegex] - Regex string for custom matching
 * @param {number} [options.maxElements=500] - Max DOM elements to scan
 * @param {boolean} [options.all=false] - Return all matches (not just best)
 * @param {string} [options.label] - Logging label (defaults to intent name)
 * @returns {Promise<{x:number, y:number, text:string, score:number, tag:string, disabled:boolean}|null>}
 */
async function findByIntent(page, intent, options = {}) {
  const {
    timeout = 8000,
    minScore = 30,
    extraPatterns = [],
    extraExclude = [],
    customRegex = null,
    maxElements = 500,
    all = false,
    label = null,
    siteSlug = null,           // enables Tier 0 + Tier 2
    siteName = null,           // used for oracle prompt (Tier 2)
    confidenceThreshold = (config.llmOracleConfidenceThreshold || 60),  // score below this → escalate to oracle
  } = options;

  // Resolve intent config
  let intentConfig;
  if (typeof intent === 'string') {
    intentConfig = INTENTS[intent];
    if (!intentConfig) {
      throw new Error(`findByIntent: unknown intent '${intent}'. Available: ${Object.keys(INTENTS).join(', ')}`);
    }
  } else {
    // Custom intent object
    intentConfig = intent;
  }

  const tag = label || (typeof intent === 'string' ? intent : 'custom');
  // Cache key always uses the raw intent name — labels are for logging only.
  // Without this, `label: 'site/homepage-login'` and a plain 'login' call
  // would fragment into separate sidecar entries for the same button.
  const cacheKey = typeof intent === 'string' ? intent : (label || 'custom');

  // ── Tier 0: Sidecar cache ──────────────────────────────────────────────
  // If we have a previously-learned CSS selector for this site+intent, try
  // it first. Hit = skip the heuristic entirely. Miss = evict and fall through.
  if (siteSlug && !all) {
    const cachedSelector = getCachedSelector(siteSlug, cacheKey);
    if (cachedSelector) {
      try {
        const el = await page.$(cachedSelector);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            const x = Math.round(box.x + box.width / 2);
            const y = Math.round(box.y + box.height / 2);
            // Validate element center is within viewport — off-screen clicks miss silently
            const viewport = page.viewportSize();
            if (viewport && (x < 0 || y < 0 || x > viewport.width || y > viewport.height)) {
              console.log(`[findByIntent:${tag}] Tier 0 miss — "${cachedSelector}" off-viewport @ ${x},${y} — evicting`);
              evictSidecar(siteSlug, cacheKey);
            } else {
              console.log(`[findByIntent:${tag}] Tier 0 hit — cached "${cachedSelector}" @ ${x},${y}`);
              incrementSuccess(siteSlug, cacheKey);
              return { x, y, text: cachedSelector, score: 100, tag: 'cached', disabled: false };
            }
          }
        }
        // Element not found in DOM — selector is stale
        console.log(`[findByIntent:${tag}] Tier 0 miss — evicting stale "${cachedSelector}"`);
        evictSidecar(siteSlug, cacheKey);
      } catch (err) {
        console.log(`[findByIntent:${tag}] Tier 0 error: ${err.message} — evicting`);
        evictSidecar(siteSlug, cacheKey);
      }
    }
  }

  try {
    // Promise.race to prevent hanging on heavy pages
    // Merge intentConfig + options into a single object for page.evaluate()
    const results = await Promise.race([
      page.evaluate(scoreElementsInBrowser, {
        ...intentConfig,
        maxElements,
        minScore,
        extraPatterns,
        extraExclude,
        customRegex
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('findByIntent: evaluate timeout')), timeout)
      )
    ]);

    if (!results || results.length === 0) {
      console.log(`[findByIntent:${tag}] No matches (minScore=${minScore})`);

      // ── Tier 2: LLM oracle — no heuristic matches at all ──────────────
      if (siteSlug && !all) {
        const oracleResult = await escalateToOracle(page, tag, cacheKey, siteSlug, siteName, confidenceThreshold, 'no heuristic matches');
        if (oracleResult) return oracleResult;
      }

      return all ? [] : null;
    }

    // Log top results for debugging
    const top3 = results.slice(0, 3).map(r =>
      `"${r.text}" (score=${r.score}, ${r.tag}, ${r.width}x${r.height}${r.disabled ? ', disabled' : ''})`
    ).join(', ');
    console.log(`[findByIntent:${tag}] ${results.length} match(es) — top: ${top3}`);

    if (all) return results;

    const best = results[0];

    // ── Tier 2: LLM oracle — low confidence heuristic match ──────────────
    if (best.score < confidenceThreshold && siteSlug) {
      const oracleResult = await escalateToOracle(page, tag, cacheKey, siteSlug, siteName, confidenceThreshold, `low confidence score ${best.score} < ${confidenceThreshold}`);
      if (oracleResult) return oracleResult;
      // Oracle failed — fall through to use the weak heuristic match rather than fail completely
    }

    return best;
  } catch (err) {
    console.log(`[findByIntent:${tag}] Error: ${err.message}`);
    return all ? [] : null;
  }
}

/**
 * Find + click in one call. Returns the match result or null.
 *
 * @param {import('playwright').Page} page
 * @param {string|object} intent
 * @param {object} [options] - Same as findByIntent, plus:
 * @param {number} [options.postClickDelay=500] - Delay after clicking (ms)
 * @returns {Promise<{x:number, y:number, text:string, score:number}|null>}
 */
async function clickByIntent(page, intent, options = {}) {
  const { postClickDelay = 500, ...findOpts } = options;

  const result = await findByIntent(page, intent, findOpts);
  if (!result) return null;
  if (result.notFound) {
    const tag = findOpts.label || (typeof intent === 'string' ? intent : 'custom');
    console.log(`[clickByIntent:${tag}] Oracle reported not_found — skipping click`);
    return null;
  }

  const tag = findOpts.label || (typeof intent === 'string' ? intent : 'custom');
  console.log(`[clickByIntent:${tag}] Clicking "${result.text}" @ ${result.x},${result.y}`);
  await page.mouse.click(result.x, result.y);

  if (postClickDelay > 0) {
    await new Promise(r => setTimeout(r, postClickDelay));
  }

  // Health check: verify page survived the click (dismiss clicks on promo banners can trigger navigation/crash)
  try {
    await page.evaluate(() => document.readyState);
  } catch (healthErr) {
    if (healthErr.message && (healthErr.message.includes('closed') || healthErr.message.includes('crashed') || healthErr.message.includes('destroyed') || healthErr.message.includes('Target'))) {
      console.log(`[clickByIntent:${tag}] WARNING: Page destroyed after clicking "${result.text}" — returning crash signal`);
      return { ...result, pageCrashed: true };
    }
    // Non-crash error (e.g. timeout) — don't swallow it
    throw healthErr;
  }

  return result;
}

module.exports = {
  INTENTS,
  findByIntent,
  clickByIntent,
  scoreElementsInBrowser // Exported for testing/debugging
};
