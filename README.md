# Sweepsites

Dashboard + automation framework for tracking daily reward collections across sweepstakes casino sites.

**What it does:**
- Web dashboard to track which sites you've collected from today, your SC/GC balances, bankroll, and P&L
- Collector framework that automates daily bonus claims using Playwright + Chrome CDP
- Balance tracking with delta verification (detects if a claim actually worked)
- Intent-based element finding (describes WHAT to click, not WHERE — survives site redesigns)
- Google OAuth auto-login for sites that use it
- Discord notifications on failures
- Tax estimation and CSV export tools

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/sweepsites.git
cd sweepsites
bash setup.sh
npm start
```

Open http://localhost:3050 — you'll see the dashboard with sample data.

## Architecture

```
sweepsites/
├── app/                    # Frontend dashboard (HTML, JS, CSS)
│   ├── index.html          # Main tracker view
│   ├── autorun.html        # Batch run monitor
│   ├── taxes.html          # Tax estimator
│   └── reports.html        # Historical reports
├── server/                 # Express API + SQLite
│   ├── server.js           # API server (port 3050)
│   ├── seed.js             # Sample data seeder
│   └── db/                 # Database layer (migrations, repositories)
├── automation/             # Collector framework
│   ├── config.js           # Configuration (Chrome endpoint, timeouts, etc.)
│   ├── notify.js           # Discord webhook notifications
│   ├── collect-all.js      # Batch runner — runs all collectors sequentially
│   ├── secrets.example.js  # Template for secrets (Discord tokens, etc.)
│   ├── utils/
│   │   ├── base-collector.js   # Core framework — createCollector()
│   │   ├── browser.js          # Playwright CDP connection management
│   │   ├── humanize.js         # Human-like delays, mouse curves
│   │   ├── find-by-intent.js   # Intent-based element scoring
│   │   ├── google-oauth.js     # Google account selection + OAuth flows
│   │   ├── credentials.js      # GPG pass store integration
│   │   ├── llm-oracle.js       # Claude CLI fallback for element finding
│   │   ├── sidecar-cache.js    # Learned selector cache
│   │   └── focus-guard.js      # Prevents Chrome from stealing focus
│   └── collectors/
│       ├── _example-oauth.js   # Template: Google OAuth site
│       └── _example-email.js   # Template: Email/password site
├── tests/                  # Test suite
├── setup.sh                # One-command setup
└── package.json
```

## Writing a Collector

Collectors are ~50-150 lines of site-specific logic. The framework (`createCollector()`) handles everything else: Chrome connection, login, popup dismissal, cooldown detection, balance verification, tracker updates, error recovery, and retry.

Copy one of the example templates and fill in the callbacks:

```js
const { createCollector } = require('../utils/base-collector');

module.exports = createCollector({
  siteId: 'my-casino',
  siteName: 'My Casino',
  siteUrl: 'https://www.my-casino.com',
  rewardSC: 0.30,       // Expected SC reward
  rewardGC: 10000,       // Expected GC reward
  oauth: 'google',       // or omit for manual/email login

  isLoggedIn: async (page) => { /* return true/false */ },
  navigateToReward: async (page, helpers) => { /* get to the bonus page */ },
  checkCooldown: async (page) => { /* return { onCooldown, message } */ },
  collect: async (page, helpers) => { /* click the claim button */ },

  // Optional:
  scrapeBalance: async (page) => { /* return SC balance number or null */ },
  performLogin: async (page, context, helpers) => { /* custom login flow */ },
  dismissPopups: async (page, helpers) => { /* custom popup handling */ },
});

if (require.main === module) module.exports.runCLI();
```

See `_example-oauth.js` and `_example-email.js` for fully commented templates.

### Running a Collector

```bash
# Test without claiming (stops before the click)
node automation/collectors/my-casino.js --dry-run

# Live run
node automation/collectors/my-casino.js

# Run all collectors
npm run collect

# Dry-run all collectors
npm run collect:dry
```

## Chrome Setup

Collectors connect to an existing Chrome instance via CDP (Chrome DevTools Protocol). Start Chrome with remote debugging:

```bash
# Linux
google-chrome --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Log into your Google account and the casino sites manually in this Chrome instance. The collectors share the same cookies/sessions — once you're logged in, they stay logged in.

Set `CHROME_ENDPOINT` env var if Chrome is on a different host/port:
```bash
export CHROME_ENDPOINT=http://192.168.1.100:9222
```

## Credentials

For email/password sites, credentials are stored in a GPG-encrypted [pass](https://www.passwordstore.org/) store:

```bash
# Initialize pass (one-time)
pass init your-gpg-key-id

# Store a site password
pass insert sweepsites/sites/my-casino

# Set your default email
export SWEEPSITES_EMAIL=your-email@gmail.com

# For Google OAuth sites
export GOOGLE_OAUTH_EMAIL=your-email@gmail.com
```

## Discord Notifications

Copy the secrets template and fill in your webhook URLs:

```bash
cp automation/secrets.example.js automation/secrets.js
# Edit automation/secrets.js with your Discord webhook URLs
```

Or use environment variables:
```bash
export DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
```

## Dashboard Features

- **Tracker**: Daily collection progress, SC/GC totals, per-site status
- **Autorun**: Monitor batch collection runs in real-time
- **Tax Estimator**: Track purchases, redemptions, and estimated tax liability
- **Reports**: Historical collection data, CSV export

## Configuration

Edit `automation/config.js` for:
- Chrome endpoint URL
- Timeouts (page load, element wait)
- Delay between sites in batch runs
- LLM Oracle (requires Claude CLI) — AI fallback for finding UI elements
- Discord notification settings

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Dashboard server port | `3050` |
| `CHROME_ENDPOINT` | Chrome CDP endpoint | `http://localhost:9222` |
| `SWEEPSITES_EMAIL` | Default login email | — |
| `GOOGLE_OAUTH_EMAIL` | Google OAuth email | `SWEEPSITES_EMAIL` |
| `DISCORD_WEBHOOK` | Discord notification webhook | — |
| `DISCORD_SC_WEBHOOK` | SC-specific webhook | — |
| `TZ` | Timezone for "today" logic | `America/Los_Angeles` |

## License

MIT
