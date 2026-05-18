/**
 * Template for automation/secrets.js (which is gitignored).
 *
 * Copy this file to `secrets.js` and fill in the blanks, OR export the
 * matching env vars (DISCORD_WEBHOOK, DISCORD_SC_WEBHOOK, etc.) before
 * running any collector.
 */

'use strict';

module.exports = {
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  discordScWebhook: process.env.DISCORD_SC_WEBHOOK || '',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordDealsWebhook: process.env.DISCORD_DEALS_WEBHOOK || '',
  discordFreebiesWebhook: process.env.DISCORD_FREEBIES_WEBHOOK || '',
};
