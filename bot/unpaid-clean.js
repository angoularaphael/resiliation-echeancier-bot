/**
 * Supprime toutes les échéances impayées d’une fiche membre Deciplus.
 * Les impayés bloquent la migration de salle.
 */
const { randomDelay, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { openMemberCheck } = require('./wallet');

function getSelectors() {
  try {
    return loadJson('config/deciplus-selectors.json');
  } catch {
    return {};
  }
}

function getScopes(page) {
  return [page, ...(page.frames?.() || [])];
}

async function clickIfVisible(locator) {
  if ((await locator.count()) === 0) return false;
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click({ force: true }).catch(() => {});
  return true;
}

async function confirmDelete(page) {
  const sel = getSelectors().member_unpaid || {};
  for (const ctx of getScopes(page)) {
    const btn = ctx.locator(sel.confirm || 'button:has-text("Confirmer")').first();
    if (await clickIfVisible(btn)) {
      await randomDelay(400, 700);
      return true;
    }
  }
  const confirm = page.getByRole('button', { name: /confirmer|oui|valider/i }).first();
  if (await clickIfVisible(confirm)) {
    await randomDelay(400, 700);
    return true;
  }
  return false;
}

async function countUnpaidRows(page) {
  const sel = getSelectors().member_unpaid || {};
  let n = 0;
  for (const ctx of getScopes(page)) {
    try {
      n += await ctx.locator(sel.row || 'tr:has-text("Impayé")').count();
    } catch {
      /* frame */
    }
  }
  return n;
}

async function deleteUnpaidOnMember(page, memberId, gymConfig = {}) {
  await openMemberCheck(page, memberId, gymConfig);
  await randomDelay(600, 1000);

  const sel = getSelectors().member_unpaid || {};
  let deleted = 0;
  const max = 40;

  for (let i = 0; i < max; i += 1) {
    const before = await countUnpaidRows(page);
    if (before === 0) break;

    let clicked = false;
    for (const ctx of getScopes(page)) {
      const row = ctx.locator(sel.row || 'tr:has-text("Impayé")').first();
      if ((await row.count()) === 0) continue;
      const del = row.locator(sel.delete || 'button:has-text("Supprimer")').first();
      if (await clickIfVisible(del)) {
        clicked = true;
        break;
      }
      const anyDel = ctx.locator(sel.delete || 'button:has-text("Supprimer")').first();
      if (await clickIfVisible(anyDel)) {
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      logWarn('Impayés visibles mais bouton supprimer introuvable', {
        member_id: memberId,
        remaining: before,
      });
      break;
    }

    await confirmDelete(page);
    await randomDelay(500, 900);
    deleted += 1;
  }

  const remaining = await countUnpaidRows(page);
  logInfo('Nettoyage impayés Deciplus', {
    member_id: memberId,
    deleted,
    remaining,
  });
  return { deleted, remaining };
}

module.exports = { deleteUnpaidOnMember, countUnpaidRows };
