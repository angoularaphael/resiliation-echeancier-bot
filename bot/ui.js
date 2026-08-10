'use strict';

const { randomDelay } = require('../lib/utils');
const { logInfo } = require('../lib/logger');

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

/**
 * Modales Vue nextgen (modal-mask / blocText) qui bloquent le clic sur .ari-select.
 */
async function dismissDeciplusModals(page) {
  const mask = page.locator('.modal-mask').first();
  if ((await mask.count()) === 0 || !(await mask.isVisible().catch(() => false))) {
    return false;
  }

  logInfo('Modale Deciplus détectée — fermeture avant sélection site');

  const closeBtns = [
    page.locator('.modal-mask button:has-text("OK")').first(),
    page.locator('.modal-mask button:has-text("Fermer")').first(),
    page.locator('.modal-mask button:has-text("Continuer")').first(),
    page.locator('.modal-mask button:has-text("J\'ai compris")').first(),
    page.locator('.modal-mask button:has-text("Compris")').first(),
    page.locator('.modal-mask button:has-text("Valider")').first(),
    page
      .locator(
        '.modal-mask .close, .modal-mask [aria-label="Close"], .modal-mask .el-dialog__headerbtn'
      )
      .first(),
    page.locator('.modal-mask button').last(),
  ];

  for (const btn of closeBtns) {
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ force: true, timeout: 3000 }).catch(() => {});
      await randomDelay(300, 600);
      if ((await mask.count()) === 0 || !(await mask.isVisible().catch(() => false))) {
        return true;
      }
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  await randomDelay(300, 500);

  if ((await mask.count()) > 0 && (await mask.isVisible().catch(() => false))) {
    await page
      .evaluate(() => {
        document.querySelectorAll('.modal-mask').forEach((el) => {
          el.style.display = 'none';
          el.remove();
        });
      })
      .catch(() => {});
    await randomDelay(200, 400);
  }

  return true;
}

module.exports = {
  dismissJqueryUiOverlay,
  dismissDeciplusModals,
  hasVisibleOverlay,
};
