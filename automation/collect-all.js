#!/usr/bin/env node
/**
 * Collect All Sites
 * Discovers and runs all collectors in the collectors/ directory sequentially.
 *
 * Usage:
 *   node automation/collect-all.js              # Run all collectors
 *   node automation/collect-all.js --dry-run    # Dry run (stop before claiming)
 *   node automation/collect-all.js --only site1 site2  # Run specific sites only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { disconnectAll } = require('./utils/browser');

const COLLECTORS_DIR = path.join(__dirname, 'collectors');

function discoverCollectors() {
  const files = fs.readdirSync(COLLECTORS_DIR)
    .filter(f => f.endsWith('.js') && !f.startsWith('_'));

  return files.map(f => {
    const mod = require(path.join(COLLECTORS_DIR, f));
    return {
      file: f,
      siteId: mod.SITE_ID,
      siteName: mod.SITE_NAME,
      collect: mod.collect,
    };
  }).filter(c => c.collect && c.siteId);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyIdx = args.indexOf('--only');
  const onlyFilter = onlyIdx >= 0 ? args.slice(onlyIdx + 1) : null;

  let collectors = discoverCollectors();

  if (onlyFilter && onlyFilter.length > 0) {
    collectors = collectors.filter(c => onlyFilter.includes(c.siteId));
  }

  console.log('='.repeat(60));
  console.log(`Sweepsites Batch Runner`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Sites: ${collectors.length}`);
  console.log('='.repeat(60));
  console.log('');

  const results = [];

  for (const collector of collectors) {
    console.log(`\n--- ${collector.siteName} (${collector.siteId}) ---`);
    const start = Date.now();

    try {
      const result = await collector.collect({ dryRun });
      result.elapsed = Date.now() - start;
      results.push(result);

      if (result.success) {
        console.log(`  Result: SUCCESS (+${result.sc || 0} SC, +${result.gc || 0} GC) [${Math.round(result.elapsed / 1000)}s]`);
      } else if (result.onCooldown) {
        console.log(`  Result: ON COOLDOWN [${Math.round(result.elapsed / 1000)}s]`);
      } else {
        console.log(`  Result: FAILED — ${result.error} [${Math.round(result.elapsed / 1000)}s]`);
      }
    } catch (err) {
      console.error(`  Result: CRASHED — ${err.message}`);
      results.push({ site: collector.siteId, siteName: collector.siteName, success: false, error: err.message });
    }

    // Disconnect CDP between collectors to avoid connection exhaustion
    await disconnectAll();
  }

  // Summary
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success && !r.onCooldown);
  const cooldown = results.filter(r => r.onCooldown);
  const totalSC = successful.reduce((sum, r) => sum + (r.sc || 0), 0);
  const totalGC = successful.reduce((sum, r) => sum + (r.gc || 0), 0);

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Collected:   ${successful.length}`);
  console.log(`  On Cooldown: ${cooldown.length}`);
  console.log(`  Failed:      ${failed.length}`);
  console.log(`  Total SC:    +${totalSC.toFixed(2)}`);
  console.log(`  Total GC:    +${totalGC}`);

  if (failed.length > 0) {
    console.log('\nFailed sites:');
    for (const r of failed) {
      console.log(`  ${r.site}: ${r.error?.substring(0, 80)}`);
    }
  }

  console.log('='.repeat(60));
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Runner crashed:', err);
  process.exit(1);
});
