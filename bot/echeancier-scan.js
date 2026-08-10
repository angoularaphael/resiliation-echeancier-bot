/**
 * Scan Deciplus Manager → Échéancier → Impayés.
 * Cible : 2 impayés consécutifs (mois en cours) sur contrats comptant / sans engagement → résil auto.
 */
const { logInfo, logWarn } = require('../lib/logger');
const { cancelSale } = require('./cancel-sale');
const { gotoDeciplus } = require('./auth');

function dryRun() {
  return String(process.env.ECHEANCIER_DRY_RUN || '0') === '1';
}

function currentMonthLabel(d = new Date()) {
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

function isEligibleContractLabel(label) {
  const t = String(label || '').toLowerCase();
  if (!t) return false;
  // Exclure forfaits engagement / 12 mois « année »
  if (/engagement|12\s*mois|12mois|annuel|saison/i.test(t) && !/sans\s*engagement/i.test(t)) {
    return false;
  }
  return /comptant|sans\s*engagement|4\s*semaines|\/\s*4|29\s*€|34[,.]99|36[,.]99|44[,.]99/i.test(t) || /comptant/i.test(t);
}

async function openEcheancierImpayes(page) {
  const origin = new URL(page.url()).origin;
  const candidates = [
    'nextgen/manager/payments-schedules',
    'nextgen/presta_echeance.php',
    'nextgen/legacy?path=' + encodeURIComponent('/presta_echeance.php'),
    'nextgen/manager/echeancier',
    'nextgen/echeancier',
  ];
  let opened = false;
  for (const rel of candidates) {
    await page
      .goto(new URL(rel, origin + '/').href, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      })
      .catch(() => {});
    await page.waitForTimeout(1000);
    const url = page.url();
    const has =
      /payments-schedules|presta_echeance|ech[eé]ancier/i.test(url) ||
      (await page
        .locator('text=/échéancier|echeancier|impay|payments.?schedules/i')
        .first()
        .isVisible()
        .catch(() => false));
    if (has && !/acces_interdit/i.test(url)) {
      opened = true;
      logInfo('Échéancier ouvert', { url });
      break;
    }
  }

  if (!opened) {
    // Menu Manager → Echéanciers V2 / Echéanciers
    await page.goto(new URL('nextgen/', origin + '/').href, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(800);
    const manager = page.getByText(/^Manager$/i).first();
    if ((await manager.count()) > 0) {
      await manager.hover().catch(() => {});
      await page.waitForTimeout(500);
    }
    const echeancier = page
      .locator('a[href*="payments-schedules"], a[href*="presta_echeance"]')
      .or(page.getByRole('link', { name: /éch[eé]anciers?\s*v2|éch[eé]anciers?/i }))
      .first();
    if ((await echeancier.count()) === 0) {
      throw new Error('Menu Échéancier introuvable');
    }
    await echeancier.click();
    await page.waitForTimeout(1200);
    opened = true;
    logInfo('Échéancier ouvert via menu', { url: page.url() });
  }

  // Tous les états → Impayés → Appliquer
  const allStates = page.locator('text=/tous les états|tous les etats/i').first();
  if ((await allStates.count()) > 0) await allStates.click().catch(() => {});
  await page.waitForTimeout(400);

  const unpaidCandidates = [
    page.getByText(/^Impay/i).first(),
    page.locator('label').filter({ hasText: /Impay/i }).first(),
    page.locator('[title*="Impay" i]').first(),
    page.locator('input[value*="Impay" i]').first(),
  ];
  for (const unpaid of unpaidCandidates) {
    if ((await unpaid.count()) > 0 && (await unpaid.isVisible().catch(() => false))) {
      await unpaid.click({ force: true }).catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(300);

  const apply = page.getByRole('button', { name: /appliquer|filtrer|valider|rechercher/i }).first();
  if ((await apply.count()) > 0) await apply.click().catch(() => {});
  else
    await page
      .locator('input[type="submit"][value*="Appliquer"], button:has-text("Appliquer")')
      .first()
      .click()
      .catch(() => {});
  await page.waitForTimeout(1500);
}

/**
 * Parse basique des lignes visibles : regrouper par membre les échéances impayées du mois.
 * Retourne [{ member_id, name, unpaid_count, labels }]
 */
async function parseUnpaidRows(page) {
  const month = new Date().getMonth() + 1;
  const year = new Date().getFullYear();
  const rows = await page.evaluate(
    ({ month, year }) => {
      const out = [];
      const trs = Array.from(document.querySelectorAll('table tr, .el-table__row, tr'));
      for (const tr of trs) {
        const text = (tr.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 8) continue;
        if (!/impay/i.test(text) && !/non\s*pay/i.test(text)) continue;
        // date JJ/MM/AAAA
        const dm = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (dm) {
          const mm = Number(dm[2]);
          const yy = Number(dm[3]);
          if (mm !== month || yy !== year) continue;
        }
        const idm = text.match(/\b(\d{4,6})\b/);
        const href = tr.querySelector('a[href*="idj="]')?.getAttribute('href') || '';
        const idj = (href.match(/idj=(\d+)/) || [])[1] || (idm ? idm[1] : null);
        out.push({ text: text.slice(0, 200), member_id: idj });
      }
      return out;
    },
    { month, year }
  );

  const byMember = new Map();
  for (const row of rows) {
    if (!row.member_id) continue;
    const cur = byMember.get(row.member_id) || { member_id: row.member_id, unpaid_count: 0, samples: [] };
    cur.unpaid_count += 1;
    if (cur.samples.length < 3) cur.samples.push(row.text);
    byMember.set(row.member_id, cur);
  }
  return [...byMember.values()].filter((m) => m.unpaid_count >= 2);
}

async function memberHasEligibleContract(page, memberId) {
  const { openMemberCheck } = require('./wallet');
  await openMemberCheck(page, memberId).catch(() => {});
  await page.waitForTimeout(800);
  const { findActiveContracts } = require('./cancel-sale');
  const contracts = await findActiveContracts(page);
  const eligible = contracts.filter((c) => isEligibleContractLabel(c.label));
  return { contracts, eligible };
}

/**
 * Exécute un scan complet (à appeler sous runWithSession).
 */
async function runEcheancierScan(page, { limit = 30 } = {}) {
  logInfo('Échéancier — scan impayés démarré', {
    month: currentMonthLabel(),
    dry_run: dryRun(),
  });

  await gotoDeciplus(page).catch(() => {});
  await openEcheancierImpayes(page);
  const candidates = await parseUnpaidRows(page);
  logInfo('Échéancier — candidats 2+ impayés mois', {
    count: candidates.length,
    sample: candidates.slice(0, 5).map((c) => c.member_id),
  });

  const results = [];
  for (const cand of candidates.slice(0, limit)) {
    try {
      const { eligible, contracts } = await memberHasEligibleContract(page, cand.member_id);
      if (!eligible.length) {
        results.push({
          member_id: cand.member_id,
          skipped: true,
          reason: 'no_eligible_contract',
          contracts: contracts.map((c) => c.label?.slice(0, 60)),
        });
        continue;
      }
      if (dryRun()) {
        results.push({
          member_id: cand.member_id,
          dry_run: true,
          would_cancel: eligible.map((c) => c.label?.slice(0, 60)),
          unpaid_count: cand.unpaid_count,
        });
        continue;
      }
      const cancel = await cancelSale(page, cand.member_id, {
        cancelReason: 'echeancier_impayes',
      });
      results.push({
        member_id: cand.member_id,
        cancelled_count: cancel.cancelled_count,
        unpaid_count: cand.unpaid_count,
      });
    } catch (err) {
      logWarn('Échéancier — membre échoué', { member_id: cand.member_id, error: err.message });
      results.push({ member_id: cand.member_id, error: err.message });
    }
  }

  logInfo('Échéancier — scan terminé', {
    candidates: candidates.length,
    processed: results.length,
    cancelled: results.filter((r) => r.cancelled_count > 0).length,
  });
  return { ok: true, candidates: candidates.length, results };
}

module.exports = {
  runEcheancierScan,
  isEligibleContractLabel,
  dryRun,
};
