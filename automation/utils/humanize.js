/**
 * Humanize Utility
 * Makes automation behave more like a real human to avoid bot detection
 */

'use strict';

/**
 * Generate a random number with normal distribution (bell curve)
 * More realistic than uniform random - humans cluster around averages
 */
function gaussianRandom(mean = 0, stdev = 1) {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * stdev + mean;
}

/**
 * Random delay with human-like variance
 * @param {number} baseMs - Base delay in milliseconds
 * @param {number} variance - Variance factor (0.3 = ±30%)
 */
function randomDelay(baseMs, variance = 0.3) {
  const min = baseMs * (1 - variance);
  const max = baseMs * (1 + variance);
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * Sleep with randomized duration
 * @param {Page} page - Playwright page
 * @param {number} baseMs - Base delay
 * @param {number} variance - Variance factor
 */
async function humanDelay(page, baseMs, variance = 0.3) {
  const delay = randomDelay(baseMs, variance);
  await page.waitForTimeout(delay);
  return delay;
}

/**
 * Generate bezier curve points for natural mouse movement
 * Humans don't move in straight lines - they curve and wobble
 */
function bezierCurve(start, end, numPoints = 20) {
  const points = [];

  // Control points for the curve (add some randomness)
  const cp1 = {
    x: start.x + (end.x - start.x) * 0.25 + gaussianRandom(0, 20),
    y: start.y + (end.y - start.y) * 0.1 + gaussianRandom(0, 30)
  };
  const cp2 = {
    x: start.x + (end.x - start.x) * 0.75 + gaussianRandom(0, 20),
    y: start.y + (end.y - start.y) * 0.9 + gaussianRandom(0, 30)
  };

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    points.push({
      x: mt3 * start.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * end.x,
      y: mt3 * start.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * end.y
    });
  }

  return points;
}

/**
 * Move mouse along a natural curved path
 * @param {Page} page - Playwright page
 * @param {number} toX - Target X coordinate
 * @param {number} toY - Target Y coordinate
 * @param {Object} options - Movement options
 */
async function humanMouseMove(page, toX, toY, options = {}) {
  const { steps = 15, wobble = true } = options;

  // Get current mouse position (or start from random edge position)
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const currentPos = await page.evaluate(() => {
    return window.__lastMousePos || { x: Math.random() * 200, y: Math.random() * 200 };
  });

  const start = { x: currentPos.x || 100, y: currentPos.y || 100 };
  const end = { x: toX, y: toY };

  // Generate curved path
  const points = bezierCurve(start, end, steps);

  // Move through each point with slight delays
  for (let i = 0; i < points.length; i++) {
    let { x, y } = points[i];

    // Add tiny wobble for realism (humans aren't perfectly steady)
    if (wobble && i > 0 && i < points.length - 1) {
      x += gaussianRandom(0, 1.5);
      y += gaussianRandom(0, 1.5);
    }

    // Clamp to viewport
    x = Math.max(0, Math.min(viewport.width - 1, x));
    y = Math.max(0, Math.min(viewport.height - 1, y));

    await page.mouse.move(x, y);

    // Variable speed - slower at start and end (like real hand movement)
    const progress = i / points.length;
    const speedFactor = 1 - Math.abs(progress - 0.5) * 0.5; // Faster in middle
    const delay = Math.floor(5 + Math.random() * 10 * speedFactor);
    await page.waitForTimeout(delay);
  }

  // Store final position
  await page.evaluate((pos) => {
    window.__lastMousePos = pos;
  }, { x: toX, y: toY });
}

/**
 * Human-like click with natural mouse movement
 * @param {Page} page - Playwright page
 * @param {number} x - Target X coordinate
 * @param {number} y - Target Y coordinate
 * @param {Object} options - Click options
 */
async function humanClick(page, x, y, options = {}) {
  const {
    moveFirst = true,
    preClickDelay = true,
    postClickDelay = true,
    doubleClick = false
  } = options;

  // Add slight randomness to click position (humans don't hit exact center)
  const jitterX = x + gaussianRandom(0, 3);
  const jitterY = y + gaussianRandom(0, 3);

  // Move to position naturally
  if (moveFirst) {
    await humanMouseMove(page, jitterX, jitterY);
  }

  // Small delay before clicking (human reaction time)
  if (preClickDelay) {
    await page.waitForTimeout(randomDelay(100, 0.5));
  }

  // Click
  if (doubleClick) {
    await page.mouse.dblclick(jitterX, jitterY);
  } else {
    await page.mouse.click(jitterX, jitterY);
  }

  // Small delay after clicking
  if (postClickDelay) {
    await page.waitForTimeout(randomDelay(150, 0.5));
  }
}

/**
 * Click on an element with human-like behavior
 * @param {Page} page - Playwright page
 * @param {ElementHandle|string} elementOrSelector - Element or selector
 * @param {Object} options - Click options
 */
async function humanClickElement(page, elementOrSelector, options = {}) {
  const element = typeof elementOrSelector === 'string'
    ? await page.$(elementOrSelector)
    : elementOrSelector;

  if (!element) {
    throw new Error(`Element not found: ${elementOrSelector}`);
  }

  const box = await element.boundingBox();
  if (!box) {
    throw new Error('Element has no bounding box');
  }

  // Click somewhere within the element, not dead center
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);

  await humanClick(page, x, y, options);
}

/**
 * Type text with human-like timing
 * @param {Page} page - Playwright page
 * @param {string} text - Text to type
 * @param {Object} options - Typing options
 */
async function humanType(page, text, options = {}) {
  const {
    minDelay = 50,
    maxDelay = 150,
    mistakeChance = 0.02, // 2% chance of typo
    selector = null
  } = options;

  if (selector) {
    await page.click(selector);
    await page.waitForTimeout(randomDelay(200, 0.3));
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Occasional typo and correction (very human)
    if (mistakeChance > 0 && Math.random() < mistakeChance && i < text.length - 1) {
      // Type wrong character
      const wrongChar = String.fromCharCode(char.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await page.keyboard.type(wrongChar);
      await page.waitForTimeout(randomDelay(100, 0.3));

      // Backspace
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(randomDelay(80, 0.3));
    }

    // Type the correct character
    await page.keyboard.type(char);

    // Variable delay between keystrokes
    const delay = minDelay + Math.random() * (maxDelay - minDelay);
    // Longer pause after punctuation/spaces
    const extraDelay = [' ', '.', ',', '!', '?'].includes(char) ? randomDelay(100, 0.5) : 0;
    await page.waitForTimeout(delay + extraDelay);
  }
}

/**
 * Scroll page in human-like chunks
 * @param {Page} page - Playwright page
 * @param {number} distance - Approximate distance to scroll (negative = up)
 */
async function humanScroll(page, distance) {
  const steps = Math.ceil(Math.abs(distance) / 100);
  const direction = distance > 0 ? 1 : -1;

  for (let i = 0; i < steps; i++) {
    const scrollAmount = (80 + Math.random() * 40) * direction;
    await page.mouse.wheel(0, scrollAmount);
    await page.waitForTimeout(randomDelay(50, 0.5));
  }

  // Settle delay
  await page.waitForTimeout(randomDelay(200, 0.3));
}

/**
 * Inject anti-detection patches into the page
 * Call this after page load
 * @param {Page} page - Playwright page
 */
async function injectStealthPatches(page) {
  await page.addInitScript(() => {
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true
    });

    // Fake plugins (headless Chrome has none)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' }
        ];
        plugins.length = 3;
        return plugins;
      },
      configurable: true
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true
    });

    // Override visibility API - page always appears visible/focused
    Object.defineProperty(document, 'hidden', {
      get: () => false,
      configurable: true
    });

    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible',
      configurable: true
    });

    // Prevent detection of automation via permissions
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      const permissionsObj = window.navigator.permissions;
      window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery.call(permissionsObj, parameters);
      };
    }

    // Chrome-specific properties that headless lacks
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };

    // Override toString to hide modifications
    const originalToString = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (this === navigator.permissions.query) {
        return 'function query() { [native code] }';
      }
      return originalToString.call(this);
    };
  });
}

/**
 * Random "thinking" pause - simulates human reading/deciding
 * @param {Page} page - Playwright page
 * @param {string} action - What they're "thinking" about (for logging)
 */
async function thinkingPause(page, action = 'deciding') {
  const delay = randomDelay(800, 0.5);
  console.log(`  [humanize] Pausing ${delay}ms (${action})...`);
  await page.waitForTimeout(delay);
}

module.exports = {
  // Delays
  randomDelay,
  humanDelay,
  thinkingPause,

  // Mouse
  humanMouseMove,
  humanClick,
  humanClickElement,

  // Keyboard
  humanType,

  // Scrolling
  humanScroll,

  // Anti-detection
  injectStealthPatches,

  // Helpers
  gaussianRandom,
  bezierCurve
};
