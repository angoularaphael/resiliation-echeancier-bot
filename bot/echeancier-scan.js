/**
 * Scan Deciplus Manager → Échéancier → Impayés.
 * Relance mail (impayé du jour / mois en cours), contentieux le mois suivant,
 * résiliation 24h après (date effective = aujourd’hui, mois en cours).
 */
const { logInfo, logWarn } = require('../lib/logger');
const { cancelSale } = require('./cancel-sale');
const { gotoDeciplus } = require('./auth');
const { classifyUnpaid, shouldCancel, nextCancelAfter } = require('../lib/echeancier-policy');
const { loadState, saveState, touchMember } = require('../lib/echeancier-state');
const { sendUnpaidReminder, sendContentieuxNotice } = require('../lib/echeancier-mail');

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
 * Membres avec au moins 1 échéance impayée (date du jour / mois en cours / mois précédent).
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
        const idm = text.match(/\b(1\d{4}|2\d{4})\b/);
        idj = idm ? idm[1] : null;
      }
      const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
      out.push({ text: text.slice(0, 240), member_id: idj, dates, email });
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
      email: '',
    };
    cur.unpaid_count += 1;
    if (cur.samples.length < 4) cur.samples.push(row.text);
    if (!cur.email && row.email) cur.email = row.email;
    for (const d of row.dates || []) {
      cur.dateKeys.add(d.key);
      cur.timestamps.push(d.t);
    }
    byMember.set(row.member_id, cur);
  }

  const results = [];
  for (const cur of byMember.values()) {
    if (cur.unpaid_count < 1) continue;
    results.push({
      member_id: cur.member_id,
      unpaid_count: cur.unpaid_count,
      samples: cur.samples,
      months: [...cur.dateKeys].sort(),
      timestamps: cur.timestamps,
      email: cur.email || '',
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

async function readMemberContact(page) {
  const { getMemberFormContext } = require('./member');
  const ctx = await getMemberFormContext(page, { waitMs: 5000 });
  const email = await ctx
    .locator('input[name="email"]:not(#i_email)')
    .first()
    .inputValue()
    .catch(() => '');
  const firstName = await ctx
    .locator('input[name="prenom"]:not(#i_prenom)')
    .first()
    .inputValue()
    .catch(() => '');
  const lastName = await ctx
    .locator('input[name="nom"]:not(#i_nom)')
    .first()
    .inputValue()
    .catch(() => '');
  return {
    email: String(email || '').trim(),
    firstName: String(firstName || '').trim(),
    lastName: String(lastName || '').trim(),
  };
}

/**
 * 1) Analyse + mails (relance jour J, contentieux mois suivant).
 * 2) Résiliation mois en cours pour ceux dont le délai 24h est écoulé
 *    (ou forceCancel pour un test limité).
 */
async function runEcheancierScan(page, { limit = 30, cancelLimit, forceCancel = false } = {}) {
  const isDry = dryRun();
  const max = Math.max(0, Number(limit) || 30);
  const maxCancel = Math.max(0, Number(cancelLimit != null ? cancelLimit : max) || 0);
  const force = Boolean(forceCancel) && !isDry;
  logInfo('Échéancier — scan impayés démarré', {
    month: currentMonthLabel(),
    dry_run: isDry,
    force_cancel: force,
    limit: max,
    cancel_limit: maxCancel,
  });

  await gotoDeciplus(page).catch(() => {});
  await openEcheancierImpayes(page);
  const candidates = await parseUnpaidRows(page);
  const work = candidates.slice(0, max);
  logInfo('Échéancier — impayés détectés', {
    count: candidates.length,
    will_process: work.length,
    sample: work.slice(0, 8).map((c) => ({
      id: c.member_id,
      unpaid: c.unpaid_count,
      months: c.months,
    })),
  });

  const state = loadState();
  const results = [];
  let cancelled = 0;

  logInfo('Échéancier — phase ANALYSE (mails)');
  for (let i = 0; i < work.length; i += 1) {
    const cand = work[i];
    const classified = classifyUnpaid(cand);
    const row = {
      member_id: cand.member_id,
      unpaid_count: cand.unpaid_count,
      months: cand.months,
      classified,
    };
    try {
      logInfo(`Échéancier — analyse ${i + 1}/${work.length}`, {
        member_id: cand.member_id,
        due_today: classified.dueToday,
        current_month: classified.hasCurrent,
        previous_month: classified.hasPrevious,
      });
      const { eligible, contracts } = await memberHasEligibleContract(page, cand.member_id);
      const contact = await readMemberContact(page);
      const email = contact.email || cand.email || '';
      const prenom = contact.firstName || '';
      touchMember(state, cand.member_id, {
        email,
        prenom,
        nom: contact.lastName || '',
        last_unpaid_months: cand.months,
        last_seen_at: new Date().toISOString(),
      });
      const mem = state.members[cand.member_id] || {};

      if (!isDry && classified.wantsReminder && !mem.reminder_at) {
        const mail = await sendUnpaidReminder({ email, prenom });
        if (mail.sent) touchMember(state, cand.member_id, { reminder_at: new Date().toISOString() });
        row.reminder = mail;
      } else if (mem.reminder_at) {
        row.reminder = { skipped: true, already: true };
      }

      if (!isDry && classified.wantsContentieux && !mem.contentieux_at) {
        const mail = await sendContentieuxNotice({ email, prenom });
        if (mail.sent) {
          touchMember(state, cand.member_id, {
            contentieux_at: new Date().toISOString(),
            cancel_after: nextCancelAfter(),
          });
        }
        row.contentieux = mail;
      } else if (mem.contentieux_at) {
        row.contentieux = { skipped: true, already: true };
      }

      row.contracts = contracts.map((c) => c.label?.slice(0, 60));
      row.eligible = eligible.map((c) => c.label?.slice(0, 60));
      row.email = email || null;
    } catch (err) {
      logWarn('Échéancier — analyse membre échouée', { member_id: cand.member_id, error: err.message });
      row.error = err.message;
    }
    results.push(row);
  }
  saveState(state);

  logInfo('Échéancier — phase RÉSILIATION (mois en cours)');
  for (let i = 0; i < work.length; i += 1) {
    if (cancelled >= maxCancel) break;
    const cand = work[i];
    const row = results[i];
    const classified = classifyUnpaid(cand);
    const mem = state.members[cand.member_id] || {};
    if (mem.cancelled_at) {
      row.skipped = true;
      row.reason = 'already_cancelled';
      continue;
    }
    if (!row.eligible || !row.eligible.length) {
      row.skipped = true;
      row.reason = row.reason || 'no_eligible_contract';
      logWarn('Échéancier — aucun contrat actif à résilier', { member_id: cand.member_id });
      continue;
    }
    const due = shouldCancel(mem, classified, { force });
    if (!due) {
      row.skipped = true;
      row.reason = classified.wantsContentieux ? 'wait_24h_contentieux' : 'reminder_only';
      continue;
    }
    if (isDry) {
      row.dry_run = true;
      row.would_cancel = row.eligible;
      logInfo(`Échéancier — dry-run résil ${i + 1}/${work.length}`, {
        member_id: cand.member_id,
        would_cancel: row.eligible,
      });
      continue;
    }
    try {
      logInfo(`Échéancier — résiliation ${cancelled + 1}/${maxCancel}`, {
        member_id: cand.member_id,
        contracts: row.eligible,
      });
      const cancel = await cancelSale(page, cand.member_id, {
        cancelReason: 'echeancier_impayes',
        cancelDate: new Date(),
      });
      row.cancelled_count = cancel.cancelled_count;
      row.skip_reason = cancel.skip_reason || null;
      if (Number(cancel.cancelled_count) > 0) {
        cancelled += 1;
        touchMember(state, cand.member_id, { cancelled_at: new Date().toISOString() });
        saveState(state);
        logInfo('Échéancier — résiliation effectuée', {
          member_id: cand.member_id,
          cancelled_count: cancel.cancelled_count,
        });
      }
    } catch (err) {
      logWarn('Échéancier — résiliation échouée', { member_id: cand.member_id, error: err.message });
      row.error = err.message;
    }
  }
  saveState(state);

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
  return { ok: true, candidates: candidates.length, dry_run: isDry, cancelled, results };
}

module.exports = {
  runEcheancierScan,
  isEligibleContractLabel,
  dryRun,
};
