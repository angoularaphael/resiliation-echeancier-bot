'use strict';

const { randomDelay } = require('../lib/utils');

const DIALOG_CLOSE_SELECTORS = [
  '.ui-dialog-buttonpane button:has-text("OK")',
  '.ui-dialog-buttonpane button:has-text("Valider")',
  '.ui-dialog-buttonpane button:has-text("Fermer")',
  '.ui-dialog-buttonpane button:has-text("Ignorer")',
  '.ui-dialog-titlebar-close',
  'button.ui-dialog-titlebar-close',
];

async function hasVisibleOverlay(page) {
  const overlay = page.locator('.ui-widget-overlay.ui-front').first();
  if ((await overlay.count()) === 0) return false;
  return overlay.isVisible().catch(() => false);
}

async function dismissJqueryUiOverlay(page) {
  if (!(await hasVisibleOverlay(page))) return false;

  await page.keyboard.press('Escape').catch(() => {});
  await randomDelay(200, 400);

  for (const sel of DIALOG_CLOSE_SELECTORS) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ force: true, timeout: 3000 }).catch(() => {});
      await randomDelay(200, 500);
    }
  }

  const overlay = page.locator('.ui-widget-overlay.ui-front').first();
  if ((await overlay.count()) > 0) {
    await overlay.waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => {
      await page.evaluate(() => {
        document.querySelectorAll('.ui-widget-overlay').forEach((el) => el.remove());
        document.querySelectorAll('.ui-dialog').forEach((el) => {
          if (el.style) el.style.display = 'none';
        });
      });
    });
  }

  return !(await hasVisibleOverlay(page));
}

module.exports = {
  dismissJqueryUiOverlay,
  hasVisibleOverlay,
};
