'use strict';

const http = require('http');
const { execFileSync, spawn } = require('child_process');
const config = require('../config');

function parseEndpoint() {
  const ep = config.chromeEndpoint.replace(/^http:\/\//, '');
  const [hostname, port] = ep.split(':');
  return { hostname, port: parseInt(port) || 9222 };
}

async function isChromeReachable() {
  const { hostname, port } = parseEndpoint();
  return new Promise(resolve => {
    http.get({ hostname, port, path: '/json/version', timeout: 3000 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

async function ensureChrome() {
  if (await isChromeReachable()) return true;

  console.log('[ensure-chrome] Chrome not reachable, attempting to start...');

  const chromePaths = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];

  let chromeBin = null;
  for (const p of chromePaths) {
    try {
      execFileSync('which', [p], { encoding: 'utf8', timeout: 2000 });
      chromeBin = p;
      break;
    } catch {}
  }

  if (!chromeBin) {
    console.error('[ensure-chrome] No Chrome/Chromium binary found');
    return false;
  }

  const { port } = parseEndpoint();
  const child = spawn(chromeBin, [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll for up to 30s
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isChromeReachable()) {
      console.log('[ensure-chrome] Chrome is now reachable');
      return true;
    }
  }

  console.error('[ensure-chrome] Chrome did not become reachable within 30s');
  return false;
}

module.exports = { isChromeReachable, ensureChrome };
