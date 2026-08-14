/**
 * Après paiement relance : fiche adhérent → échéancier → Encaisser → Carte Bancaire.
 */
const { logInfo, logWarn } = require('../lib/logger');
const { gotoDeciplus } = require('./auth');
const { openEcheancierImpayes } = require('./echeancier-scan');

function dryRun() {
  return String(process.env.ECHEANCIER_DRY_RUN || '0') === '1';
}

function formatAmount(cents) {
  const n = Number(cents) || 0;
  if (!n) return '';
  return (n / 100).toFixed(2).replace('.', ',');
}

async function pickDialogPaymentMode(page, dialog) {
  const wanted = /carte\s*bancaire/i;
  const native = dialog.locator('select').first();
  if ((await native.count()) > 0) {
    const ok = await native
      .selectOption({ label: /carte\s*bancaire/i })
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
  }

  const trigger = dialog.locator('.el-select, .el-input, [class*="select"]').first();
  if ((await trigger.count()) > 0) {
    await trigger.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }
  const opt = page
    .locator('.el-select-dropdown:visible .el-select-dropdown__item, li[role="option"], .el-option')
    .filter({ hasText: wanted })
    .first();
  if ((await opt.count()) > 0) {
    await opt.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function confirmEncaisserDialog(page) {
  const dialog = page
    .locator('.el-dialog:visible, .el-overlay-dialog:visible, [role="dialog"]:visible')
    .filter({ hasText: /encaisser une [eé]ch[eé]ance/i })
    .last();
  const visible =
    (await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false));
  const box = visible ? dialog : page;
  await pickDialogPaymentMode(page, box);
  const confirm = box.getByRole('button', { name: /confirmer et encaisser/i }).first();
  if ((await confirm.count()) > 0) {
    await confirm.click({ force: true });
  } else {
    await page.getByRole('button', { name: /confirmer et encaisser/i }).first().click({ force: true });
  }
  await page.waitForTimeout(1500);
}

async function findUnpaidRow(page, { name, amountLabel }) {
  const rows = page.locator('tr.el-table__row, .el-table__body tr, table tbody tr');
  const count = await rows.count();
  let fallback = null;
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const text = String((await row.innerText().catch(() => '')) || '');
    if (!/impay/i.test(text)) continue;
    const nameOk = !name || new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text);
    if (!nameOk) continue;
    if (amountLabel && text.includes(amountLabel)) return row;
    if (!fallback) fallback = row;
  }
  return fallback;
}

async function clickEncaisser(row) {
  const btn = row.getByRole('button', { name: /^encaisser$/i }).first();
  if ((await btn.count()) > 0) {
    await btn.click({ force: true });
    return true;
  }
  const link = row.getByText(/^encaisser$/i).first();
  if ((await link.count()) > 0) {
    await link.click({ force: true });
    return true;
  }
  return false;
}

async function maybeSearchMember(page, name) {
  if (!name) return;
  const input = page
    .getByPlaceholder(/adherent|adhérent|nom|recherche/i)
    .or(page.locator('input[type="search"], .el-input__inner[placeholder*="Nom"]'))
    .first();
  if ((await input.count()) === 0) return;
  await input.click({ force: true }).catch(() => {});
  await input.fill(name).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(1200);
}

async function encaisserEcheance(page, { memberId, name, amountCents } = {}) {
  const isDry = dryRun();
  const amountLabel = formatAmount(amountCents);
  logInfo('Échéancier — encaissement CB', {
    member_id: memberId || null,
    name: name || null,
    amount: amountLabel || null,
    dry_run: isDry,
  });

  await gotoDeciplus(page).catch(() => {});
  await openEcheancierImpayes(page);
  await maybeSearchMember(page, name);

  const row = await findUnpaidRow(page, { name, amountLabel });
  if (!row) {
    logWarn('Échéancier — ligne impayée introuvable pour encaisser', {
      member_id: memberId || null,
      name: name || null,
    });
    return { ok: false, reason: 'row_not_found' };
  }

  if (isDry) {
    return { ok: true, dry_run: true, would_encaisser: true };
  }

  const clicked = await clickEncaisser(row);
  if (!clicked) {
    return { ok: false, reason: 'encaisser_button_missing' };
  }
  await page.waitForTimeout(800);
  await confirmEncaisserDialog(page);
  logInfo('Échéancier — encaissement CB confirmé', { member_id: memberId || null });
  return { ok: true, encaissed: true };
}

module.exports = { encaisserEcheance };
