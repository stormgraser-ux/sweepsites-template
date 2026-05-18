'use strict';

const fs = require('fs');
const path = require('path');

const LEARNED_DIR = path.join(__dirname, '../../data/learned');

function sidecarPath(slug) {
  return path.join(LEARNED_DIR, `${slug}.json`);
}

function readSidecar(slug) {
  try {
    const raw = fs.readFileSync(sidecarPath(slug), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSidecar(slug, intent, entry) {
  let data = readSidecar(slug) || { version: 1, site: slug, learned: {} };
  const now = new Date().toISOString();
  const existing = data.learned[intent] || {};

  data.learned[intent] = {
    selector: entry.selector,
    description: entry.description,
    learnedAt: existing.learnedAt || now,
    successCount: (existing.successCount || 0) + (entry.increment ? 1 : 0),
    lastSuccess: now
  };

  fs.mkdirSync(LEARNED_DIR, { recursive: true });
  const target = sidecarPath(slug);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

function incrementSuccess(slug, intent) {
  const data = readSidecar(slug);
  if (!data?.learned?.[intent]) return;
  writeSidecar(slug, intent, { ...data.learned[intent], increment: true });
}

function evictSidecar(slug, intent) {
  const data = readSidecar(slug);
  if (!data?.learned?.[intent]) return;
  delete data.learned[intent];
  const target = sidecarPath(slug);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
  console.log(`[sidecar:${slug}] Evicted stale entry for intent "${intent}"`);
}

function getCachedSelector(slug, intent) {
  const data = readSidecar(slug);
  return data?.learned?.[intent]?.selector || null;
}

module.exports = { readSidecar, writeSidecar, incrementSuccess, evictSidecar, getCachedSelector };
