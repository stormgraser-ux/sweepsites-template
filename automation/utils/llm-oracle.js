'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

function stripEnv(...keys) {
  const env = { ...process.env };
  for (const k of keys) delete env[k];
  return env;
}

const CLAUDE_BIN = (() => {
  if (config.fixAgent && config.fixAgent.claudeCli && config.fixAgent.claudeCli !== 'claude') {
    if (fs.existsSync(config.fixAgent.claudeCli)) return config.fixAgent.claudeCli;
  }
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch (_) {}
  return 'claude';
})();

if (CLAUDE_BIN !== 'claude') {
  console.log(`[llm-oracle] CLI resolved: ${CLAUDE_BIN}`);
} else {
  console.warn('[llm-oracle] WARNING: claude binary not found — oracle calls will fail');
}

const INTENT_DESCRIPTIONS = {
  claim:    'the daily bonus, daily reward, or free coins claim button',
  dismiss:  'a close, dismiss, or skip button for a modal or popup',
  login:    'a login or sign-in button',
  confirm:  'an OK, confirm, or acknowledgment button',
  cooldown: 'a disabled claim button or cooldown timer showing time remaining',
  consent:  'a cookie consent accept button'
};

const OUTPUT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    x:           { type: 'number',  description: 'Center X coordinate in screenshot pixels' },
    y:           { type: 'number',  description: 'Center Y coordinate in screenshot pixels' },
    selector:    { type: 'string',  description: 'CSS selector for the element (best-effort)' },
    description: { type: 'string',  description: 'What you found, in plain English' },
    confidence:  { type: 'string',  enum: ['high', 'medium', 'low'] },
    not_found:   { type: 'boolean', description: 'True if no claimable element exists (cooldown etc)' }
  },
  required: ['x', 'y', 'confidence', 'not_found']
});

async function consultOracle(page, intent, siteSlug, siteName, options = {}) {
  if (!config.llmOracleEnabled) return null;

  const intentDescription = INTENT_DESCRIPTIONS[intent] || `a "${intent}" element`;
  const url = page.url();
  const { extraContext = '' } = options;

  const imgPath = path.join(os.tmpdir(), `oracle-${siteSlug}-${Date.now()}.png`);
  try {
    await page.screenshot({ type: 'png', fullPage: false, path: imgPath });
  } catch (err) {
    console.warn(`[llm-oracle:${siteSlug}] Screenshot failed: ${err.message}`);
    return null;
  }

  const prompt = [
    `Use the Read tool to view the screenshot at: ${imgPath}`,
    `Then identify: ${intentDescription}`,
    `Site: ${siteName}  URL: ${url}`,
    extraContext ? `Context: ${extraContext}` : '',
    'Set not_found=true if no claimable element exists (e.g. only a cooldown timer is visible).',
    'x/y must be the center pixel coordinates of the element within the screenshot.',
    'For selector: provide a valid CSS selector usable with document.querySelector().',
    'Do NOT use jQuery syntax. If you cannot determine a reliable CSS selector, omit it.'
  ].filter(Boolean).join('\n');

  const model = config.llmOracleModel || 'claude-haiku-4-5-20251001';

  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, [
        '-p',
        '--tools', 'Read',
        '--model', model,
        '--output-format', 'json',
        '--json-schema', OUTPUT_SCHEMA,
        '--no-session-persistence',
        '--dangerously-skip-permissions',
        prompt
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: stripEnv('CLAUDECODE')
      });

      const chunks = [];
      const errChunks = [];
      child.stdout.on('data', d => chunks.push(d));
      child.stderr.on('data', d => errChunks.push(d));

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Oracle timeout (45s)'));
      }, 45000);

      child.on('close', (code) => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks).toString();
        const err = Buffer.concat(errChunks).toString();
        if (code !== 0) {
          const e = new Error(`CLI exited with code ${code}`);
          e.stderr = err;
          reject(e);
        } else {
          resolve(out);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (err) {
    console.warn(`[llm-oracle:${siteSlug}] CLI call failed: ${err.message}`);
    if (err.stderr) console.warn(`[llm-oracle:${siteSlug}] stderr: ${String(err.stderr).slice(0, 300)}`);
    return null;
  } finally {
    try { fs.unlinkSync(imgPath); } catch (_) {}
  }

  let result;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope.is_error) {
      console.warn(`[llm-oracle:${siteSlug}] Claude returned error: ${envelope.result}`);
      return null;
    }
    const raw = envelope.structured_output || envelope.result;
    result = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn(`[llm-oracle:${siteSlug}] JSON parse failed: ${err.message} — stdout: ${String(stdout).slice(0, 200)}`);
    return null;
  }

  console.log(
    `[llm-oracle:${siteSlug}] ${result.not_found ? 'NOT_FOUND' : `Found @ ${result.x},${result.y}`}` +
    ` — ${result.description || '(no description)'} (confidence=${result.confidence})`
  );

  if (result.confidence === 'low') {
    console.warn(`[llm-oracle:${siteSlug}] Low confidence — not trusting result`);
    return null;
  }

  return {
    x:           result.x,
    y:           result.y,
    selector:    result.selector || null,
    description: result.description || '',
    confidence:  result.confidence,
    notFound:    !!result.not_found
  };
}

module.exports = { consultOracle };
