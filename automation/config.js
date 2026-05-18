/**
 * Automation Configuration
 * Update these settings for your environment
 */

process.env.TZ = process.env.TZ || 'America/Los_Angeles';

// Secrets live in automation/secrets.js (gitignored). Falls back to env vars.
// See automation/secrets.example.js for template.
let secrets;
try {
  secrets = require('./secrets');
} catch (e) {
  secrets = {
    discordWebhook: process.env.DISCORD_WEBHOOK || '',
    discordScWebhook: process.env.DISCORD_SC_WEBHOOK || '',
    discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
    discordDealsWebhook: process.env.DISCORD_DEALS_WEBHOOK || '',
    discordFreebiesWebhook: process.env.DISCORD_FREEBIES_WEBHOOK || '',
  };
}

function getChromeEndpoint() {
  if (process.env.CHROME_ENDPOINT) {
    console.log(`[config] Using CHROME_ENDPOINT from env: ${process.env.CHROME_ENDPOINT}`);
    return process.env.CHROME_ENDPOINT;
  }
  return 'http://localhost:9222';
}

module.exports = {
  discordWebhook: secrets.discordWebhook,
  discordScWebhook: secrets.discordScWebhook,
  discordBotToken: secrets.discordBotToken,
  discordScChannelId: process.env.DISCORD_SC_CHANNEL_ID || '',

  chromeEndpoint: getChromeEndpoint(),
  databasePath: './data/sweepsites.sqlite',

  pageLoadTimeout: 60000,
  elementTimeout: 10000,
  delayBetweenSites: 1500,
  screenshotOnFailure: true,
  keepTabOpenOnFailure: true,

  llmOracleEnabled: false,
  llmOracleModel: 'claude-haiku-4-5-20251001',
  llmOracleConfidenceThreshold: 60,

  fixAgent: {
    enabled: false,
    model: 'claude-opus-4-6',
    maxTurnsPerFix: 15,
    timeoutMs: 300000,
    maxDailySpawns: 20,
    maxAttemptsPerSite: 2,
    claudeCli: process.env.CLAUDE_CLI || 'claude',
  },

  discordDealsWebhook: secrets.discordDealsWebhook,

  deals: {
    rtp: 0.94,
    taxRate: 0.33,
    minProfit: 2.00,
  },
};
