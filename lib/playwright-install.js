/**
 * Install Playwright browser — léger pour KataBump (chromium-headless-shell).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function browsersPath() {
  const custom = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom) return custom;
  return path.join(process.cwd(), 'data', 'ms-playwright');
}

function hasBrowserInstalled(basePath) {
  if (!fs.existsSync(basePath)) return false;
  const entries = fs.readdirSync(basePath, { withFileTypes: true });
  return entries.some((e) => e.isDirectory() && /chromium|headless/i.test(e.name));
}

function installPlaywrightBrowser() {
  const base = browsersPath();
  process.env.PLAYWRIGHT_BROWSERS_PATH = base;
  fs.mkdirSync(base, { recursive: true });

  if (hasBrowserInstalled(base)) {
    console.log(`[BOXPLUS] Playwright déjà installé (${base})`);
    return;
  }

  const variants = [
    'chromium-headless-shell',
    'chromium',
  ];

  for (const variant of variants) {
    try {
      console.log(`[BOXPLUS] Installation Playwright: ${variant} → ${base}`);
      execSync(`npx playwright install ${variant}`, {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: base },
      });
      if (hasBrowserInstalled(base)) return;
    } catch (err) {
      console.warn(`[BOXPLUS] Échec install ${variant}:`, err.message || err);
    }
  }

  throw new Error(
    'Playwright non installé — disque plein (ENOSPC) ? Libère de l’espace ou augmente le quota KataBump.'
  );
}

module.exports = { installPlaywrightBrowser, browsersPath, hasBrowserInstalled };
