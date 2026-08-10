/**
 * Lancement Playwright adapté aux hébergeurs Linux (BotHosting, KataBump).
 */
const { chromium } = require('playwright');
const { logWarn } = require('../lib/logger');
const { sleep } = require('../lib/utils');
const { installChromiumSystemDeps } = require('../lib/playwright-host-deps');
const path = require('path');

function isHostedBot() {
  if (process.platform !== 'linux') return false;
  return Boolean(
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
      process.env.BOXPLUS_HOSTED === '1' ||
      process.cwd().startsWith('/home/container')
  );
}

function getChromiumLaunchOptions() {
  const hosted = isHostedBot();
  const headless =
    String(process.env.DECIPLUS_HEADLESS ?? (hosted ? 'true' : 'false')).toLowerCase() !== 'false';
  const slowMo = headless ? 0 : Number(process.env.DECIPLUS_SLOW_MO || 100);

  const args = hosted
    ? [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-networking',
        '--mute-audio',
      ]
    : [];

  if (String(process.env.PLAYWRIGHT_SINGLE_PROCESS || 'false').toLowerCase() === 'true') {
    args.push('--single-process', '--no-zygote');
  }

  return {
    headless,
    slowMo: slowMo > 0 ? slowMo : undefined,
    args,
    timeout: Number(process.env.PLAYWRIGHT_LAUNCH_TIMEOUT || 120000),
  };
}

async function launchChromiumWithRetry(maxAttempts = 3) {
  if (isHostedBot()) {
    const dataRoot = process.env.BOT_DATA_DIR || path.join(process.cwd(), 'data');
    installChromiumSystemDeps({
      baseDir: path.join(dataRoot, 'system-libs'),
      botDir: process.cwd(),
    });
  }

  const opts = getChromiumLaunchOptions();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const browser = await chromium.launch(opts);
      if (!browser.isConnected()) {
        throw new Error('Navigateur déconnecté immédiatement après launch');
      }
      return browser;
    } catch (err) {
      lastError = err;
      logWarn(`Playwright launch ${attempt}/${maxAttempts} échoué`, {
        error: err.message,
        headless: opts.headless,
      });
      if (attempt < maxAttempts) {
        await sleep(4000 * attempt);
      }
    }
  }

  throw lastError || new Error('Impossible de lancer Chromium');
}

module.exports = {
  getChromiumLaunchOptions,
  launchChromiumWithRetry,
  isHostedBot,
};
