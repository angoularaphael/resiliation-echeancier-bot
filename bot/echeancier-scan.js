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

function formatFrDate(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function clickActualiser(page) {
  const btn = page.getByRole('button', { name: /actualiser|appliquer|filtrer|rechercher/i }).first();
  if ((await btn.count()) > 0) await btn.click().catch(() => {});
  else
    await page
      .locator('button:has-text("Actualiser"), button:has-text("Appliquer")')
      .first()
      .click()
      .catch(() => {});
  await page.waitForTimeout(2000);
}

async function pickSelectOption(page, labelRe, optionRe) {
  const item = page.locator('.el-form-item, .filter-item, .el-form-item__content').filter({ hasText: labelRe }).first();
  const trigger = item.locator('.el-select, .el-input, input').first();
  if ((await trigger.count()) === 0) {
    const fallback = page.locator('.el-select').filter({ hasText: /A faire|Payé|Impay|Tous/i }).first();
    if ((await fallback.count()) === 0) return false;
    await fallback.click({ force: true }).catch(() => {});
  } else {
    await trigger.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(500);
  const opt = page
    .locator(
      '.el-select-dropdown:visible .el-select-dropdown__item, .el-select-dropdown__item, li[role="option"], .el-option'
    )
    .filter({ hasText: optionRe })
    .first();
  if ((await opt.count()) === 0 || !(await opt.isVisible().catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await opt.click({ force: true }).catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

async function fillDateField(page, placeholderRe, valueFr) {
  const input = page.getByPlaceholder(new RegExp(placeholderRe, 'i')).first();
  if ((await input.count()) === 0) return false;
  await input.click({ force: true }).catch(() => {});
  await page.waitForTimeout(200);
  await input.press('Control+A').catch(() => {});
  await input.fill(valueFr).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

async function toggleNamedCheck(page, nameRe, wantChecked) {
  const lab = page.locator('label, .el-checkbox, .el-radio, button, span').filter({ hasText: nameRe }).first();
  if ((await lab.count()) === 0) return false;
  const cls = (await lab.getAttribute('class').catch(() => '')) || '';
  const checked = /is-checked|is-active|checked/i.test(cls);
  if (checked !== wantChecked) await lab.click({ force: true }).catch(() => {});
  return true;
}

function nameKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function monthWindows(now = new Date()) {
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const cur = new Date(now.getFullYear(), now.getMonth(), 1);
  return [
    {
      from: formatFrDate(prev),
      to: formatFrDate(prevEnd),
      label: `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`,
    },
    {
      from: formatFrDate(cur),
      to: formatFrDate(now),
      label: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`,
    },
  ];
}

async function typeDateField(page, placeholderRe, valueFr) {
  const input = page.getByPlaceholder(placeholderRe).first();
  if ((await input.count()) === 0) return '';
  await input.click({ clickCount: 3, force: true }).catch(() => {});
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.type(valueFr, { delay: 25 });
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(250);
  return input.inputValue().catch(() => '');
}

async function setDateRange(page, fromStr, toStr) {
  const gotFrom = await typeDateField(page, /Date de début/i, fromStr);
  const gotTo = await typeDateField(page, /Date de fin/i, toStr);
  logInfo('Échéancier — dates', { want_from: fromStr, got_from: gotFrom, want_to: toStr, got_to: gotTo });
}

async function applyEtatImpaye(page) {
  const etatTrigger = page
    .getByText(/éléments sélectionnés/i)
    .or(page.getByText(/^A faire$/i))
    .or(page.getByText(/^Impay/i))
    .or(page.getByText(/^[ÉE]tat$/i))
    .first();
  if ((await etatTrigger.count()) > 0) await etatTrigger.click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);

  const drop = page.locator('.el-select-dropdown:visible, .el-popper:visible, [role="listbox"]:visible').last();
  const clickDrop = async (nameRe, wantOn) => {
    const opt = drop.getByText(nameRe).first();
    const fallback = page.getByText(nameRe).last();
    const el = (await opt.count()) > 0 ? opt : fallback;
    if ((await el.count()) === 0) return false;
    const row = el.locator('xpath=ancestor::*[self::label or self::li or self::div][1]');
    const cls = `${(await el.getAttribute('class').catch(() => '')) || ''} ${(await row.getAttribute('class').catch(() => '')) || ''}`;
    const on = /is-checked|is-selected|checked/i.test(cls);
    if (on !== wantOn) await el.click({ force: true }).catch(() => {});
    return true;
  };
  await clickDrop(/^A faire$/i, false);
  const etatOk = await clickDrop(/^Impay/i, true);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  logInfo('Échéancier — état Impayé', { etat: etatOk });
  return etatOk;
}

async function applyUnpaidFilters(page) {
  await applyEtatImpaye(page);
  const [first] = monthWindows();
  await setDateRange(page, first.from, first.to);
  await clickActualiser(page);
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

  await applyUnpaidFilters(page);

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

      const cells = Array.from(tr.querySelectorAll('td, .cell, .el-table__cell'))
        .map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const nameFromCell = cells.length >= 2 && /^\d{2}\/\d{2}\/\d{4}$/.test(cells[0]) ? cells[1] : '';
      const nameFromText =
        (text.match(
          /^\d{2}\/\d{2}\/\d{4}\s+(.+?)\s+(?:OFFRE|Badge|Etudiants|Étudiants|\d+[.,]\d{2}\s*€)/i
        ) || [])[1] || '';
      const name = (nameFromCell || nameFromText).trim();

      const href =
        tr.querySelector('a[href*="idj="], a[href*="idj%3D"]')?.getAttribute('href') ||
        tr.querySelector('a[href*="id="]')?.getAttribute('href') ||
        '';
      let idj = (href.match(/idj[=%](\d+)/i) || href.match(/[?&]id=(\d+)/i) || [])[1] || null;
      if (!idj) {
        const idm = text.match(/\b(1\d{4}|2\d{4})\b/);
        idj = idm ? idm[1] : null;
      }
      const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
      out.push({ text: text.slice(0, 240), member_id: idj, name, dates, email });
    }
    return out;
  });

  const byMember = new Map();
  for (const row of rows) {
    const key = row.member_id || (row.name ? `name:${nameKey(row.name)}` : null);
    if (!key) continue;
    const cur = byMember.get(key) || {
      member_id: row.member_id || null,
      name: row.name || '',
      unpaid_count: 0,
      samples: [],
      dateKeys: new Set(),
      timestamps: [],
      email: '',
    };
    cur.unpaid_count += 1;
    if (!cur.member_id && row.member_id) cur.member_id = row.member_id;
    if (!cur.name && row.name) cur.name = row.name;
    if (cur.samples.length < 4) cur.samples.push(row.text);
    if (!cur.email && row.email) cur.email = row.email;
    for (const d of row.dates || []) {
      cur.dateKeys.add(d.key);
      cur.timestamps.push(d.t);
    }
    byMember.set(key, cur);
  }

  const results = [];
  for (const cur of byMember.values()) {
    if (cur.unpaid_count < 1) continue;
    results.push({
      member_id: cur.member_id,
      name: cur.name || '',
      unpaid_count: cur.unpaid_count,
      samples: cur.samples,
      months: [...cur.dateKeys].sort(),
      timestamps: cur.timestamps,
      email: cur.email || '',
    });
  }
  return results;
}

function mergeUnpaid(parts) {
  const merged = new Map();
  for (const row of parts) {
    const key = row.member_id || (row.name ? `name:${nameKey(row.name)}` : null);
    if (!key) continue;
    const cur = merged.get(key) || {
      member_id: row.member_id || null,
      name: row.name || '',
      unpaid_count: 0,
      samples: [],
      months: [],
      timestamps: [],
      email: '',
    };
    cur.unpaid_count += Number(row.unpaid_count || 0);
    if (!cur.member_id && row.member_id) cur.member_id = row.member_id;
    if (!cur.name && row.name) cur.name = row.name;
    if (!cur.email && row.email) cur.email = row.email;
    cur.months = [...new Set([...(cur.months || []), ...(row.months || [])])].sort();
    cur.timestamps = [...(cur.timestamps || []), ...(row.timestamps || [])];
    for (const s of row.samples || []) {
      if (cur.samples.length < 6 && !cur.samples.includes(s)) cur.samples.push(s);
    }
    merged.set(key, cur);
  }
  return [...merged.values()];
}

function formatIsoDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function candidatesFromScheduleRows(rows) {
  const byMember = new Map();
  for (const r of rows || []) {
    const memberId = String(r.memberId || r.member?.id || '');
    if (!memberId) continue;
    const date = String(r.paymentDate || r.date || '').slice(0, 10);
    const [y, m, d] = date.split('-').map(Number);
    if (!y || !m || !d) continue;
    const name = [r.member?.name, r.member?.surname].filter(Boolean).join(' ').trim();
    const cur = byMember.get(memberId) || {
      member_id: memberId,
      name,
      unpaid_count: 0,
      samples: [],
      dateKeys: new Set(),
      timestamps: [],
      email: '',
    };
    cur.unpaid_count += 1;
    if (!cur.name && name) cur.name = name;
    cur.dateKeys.add(`${y}-${String(m).padStart(2, '0')}`);
    cur.timestamps.push(new Date(y, m - 1, d).getTime());
    if (cur.samples.length < 4) {
      cur.samples.push(`${date} ${name} ${r.product?.name || ''} ${r.status || 'unpaid'}`.trim());
    }
    byMember.set(memberId, cur);
  }
  return [...byMember.values()].map((cur) => ({
    member_id: cur.member_id,
    name: cur.name || '',
    unpaid_count: cur.unpaid_count,
    samples: cur.samples,
    months: [...cur.dateKeys].sort(),
    timestamps: cur.timestamps,
    email: cur.email || '',
  }));
}

async function fetchPaymentSchedules(page, { fromIso, toIso, status = ['unpaid'] }) {
  const params = new URLSearchParams({
    from: fromIso,
    to: toIso,
    triggerHack: '0',
    page: '1',
    per_page: '1000',
  });
  for (const s of status) params.append('status[]', s);
  const url = `https://api.deciplus.pro/staff/v1/payment-schedules?${params}`;

  const evalRes = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    return { ok: r.ok, status: r.status, text: await r.text() };
  }, url).catch(() => null);

  let payload = null;
  if (evalRes?.ok) {
    try {
      payload = JSON.parse(evalRes.text);
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    const res = await page.context().request.get(url);
    if (!res.ok()) throw new Error(`payment-schedules HTTP ${res.status()}`);
    payload = await res.json();
  }

  const rows = [...(payload.rows || [])];
  const total = Number(payload.count || rows.length);
  let pageNo = 2;
  while (rows.length < total && pageNo <= 10) {
    params.set('page', String(pageNo));
    const nextUrl = `https://api.deciplus.pro/staff/v1/payment-schedules?${params}`;
    const next = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return r.ok ? await r.json() : null;
    }, nextUrl).catch(() => null);
    if (!next?.rows?.length) break;
    rows.push(...next.rows);
    pageNo += 1;
  }
  return { count: total, rows };
}

async function collectUnpaidAcrossMonths(page) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const fromIso = formatIsoDate(from);
  const toIso = formatIsoDate(now);
  const { count, rows } = await fetchPaymentSchedules(page, {
    fromIso,
    toIso,
    status: ['unpaid'],
  });
  const merged = candidatesFromScheduleRows(rows);
  merged.sort((a, b) => {
    const score = (r) => (r.months || []).length * 10 + Number(r.unpaid_count || 0);
    return score(b) - score(a);
  });
  const consecutive = merged.filter((r) => (r.months || []).length >= 2);
  logInfo('Échéancier — API impayés', {
    from: fromIso,
    to: toIso,
    rows: rows.length,
    count,
    members: merged.length,
    consecutive: consecutive.length,
    sample: consecutive.slice(0, 8).map((r) => ({
      id: r.member_id,
      name: r.name,
      months: r.months,
      unpaid: r.unpaid_count,
    })),
  });
  return merged;
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
  const candidates = await collectUnpaidAcrossMonths(page);
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
        name: cand.name,
        due_today: classified.dueToday,
        current_month: classified.hasCurrent,
        previous_month: classified.hasPrevious,
      });
      if (!cand.member_id && cand.name) {
        const { searchMember } = require('./member');
        const found = await searchMember(page, cand.name).catch(() => ({ found: false }));
        if (found?.found && found.member_id) cand.member_id = found.member_id;
      }
      if (!cand.member_id) {
        row.skipped = true;
        row.reason = 'member_id_introuvable';
        row.name = cand.name;
        results.push(row);
        continue;
      }
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
  openEcheancierImpayes,
  parseUnpaidRows,
  collectUnpaidAcrossMonths,
};
