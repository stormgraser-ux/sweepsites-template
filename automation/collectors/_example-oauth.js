#!/usr/bin/env node
/**
 * Example Collector — Google OAuth Site
 *
 * Template for a site that uses Google OAuth for login.
 * Copy this file, rename it to your site's slug (e.g. chumba.js),
 * and fill in the site-specific logic.
 *
 * The createCollector() framework handles:
 * - Chrome connection via CDP
 * - Login detection + auto-login via Google OAuth
 * - Popup/overlay dismissal
 * - Cooldown detection
 * - Balance tracking (before/after collection)
 * - Tracker API updates
 * - Discord notifications on failure
 * - Cookie-nuke retry on first failure
 * - Screenshot capture
 *
 * You only write the site-specific parts:
 * - isLoggedIn: how to detect if you're logged in
 * - navigateToReward: how to get to the daily bonus page
 * - checkCooldown: how to detect if already claimed today
 * - collect: how to click the claim button
 * - scrapeBalance (optional): how to read your SC balance
 */

'use strict';

const { createCollector } = require('../utils/base-collector');

const SITE_URL = 'https://www.example-casino.com';

module.exports = createCollector({
  siteId: 'example-casino',
  siteName: 'Example Casino',
  siteUrl: SITE_URL,
  rewardSC: 0.30,
  rewardGC: 10000,
  stealth: true,

  // 'google' enables auto-login via Google OAuth.
  // The framework clicks the Google button, handles account selection,
  // and deals with popup vs redirect flows automatically.
  oauth: 'google',

  // Return true if the page shows a logged-in state.
  // Check for avatar, balance display, logout button, etc.
  isLoggedIn: async (page) => {
    return page.evaluate(() => {
      const hasBalance = !!document.querySelector('[class*="balance"], [class*="wallet"]');
      const hasAvatar = !!document.querySelector('[class*="avatar"], [class*="profile"]');
      const hasLoginButton = !!document.querySelector('button:has-text("Login"), button:has-text("Sign Up")');
      if (hasLoginButton) return false;
      return hasBalance || hasAvatar;
    }).catch(() => false);
  },

  // (Optional) Read the SC balance from the page.
  // Enables balance-delta verification after collection.
  scrapeBalance: async (page) => {
    return page.evaluate(() => {
      const text = document.body?.innerText || '';
      const match = text.match(/SC\s*:?\s*(\d+(?:,\d{3})*(?:\.\d{2})?)/i);
      if (match) {
        const value = parseFloat(match[1].replace(/,/g, ''));
        if (value >= 0 && value < 100000) return value;
      }
      return null;
    }).catch(() => null);
  },

  // Navigate to the page where the daily reward can be claimed.
  navigateToReward: async (page, helpers) => {
    helpers.log('Navigating to daily bonus...');
    // Option 1: Direct URL
    await page.goto(`${SITE_URL}/rewards`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await helpers.delay(3000);

    // Option 2: Click a menu item (use findByIntent or direct selector)
    // await helpers.clickByIntent('claim');
  },

  // Check if the daily reward has already been claimed.
  // Return { onCooldown: true, message: '...' } if on cooldown.
  checkCooldown: async (page) => {
    return page.evaluate(() => {
      const text = document.body?.innerText || '';
      if (/already claimed|come back tomorrow|hours? remaining/i.test(text)) {
        return { onCooldown: true, message: 'Already claimed today' };
      }
      // Check if claim button exists and is enabled
      const claimBtn = [...document.querySelectorAll('button')].find(b =>
        b.offsetHeight > 0 && /claim|collect/i.test(b.textContent.trim())
      );
      if (!claimBtn) {
        return { onCooldown: true, message: 'No claim button found' };
      }
      if (claimBtn.disabled) {
        return { onCooldown: true, message: 'Claim button is disabled' };
      }
      return { onCooldown: false };
    });
  },

  // Perform the actual collection click.
  collect: async (page, helpers) => {
    // Find and click the claim button using coordinates (most reliable)
    const coords = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b =>
        b.offsetHeight > 0 && /claim|collect/i.test(b.textContent.trim())
      );
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    if (!coords) throw new Error('Claim button not found');

    helpers.log(`Clicking Claim at (${Math.round(coords.x)}, ${Math.round(coords.y)})...`);
    await page.mouse.click(coords.x, coords.y);
    await helpers.delay(4000);

    // Verify success
    const success = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return /congratulations|successfully|claimed|collected/i.test(text);
    });

    if (!success) {
      helpers.log('Warning: success text not detected, checking button state...');
      const stillHasClaim = await page.evaluate(() => {
        return [...document.querySelectorAll('button')].some(b =>
          b.offsetHeight > 0 && /claim|collect/i.test(b.textContent.trim())
        );
      });
      if (stillHasClaim) throw new Error('Claim button still present — claim may have failed');
    }

    helpers.log('Daily bonus collected!');
  },
});

if (require.main === module) module.exports.runCLI();
