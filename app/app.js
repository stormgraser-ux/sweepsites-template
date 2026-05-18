// State
let sites = [];
let collections = [];
let lastCollections = {}; // Map of site_id -> last collection timestamp
let currentSite = null;
let showHidden = false;
let activeFilter = 'all'; // 'all', 'ready', 'cooldown', 'issues'
let activeModalTab = 'overview';
let lastRuns = {}; // { '24hr': { timestamp, ... }, 'fixed-time': { timestamp, ... } }

// Balance threshold for redeemable badge
let balanceThreshold = parseInt(localStorage.getItem('balanceThreshold') ?? '100', 10);

const API_BASE = '';

// Sites that are perpetually stale/shelved — suppress from "Needs attention"
const IGNORED_ATTENTION_IDS = new Set([
  'acornfun', 'chumba', 'clash5', 'coinsbackcasino', 'luckyrush', 'moonspin', 'peakplay', 'sweetsweeps'
]);

// Sites that have working collectors
const SITES_WITH_COLLECTORS = new Set([
  'ace', 'acornfun', 'american-luck', 'baba-casino', 'casino-click', 'cashoomo', 'chanced',
  'chipnwin', 'chumba', 'clash5', 'clubs-poker', 'coinsbackcasino', 'coin-wizard-games', 'coolspin', 'crashduel', 'crown-coins', 'dara-casino',
  'dimesweeps', 'firesevens', 'fortunewins', 'fortune-wheelz', 'funrize', 'funzcity',
  'gains', 'global-poker', 'gold-treasure', 'golden-hearts', 'hello-milllions', 'high5',
  'jackpotrabbit', 'jefebet', 'kickr', 'lavish-luck', 'legendz', 'lonestar', 'luck-party',
  'lucky-bits-vegas', 'luckyhands', 'luckyland', 'luckyland-casino', 'luckyrush', 'luckystake',
  'lunaland-casino', 'mcluck', 'megabonanza', 'megaspinz', 'modo', 'moonspin',
  'moozi', 'mr-goodwin', 'myprize', 'nolimitcoins', 'peakplay', 'playfame', 'playtana', 'pulsz',
  'pulsz-bingo', 'punt', 'realprize', 'richsweeps', 'rolla', 'rollingriches', 'roxymoxy',
  'rubysweeps', 'scarletsands', 'sidepot', 'sixty6', 'smiles-casino', 'speedsweeps', 'spinblitz',
  'spindoo', 'spinfinite', 'spinpals', 'spinquest', 'spinsaga', 'sportzino', 'spree', 'stackr',
  'sheesh', 'stake', 'stormrush', 'sweepnext', 'sweepsla', 'sweepsroyal', 'sweepshark',
  'sweepsusa', 'sweetsweeps', 'tao-fortune', 'thrillcoins', 'wildworld', 'winbonanza', 'wow-vegas', 'yaycasino', 'yotta',
  'zoot', 'zula'
]);

// DOM Elements
const sitesGrid = document.getElementById('sitesGrid');
const searchInput = document.getElementById('searchInput');
const collectModal = document.getElementById('collectModal');
const addSiteModal = document.getElementById('addSiteModal');

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  updateDateDisplay();
  await loadData();
  loadLastRuns();
  setupEventListeners();
  render();

  // Onboarding: empty state banner + welcome wizard
  await initOnboardingBanner();
  initWelcomeWizard();

  // Chrome status indicator
  ChromeStatus.start();

  // PWA shortcut action handler
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  if (action) {
    window.history.replaceState({}, '', window.location.pathname);
    if (action === 'collect-all') openAutomationModal();
    if (action === 'start-chrome') startDebugChrome();
  }

  // Refresh cooldown timers every minute
  setInterval(() => {
    render();
  }, 60000);
}

function updateDateDisplay() {
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  document.getElementById('currentDate').textContent = new Date().toLocaleDateString('en-US', options);
}

async function loadData() {
  try {
    const [sitesRes, collectionsRes, lastCollectionsRes] = await Promise.all([
      fetch(`${API_BASE}/api/sites`),
      fetch(`${API_BASE}/api/collections/today`),
      fetch(`${API_BASE}/api/collections/last`)
    ]);
    sites = await sitesRes.json();
    collections = await collectionsRes.json();

    const lastCollectionsList = await lastCollectionsRes.json();
    lastCollections = {};
    for (const lc of lastCollectionsList) {
      lastCollections[lc.site_id] = lc.occurred_at;
    }

    checkHealth();
  } catch (err) {
    console.error('Failed to load data:', err);
    sites = [];
    collections = [];
    lastCollections = {};
  }
}

async function loadLastRuns() {
  try {
    const res = await fetch(`${API_BASE}/api/automation/last-runs`);
    lastRuns = await res.json();
  } catch { lastRuns = {}; }
  updateLastRunLabel();
}

function updateLastRunLabel() {
  const el = document.getElementById('lastRunLabel');
  if (!el) return;

  // Show the most recent run of any type
  const infoCa = lastRuns['collect-all'];
  const info24 = lastRuns['24hr'];
  const infoFt = lastRuns['fixed-time'];
  const tCa = infoCa?.timestamp ? new Date(infoCa.timestamp).getTime() : 0;
  const t24 = info24?.timestamp ? new Date(info24.timestamp).getTime() : 0;
  const tFt = infoFt?.timestamp ? new Date(infoFt.timestamp).getTime() : 0;
  const maxT = Math.max(tCa, t24, tFt);
  const info = maxT === tCa ? infoCa : (maxT === t24 ? info24 : infoFt);

  if (!info || !info.timestamp) {
    el.textContent = '';
    return;
  }
  const d = new Date(info.timestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffH = Math.floor(diffMs / 3600000);
  const diffM = Math.floor((diffMs % 3600000) / 60000);
  let ago;
  if (diffH >= 24) {
    const days = Math.floor(diffH / 24);
    ago = `${days}d ago`;
  } else if (diffH > 0) {
    ago = `${diffH}h ${diffM}m ago`;
  } else {
    ago = `${diffM}m ago`;
  }
  const time = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
  el.textContent = `Last run: ${time} (${ago})`;
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health/ledger');
    const data = await res.json();
    const badge = document.getElementById('healthBadge');
    const icon = document.getElementById('healthIcon');
    const text = document.getElementById('healthText');
    const panel = document.getElementById('healthPanel');

    if (!data.warnings || data.warnings.length === 0) {
      badge.className = 'health-badge healthy';
      icon.textContent = '\u25CF';
      text.textContent = 'Data OK';
      panel.style.display = 'none';
    } else {
      badge.className = 'health-badge warning';
      icon.textContent = '\u25CF';
      text.textContent = `${data.warnings.length} issue${data.warnings.length > 1 ? 's' : ''}`;
      panel.textContent = '';
      for (const w of data.warnings) {
        const item = document.createElement('div');
        item.className = 'health-panel-item';
        item.textContent = w.message;
        panel.appendChild(item);
      }
      badge.onclick = function(e) {
        e.stopPropagation();
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      };
      panel.onclick = function(e) { e.stopPropagation(); };
      document.addEventListener('click', function() { panel.style.display = 'none'; });
    }
    badge.style.display = 'inline-flex';
  } catch (err) {
    // Non-critical
  }
}

function setupEventListeners() {
  // Search
  searchInput.addEventListener('input', render);

  // Filter pills
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeFilter = pill.dataset.filter;
      render();
    });
  });

  // Export
  document.getElementById('exportBtn').addEventListener('click', exportCSV);

  // Show hidden toggle
  document.getElementById('showHiddenBtn').addEventListener('click', () => {
    showHidden = !showHidden;
    const btn = document.getElementById('showHiddenBtn');
    if (showHidden) {
      btn.textContent = 'Hide hidden sites';
    }
    render();
  });

  // Add site
  document.getElementById('addSiteBtn').addEventListener('click', () => {
    addSiteModal.classList.add('active');
    document.getElementById('newSiteName').focus();
  });

  // Close modals
  document.getElementById('closeModal').addEventListener('click', closeCollectModal);
  document.getElementById('closeAddModal').addEventListener('click', () => addSiteModal.classList.remove('active'));
  document.getElementById('cancelAddSite').addEventListener('click', () => addSiteModal.classList.remove('active'));

  // Click outside modal to close
  let modalMouseDownTarget = null;
  collectModal.addEventListener('mousedown', (e) => { modalMouseDownTarget = e.target; });
  collectModal.addEventListener('click', (e) => {
    if (e.target === collectModal && modalMouseDownTarget === collectModal) closeCollectModal();
    modalMouseDownTarget = null;
  });

  let addModalMouseDownTarget = null;
  addSiteModal.addEventListener('mousedown', (e) => { addModalMouseDownTarget = e.target; });
  addSiteModal.addEventListener('click', (e) => {
    if (e.target === addSiteModal && addModalMouseDownTarget === addSiteModal) addSiteModal.classList.remove('active');
    addModalMouseDownTarget = null;
  });

  // Save new site
  document.getElementById('saveNewSite').addEventListener('click', saveNewSite);

  // Visit site (header button)
  document.getElementById('visitSiteBtnHeader').addEventListener('click', () => {
    const url = document.getElementById('siteUrl').value.trim() || (currentSite && currentSite.url);
    if (url) window.open(url, '_blank');
  });

  // Auto-save URL on blur
  document.getElementById('siteUrl').addEventListener('blur', saveUrlOnBlur);

  // Confirm collection
  document.getElementById('confirmCollect').addEventListener('click', confirmCollection);

  // Hide/unhide site
  document.getElementById('toggleHideBtn').addEventListener('click', toggleHideSite);
  document.getElementById('togglePinBtn').addEventListener('click', async () => {
    if (!currentSite) return;
    await togglePin(currentSite.id);
    // Refresh the label / color to reflect the new state
    currentSite = sites.find(s => String(s.id) === String(currentSite.id)) || currentSite;
    const pinBtn = document.getElementById('togglePinBtn');
    if (pinBtn) {
      if (currentSite.pinned) {
        pinBtn.textContent = 'Unpin from focus';
        pinBtn.className = 'btn btn-secondary btn-sm';
      } else {
        pinBtn.textContent = 'Pin to focus';
        pinBtn.className = 'btn btn-primary btn-sm';
      }
    }
  });

  // Uncollect site
  document.getElementById('uncollectBtn').addEventListener('click', uncollectSite);

  // Site-specific purchase
  document.getElementById('confirmSitePurchase').addEventListener('click', confirmSitePurchase);

  // Live $/SC ratio display (multi-row)
  function updatePurchaseRatio() {
    const rows = document.querySelectorAll('#purchaseRows .purchase-row');
    let totalPaid = 0, totalSC = 0;
    rows.forEach(row => {
      const paid = parseFloat(row.querySelector('.purchase-amount').value) || 0;
      const sc = parseFloat(row.querySelector('.purchase-sc').value) || 0;
      totalPaid += paid;
      totalSC += sc;
    });
    const display = document.getElementById('purchaseRatioDisplay');
    const value = document.getElementById('purchaseRatioValue');
    if (totalPaid > 0 && totalSC > 0) {
      value.textContent = '$' + (totalPaid / totalSC).toFixed(2) + '/SC';
      display.style.display = 'block';
    } else {
      display.style.display = 'none';
    }
  }
  document.getElementById('purchaseRows').addEventListener('input', updatePurchaseRatio);

  // Add purchase row
  document.getElementById('addPurchaseRow').addEventListener('click', function() {
    const container = document.getElementById('purchaseRows');
    const row = document.createElement('div');
    row.className = 'purchase-row form-row';

    const amountGroup = document.createElement('div');
    amountGroup.className = 'form-group';
    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.className = 'purchase-amount';
    amountInput.step = '0.01';
    amountInput.placeholder = '9.99';
    amountGroup.appendChild(amountInput);

    const scGroup = document.createElement('div');
    scGroup.className = 'form-group';
    const scInput = document.createElement('input');
    scInput.type = 'number';
    scInput.className = 'purchase-sc';
    scInput.step = '0.01';
    scInput.placeholder = '10.00';
    scGroup.appendChild(scInput);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-row';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', function() {
      row.remove();
      updatePurchaseRatio();
    });

    row.appendChild(amountGroup);
    row.appendChild(scGroup);
    row.appendChild(removeBtn);
    container.appendChild(row);
    amountInput.focus();
  });

  // Chrome
  document.getElementById('startChromeBtn').addEventListener('click', startDebugChrome);

  // Automation modal
  const automationModal = document.getElementById('automationModal');
  document.getElementById('collectAllBtn').addEventListener('click', openAutomationModal);
  const readyCtaBtn = document.getElementById('readyCtaBtn');
  if (readyCtaBtn) readyCtaBtn.addEventListener('click', openAutomationModal);
  document.getElementById('closeAutomationModal').addEventListener('click', closeAutomationModal);
  document.getElementById('startCollectAll').addEventListener('click', () => startAutomation(false));
  document.getElementById('startCollectDry').addEventListener('click', () => startAutomation(true));
  document.getElementById('stopAutomation').addEventListener('click', stopAutomation);
  document.getElementById('copyFailures').addEventListener('click', copyFailuresForClaude);

  // Session & Redemption
  document.getElementById('confirmSession').addEventListener('click', recordSession);
  document.getElementById('confirmRedeem').addEventListener('click', requestRedemption);
  document.getElementById('sessionEnd').addEventListener('input', updateSessionPnl);
  document.getElementById('sessionSpins').addEventListener('input', updateSessionCalc);
  document.getElementById('sessionBet').addEventListener('input', updateSessionCalc);
  document.getElementById('sessionEnd').addEventListener('input', updateSessionCalc);
  document.getElementById('sessionPlaythrough').addEventListener('input', function() {
    this.dataset.manual = 'true';
    updateSessionCalc();
  });

  let automationModalMouseDownTarget = null;
  automationModal.addEventListener('mousedown', (e) => { automationModalMouseDownTarget = e.target; });
  automationModal.addEventListener('click', (e) => {
    if (e.target === automationModal && automationModalMouseDownTarget === automationModal) closeAutomationModal();
    automationModalMouseDownTarget = null;
  });

  // Modal tabs
  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => switchModalTab(tab.dataset.tab));
  });

  // Redeemable badge toggle
  document.getElementById('redeemableBadge').addEventListener('click', (e) => {
    e.stopPropagation();
    const badge = document.getElementById('redeemableBadge');
    badge.classList.toggle('open');
  });
  document.addEventListener('click', () => {
    document.getElementById('redeemableBadge').classList.remove('open');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCollectModal();
      addSiteModal.classList.remove('active');
      closeAutomationModal();
    }
    if (e.key === 'Enter' && collectModal.classList.contains('active')) {
      if (document.activeElement && document.activeElement.id === 'scAmount') {
        confirmCollection();
      }
    }
  });
}

// ========== PIN / FOCUS STRIP ==========

const FOCUS_PIN_CAP = 4;

// Deterministic hue per site so focus cards feel distinct.
// Golden-ratio spacing avoids two adjacent pinned sites landing on the same tint.
function siteHue(site) {
  const key = String(site.id || site.name || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return Math.floor((h * 137.508) % 360);
}

function buildPinIcon(isPinned) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', isPinned ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', isPinned ? '0' : '1.6');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M12 2 10 8H4l5 4-2 8 5-5 5 5-2-8 5-4h-6l-2-6Z');
  svg.appendChild(path);
  return svg;
}

async function togglePin(siteId) {
  const site = sites.find(s => String(s.id) === String(siteId));
  if (!site) return;
  const nextPinned = !site.pinned;

  // Client-side cap check — short-circuit network call with a toast.
  if (nextPinned) {
    const pinnedCount = sites.filter(s => s.pinned && s.active && !s.hidden).length;
    if (pinnedCount >= FOCUS_PIN_CAP) {
      showToast(`Focus strip is full (${FOCUS_PIN_CAP} pinned). Unpin one first.`);
      return;
    }
  }

  try {
    const res = await fetch(API_BASE + '/api/sites/' + encodeURIComponent(siteId) + '/pin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: nextPinned })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to update pin');
      return;
    }
    site.pinned = nextPinned;
    render();
  } catch (err) {
    showToast('Failed to update pin');
  }
}

function renderFocusStrip(pinnedSites, collectedIds) {
  const wrap = document.getElementById('focusStrip');
  if (!wrap) return;

  if (!pinnedSites.length) {
    wrap.style.display = 'none';
    wrap.textContent = '';
    return;
  }

  wrap.textContent = '';
  wrap.style.display = 'grid';

  for (const site of pinnedSites) {
    const status = classifySite(site, collectedIds);
    const cooldownInfo = getCooldownInfo(site);
    const pnl = site.pnl || 0;

    const card = document.createElement('div');
    card.className = 'focus-card status-' + status;
    card.style.setProperty('--focus-h', siteHue(site));
    card.dataset.id = site.id;

    const pinBtn = document.createElement('button');
    pinBtn.className = 'focus-pin on';
    pinBtn.title = 'Unpin';
    pinBtn.appendChild(buildPinIcon(true));
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(site.id);
    });
    card.appendChild(pinBtn);

    const name = document.createElement('div');
    name.className = 'focus-name';
    name.textContent = site.name;
    card.appendChild(name);

    const sub = document.createElement('div');
    sub.className = 'focus-sub';
    if (status === 'ready') sub.textContent = 'Ready to collect';
    else if (status === 'collected') sub.textContent = 'Collected today';
    else if (status === 'issues') {
      sub.textContent =
        site.cooldown_reason === 'stale' ? 'Stale' :
        site.cooldown_reason === 'suspended' ? 'Suspended' :
        site.meta?.suspicious ? 'Suspicious' :
        site.account_status === 'locked' ? 'Locked' :
        site.account_status === 'banned' ? 'Banned' : 'Needs attention';
    } else {
      sub.textContent = 'In ' + cooldownInfo.text;
    }
    card.appendChild(sub);

    const amount = document.createElement('div');
    amount.className = 'focus-amount';
    amount.textContent = '$' + (site.bankroll || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    card.appendChild(amount);

    const delta = document.createElement('div');
    delta.className = 'focus-delta';
    delta.style.color = pnl >= 0 ? 'var(--accent)' : 'var(--danger)';
    delta.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    card.appendChild(delta);

    card.addEventListener('click', () => openCollectModal(site.id));
    wrap.appendChild(card);
  }
}

// ========== SITE CLASSIFICATION ==========

function classifySite(site, collectedIds) {
  if (collectedIds.has(String(site.id))) return 'collected';

  if (IGNORED_ATTENTION_IDS.has(site.id)) return 'cooldown';

  const hasIssue =
    (site.cooldown_reason === 'stale' || site.cooldown_reason === 'suspended') ||
    site.meta?.suspicious ||
    (site.account_status === 'locked' || site.account_status === 'banned') ||
    (site.days_since_collection != null && site.days_since_collection >= 7);

  if (hasIssue) return 'issues';

  const cooldownInfo = getCooldownInfo(site);
  if (cooldownInfo.ready) return 'ready';

  return 'cooldown';
}

// ========== RENDER ==========

function render() {
  const searchTerm = searchInput.value.toLowerCase();
  const collectedIds = new Set(collections.map(c => String(c.site_id)));

  let activeSites = sites.filter(s => s.active);
  let hiddenSites = sites.filter(s => !s.active);

  // Apply search
  if (searchTerm) {
    activeSites = activeSites.filter(s => s.name.toLowerCase().includes(searchTerm));
    hiddenSites = hiddenSites.filter(s => s.name.toLowerCase().includes(searchTerm));
  }

  // Classify each active site
  const classified = { ready: [], cooldown: [], issues: [], collected: [] };
  for (const site of activeSites) {
    const status = classifySite(site, collectedIds);
    classified[status].push(site);
  }

  // Update filter pill counts
  document.getElementById('filterCountAll').textContent = activeSites.length;
  document.getElementById('filterCountReady').textContent = classified.ready.length;
  document.getElementById('filterCountCooldown').textContent = classified.cooldown.length;
  document.getElementById('filterCountIssues').textContent = classified.issues.length;

  // Apply active filter — interleave section dividers on "all"
  let displaySites;
  if (activeFilter === 'all') {
    const sectionOrder = [
      ['ready', 'Ready to collect'],
      ['issues', 'Needs attention'],
      ['cooldown', 'On cooldown'],
      ['collected', 'Collected today'],
    ];
    displaySites = [];
    for (const [key, label] of sectionOrder) {
      const group = classified[key] || [];
      if (!group.length) continue;
      displaySites.push({ __divider: true, key, label, count: group.length });
      displaySites.push(...group.sort((a, b) => a.name.localeCompare(b.name)));
    }
  } else {
    displaySites = (classified[activeFilter] || []).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Include hidden sites if toggled
  if (showHidden && hiddenSites.length > 0) {
    if (activeFilter === 'all' && hiddenSites.length) {
      displaySites.push({ __divider: true, key: 'hidden', label: 'Hidden', count: hiddenSites.length });
    }
    displaySites = displaySites.concat(hiddenSites.sort((a, b) => a.name.localeCompare(b.name)));
  }

  // Update ready count on Collect All button
  const collectAllBtn = document.getElementById('collectAllBtn');
  const readyWithCollectors = classified.ready.filter(s => SITES_WITH_COLLECTORS.has(s.id));
  currentPrioritySites = readyWithCollectors;
  collectAllBtn.textContent = '';
  collectAllBtn.append('▶ Collect All');
  if (readyWithCollectors.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'ready-badge';
    badge.textContent = String(readyWithCollectors.length);
    collectAllBtn.append(' ', badge);
  }

  // Ready-count CTA banner
  const ctaBar = document.getElementById('readyCtaBar');
  if (ctaBar) {
    const readyCount = classified.ready.length;
    if (readyCount > 0 && activeFilter !== 'ready') {
      ctaBar.style.display = 'flex';
      document.getElementById('readyCtaCount').textContent = readyCount;
    } else {
      ctaBar.style.display = 'none';
    }
  }

  // Render focus strip (pinned, active, non-hidden)
  const pinnedSites = activeSites
    .filter(s => s.pinned)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, FOCUS_PIN_CAP);
  renderFocusStrip(pinnedSites, collectedIds);

  // Render grid
  renderSiteGrid(sitesGrid, displaySites, collectedIds);

  // Empty state
  const isEmpty = displaySites.length === 0;
  document.getElementById('sitesEmpty').style.display = isEmpty ? 'block' : 'none';
  sitesGrid.style.display = isEmpty ? 'none' : 'grid';

  // Hidden link
  const hiddenLink = document.getElementById('showHiddenLink');
  if (hiddenSites.length > 0 && !showHidden) {
    hiddenLink.style.display = 'block';
    document.getElementById('hiddenCountDisplay').textContent = hiddenSites.length;
  } else {
    hiddenLink.style.display = 'none';
  }

  // Update stats
  updateStats(activeSites, collectedIds);

  // Redeemable badge
  renderRedeemableBadge(activeSites);
}

// ========== COOLDOWN CALCULATION ==========

function getCooldownInfo(site) {
  if (IGNORED_ATTENTION_IDS.has(site.id)) {
    return { ready: false, remaining: 0, text: 'Shelved' };
  }
  // Server-side cooldown classification takes priority
  if (site.cooldown_reason && site.cooldown_reason !== 'expected') {
    const sinceMs = site.cooldown_since ? Date.now() - new Date(site.cooldown_since).getTime() : 0;
    const sinceDays = Math.floor(sinceMs / 86400000);
    const sinceText = sinceDays > 0 ? sinceDays + 'd' : '<1d';
    return {
      ready: false, remaining: 0,
      text: site.cooldown_reason === 'stale' ? 'Stale (' + sinceText + ')'
          : site.cooldown_reason === 'suspended' ? 'Suspended'
          : 'Suspicious (' + sinceText + ')',
      reason: site.cooldown_reason,
      message: site.cooldown_message
    };
  }

  const lastCollection = lastCollections[site.id];
  const now = Date.now();

  const lastCollectionTime = lastCollection ? new Date(lastCollection).getTime() : 0;
  const lastCheckedTime = site.last_checked ? new Date(site.last_checked).getTime() : 0;
  const lastTouched = Math.max(lastCollectionTime, lastCheckedTime);

  // Fixed wall-clock reset
  const resetHour = site.meta && site.meta.reset_hour_utc;
  if (resetHour != null) {
    const nowDate = new Date(now);
    const todayReset = new Date(Date.UTC(
      nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate(), resetHour, 0, 0
    ));
    const mostRecentReset = todayReset.getTime() <= now
      ? todayReset
      : new Date(todayReset.getTime() - 24 * 60 * 60 * 1000);
    const nextReset = new Date(mostRecentReset.getTime() + 24 * 60 * 60 * 1000);

    if (lastTouched >= mostRecentReset.getTime()) {
      const remainingMinutes = (nextReset.getTime() - now) / 60000;
      if (remainingMinutes <= 0) return { ready: true, remaining: 0, text: 'Ready' };
      const hours = Math.floor(remainingMinutes / 60);
      const mins = Math.floor(remainingMinutes % 60);
      const text = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
      return { ready: false, remaining: remainingMinutes, text };
    }
    return { ready: true, remaining: 0, text: 'Ready' };
  }

  // Rolling cooldown
  const cooldownMinutes = site.cooldown_minutes || 1440;

  if (lastTouched === 0) {
    return { ready: true, remaining: 0, text: 'Ready' };
  }

  const elapsedMinutes = (now - lastTouched) / 60000;
  const remainingMinutes = cooldownMinutes - elapsedMinutes;

  if (remainingMinutes <= 0) {
    return { ready: true, remaining: 0, text: 'Ready' };
  }

  const hours = Math.floor(remainingMinutes / 60);
  const mins = Math.floor(remainingMinutes % 60);
  let text;
  if (hours > 0) {
    text = hours + 'h ' + mins + 'm';
  } else {
    text = mins + 'm';
  }

  return { ready: false, remaining: remainingMinutes, text };
}

// ========== SITE GRID ==========

function renderSiteGrid(container, siteList, collectedIds) {
  if (siteList.length === 0) {
    container.textContent = '';
    return;
  }

  // Build cards using DOM methods for safety
  container.textContent = '';

  for (const site of siteList) {
    // Section divider (interleaved when filter === 'all')
    if (site && site.__divider) {
      const divider = document.createElement('div');
      divider.className = 'section-label';
      divider.dataset.group = site.key;
      const label = document.createElement('span');
      label.textContent = site.label;
      const count = document.createElement('span');
      count.className = 'section-count';
      count.textContent = site.count;
      const rule = document.createElement('span');
      rule.className = 'section-rule';
      divider.append(label, count, rule);
      container.appendChild(divider);
      continue;
    }

    const status = classifySite(site, collectedIds);
    const isCollected = status === 'collected';
    const isHidden = !site.active;
    const collection = isCollected ? collections.find(c => String(c.site_id) === String(site.id)) : null;
    const cooldownInfo = getCooldownInfo(site);
    const pnl = site.pnl || 0;
    const pnlSign = pnl >= 0 ? '+' : '';

    const card = document.createElement('div');
    card.className = 'site-card status-' + status + (isHidden ? ' hidden-site' : '');
    card.dataset.id = site.id;

    // Line 1: name + suspicious icon + pin
    const line1 = document.createElement('div');
    line1.className = 'site-card-line1';
    const nameEl = document.createElement('span');
    nameEl.className = 'site-name';
    nameEl.textContent = site.name;
    line1.appendChild(nameEl);
    if (site.meta?.suspicious) {
      const suspIcon = document.createElement('span');
      suspIcon.className = 'site-badge site-badge-cd-suspicious';
      suspIcon.title = 'Suspicious';
      suspIcon.textContent = '\u26a0';
      line1.appendChild(suspIcon);
    }
    const pinBtn = document.createElement('button');
    pinBtn.className = 'site-card-pin' + (site.pinned ? ' on' : '');
    pinBtn.title = site.pinned ? 'Unpin' : 'Pin to focus strip';
    pinBtn.appendChild(buildPinIcon(!!site.pinned));
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(site.id);
    });
    line1.appendChild(pinBtn);
    card.appendChild(line1);

    // Line 2: bankroll + P&L
    const line2 = document.createElement('div');
    line2.className = 'site-card-line2';
    const bankrollEl = document.createElement('span');
    bankrollEl.className = 'card-bankroll';
    bankrollEl.textContent = '$' + (site.bankroll || 0).toFixed(2);
    const sepEl = document.createElement('span');
    sepEl.className = 'card-separator';
    sepEl.textContent = '\u00B7';
    const pnlEl = document.createElement('span');
    pnlEl.className = 'card-pnl';
    pnlEl.style.color = pnl >= 0 ? 'var(--success-light)' : 'var(--danger)';
    pnlEl.textContent = pnlSign + '$' + pnl.toFixed(2);
    line2.append(bankrollEl, sepEl, pnlEl);
    card.appendChild(line2);

    // Line 3: status + badges
    const line3 = document.createElement('div');
    line3.className = 'site-card-line3';

    if (isCollected) {
      const statusEl = document.createElement('span');
      statusEl.className = 'card-status-collected';
      statusEl.textContent = '+$' + (collection?.sc_amount || 0).toFixed(2) + ' SC';
      line3.appendChild(statusEl);
    } else if (status === 'ready') {
      const statusEl = document.createElement('span');
      statusEl.className = 'card-status-ready';
      statusEl.textContent = 'Ready';
      line3.appendChild(statusEl);
    } else if (status === 'issues') {
      const statusEl = document.createElement('span');
      statusEl.className = 'card-status-issue';
      let issueText = 'Issue';
      if (site.cooldown_reason === 'stale') {
        const cdDays = site.cooldown_since ? Math.floor((Date.now() - new Date(site.cooldown_since).getTime()) / 86400000) : '?';
        issueText = 'Stale (' + cdDays + 'd)';
      } else if (site.cooldown_reason === 'suspended') {
        issueText = 'Suspended';
      } else if (site.meta?.suspicious) {
        issueText = 'Suspicious';
      } else if (site.account_status === 'locked') {
        issueText = 'Locked';
      } else if (site.account_status === 'banned') {
        issueText = 'Banned';
      } else if (site.days_since_collection >= 7) {
        issueText = site.days_since_collection + 'd stale';
      }
      statusEl.textContent = issueText;
      line3.appendChild(statusEl);
    } else {
      const statusEl = document.createElement('span');
      statusEl.className = 'card-status-cooldown';
      statusEl.textContent = cooldownInfo.text;
      line3.appendChild(statusEl);
    }

    // Badges
    if (!isCollected && !isHidden) {
      if (site.account_status === 'registered') {
        const badge = document.createElement('span');
        badge.className = 'site-badge site-badge-kyc';
        badge.textContent = 'KYC needed';
        line3.appendChild(badge);
      } else if (site.account_status === 'kyc_done') {
        const badge = document.createElement('span');
        badge.className = 'site-badge site-badge-verified';
        badge.textContent = '\u2713 Verified';
        line3.appendChild(badge);
      }
      if ((site.account_status === 'registered' || site.account_status === 'kyc_done') && !site.welcome_bonus_claimed) {
        const badge = document.createElement('a');
        badge.className = 'site-badge site-badge-welcome';
        badge.href = site.url || '#';
        badge.target = '_blank';
        badge.rel = 'noopener';
        badge.textContent = 'Claim bonus';
        badge.addEventListener('click', (e) => e.stopPropagation());
        line3.appendChild(badge);
      }
      if (site.account_status === 'registered' && (site.collection_count || 0) >= 14) {
        const badge = document.createElement('span');
        badge.className = 'site-badge site-badge-kyc-nudge';
        badge.title = 'Verify your identity now so you are ready to redeem';
        badge.textContent = '\u26a0 Verify';
        line3.appendChild(badge);
      }
    }

    card.appendChild(line3);

    card.addEventListener('click', () => openCollectModal(card.dataset.id));
    container.appendChild(card);
  }
}

// ========== STATS ==========

function updateStats(activeSites, collectedIds) {
  const collected = collectedIds.size;
  const total = activeSites.length;
  const percent = total > 0 ? Math.round((collected / total) * 100) : 0;

  const totalSC = collections.reduce((sum, c) => sum + (c.sc_amount || 0), 0);
  const totalBankroll = activeSites.reduce((sum, s) => sum + (s.bankroll || 0), 0);
  const totalPnL = activeSites.reduce((sum, s) => sum + (s.pnl || 0), 0);
  const ytdPnL = activeSites.reduce((sum, s) => sum + (s.pnl_ytd || 0), 0);

  // Progress ring (r=20, circumference=125.66)
  const circumference = 2 * Math.PI * 20;
  const offset = circumference - (percent / 100) * circumference;
  document.getElementById('progressRing').style.strokeDashoffset = offset;
  document.getElementById('progressPercent').textContent = percent + '%';

  document.getElementById('progressCount').textContent = collected + ' of ' + total + ' collected';
  document.getElementById('totalSC').textContent = '$' + totalSC.toFixed(2);
  document.getElementById('totalBankroll').textContent = '$' + totalBankroll.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

  // YTD P&L
  const pnlEl = document.getElementById('totalPnL');
  pnlEl.textContent = (ytdPnL >= 0 ? '+' : '') + '$' + ytdPnL.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  pnlEl.className = 'hero-stat-value' + (ytdPnL >= 0 ? '' : ' negative');
  pnlEl.style.color = ytdPnL >= 0 ? 'var(--success-light)' : 'var(--danger)';

  // All-time P&L
  const allTimeEl = document.getElementById('totalPnLAllTime');
  allTimeEl.textContent = (totalPnL >= 0 ? '+' : '') + '$' + totalPnL.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' all-time';
  allTimeEl.style.color = totalPnL >= 0 ? 'var(--success-light)' : 'var(--danger)';
}

// ========== REDEEMABLE BADGE ==========

function renderRedeemableBadge(activeSites) {
  const badge = document.getElementById('redeemableBadge');
  const dropdown = document.getElementById('redeemableDropdown');
  const countEl = document.getElementById('redeemableCount');

  const qualifying = activeSites
    .filter(s => (s.bankroll || 0) >= balanceThreshold)
    .sort((a, b) => (b.bankroll || 0) - (a.bankroll || 0));

  if (qualifying.length === 0) {
    badge.style.display = 'none';
    return;
  }

  badge.style.display = 'inline-flex';
  countEl.textContent = qualifying.length;

  // Build dropdown with DOM methods
  dropdown.textContent = '';
  qualifying.forEach(site => {
    const item = document.createElement('div');
    item.className = 'redeemable-dropdown-item';

    const name = document.createElement('span');
    name.className = 'redeemable-dropdown-name';
    name.textContent = site.name;

    const bal = document.createElement('span');
    bal.className = 'redeemable-dropdown-balance';
    bal.textContent = '$' + (site.bankroll || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    item.appendChild(name);
    item.appendChild(bal);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      badge.classList.remove('open');
      openCollectModal(site.id);
    });
    dropdown.appendChild(item);
  });
}

// ========== MODAL TAB SWITCHING ==========

function switchModalTab(tabName) {
  activeModalTab = tabName;

  document.querySelectorAll('.modal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });

  document.querySelectorAll('.modal-tab-content').forEach(panel => {
    panel.classList.remove('active');
  });
  const activePanel = document.getElementById('tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
  if (activePanel) activePanel.classList.add('active');

  if (tabName === 'collect') {
    setTimeout(() => document.getElementById('scAmount').select(), 50);
  }
}

// ========== TOAST ==========

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastMessage').textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// ========== COLLECT MODAL ==========

function openCollectModal(siteId) {
  currentSite = sites.find(s => String(s.id) === String(siteId));
  if (!currentSite) {
    console.error('Site not found:', siteId);
    alert('Site not found: ' + siteId);
    return;
  }

  const existingCollection = collections.find(c => String(c.site_id) === String(siteId));

  // === Persistent Header ===
  document.getElementById('modalSiteName').textContent = currentSite.name;

  const bankroll = currentSite.bankroll || 0;
  const pnl = currentSite.pnl || 0;
  document.getElementById('modalBalance').textContent = '$' + bankroll.toFixed(2);
  const pnlDisplay = document.getElementById('modalPnl');
  pnlDisplay.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
  pnlDisplay.style.color = pnl >= 0 ? 'var(--success-light)' : 'var(--danger)';

  // Suspicious banner
  const bannerArea = document.getElementById('suspiciousBannerArea');
  bannerArea.textContent = '';
  if (currentSite.meta?.suspicious) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#ff4444;color:#fff;padding:8px 12px;border-radius:6px;margin-top:10px;font-size:13px;';
    const strong = document.createElement('strong');
    strong.textContent = '\u26a0 SUSPICIOUS \u2014 DO NOT PURCHASE';
    const reason = document.createElement('div');
    reason.style.marginTop = '4px';
    reason.textContent = currentSite.meta.suspicious_reason || 'Redemption issues detected. Do not buy SC packages from this site.';
    banner.appendChild(strong);
    banner.appendChild(reason);
    bannerArea.appendChild(banner);
  }

  // Community warning banner (from Discord intel, daily scrapes, etc.)
  const cwArea = document.getElementById('communityWarningArea');
  cwArea.textContent = '';
  const warnings = currentSite.meta?.community_warnings || [];
  warnings.forEach(w => {
    const colors = {
      red: { bg: '#cc3333', text: '#fff' },
      yellow: { bg: '#e6a817', text: '#1a1a1a' },
    };
    const c = colors[w.severity] || colors.yellow;
    const banner = document.createElement('div');
    banner.style.cssText = `background:${c.bg};color:${c.text};padding:8px 12px;border-radius:6px;margin-top:8px;font-size:13px;`;
    const strong = document.createElement('strong');
    strong.textContent = (w.severity === 'red' ? '\u26a0 ' : '\u26a0\ufe0f ') + (w.label || 'Community Warning');
    const detail = document.createElement('div');
    detail.style.marginTop = '4px';
    detail.textContent = w.message;
    if (w.source) {
      const src = document.createElement('div');
      src.style.cssText = 'margin-top:4px;font-size:11px;opacity:0.7;';
      src.textContent = 'Source: ' + w.source + (w.date ? ' (' + w.date + ')' : '');
      detail.appendChild(src);
    }
    banner.appendChild(strong);
    banner.appendChild(detail);
    cwArea.appendChild(banner);
  });

  // Playthrough banner
  const ptArea = document.getElementById('playthroughBannerArea');
  ptArea.textContent = '';
  const ptMultiplier = currentSite.meta?.playthrough_multiplier;
  if (ptMultiplier) {
    const ptBanner = document.createElement('div');
    ptBanner.className = 'playthrough-banner';
    ptBanner.style.display = 'block';
    const required = (bankroll * ptMultiplier).toFixed(2);
    const label = document.createElement('strong');
    label.textContent = ptMultiplier + 'x Playthrough';
    ptBanner.appendChild(label);
    const detail = document.createElement('span');
    detail.className = 'playthrough-detail';
    detail.textContent = ' \u2014 ' + required + ' SC to redeem ' + bankroll.toFixed(2) + ' SC';
    ptBanner.appendChild(detail);
    if (currentSite.meta?.playthrough_note) {
      const note = document.createElement('div');
      note.className = 'playthrough-note';
      note.textContent = currentSite.meta.playthrough_note;
      ptBanner.appendChild(note);
    }
    ptArea.appendChild(ptBanner);
  }

  // === Overview Tab ===
  const washingDiv = document.getElementById('washingGames');
  const washingList = document.getElementById('washingGamesList');
  const washGames = currentSite.meta?.washingGames;
  let hasOverviewContent = false;

  if (washGames && washGames.length > 0) {
    washingDiv.style.display = 'block';
    washingList.textContent = '';
    washGames.forEach(g => {
      const item = document.createElement('div');
      item.className = 'washing-game-item';
      const name = document.createElement('span');
      name.className = 'washing-game-name';
      name.textContent = g.name;
      const stats = document.createElement('span');
      stats.className = 'washing-game-stats';
      [
        { text: g.rtp + '%', cls: 'pill-rtp' },
        { text: g.volatility, cls: 'pill-vol' },
        { text: '$' + g.minBet, cls: 'pill-bet' },
      ].forEach(p => {
        const pill = document.createElement('span');
        pill.className = 'washing-pill ' + p.cls;
        pill.textContent = p.text;
        stats.appendChild(pill);
      });
      item.appendChild(name);
      item.appendChild(stats);
      washingList.appendChild(item);
    });
    hasOverviewContent = true;
  } else {
    washingDiv.style.display = 'none';
  }

  // Excluded wash games
  const excludedDiv = document.getElementById('excludedWashGames');
  const excludedGames = currentSite.meta?.excludedWashGames;
  if (excludedGames && excludedGames.length > 0) {
    excludedDiv.style.display = 'block';
    while (excludedDiv.firstChild) excludedDiv.removeChild(excludedDiv.firstChild);
    const label = document.createElement('label');
    label.className = 'tab-section-label';
    label.textContent = 'Excluded from Playthrough';
    excludedDiv.appendChild(label);
    const list = document.createElement('div');
    list.className = 'excluded-games-list';
    excludedGames.forEach(g => {
      const item = document.createElement('div');
      item.className = 'excluded-game-item';
      const name = document.createElement('span');
      name.className = 'excluded-game-name';
      name.textContent = g.name;
      const reason = document.createElement('span');
      reason.className = 'excluded-game-reason';
      reason.textContent = g.reason || 'Does not count toward playthrough';
      item.appendChild(name);
      item.appendChild(reason);
      list.appendChild(item);
    });
    excludedDiv.appendChild(list);
    hasOverviewContent = true;
  } else {
    excludedDiv.style.display = 'none';
  }

  // Cross-wash safety
  const cwSection = document.getElementById('crossWashSection');
  const cwInfo = document.getElementById('crossWashInfo');
  const crossWash = currentSite.meta?.cross_wash;
  if (crossWash) {
    cwSection.style.display = 'block';
    cwInfo.textContent = '';
    const ratingColors = { safe: '#2d8a4e', caution: '#e6a817', danger: '#cc3333' };
    const ratingLabels = { safe: 'Safe Target', caution: 'Use Caution', danger: 'Avoid' };
    const badge = document.createElement('div');
    const color = ratingColors[crossWash.rating] || '#888';
    badge.style.cssText = `display:inline-block;background:${color};color:#fff;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:6px;`;
    badge.textContent = ratingLabels[crossWash.rating] || crossWash.rating;
    cwInfo.appendChild(badge);
    if (crossWash.note) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:4px;';
      note.textContent = crossWash.note;
      cwInfo.appendChild(note);
    }
    if (crossWash.games && crossWash.games.length) {
      const gamesDiv = document.createElement('div');
      gamesDiv.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:4px;';
      gamesDiv.textContent = 'Games: ' + crossWash.games.join(', ');
      cwInfo.appendChild(gamesDiv);
    }
    hasOverviewContent = true;
  } else {
    cwSection.style.display = 'none';
  }

  // Realized RTP
  document.getElementById('overviewEmpty').style.display = hasOverviewContent ? 'none' : 'block';
  loadRealizedRtp(currentSite.id, currentSite.name).then(hasData => {
    if (!hasData && !hasOverviewContent) {
      document.getElementById('overviewEmpty').style.display = 'block';
    } else {
      document.getElementById('overviewEmpty').style.display = 'none';
    }
  });

  // === Transactions Tab ===
  const purchaseContainer = document.getElementById('purchaseRows');
  const firstPurchaseRow = purchaseContainer.querySelector('.purchase-row');
  firstPurchaseRow.querySelector('.purchase-amount').value = '';
  firstPurchaseRow.querySelector('.purchase-sc').value = '';
  while (purchaseContainer.children.length > 1) purchaseContainer.lastChild.remove();
  document.getElementById('purchaseRatioDisplay').style.display = 'none';
  document.getElementById('redeemAmount').value = '';
  document.getElementById('redeemDest').value = 'KeyBank';
  loadPendingRedemptions(currentSite.id);
  loadTransactionHistory(currentSite.id);

  // === Collect Tab ===
  document.getElementById('scAmount').value = existingCollection?.sc_amount ?? currentSite.typical_sc;
  document.getElementById('confirmCollect').textContent = existingCollection ? 'Update' : 'Mark Collected';
  document.getElementById('uncollectBtn').style.display = existingCollection ? 'inline-block' : 'none';

  document.getElementById('sessionStart').value = currentSite.bankroll || 0;
  document.getElementById('sessionEnd').value = '';
  document.getElementById('sessionSpins').value = '';
  document.getElementById('sessionBet').value = '';
  document.getElementById('sessionPlaythrough').value = '';
  document.getElementById('sessionPnl').textContent = '--';
  document.getElementById('sessionPnl').className = 'session-pnl';
  document.getElementById('sessionRtpDisplay').style.display = 'none';

  const gameSelect = document.getElementById('sessionGame');
  while (gameSelect.firstChild) gameSelect.removeChild(gameSelect.firstChild);
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '\u2014 select game \u2014';
  gameSelect.appendChild(defaultOpt);
  if (washGames && washGames.length > 0) {
    washGames.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = g.name + ' (' + g.rtp + '% RTP)';
      opt.dataset.rtp = g.rtp;
      opt.dataset.provider = g.provider || '';
      gameSelect.appendChild(opt);
    });
  }
  const otherOpt = document.createElement('option');
  otherOpt.value = '__other__';
  otherOpt.textContent = 'Other...';
  gameSelect.appendChild(otherOpt);

  // === Settings Tab ===
  document.getElementById('siteUrl').value = currentSite.url || '';

  const hideBtn = document.getElementById('toggleHideBtn');
  if (currentSite.active) {
    hideBtn.textContent = 'Hide Site';
    hideBtn.className = 'btn btn-danger';
  } else {
    hideBtn.textContent = 'Unhide Site';
    hideBtn.className = 'btn btn-success';
  }

  const pinBtn = document.getElementById('togglePinBtn');
  if (pinBtn) {
    if (currentSite.pinned) {
      pinBtn.textContent = 'Unpin from focus';
      pinBtn.className = 'btn btn-secondary btn-sm';
    } else {
      pinBtn.textContent = 'Pin to focus';
      pinBtn.className = 'btn btn-primary btn-sm';
    }
  }

  const setupContainer = document.getElementById('accountSetupContainer');
  if (setupContainer) {
    setupContainer.textContent = '';
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = renderAccountSetupSection(currentSite);
    while (tempDiv.firstChild) setupContainer.appendChild(tempDiv.firstChild);
    wireAccountSetupSection(currentSite);
  }

  // Reset to Overview tab and open
  switchModalTab('overview');
  collectModal.classList.add('active');
}

function closeCollectModal() {
  collectModal.classList.remove('active');
  currentSite = null;
}

// ========== TRANSACTION HISTORY ==========

async function loadTransactionHistory(siteId) {
  const container = document.getElementById('transactionHistory');
  container.textContent = '';

  try {
    const response = await fetch(API_BASE + '/api/ledger?site=' + siteId + '&types=purchase,redemption_requested,redemption_received&limit=20');
    if (!response.ok) return;

    const events = await response.json();
    if (!events.length) {
      const empty = document.createElement('div');
      empty.className = 'txn-history-empty';
      empty.textContent = 'No transactions yet';
      container.appendChild(empty);
      return;
    }

    events.forEach(ev => {
      const item = document.createElement('div');
      item.className = 'txn-item';

      const date = document.createElement('span');
      date.className = 'txn-date';
      date.textContent = new Date(ev.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      const type = document.createElement('span');
      type.className = 'txn-type';
      if (ev.type === 'purchase') {
        type.classList.add('txn-type-purchase');
        type.textContent = 'Buy';
      } else if (ev.type === 'redemption_requested') {
        type.classList.add('txn-type-withdrawal');
        type.textContent = 'Withdraw';
      } else if (ev.type === 'redemption_received') {
        type.classList.add('txn-type-received');
        type.textContent = 'Received';
      }

      const notes = document.createElement('span');
      notes.className = 'txn-notes';
      notes.textContent = ev.notes || '';

      const amount = document.createElement('span');
      amount.className = 'txn-amount';
      const cashAmt = ev.cash_amount || 0;
      amount.textContent = '$' + Math.abs(cashAmt).toFixed(2);
      amount.style.color = cashAmt >= 0 ? 'var(--success-light)' : 'var(--danger)';

      item.append(date, type, notes, amount);
      container.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load transaction history:', err);
  }
}

// ========== COLLECTION ==========

async function confirmCollection() {
  if (!currentSite) return;

  const newUrl = document.getElementById('siteUrl').value.trim();
  const scAmount = parseFloat(document.getElementById('scAmount').value) || 0;
  const existingIndex = collections.findIndex(c => String(c.site_id) === String(currentSite.id));

  try {
    // Update URL if changed
    const currentUrl = currentSite.url || '';
    if (newUrl !== currentUrl) {
      const updateResponse = await fetch(API_BASE + '/api/sites/' + currentSite.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newUrl })
      });
      if (updateResponse.ok) currentSite.url = newUrl;
    }

    if (existingIndex >= 0) {
      const deleteResponse = await fetch(API_BASE + '/api/collections/' + collections[existingIndex].id, { method: 'DELETE' });
      if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Delete failed: HTTP ' + deleteResponse.status);
      }
    }

    const response = await fetch(API_BASE + '/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_id: currentSite.id,
        sc_amount: scAmount,
        gc_amount: 0,
        method: 'manual'
      })
    });

    const newCollection = await response.json();

    if (existingIndex >= 0) {
      collections[existingIndex] = newCollection;
    } else {
      collections.push(newCollection);
    }

    const siteId = currentSite.id;
    const siteName = currentSite.name;
    render();
    openCollectModal(siteId);
    showToast(siteName + ' marked as collected!');
  } catch (err) {
    console.error('Failed to save collection:', err);
    alert('Failed to save: ' + err.message);
  }
}

async function saveNewSite() {
  const name = document.getElementById('newSiteName').value.trim();
  if (!name) { alert('Please enter a site name'); return; }

  const newSite = {
    name,
    url: document.getElementById('newSiteUrl').value.trim(),
    typical_sc: parseFloat(document.getElementById('newSiteSC').value) || 0.30,
    typical_gc: parseInt(document.getElementById('newSiteGC').value) || 10000,
    reset_type: document.getElementById('newSiteReset').value
  };

  try {
    const response = await fetch(API_BASE + '/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSite)
    });

    const savedSite = await response.json();
    sites.push(savedSite);

    document.getElementById('newSiteName').value = '';
    document.getElementById('newSiteUrl').value = '';
    document.getElementById('newSiteSC').value = '0.30';
    document.getElementById('newSiteGC').value = '10000';

    addSiteModal.classList.remove('active');
    render();
    showToast(savedSite.name + ' added!');
  } catch (err) {
    console.error('Failed to add site:', err);
    alert('Failed to add site. Please try again.');
  }
}

function exportCSV() {
  window.location.href = API_BASE + '/api/export/today';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function saveUrlOnBlur() {
  if (!currentSite) return;
  const newUrl = document.getElementById('siteUrl').value.trim();
  const currentUrl = currentSite.url || '';
  if (newUrl === currentUrl) return;

  try {
    const response = await fetch(API_BASE + '/api/sites/' + currentSite.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: newUrl })
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    currentSite.url = newUrl;
    showToast('URL saved');
  } catch (err) {
    console.error('Failed to save URL:', err);
    showToast('Failed to save URL');
  }
}

async function uncollectSite() {
  if (!currentSite) return;
  const siteName = currentSite.name;
  const existingCollection = collections.find(c => String(c.site_id) === String(currentSite.id));
  if (!existingCollection) { alert('This site is not collected today.'); return; }

  try {
    const response = await fetch(API_BASE + '/api/collections/' + existingCollection.id, { method: 'DELETE' });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'HTTP ' + response.status);
    }
    const index = collections.findIndex(c => c.id === existingCollection.id);
    if (index >= 0) collections.splice(index, 1);

    const siteId = currentSite.id;
    render();
    openCollectModal(siteId);
    showToast(siteName + ' uncollected');
  } catch (err) {
    console.error('Failed to uncollect site:', err);
    alert('Failed to uncollect: ' + err.message);
  }
}

async function toggleHideSite() {
  if (!currentSite) return;
  const siteName = currentSite.name;
  const newActiveState = !currentSite.active;

  try {
    const response = await fetch(API_BASE + '/api/sites/' + currentSite.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: newActiveState })
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'HTTP ' + response.status);
    }

    currentSite.active = newActiveState;
    closeCollectModal();
    render();
    showToast(siteName + (newActiveState ? ' unhidden' : ' hidden'));
  } catch (err) {
    console.error('Failed to update site:', err);
    alert('Failed to update site: ' + err.message);
  }
}

// ========== SITE PURCHASE (in-modal) ==========

async function confirmSitePurchase() {
  if (!currentSite) return;

  const rows = document.querySelectorAll('#purchaseRows .purchase-row');
  let amountPaid = 0, scReceived = 0;
  rows.forEach(row => {
    amountPaid += parseFloat(row.querySelector('.purchase-amount').value) || 0;
    scReceived += parseFloat(row.querySelector('.purchase-sc').value) || 0;
  });

  if (!amountPaid || amountPaid <= 0) { alert('Please enter the amount paid'); return; }
  if (!scReceived || scReceived <= 0) { alert('Please enter the SC received'); return; }

  try {
    const response = await fetch(API_BASE + '/api/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'purchase',
        site_id: currentSite.id,
        site_name: currentSite.name,
        cash_amount: -amountPaid,
        coin_amount: scReceived,
        coin_type: 'SC',
        notes: 'Purchased ' + scReceived.toFixed(2) + ' SC for $' + amountPaid.toFixed(2) + ' ($' + (amountPaid / scReceived).toFixed(2) + '/SC)'
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'HTTP ' + response.status);
    }

    const newBankroll = (currentSite.bankroll || 0) + scReceived;
    const updateResponse = await fetch(API_BASE + '/api/sites/' + currentSite.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankroll: newBankroll })
    });

    if (updateResponse.ok) {
      currentSite.bankroll = newBankroll;
      document.getElementById('modalBalance').textContent = '$' + newBankroll.toFixed(2);
    }

    // Reset all rows back to single empty row
    const container = document.getElementById('purchaseRows');
    const firstRow = container.querySelector('.purchase-row');
    firstRow.querySelector('.purchase-amount').value = '';
    firstRow.querySelector('.purchase-sc').value = '';
    while (container.children.length > 1) container.lastChild.remove();
    document.getElementById('purchaseRatioDisplay').style.display = 'none';
    loadTransactionHistory(currentSite.id);

    render();
    showToast('Purchased ' + scReceived + ' SC on ' + currentSite.name + ' for $' + amountPaid.toFixed(2));
  } catch (err) {
    console.error('Failed to record purchase:', err);
    alert('Failed to record purchase: ' + err.message);
  }
}

// ========== SESSIONS & REDEMPTIONS ==========

function updateSessionPnl() {
  const start = parseFloat(document.getElementById('sessionStart').value) || 0;
  const end = parseFloat(document.getElementById('sessionEnd').value);
  const pnlEl = document.getElementById('sessionPnl');

  if (isNaN(end) || document.getElementById('sessionEnd').value === '') {
    pnlEl.textContent = '--';
    pnlEl.className = 'session-pnl';
    return;
  }

  const delta = end - start;
  const sign = delta >= 0 ? '+' : '';
  pnlEl.textContent = sign + delta.toFixed(2) + ' SC';
  pnlEl.className = 'session-pnl ' + (delta >= 0 ? 'positive' : 'negative');
}

function updateSessionCalc() {
  const spins = parseInt(document.getElementById('sessionSpins').value) || 0;
  const bet = parseFloat(document.getElementById('sessionBet').value) || 0;
  const playthroughEl = document.getElementById('sessionPlaythrough');

  if (spins > 0 && bet > 0 && !playthroughEl.dataset.manual) {
    playthroughEl.value = (spins * bet).toFixed(2);
  }

  const start = parseFloat(document.getElementById('sessionStart').value) || 0;
  const end = parseFloat(document.getElementById('sessionEnd').value);
  const wagered = parseFloat(playthroughEl.value) || 0;
  const rtpDisplay = document.getElementById('sessionRtpDisplay');
  const rtpValue = document.getElementById('sessionRtpValue');

  if (!isNaN(end) && wagered > 0) {
    const delta = end - start;
    const totalReturned = wagered + delta;
    const rtp = (totalReturned / wagered) * 100;
    rtpValue.textContent = rtp.toFixed(2) + '%';
    rtpValue.className = 'session-rtp-value ' + (rtp >= 100 ? 'positive' : 'negative');
    rtpDisplay.style.display = 'flex';
  } else {
    rtpDisplay.style.display = 'none';
  }

  updateSessionPnl();
}

async function loadRealizedRtp(siteId, siteName) {
  const container = document.getElementById('realizedRtp');
  const list = document.getElementById('realizedRtpList');

  try {
    const response = await fetch(API_BASE + '/api/game-stats');
    if (!response.ok) { container.style.display = 'none'; return false; }
    const allStats = await response.json();

    const siteStats = allStats.filter(s => s.site === siteName);
    if (siteStats.length === 0) { container.style.display = 'none'; return false; }

    container.style.display = 'block';
    while (list.firstChild) list.removeChild(list.firstChild);

    siteStats.forEach(g => {
      const item = document.createElement('div');
      item.className = 'realized-rtp-item';

      const nameCol = document.createElement('div');
      nameCol.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;';

      const name = document.createElement('span');
      name.className = 'realized-rtp-game';
      name.textContent = g.game;
      nameCol.appendChild(name);

      const detail = document.createElement('span');
      detail.className = 'realized-rtp-detail';
      const spinsStr = g.total_spins ? g.total_spins.toLocaleString() + ' spins' : '';
      const wageredStr = g.total_wagered ? g.total_wagered.toFixed(2) + ' SC wagered' : '';
      detail.textContent = [spinsStr, wageredStr].filter(Boolean).join(' \u00B7 ');
      nameCol.appendChild(detail);

      const stats = document.createElement('span');
      stats.className = 'realized-rtp-stats';

      const rtpPill = document.createElement('span');
      rtpPill.className = 'pill-realized ' + (g.realized_rtp >= 100 ? 'positive' : 'negative');
      rtpPill.textContent = g.realized_rtp.toFixed(2) + '%';
      stats.appendChild(rtpPill);

      if (g.rtp_delta !== null && g.advertised_rtp) {
        const deltaPill = document.createElement('span');
        const sign = g.rtp_delta >= 0 ? '+' : '';
        deltaPill.className = 'pill-delta ' + (g.rtp_delta >= 0 ? 'positive' : 'negative');
        deltaPill.textContent = sign + g.rtp_delta.toFixed(1) + '% vs ' + g.advertised_rtp + '%';
        stats.appendChild(deltaPill);
      }

      const sessPill = document.createElement('span');
      sessPill.className = 'pill-sessions';
      sessPill.textContent = g.session_count + ' session' + (g.session_count !== 1 ? 's' : '');
      stats.appendChild(sessPill);

      item.appendChild(nameCol);
      item.appendChild(stats);
      list.appendChild(item);
    });

    return true;
  } catch (err) {
    console.error('Failed to load realized RTP:', err);
    container.style.display = 'none';
    return false;
  }
}

async function recordSession() {
  if (!currentSite) return;

  const startingSC = parseFloat(document.getElementById('sessionStart').value);
  const endingSC = parseFloat(document.getElementById('sessionEnd').value);
  const spins = parseInt(document.getElementById('sessionSpins').value) || 0;
  const betSize = parseFloat(document.getElementById('sessionBet').value) || 0;
  const playthrough = parseFloat(document.getElementById('sessionPlaythrough').value) || 0;
  const gameSelect = document.getElementById('sessionGame');
  const gameName = gameSelect.value === '__other__' ? prompt('Game name:') : gameSelect.value;
  const selectedOption = gameSelect.selectedOptions[0];
  const advertisedRtp = selectedOption?.dataset?.rtp ? parseFloat(selectedOption.dataset.rtp) : null;
  const provider = selectedOption?.dataset?.provider || null;

  if (isNaN(endingSC)) { alert('Please enter ending SC balance'); return; }

  const delta = endingSC - (startingSC || 0);
  const totalWagered = playthrough || (spins * betSize) || 0;
  const totalReturned = totalWagered > 0 ? totalWagered + delta : 0;
  const realizedRtp = totalWagered > 0 ? (totalReturned / totalWagered) * 100 : null;

  const meta = { starting_sc: startingSC || 0, ending_sc: endingSC, playthrough: totalWagered };
  if (gameName) meta.game = gameName;
  if (provider) meta.provider = provider;
  if (advertisedRtp) meta.advertised_rtp = advertisedRtp;
  if (realizedRtp !== null) meta.realized_rtp = Math.round(realizedRtp * 100) / 100;
  if (spins > 0) meta.spins = spins;
  if (betSize > 0) meta.bet_size = betSize;
  if (totalWagered > 0) meta.total_wagered = Math.round(totalWagered * 100) / 100;
  if (totalReturned > 0) meta.total_returned = Math.round(totalReturned * 100) / 100;

  const gameNote = gameName ? ' [' + gameName + ']' : '';
  const rtpNote = realizedRtp !== null ? ' (RTP: ' + realizedRtp.toFixed(2) + '%)' : '';

  try {
    const response = await fetch(API_BASE + '/api/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'session',
        site_id: currentSite.id,
        site_name: currentSite.name,
        coin_amount: delta,
        coin_type: 'SC',
        meta,
        notes: 'Session' + gameNote + ': ' + (startingSC || 0).toFixed(2) + ' \u2192 ' + endingSC.toFixed(2) + ' SC (wagered ' + totalWagered.toFixed(2) + ')' + rtpNote
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'HTTP ' + response.status);
    }

    const updateResponse = await fetch(API_BASE + '/api/sites/' + currentSite.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankroll: endingSC })
    });

    if (updateResponse.ok) {
      currentSite.bankroll = endingSC;
      document.getElementById('modalBalance').textContent = '$' + endingSC.toFixed(2);
      document.getElementById('sessionStart').value = endingSC;
    }

    document.getElementById('sessionEnd').value = '';
    document.getElementById('sessionSpins').value = '';
    document.getElementById('sessionBet').value = '';
    document.getElementById('sessionPlaythrough').value = '';
    delete document.getElementById('sessionPlaythrough').dataset.manual;
    document.getElementById('sessionPnl').textContent = '--';
    document.getElementById('sessionPnl').className = 'session-pnl';
    document.getElementById('sessionRtpDisplay').style.display = 'none';
    document.getElementById('sessionGame').value = '';

    loadRealizedRtp(currentSite.id, currentSite.name);

    render();
    const sign = delta >= 0 ? '+' : '';
    const rtpStr = realizedRtp !== null ? ' | RTP: ' + realizedRtp.toFixed(2) + '%' : '';
    showToast('Session logged: ' + sign + delta.toFixed(2) + ' SC on ' + currentSite.name + rtpStr);
  } catch (err) {
    console.error('Failed to record session:', err);
    alert('Failed to record session: ' + err.message);
  }
}

async function requestRedemption() {
  if (!currentSite) return;
  const amount = parseFloat(document.getElementById('redeemAmount').value);
  const dest = document.getElementById('redeemDest').value.trim();
  if (!amount || amount <= 0) { alert('Please enter a withdrawal amount'); return; }

  try {
    const response = await fetch(API_BASE + '/api/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'redemption_requested',
        site_id: currentSite.id,
        site_name: currentSite.name,
        cash_amount: amount,
        coin_type: 'SC',
        status: 'pending',
        meta: { redemption_method: dest || 'Unknown' },
        notes: 'Withdrawal $' + amount.toFixed(2) + (dest ? ' \u2192 ' + dest : '')
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'HTTP ' + response.status);
    }

    const newBankroll = (currentSite.bankroll || 0) - amount;
    const updateResponse = await fetch(API_BASE + '/api/sites/' + currentSite.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankroll: newBankroll })
    });

    if (updateResponse.ok) {
      currentSite.bankroll = newBankroll;
      document.getElementById('modalBalance').textContent = '$' + newBankroll.toFixed(2);
    }

    document.getElementById('redeemAmount').value = '';
    document.getElementById('redeemDest').value = '';
    loadPendingRedemptions(currentSite.id);
    loadTransactionHistory(currentSite.id);

    render();
    showToast('Withdrawal of $' + amount.toFixed(2) + ' requested from ' + currentSite.name);
  } catch (err) {
    console.error('Failed to request redemption:', err);
    alert('Failed to request redemption: ' + err.message);
  }
}

async function loadPendingRedemptions(siteId) {
  const container = document.getElementById('pendingRedemptions');
  container.textContent = '';

  try {
    const response = await fetch(API_BASE + '/api/ledger?types=redemption_requested&site=' + siteId + '&status=pending');
    if (!response.ok) return;
    const events = await response.json();
    if (!events.length) return;

    const label = document.createElement('div');
    label.className = 'pending-label';
    label.textContent = 'Pending Withdrawals';
    container.appendChild(label);

    events.forEach(ev => {
      const meta = typeof ev.meta === 'string' ? JSON.parse(ev.meta) : (ev.meta || {});
      const date = new Date(ev.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      const item = document.createElement('div');
      item.className = 'pending-item';

      const dateSpan = document.createElement('span');
      dateSpan.className = 'pending-date';
      dateSpan.textContent = date;

      const amountSpan = document.createElement('span');
      amountSpan.className = 'pending-amount';
      amountSpan.textContent = '$' + (ev.cash_amount || 0).toFixed(2);

      const destSpan = document.createElement('span');
      destSpan.className = 'pending-dest';
      destSpan.textContent = meta.redemption_method || '';

      const btn = document.createElement('button');
      btn.className = 'btn btn-success';
      btn.textContent = 'Received';
      btn.addEventListener('click', () => markRedemptionReceived(ev.id, ev.cash_amount || 0, ev.site_name || ''));

      item.append(dateSpan, amountSpan, destSpan, btn);
      container.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load pending redemptions:', err);
  }
}

async function markRedemptionReceived(eventId, cashAmount, siteName) {
  try {
    const patchResponse = await fetch(API_BASE + '/api/ledger/' + eventId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'received' })
    });
    if (!patchResponse.ok) {
      const errorData = await patchResponse.json().catch(() => ({}));
      throw new Error(errorData.error || 'HTTP ' + patchResponse.status);
    }

    await fetch(API_BASE + '/api/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'redemption_received',
        site_name: siteName,
        cash_amount: cashAmount,
        coin_type: 'SC',
        status: 'received',
        linked_event_id: eventId,
        notes: 'Received $' + cashAmount.toFixed(2) + ' withdrawal from ' + siteName
      })
    });

    if (currentSite) {
      loadPendingRedemptions(currentSite.id);
      loadTransactionHistory(currentSite.id);
    }

    showToast('$' + cashAmount.toFixed(2) + ' withdrawal from ' + siteName + ' marked received');
  } catch (err) {
    console.error('Failed to mark redemption received:', err);
    alert('Failed to update: ' + err.message);
  }
}

// ========== AUTOMATION ==========

let currentPrioritySites = [];
let automationEventSource = null;
let automationState = { sites: [], stats: null, running: false, complete: false };

function openAutomationModal() {
  const modal = document.getElementById('automationModal');
  modal.classList.add('active');
  resetAutomationUI();
  populatePreview();
  checkAutomationStatus();
}

function populatePreview() {
  const preview = document.getElementById('automationPreview');
  const grid = document.getElementById('previewSiteGrid');
  const count = document.getElementById('previewCount');
  grid.textContent = '';

  if (currentPrioritySites.length === 0) {
    preview.style.display = 'none';
    return;
  }

  count.textContent = currentPrioritySites.length;

  for (const site of currentPrioritySites) {
    const sc = site.typical_sc ? site.typical_sc + ' SC' : '';
    const gc = site.typical_gc ? Number(site.typical_gc).toLocaleString() + ' GC' : '';
    const reward = [sc, gc].filter(Boolean).join(' + ') || 'scrape only';

    const card = document.createElement('div');
    card.className = 'automation-site-card status-pending';
    card.dataset.siteId = site.id;

    const nameEl = document.createElement('div');
    nameEl.className = 'site-name';
    nameEl.title = site.name;
    nameEl.textContent = site.name;

    const statusEl = document.createElement('div');
    statusEl.className = 'site-status';
    statusEl.style.opacity = '0.6';
    statusEl.textContent = reward;

    card.appendChild(nameEl);
    card.appendChild(statusEl);
    grid.appendChild(card);
  }

  preview.style.display = 'block';
}

function resetAutomationUI() {
  automationState = { sites: [], stats: null, running: false, complete: false };

  document.getElementById('automationControls').style.display = 'block';
  document.getElementById('automationProgress').style.display = 'none';
  document.getElementById('automationSpinner').style.display = 'none';
  document.getElementById('automationTitle').textContent = 'Collection Run';
  document.getElementById('automationOutput').textContent = '';
  document.getElementById('automationSiteGrid').textContent = '';
  document.getElementById('automationFailures').style.display = 'none';
  document.getElementById('automationComplete').style.display = 'none';
  document.getElementById('automationStatusBanner').className = 'automation-status-banner';
  document.getElementById('automationCurrentSite').textContent = 'Initializing...';
  updateAutomationStats({ collected: 0, cooldown: 0, failed: 0 });
}

function closeAutomationModal() {
  document.getElementById('automationModal').classList.remove('active');
  if (automationEventSource) {
    automationEventSource.close();
    automationEventSource = null;
  }
}

async function checkAutomationStatus() {
  try {
    const response = await fetch(API_BASE + '/api/automation/status');
    const status = await response.json();
    if (status.running || (status.sites && status.sites.length > 0)) {
      showAutomationProgress(status);
      if (status.running) subscribeToUpdates();
    }
  } catch (err) {
    console.error('Failed to check automation status:', err);
  }
}

async function startAutomation(dryRun) {
  try {
    const params = new URLSearchParams();
    if (dryRun) params.set('dryRun', 'true');
    const url = API_BASE + '/api/automation/collect-all?' + params.toString();
    const response = await fetch(url, { method: 'POST' });
    const result = await response.json();

    if (!response.ok) {
      if (response.status === 409) {
        showToast('Automation already running');
        showAutomationProgress({ running: true, sites: [] });
        subscribeToUpdates();
      } else {
        alert(result.error || 'Failed to start automation');
      }
      return;
    }

    showAutomationProgress({ running: true, sites: [] });
    document.getElementById('automationTitle').textContent = 'Collection Run';
    document.getElementById('automationCurrentSite').textContent = dryRun
      ? 'Starting dry run...'
      : 'Starting collection...';

    subscribeToUpdates();
  } catch (err) {
    console.error('Failed to start automation:', err);
    alert('Failed to start automation: ' + err.message);
  }
}

async function stopAutomation() {
  const btn = document.getElementById('stopAutomation');
  btn.disabled = true;
  btn.textContent = 'Stopping...';

  try {
    const response = await fetch(API_BASE + '/api/automation/stop', { method: 'POST' });
    const result = await response.json();

    if (response.ok) {
      document.getElementById('automationSpinner').style.display = 'none';
      btn.style.display = 'none';
      document.getElementById('automationTitle').textContent = 'Collection Stopped';
      document.getElementById('automationCurrentSite').textContent = 'Stopped by user';
      document.getElementById('automationStatusBanner').className = 'automation-status-banner failed';

      if (automationEventSource) {
        automationEventSource.close();
        automationEventSource = null;
      }
      loadData().then(render);
    } else {
      showToast(result.error || 'Failed to stop');
    }
  } catch (err) {
    console.error('Failed to stop automation:', err);
    showToast('Failed to stop: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '\u25A0 Stop';
  }
}

function showAutomationProgress(status) {
  document.getElementById('automationControls').style.display = 'none';
  document.getElementById('automationProgress').style.display = 'block';
  document.getElementById('automationSpinner').style.display = status.running ? 'inline-block' : 'none';
  document.getElementById('stopAutomation').style.display = status.running ? 'inline-block' : 'none';
  document.getElementById('automationTitle').textContent = status.running
    ? 'Collection in Progress...'
    : 'Collection Complete';

  const banner = document.getElementById('automationStatusBanner');
  banner.className = 'automation-status-banner ' + (status.running ? 'running' : 'complete');

  if (status.sites && status.sites.length > 0) {
    automationState.sites = status.sites;
    renderAutomationSiteGrid(status.sites);
  }

  if (status.stats) {
    automationState.stats = status.stats;
    updateAutomationStats(status.stats);
  }
}

function renderAutomationSiteGrid(sitesArr) {
  const grid = document.getElementById('automationSiteGrid');
  grid.textContent = '';

  for (const site of sitesArr) {
    const card = document.createElement('div');
    card.className = 'automation-site-card status-' + site.status;
    card.dataset.siteId = site.id;

    const nameEl = document.createElement('div');
    nameEl.className = 'site-name';
    nameEl.title = site.name;
    nameEl.textContent = site.name;

    const statusEl = document.createElement('div');
    statusEl.className = 'site-status';
    statusEl.textContent = getStatusIcon(site.status) + ' ' + getStatusText(site);

    card.appendChild(nameEl);
    card.appendChild(statusEl);
    grid.appendChild(card);
  }
}

function getStatusIcon(status) {
  switch (status) {
    case 'pending': return '\u25CB';
    case 'running': return '\u25C9';
    case 'success': return '\u2713';
    case 'cooldown': return '\u23F8';
    case 'failed': return '\u2717';
    default: return '?';
  }
}

function getStatusText(site) {
  switch (site.status) {
    case 'pending': return 'Pending';
    case 'running': return 'Collecting...';
    case 'success':
      const sc = site.sc || 0;
      if (sc > 0) return '+' + sc + ' SC';
      return 'Collected';
    case 'cooldown':
      return site.cooldownRemaining || 'Cooldown';
    case 'failed':
      return site.errorCode || 'Failed';
    default: return '';
  }
}

function updateAutomationStats(stats) {
  document.getElementById('statCollected').textContent = stats.collected || 0;
  document.getElementById('statCooldown').textContent = stats.cooldown || 0;
  document.getElementById('statFailed').textContent = stats.failed || 0;
  document.getElementById('statSC').textContent = (stats.totalSC || 0).toFixed(2);
}

function renderFailures(sitesArr) {
  const failures = sitesArr.filter(s => s.status === 'failed');
  const failuresPanel = document.getElementById('automationFailures');
  const failuresList = document.getElementById('failuresList');

  if (failures.length === 0) {
    failuresPanel.style.display = 'none';
    return;
  }

  failuresPanel.style.display = 'block';
  failuresList.textContent = '';
  failures.forEach(f => {
    const item = document.createElement('div');
    item.className = 'failure-item';

    const site = document.createElement('span');
    site.className = 'failure-site';
    site.textContent = f.name;

    const code = document.createElement('span');
    code.className = 'failure-code';
    code.textContent = f.errorCode || 'UNKNOWN';

    const error = document.createElement('span');
    error.className = 'failure-error';
    error.textContent = f.error || 'No details';

    item.append(site, code, error);
    failuresList.appendChild(item);
  });
}

function showCompletion(isSuccess, stats) {
  const completeEl = document.getElementById('automationComplete');
  const banner = document.getElementById('automationStatusBanner');

  completeEl.style.display = 'flex';
  completeEl.className = 'automation-complete ' + (isSuccess ? 'success' : 'failed');

  document.getElementById('completeIcon').textContent = isSuccess ? '\u2713' : '\u2717';

  if (isSuccess) {
    document.getElementById('completeText').textContent = 'Done!';
    banner.className = 'automation-status-banner complete';
    document.getElementById('automationCurrentSite').textContent =
      'Collected ' + (stats?.collected || 0) + ' sites, +' + (stats?.totalSC || 0).toFixed(2) + ' SC';
  } else {
    const failCount = stats?.failed || 0;
    document.getElementById('completeText').textContent = 'Completed with ' + failCount + ' failure' + (failCount !== 1 ? 's' : '');
    banner.className = 'automation-status-banner failed';
    document.getElementById('automationCurrentSite').textContent =
      failCount + ' site' + (failCount !== 1 ? 's' : '') + ' need attention';
  }
}

function copyFailuresForClaude() {
  const failures = automationState.sites.filter(s => s.status === 'failed');
  if (failures.length === 0) { showToast('No failures to copy'); return; }

  const text = 'Collector failures from ' + new Date().toLocaleString() + ':\n\n' +
    failures.map(f => '- ' + f.name + ' (' + f.id + '): [' + (f.errorCode || 'UNKNOWN') + '] ' + (f.error || 'No details')).join('\n');

  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard!');
  }).catch(() => {
    alert('Copy this:\n\n' + text);
  });
}

function subscribeToUpdates() {
  if (automationEventSource) automationEventSource.close();

  automationEventSource = new EventSource(API_BASE + '/api/automation/stream');

  automationEventSource.onmessage = function(event) {
    const data = JSON.parse(event.data);

    if (data.type === 'output' && data.lines && data.lines.length > 0) {
      const outputEl = document.getElementById('automationOutput');
      outputEl.textContent += data.lines.join('\n') + '\n';
      outputEl.scrollTop = outputEl.scrollHeight;
    }

    if (data.type === 'sites' || data.type === 'status') {
      if (data.sites && data.sites.length > 0) {
        automationState.sites = data.sites;
        renderAutomationSiteGrid(data.sites);
        renderFailures(data.sites);

        const running = data.sites.find(s => s.status === 'running');
        if (running) {
          document.getElementById('automationCurrentSite').textContent = 'Collecting: ' + running.name;
        }
      }

      if (data.stats) {
        automationState.stats = data.stats;
        updateAutomationStats(data.stats);
      }

      document.getElementById('automationSpinner').style.display = data.running ? 'inline-block' : 'none';
    }

    if (data.type === 'complete') {
      if (data.sites) {
        automationState.sites = data.sites;
        renderAutomationSiteGrid(data.sites);
        renderFailures(data.sites);
      }

      automationEventSource.close();
      automationEventSource = null;

      document.getElementById('automationSpinner').style.display = 'none';
      document.getElementById('stopAutomation').style.display = 'none';
      document.getElementById('automationTitle').textContent = 'Collection Complete';

      const stats = data.stats || { collected: 0, failed: 0, totalSC: 0 };
      updateAutomationStats(stats);
      const isSuccess = (stats.failed || 0) === 0;
      showCompletion(isSuccess, stats);

      automationState.complete = true;
      loadData().then(render);
      loadLastRuns();
    }
  };

  automationEventSource.onerror = function() {
    document.getElementById('automationSpinner').style.display = 'none';
    document.getElementById('automationCurrentSite').textContent = 'Connection lost. Check status manually.';
    document.getElementById('automationStatusBanner').className = 'automation-status-banner failed';
    automationEventSource.close();
    automationEventSource = null;
  };
}

// ========== START DEBUG CHROME ==========

async function startDebugChrome() {
  const btn = document.getElementById('startChromeBtn');
  btn.disabled = true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70000);
    const response = await fetch(API_BASE + '/api/automation/start-chrome', {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const result = await response.json();

    if (result.success) {
      showToast(result.alreadyRunning ? 'Chrome already running' : 'Chrome started');
    } else {
      showToast('Failed: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      showToast('Chrome launch timed out');
    } else {
      console.error('Failed to start Chrome:', err);
      showToast('Failed to start Chrome: ' + err.message);
    }
  } finally {
    btn.disabled = false;
    ChromeStatus.check();
  }
}

// ========== CHROME STATUS POLLING ==========

const ChromeStatus = {
  _interval: null,

  async check() {
    try {
      const res = await fetch(API_BASE + '/api/automation/chrome-status');
      const data = await res.json();
      const dot = document.getElementById('chromeDot');
      if (dot) dot.className = 'chrome-dot ' + (data.running ? 'online' : 'offline');
    } catch {
      const dot = document.getElementById('chromeDot');
      if (dot) dot.className = 'chrome-dot offline';
    }
  },

  start() {
    this.check();
    this._interval = setInterval(() => this.check(), 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearInterval(this._interval);
        this._interval = null;
      } else {
        this.check();
        this._interval = setInterval(() => this.check(), 30000);
      }
    });
  },
};

// ========== WELCOME WIZARD ==========

const STARTER_SITE_META = {
  'spinblitz':    { icon: '\uD83C\uDFB0', sc: 'Up to 1.85 SC/day',  desc: 'High ceiling \u2014 best days push nearly 2 SC' },
  'spinquest':    { icon: '\uD83D\uDD0D', sc: '1 SC/day',            desc: 'Flat daily reward, dead simple to collect' },
  'stake':        { icon: '\uD83C\uDFB2', sc: '1 SC/day',            desc: '3x wagering required before redemption' },
  'stake-us':     { icon: '\uD83C\uDFB2', sc: '1 SC/day',            desc: '3x wagering required before redemption' },
  'luckyland':    { icon: '\uD83C\uDF40', sc: 'Up to 1 SC/day',      desc: 'Streak bonus: hits 1 SC at day 7' },
  'chumba':       { icon: '\uD83D\uDC8E', sc: 'Up to 3 SC/day',      desc: 'Streak escalates \u2014 3 SC once you hit day 7' },
  'mcluck':       { icon: '\uD83C\uDFC6', sc: '~0.2 SC/day',         desc: 'Lower daily but reputable + strong welcome bonus' },
  'crown-coins':  { icon: '\uD83D\uDC51', sc: '1.5 SC on day 7',     desc: 'Weekly streak \u2014 patience pays, literally' },
};

let wizardSelectedSites = new Set();
let wizardCurrentStep = 1;
const WIZARD_TOTAL_STEPS = 4;

function initWelcomeWizard() {
  if (!localStorage.getItem('hasCompletedSetup')) openWelcomeWizard();

  document.getElementById('closeWizardBtn').addEventListener('click', skipWizard);
  document.getElementById('wizardSkipLink').addEventListener('click', (e) => { e.preventDefault(); skipWizard(); });
  document.getElementById('wizardNext1').addEventListener('click', () => goToWizardStep(2));
  document.getElementById('wizardBack2').addEventListener('click', () => goToWizardStep(1));
  document.getElementById('wizardNext2').addEventListener('click', () => goToWizardStep(3));
  document.getElementById('wizardBack3').addEventListener('click', () => goToWizardStep(2));
  document.getElementById('wizardNext3').addEventListener('click', () => goToWizardStep(4));
  document.getElementById('wizardBack4').addEventListener('click', () => goToWizardStep(3));
  document.getElementById('wizardDone').addEventListener('click', finishWizard);

  const modal = document.getElementById('welcomeWizardModal');
  modal.addEventListener('click', (e) => { if (e.target === modal) skipWizard(); });
}

function openWelcomeWizard() {
  document.getElementById('welcomeWizardModal').classList.add('active');
  goToWizardStep(1);
  populateWizardSiteGrid();
}

function closeWelcomeWizard() {
  document.getElementById('welcomeWizardModal').classList.remove('active');
}

function skipWizard() {
  localStorage.setItem('hasCompletedSetup', 'true');
  closeWelcomeWizard();
}

function goToWizardStep(step) {
  wizardCurrentStep = step;
  for (let i = 1; i <= WIZARD_TOTAL_STEPS; i++) {
    const el = document.getElementById('wizardStep' + i);
    if (el) el.classList.toggle('active', i === step);
  }
  const fill = document.getElementById('wizardProgressFill');
  if (fill) fill.style.width = ((step / WIZARD_TOTAL_STEPS) * 100) + '%';
  const label = document.getElementById('wizardStepLabel');
  if (label) label.textContent = 'Step ' + step + ' of ' + WIZARD_TOTAL_STEPS;
}

function populateWizardSiteGrid() {
  const grid = document.getElementById('wizardSiteGrid');
  if (!grid) return;

  const starterSites = sites.filter(s => s.is_starter);
  if (starterSites.length === 0) {
    grid.textContent = '';
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--text-muted);font-size:13px;';
    p.textContent = 'Loading sites...';
    grid.appendChild(p);
    return;
  }

  grid.textContent = '';
  starterSites.forEach(site => {
    const meta = STARTER_SITE_META[site.id] || { icon: '\uD83D\uDCB0', sc: site.typical_sc + ' SC/day', desc: 'Daily free SC' };
    const isSelected = wizardSelectedSites.has(site.id);

    const card = document.createElement('div');
    card.className = 'wizard-site-card' + (isSelected ? ' selected' : '');
    card.dataset.siteId = site.id;

    const top = document.createElement('div');
    top.className = 'wizard-site-card-top';

    const check = document.createElement('div');
    check.className = 'wizard-site-check';
    check.textContent = isSelected ? '\u2713' : '';

    const icon = document.createElement('div');
    icon.className = 'wizard-site-icon';
    icon.textContent = meta.icon;

    const name = document.createElement('div');
    name.className = 'wizard-site-name';
    name.textContent = site.name;

    top.append(check, icon, name);

    const sc = document.createElement('div');
    sc.className = 'wizard-site-sc';
    sc.textContent = meta.sc;

    const desc = document.createElement('div');
    desc.className = 'wizard-site-desc';
    desc.textContent = meta.desc;

    card.append(top, sc, desc);

    if (site.url) {
      const join = document.createElement('a');
      join.className = 'wizard-site-join';
      join.href = site.url;
      join.target = '_blank';
      join.rel = 'noopener';
      join.textContent = 'Join \u2192';
      join.addEventListener('click', (e) => e.stopPropagation());
      card.appendChild(join);
    }

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('wizard-site-join')) return;
      const id = card.dataset.siteId;
      if (wizardSelectedSites.has(id)) {
        wizardSelectedSites.delete(id);
        card.classList.remove('selected');
        card.querySelector('.wizard-site-check').textContent = '';
      } else {
        wizardSelectedSites.add(id);
        card.classList.add('selected');
        card.querySelector('.wizard-site-check').textContent = '\u2713';
      }
    });

    grid.appendChild(card);
  });
}

async function finishWizard() {
  localStorage.setItem('hasCompletedSetup', 'true');

  const promises = [...wizardSelectedSites].map(siteId =>
    fetch(API_BASE + '/api/sites/' + encodeURIComponent(siteId) + '/account-status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'registered' })
    }).catch(err => console.warn('Failed to mark site registered:', siteId, err))
  );

  await Promise.all(promises);

  try {
    const res = await fetch(API_BASE + '/api/sites');
    sites = await res.json();
  } catch (err) {
    console.warn('Failed to reload sites after wizard:', err);
  }

  closeWelcomeWizard();
  render();
  hideDismissOnboarding();
}

// ========== EMPTY STATE BANNER ==========

async function initOnboardingBanner() {
  try {
    const res = await fetch(API_BASE + '/api/collections/count');
    const { count } = await res.json();
    if (count === 0) showOnboardingBanner();
  } catch (err) {
    // Non-critical
  }
}

function showOnboardingBanner() {
  const container = document.querySelector('.container');
  const heroBar = container.querySelector('.hero-bar');
  if (!heroBar) return;

  const banner = document.createElement('div');
  banner.className = 'onboarding-banner';
  banner.id = 'onboardingBanner';

  const iconDiv = document.createElement('div');
  iconDiv.className = 'onboarding-banner-icon';
  iconDiv.textContent = '\uD83D\uDC4B';

  const textDiv = document.createElement('div');
  textDiv.className = 'onboarding-banner-text';
  const strong = document.createElement('strong');
  strong.textContent = 'New to Sweepsites?';
  const p = document.createElement('p');
  p.textContent = 'Visit each site on your list, claim your free daily coins, then come back and click the site card to record it. Start with the starred sites \u2014 they earn the most.';
  textDiv.append(strong, p);

  banner.append(iconDiv, textDiv);
  heroBar.insertAdjacentElement('afterend', banner);
}

function hideDismissOnboarding() {
  const banner = document.getElementById('onboardingBanner');
  if (banner) banner.remove();
}

// ========== ACCOUNT SETUP SECTION ==========

function renderAccountSetupSection(site) {
  const isRegistered = site.account_status === 'registered' || site.account_status === 'kyc_done';
  const isKycDone = site.account_status === 'kyc_done';
  const bonusClaimed = !!site.welcome_bonus_claimed;
  const expanded = !site.account_status;

  // Using textContent-safe approach — the only dynamic content is the site ID (validated by the server)
  return '<div class="account-setup-section ' + (expanded ? 'expanded' : '') + '" id="accountSetupSection" data-site-id="' + escapeHtml(site.id) + '">' +
    '<div class="account-setup-header" id="accountSetupToggle">' +
      '<span>Account Setup</span>' +
      '<span class="account-setup-toggle">\u25BC</span>' +
    '</div>' +
    '<div class="account-setup-body">' +
      '<div class="setup-checkbox-row ' + (isRegistered ? 'checked' : '') + '" id="setupRowRegistered">' +
        '<input type="checkbox" id="setupCheckRegistered" ' + (isRegistered ? 'checked' : '') + '>' +
        '<label class="setup-checkbox-label" for="setupCheckRegistered">Account created</label>' +
      '</div>' +
      '<div class="setup-checkbox-row ' + (isKycDone ? 'checked' : '') + '" id="setupRowKyc">' +
        '<input type="checkbox" id="setupCheckKyc" ' + (isKycDone ? 'checked' : '') + '>' +
        '<label class="setup-checkbox-label" for="setupCheckKyc">Identity verified (KYC)</label>' +
      '</div>' +
      '<div class="setup-checkbox-row ' + (bonusClaimed ? 'checked' : '') + '" id="setupRowBonus">' +
        '<input type="checkbox" id="setupCheckBonus" ' + (bonusClaimed ? 'checked' : '') + '>' +
        '<label class="setup-checkbox-label" for="setupCheckBonus">Welcome bonus claimed</label>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function wireAccountSetupSection(site) {
  const section = document.getElementById('accountSetupSection');
  if (!section) return;

  document.getElementById('accountSetupToggle').addEventListener('click', () => {
    section.classList.toggle('expanded');
  });

  const checkRegistered = document.getElementById('setupCheckRegistered');
  const checkKyc = document.getElementById('setupCheckKyc');
  const checkBonus = document.getElementById('setupCheckBonus');

  checkRegistered.addEventListener('change', async () => {
    const newStatus = checkRegistered.checked ? 'registered' : null;
    if (!checkRegistered.checked && checkKyc.checked) {
      checkKyc.checked = false;
      document.getElementById('setupRowKyc').classList.remove('checked');
    }
    document.getElementById('setupRowRegistered').classList.toggle('checked', checkRegistered.checked);
    await updateAccountStatus(site.id, newStatus);
    const s = sites.find(x => String(x.id) === String(site.id));
    if (s) s.account_status = newStatus;
    render();
  });

  checkKyc.addEventListener('change', async () => {
    const newStatus = checkKyc.checked ? 'kyc_done' : (checkRegistered.checked ? 'registered' : null);
    if (checkKyc.checked && !checkRegistered.checked) {
      checkRegistered.checked = true;
      document.getElementById('setupRowRegistered').classList.add('checked');
    }
    document.getElementById('setupRowKyc').classList.toggle('checked', checkKyc.checked);
    await updateAccountStatus(site.id, newStatus);
    const s = sites.find(x => String(x.id) === String(site.id));
    if (s) s.account_status = newStatus;
    render();
  });

  checkBonus.addEventListener('change', async () => {
    document.getElementById('setupRowBonus').classList.toggle('checked', checkBonus.checked);
    await updateWelcomeBonus(site.id, checkBonus.checked);
    const s = sites.find(x => String(x.id) === String(site.id));
    if (s) s.welcome_bonus_claimed = checkBonus.checked;
    render();
  });
}

async function updateAccountStatus(siteId, status) {
  try {
    await fetch(API_BASE + '/api/sites/' + encodeURIComponent(siteId) + '/account-status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
  } catch (err) {
    console.error('Failed to update account status:', err);
  }
}

async function updateWelcomeBonus(siteId, claimed) {
  try {
    await fetch(API_BASE + '/api/sites/' + encodeURIComponent(siteId) + '/welcome-bonus', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimed })
    });
  } catch (err) {
    console.error('Failed to update welcome bonus:', err);
  }
}
