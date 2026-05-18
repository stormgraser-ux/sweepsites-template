#!/usr/bin/env node
/**
 * Example Collector — Email/Password Login Site
 *
 * Template for a site that uses email/password login (not Google OAuth).
 * Uses the GPG-encrypted `pass` store for credentials.
 *
 * Setup:
 *   pass insert sweepsites/sites/example-site
 *   # Enter the password for your account
 *
 * Set your email in the SWEEPSITES_EMAIL env var or edit credentials.js.
 */

'use strict';

const { createCollector } = require('../utils/base-collector');
const { getCredentials } = require('../utils/credentials');

const SITE_ID = 'example-site';
const SITE_URL = 'https://www.example-site.com';

module.exports = createCollector({
  siteId: SITE_ID,
  siteName: 'Example Site',
  siteUrl: SITE_URL,
  rewardSC: 0.10,
  rewardGC: 5000,
  stealth: true,
  // Don't refresh on connect — preserve existing session
  refresh: false,

  isLoggedIn: async (page) => {
    return page.evaluate(() => {
      const hasBalance = !!document.querySelector('[class*="balance"], [class*="wallet"]');
      const hasLoginForm = !!document.querySelector('input[type="email"], input[type="password"]');
      if (hasLoginForm) return false;
      return hasBalance;
    }).catch(() => false);
  },

  // Custom login function for email/password sites.
  // Called automatically when isLoggedIn returns false.
  performLogin: async (page, context, helpers) => {
    const { email, password } = getCredentials(SITE_ID);
    helpers.log('Performing email/password login...');

    await page.goto(`${SITE_URL}/login`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await helpers.delay(2000);

    // Fill email field — use locator.fill() for React/Vue compatibility
    const emailInput = page.locator('input[type="email"], input[name="email"]');
    await emailInput.fill(email);
    await helpers.delay(500);

    // Fill password field
    const passwordInput = page.locator('input[type="password"]');
    await passwordInput.fill(password);
    await helpers.delay(500);

    // Click submit
    const submitBtn = page.locator('button[type="submit"], button:has-text("Log In")');
    await submitBtn.click();
    await helpers.delay(5000);

    // Verify login succeeded
    const loggedIn = await page.evaluate(() => {
      return !!document.querySelector('[class*="balance"], [class*="wallet"]');
    }).catch(() => false);

    if (!loggedIn) {
      helpers.log('Login appears to have failed');
      return false;
    }

    helpers.log('Login successful');
    return true;
  },

  navigateToReward: async (page, helpers) => {
    helpers.log('Navigating to daily bonus...');
    // Use intent-based navigation — the framework finds the button automatically
    await helpers.clickByIntent('claim', { minScore: 30 });
    await helpers.delay(3000);
  },

  checkCooldown: async (page) => {
    return page.evaluate(() => {
      const text = document.body?.innerText || '';
      if (/already claimed|come back|cooldown|hours? left/i.test(text)) {
        return { onCooldown: true, message: 'Already claimed today' };
      }
      return { onCooldown: false };
    });
  },

  collect: async (page, helpers) => {
    // Use intent-based clicking — the framework scores visible elements
    // and clicks the best match for a "claim" action
    const result = await helpers.clickByIntent('claim', { minScore: 40 });
    if (!result) throw new Error('Could not find claim button');
    helpers.log(`Clicked: "${result.text}"`);
    await helpers.delay(4000);
  },
});

if (require.main === module) module.exports.runCLI();
