/**
 * Scan Deciplus Manager → Échéancier → Impayés.
 * Cible : 2+ impayés → résiliation auto des contrats actifs (hors badge).
 */
const { logInfo, logWarn } = require('../lib/logger');
const { cancelSale } = require('./cancel-sale');
const { gotoDeciplus } = require('./auth');

function dryRun() {
  // Défaut = LIVE (résil réelle). Mettre ECHEANCIER_DRY_RUN=1 pour lister seulement.
  return String(process.env.ECHEANCIER_DRY_RUN || '0') === '1';
}

function currentMonthLabel(d = new Date()) {
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

function isBadgeLabel(label) {
  return /badge|carte\s*d['’]?\s*acc[eè]s/i.test(String(label || ''));
}

/**
 * Contrats à résilier sur impayés : tout abonnement actif sauf badge.
 * (Avant : filtre trop strict « comptant/sans engagement » → 0 résil alors que candidats trouvés.)
 */
function isEligibleContractLabel(label) {
  const t = String(label || '').trim();
  if (!t) return false;
  if (isBadgeLabel(t)) return false;
  return true;
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

  // Filtrer Impayés
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
  await page.waitForTimeout(2000);

  // Scroll pour charger plus de lignes (tables virtuelles)
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.wheel(0, 1200).catch(() => {});
    await page.waitForTimeout(400);
  }
}

/**
 * Membres avec au moins 2 échéances impayées (consécutives si dates dispo).
 */
async function parseUnpaidRows(page) {
  const rows = await page.evaluate(() => {
    const out = [];
    const trs = Array.from(
      document.querySelectorAll(
        'table tbody tr, .el-table__body tr, .el-table__row, table tr, [role="row"]'
      )
    );
    for (const tr of trs) {
      const text = (tr.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 8) continue;
      if (!/impay|non\s*pay|unpaid|échec|reject|retour/i.test(text)) continue;

      const dateMatches = [...text.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)];
      const dates = dateMatches.map((m) => ({
        d: Number(m[1]),
        m: Number(m[2]),
        y: Number(m[3]),
        key: `${m[3]}-${m[2]}`,
        t: new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime(),
      }));

      const href =
        tr.querySelector('a[href*="idj="], a[href*="idj%3D"]')?.getAttribute('href') || '';
      let idj = (href.match(/idj[=%](\d+)/i) || [])[1] || null;
      if (!idj) {
        const idm = text.match(/\b(1\d{4}|2\d{4})\b/); // ids membres Deciplus typiques 5 chiffres
        idj = idm ? idm[1] : null;
      }
      out.push({ text: text.slice(0, 240), member_id: idj, dates });
    }
    return out;
  });

  const byMember = new Map();
  for (const row of rows) {
    if (!row.member_id) continue;
    const cur = byMember.get(row.member_id) || {
      member_id: row.member_id,
      unpaid_count: 0,
      samples: [],
      dateKeys: new Set(),
      timestamps: [],
    };
    cur.unpaid_count += 1;
    if (cur.samples.length < 4) cur.samples.push(row.text);
    for (const d of row.dates || []) {
      cur.dateKeys.add(d.key);
      cur.timestamps.push(d.t);
    }
    byMember.set(row.member_id, cur);
  }

  const results = [];
  for (const cur of byMember.values()) {
    const keys = [...cur.dateKeys].sort();
    let consecutive = cur.unpaid_count >= 2;
    if (keys.length >= 2) {
      consecutive = true;
    }
    if (!consecutive && cur.unpaid_count < 2) continue;
    if (cur.unpaid_count < 2) continue;
    results.push({
      member_id: cur.member_id,
      unpaid_count: cur.unpaid_count,
      samples: cur.samples,
      months: keys,
    });
  }
  return results;
}

async function memberHasEligibleContract(page, memberId) {
  const { openMemberCheck } = require('./wallet');
  await openMemberCheck(page, memberId).catch(() => {});
  await page.waitForTimeout(800);
  const { findActiveContracts } = require('./cancel-sale');
  const contracts = await findActiveContracts(page);
  let eligible = contracts.filter((c) => isEligibleContractLabel(c.label));
  // Repli : tout contrat actif non-badge si le filtre n’a rien pris
  if (!eligible.length && contracts.length) {
    eligible = contracts.filter((c) => !isBadgeLabel(c.label));
  }
  return { contracts, eligible };
}

/**
 * Exécute un scan complet (à appeler sous runWithSession).
 */
async function runEcheancierScan(page, { limit = 30 } = {}) {
  const isDry = dryRun();
  logInfo('Échéancier — scan impayés démarré', {
    month: currentMonthLabel(),
    dry_run: isDry,
    mode: isDry ? 'LISTE SEULEMENT (ECHEANCIER_DRY_RUN=1)' : 'RÉSIL LIVE',
  });
  if (isDry) {
    logWarn('Échéancier — DRY RUN actif : aucune résiliation ne sera faite (ECHEANCIER_DRY_RUN=1)');
  }

  await gotoDeciplus(page).catch(() => {});
  await openEcheancierImpayes(page);
  const candidates = await parseUnpaidRows(page);
  const max = Math.max(0, Number(limit) || 30);
  logInfo('Échéancier — candidats 2+ impayés', {
    count: candidates.length,
    will_process: Math.min(candidates.length, max),
    dry_run: isDry,
    sample: candidates.slice(0, 8).map((c) => ({
      id: c.member_id,
      unpaid: c.unpaid_count,
      months: c.months,
    })),
  });

  const results = [];
  for (const cand of candidates.slice(0, max)) {
    try {
      logInfo('Échéancier — traitement membre', {
        member_id: cand.member_id,
        unpaid_count: cand.unpaid_count,
      });
      const { eligible, contracts } = await memberHasEligibleContract(page, cand.member_id);
      logInfo('Échéancier — contrats fiche', {
        member_id: cand.member_id,
        active: contracts.length,
        to_cancel: eligible.length,
        labels: contracts.map((c) => c.label?.slice(0, 70)),
      });
      if (!eligible.length) {
        logWarn('Échéancier — aucun contrat actif à résilier', {
          member_id: cand.member_id,
          active_count: contracts.length,
        });
        results.push({
          member_id: cand.member_id,
          skipped: true,
          reason: 'no_eligible_contract',
          contracts: contracts.map((c) => c.label?.slice(0, 60)),
        });
        continue;
      }
      if (isDry) {
        logInfo('Échéancier — dry-run (pas de résil)', {
          member_id: cand.member_id,
          would_cancel: eligible.map((c) => c.label?.slice(0, 60)),
        });
        results.push({
          member_id: cand.member_id,
          dry_run: true,
          would_cancel: eligible.map((c) => c.label?.slice(0, 60)),
          unpaid_count: cand.unpaid_count,
        });
        continue;
      }
      logInfo('Échéancier — lancement résiliation', {
        member_id: cand.member_id,
        contracts: eligible.map((c) => c.label?.slice(0, 60)),
      });
      const cancel = await cancelSale(page, cand.member_id, {
        cancelReason: 'echeancier_impayes',
      });
      results.push({
        member_id: cand.member_id,
        cancelled_count: cancel.cancelled_count,
        unpaid_count: cand.unpaid_count,
        skip_reason: cancel.skip_reason || null,
      });
      logInfo('Échéancier — résiliation effectuée', {
        member_id: cand.member_id,
        cancelled_count: cancel.cancelled_count,
      });
    } catch (err) {
      logWarn('Échéancier — membre échoué', { member_id: cand.member_id, error: err.message });
      results.push({ member_id: cand.member_id, error: err.message });
    }
  }

  const cancelled = results.filter((r) => Number(r.cancelled_count) > 0).length;
  const skipped = results.filter((r) => r.skipped || r.dry_run).length;
  const failed = results.filter((r) => r.error).length;
  logInfo('Échéancier — scan terminé', {
    candidates: candidates.length,
    processed: results.length,
    cancelled,
    skipped,
    failed,
    dry_run: isDry,
  });
  if (candidates.length > 0 && cancelled === 0 && !isDry) {
    logWarn('Échéancier — 0 résiliation alors que des candidats existent — voir skips/erreurs ci-dessus', {
      skipped,
      failed,
      sample_results: results.slice(0, 5),
    });
  }
  return { ok: true, candidates: candidates.length, dry_run: isDry, results };
}

module.exports = {
  runEcheancierScan,
  isEligibleContractLabel,
  dryRun,
};
