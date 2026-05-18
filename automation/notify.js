/**
 * Notification Module
 * Sends alerts via Discord webhook
 */

'use strict';

const https = require('https');
const http = require('http');
const config = require('./config');

/**
 * Send a Discord notification
 * @param {object} options
 * @param {string} options.title - Embed title
 * @param {string} options.message - Main message
 * @param {string} options.color - Hex color (without #) - red: 'ff0000', green: '00ff00', yellow: 'ffff00'
 * @param {Array} options.fields - Additional fields [{name, value}]
 */
async function sendDiscord({ title, message, color = 'ff0000', fields = [], webhookUrl }) {
  const webhook = webhookUrl || config.discordWebhook;
  if (!webhook) {
    console.log('[notify] Discord webhook not configured, skipping notification');
    return false;
  }

  const embed = {
    title: title || 'Sweepsites Alert',
    description: message,
    color: parseInt(color, 16),
    timestamp: new Date().toISOString(),
    footer: { text: 'Sweepsites Automation' },
    fields: fields.map(f => ({ name: f.name, value: String(f.value), inline: f.inline ?? true }))
  };

  const payload = JSON.stringify({
    username: 'Sweepsites Bot',
    embeds: [embed]
  });

  return new Promise((resolve) => {
    try {
      const url = new URL(webhook);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(options, (res) => {
        if (res.statusCode === 204 || res.statusCode === 200) {
          console.log('[notify] Discord notification sent');
          resolve(true);
        } else {
          console.log(`[notify] Discord returned status ${res.statusCode}`);
          resolve(false);
        }
      });

      req.on('error', (err) => {
        console.log('[notify] Discord error:', err.message);
        resolve(false);
      });

      req.write(payload);
      req.end();
    } catch (err) {
      console.log('[notify] Discord error:', err.message);
      resolve(false);
    }
  });
}

/**
 * Send failure notification
 */
async function notifyFailure(site, error, screenshot = null) {
  const errorText = String(error?.message ?? error ?? 'Unknown error').substring(0, 200);
  const fields = [
    { name: 'Site', value: site },
    { name: 'Error', value: errorText }
  ];

  if (screenshot) {
    fields.push({ name: 'Screenshot', value: screenshot, inline: false });
  }

  return sendDiscord({
    title: '❌ Collection Failed',
    message: `Failed to collect from **${site}**. Manual intervention may be required.`,
    color: 'ff0000',
    fields
  });
}

/**
 * Send success notification (optional, for important collections)
 */
async function notifySuccess(site, sc, gc) {
  return sendDiscord({
    title: '✅ Collection Successful',
    message: `Collected from **${site}**`,
    color: '00ff00',
    fields: [
      { name: 'SC', value: `+${sc}` },
      { name: 'GC', value: `+${gc}` }
    ]
  });
}

/**
 * Send summary notification
 */
async function notifySummary(results, opts = {}) {
  const { retriedCount = 0, staleSites = [] } = opts;
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success && !r.onCooldown);
  const cooldown = results.filter(r => r.onCooldown);

  const totalSC = successful.reduce((sum, r) => sum + (r.sc || 0), 0);
  const totalGC = successful.reduce((sum, r) => sum + (r.gc || 0), 0);

  let color = '00ff00'; // green
  if (failed.length > 0) color = 'ff0000'; // red
  else if (staleSites.length > 0) color = 'ffaa00'; // amber for staleness warnings
  else if (cooldown.length > 0 && successful.length === 0) color = 'ffff00'; // yellow

  const fields = [
    { name: 'Collected', value: successful.length },
    { name: 'On Cooldown', value: cooldown.length },
    { name: 'Failed', value: failed.length },
    { name: 'Total SC', value: `+${totalSC}` },
    { name: 'Total GC', value: `+${totalGC}` }
  ];

  if (retriedCount > 0) {
    fields.push({ name: 'Retried', value: retriedCount });
  }

  if (failed.length > 0) {
    fields.push({
      name: 'Failed Sites',
      value: failed.map(r => `${r.site}: ${r.error?.substring(0, 50)}`).join('\n'),
      inline: false
    });
  }

  if (staleSites.length > 0) {
    fields.push({
      name: '\u26a0 Stale Sites (7+ days without collection)',
      value: staleSites.map(s => `${s.name}: ${s.daysSince}d`).join('\n'),
      inline: false
    });
  }

  return sendDiscord({
    title: '\ud83d\udcca Collection Summary',
    message: `Finished collecting from ${results.length} sites`,
    color,
    fields
  });
}

/**
 * Send fix agent summary notification
 * @param {object} results - { fixed: string[], escalated: string[], skipped: string[] }
 */
async function sendFixSummary(results) {
  const fixedCount = results.fixed.length;
  const escalatedCount = results.escalated.length;
  const skippedCount = results.skipped.length;

  let color = '00ff00'; // green — all fixed
  if (escalatedCount > 0 && fixedCount > 0) color = 'ffff00'; // yellow — mixed
  if (escalatedCount > 0 && fixedCount === 0) color = 'ff0000'; // red — all escalated

  const fields = [
    { name: 'Fixed', value: String(fixedCount) },
    { name: 'Escalated', value: String(escalatedCount) },
    { name: 'Skipped', value: String(skippedCount) },
  ];

  if (fixedCount > 0) {
    fields.push({
      name: 'Fixes Applied',
      value: results.fixed.map(f => `+ ${f}`).join('\n').substring(0, 1000),
      inline: false,
    });
  }

  if (escalatedCount > 0) {
    fields.push({
      name: 'Needs Human',
      value: results.escalated.map(e => `! ${e}`).join('\n').substring(0, 1000),
      inline: false,
    });
  }

  return sendDiscord({
    title: 'Lucky Fix Agent Report',
    message: fixedCount > 0
      ? `Fixed ${fixedCount} collector${fixedCount > 1 ? 's' : ''}. Catch-up runner will verify shortly.`
      : `Could not auto-fix ${escalatedCount} failure${escalatedCount > 1 ? 's' : ''}. Manual intervention needed.`,
    color,
    fields,
  });
}

/**
 * Send free spins notification — collector awarded free spins that need manual play
 * @param {string} site - Site name
 * @param {object} spins - { count, game, message }
 */
async function notifyFreeSpins(site, spins) {
  const fields = [
    { name: 'Site', value: site },
    { name: 'Free Spins', value: String(spins.count || '?') },
  ];
  if (spins.game) fields.push({ name: 'Game', value: spins.game });

  return sendDiscord({
    title: '\ud83c\udfb0 Free Spins Awarded',
    message: spins.message || `**${site}** awarded ${spins.count || 'some'} free spins. Log in and play them manually.`,
    color: 'ff9900',
    fields
  });
}

module.exports = {
  sendDiscord,
  notifyFailure,
  notifySuccess,
  notifySummary,
  sendFixSummary,
  notifyFreeSpins,
};
