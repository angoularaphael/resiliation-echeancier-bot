/**
 * Scan Deciplus Manager → Échéancier → Impayés.
 * Un mail de relance (vouvoiement + lien de paiement) au premier passage 17h.
 * Chaque 17h = une tentative. À la 10e, si toujours impayé → résiliation.
 */
const { logInfo, logWarn } = require('../lib/logger');
const { cancelSale } = require('./cancel-sale');
const { gotoDeciplus } = require('./auth');
const {
  classifyUnpaid,
  shouldCancel,
  shouldSendReminder,
  shouldCountAttempt,
  isRelanceRun,
  parisDayKey,
} = require('../lib/echeancier-policy');
const { loadState, saveState, touchMember } = require('../lib/echeancier-state');
const { sendUnpaidReminder } = require('../lib/echeancier-mail');
const { mapOffer, eurosToCents, gymFromUnpaid, formatEurosFromCents } = require('../lib/echeancier-offer');
const { buildPayUrl } = require('../lib/echeancier-pay-link');

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
    const productName = String(r.product?.name || r.prestation || r.label || '').trim();
    const amountCents = eurosToCents(r.amountTTC ?? r.inclTax ?? r.priceTTC ?? r.amount ?? r.price ?? 0);
    const site =
      r.site?.name || r.siteName || r.clubName || r.zoneName || r.zone?.name || r.site || '';
    const cur = byMember.get(memberId) || {
      member_id: memberId,
      name,
      unpaid_count: 0,
      samples: [],
      dateKeys: new Set(),
      timestamps: [],
      email: '',
      product_name: '',
      amount_cents: 0,
      site: '',
    };
    cur.unpaid_count += 1;
    if (!cur.name && name) cur.name = name;
    if (!cur.product_name && productName) cur.product_name = productName;
    if (!cur.amount_cents && amountCents) cur.amount_cents = amountCents;
    if (!cur.site && site) cur.site = String(site);
    cur.dateKeys.add(`${y}-${String(m).padStart(2, '0')}`);
    cur.timestamps.push(new Date(y, m - 1, d).getTime());
    if (cur.samples.length < 4) {
      cur.samples.push(`${date} ${name} ${productName} ${r.status || 'unpaid'}`.trim());
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
    product_name: cur.product_name || '',
    amount_cents: cur.amount_cents || 0,
    gym: gymFromUnpaid({ site: cur.site, samples: cur.samples }),
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

function pickEmail(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of ['email', 'jemail', 'mail', 'eMail', 'Email', 'courriel']) {
    const v = String(obj[k] || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v;
  }
  return '';
}

async function fetchMemberContactApi(page, memberId) {
  if (!memberId) return { email: '', firstName: '', lastName: '' };
  const { getAccessToken } = require('./auth');
  const token = await getAccessToken(page);
  const url = `https://api.deciplus.pro/staff/v1/member/${memberId}`;
  let body = null;
  if (token) {
    const res = await page.context().request.get(url, {
      headers: {
        'x-access-token': token,
        'Deciplus-Client-Type': 'manager',
        Accept: 'application/json',
      },
    });
    if (res.ok()) body = await res.json().catch(() => null);
  }
  if (!body) {
    body = await page
      .evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        return r.ok ? r.json() : null;
      }, url)
      .catch(() => null);
  }
  const m = body?.response || body?.member || body?.data || body || {};
  const email = pickEmail(m) || pickEmail(body);
  const zone = String(m.zone || m.zoneName || m.site || m.categoryName || '').trim();
  return {
    email,
    firstName: String(m.name || m.prenom || m.firstName || '').trim(),
    lastName: String(m.surname || m.nom || m.lastName || '').trim(),
    zone,
    gym: gymFromUnpaid({ zone, site: zone }),
  };
}

async function readMemberContact(page) {
  const { getMemberFormContext } = require('./member');
  const ctx = await getMemberFormContext(page, { waitMs: 5000 });
  const read = async (sels) => {
    for (const sel of sels) {
      const el = ctx.locator(sel).first();
      if ((await el.count()) === 0) continue;
      const v = String((await el.inputValue().catch(() => '')) || '').trim();
      if (v) return v;
    }
    return '';
  };
  let email = await read([
    'input[name="jemail"]',
    'input[name="email"]:not(#i_email)',
    'input[type="email"]:not(#i_email)',
    '#jemail',
  ]);
  if (!email) {
    const blob = await ctx.locator('body').innerText().catch(() => '');
    email = (String(blob).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
  }
  return {
    email,
    firstName: await read(['input[name="prenom"]:not(#i_prenom)', '#prenom']),
    lastName: await read(['input[name="nom"]:not(#i_nom)', '#nom']),
  };
}

/**
 * 1) Analyse + un mail de relance (premier 17h uniquement).
 * 2) Chaque 17h incrémente la tentative ; à la 10e si inchangé → résiliation.
 */
async function runEcheancierScan(
  page,
  { limit = 30, cancelLimit, forceCancel = false, kind = '' } = {}
) {
  const isDry = dryRun();
  const isRelance = isRelanceRun(kind);
  const max = Math.max(0, Number(limit) || 30);
  const maxCancel = Math.max(0, Number(cancelLimit != null ? cancelLimit : max) || 0);
  const force = Boolean(forceCancel) && !isDry;
  logInfo('Échéancier — scan impayés démarré', {
    month: currentMonthLabel(),
    dry_run: isDry,
    force_cancel: force,
    kind: kind || 'startup',
    relance_17h: isRelance,
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
  let mailedReminder = 0;
  let noEmail = 0;
  let waitingAttempts = 0;
  let countedAttempts = 0;

  logInfo(isRelance ? 'Échéancier — phase RELANCE 17h' : 'Échéancier — phase ANALYSE (pas de mail hors 17h)');
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
      const apiContact = await fetchMemberContactApi(page, cand.member_id);
      const { eligible, contracts } = await memberHasEligibleContract(page, cand.member_id);
      const formContact = apiContact.email
        ? { email: '', firstName: '', lastName: '' }
        : await readMemberContact(page);
      const email = apiContact.email || formContact.email || cand.email || '';
      const prenom = apiContact.firstName || formContact.firstName || '';
      const nom = apiContact.lastName || formContact.lastName || '';
      const gym = apiContact.gym || cand.gym || 'minimes';
      const offer = mapOffer({
        productName: cand.product_name,
        amountCents: cand.amount_cents,
      });
      const amountCents = cand.amount_cents || offer.cents || 0;
      touchMember(state, cand.member_id, {
        email,
        prenom,
        nom,
        gym,
        product_name: cand.product_name || '',
        amount_cents: amountCents,
        last_unpaid_months: cand.months,
        last_seen_at: new Date().toISOString(),
      });
      let mem = state.members[cand.member_id] || {};

      logInfo(
        `Échéancier — analyse ${i + 1}/${work.length} · ${cand.name || cand.member_id} · mail ${email ? 'ok' : 'absent'} · ${formatEurosFromCents(amountCents)}`
      );
      if (!email) {
        noEmail += 1;
        row.no_email = true;
      }

      if (shouldCountAttempt(mem, classified, { isRelance })) {
        const next = Number(mem.attempt_count || 0) + 1;
        touchMember(state, cand.member_id, {
          attempt_count: next,
          last_attempt_day: parisDayKey(),
        });
        mem = state.members[cand.member_id] || mem;
        countedAttempts += 1;
        row.attempt_count = next;
      } else {
        row.attempt_count = Number(mem.attempt_count || 0);
      }

      if (!isDry && email && shouldSendReminder(mem, classified, { isRelance })) {
        let payUrl = '';
        try {
          payUrl = buildPayUrl({
            member_id: cand.member_id,
            email,
            prenom,
            nom,
            amount_cents: amountCents,
            gym,
            offer: offer.key,
          });
        } catch (err) {
          logWarn('Échéancier — lien paiement non généré', { error: err.message });
        }
        const mail = await sendUnpaidReminder({
          email,
          prenom,
          amountCents,
          offerLabel: offer.label,
          payUrl,
          gym,
        });
        if (mail.sent) {
          mailedReminder += 1;
          touchMember(state, cand.member_id, {
            reminder_at: new Date().toISOString(),
            reminder_count: 1,
          });
        }
        row.reminder = mail;
        row.pay_url = Boolean(payUrl);
      } else if (mem.reminder_at) {
        row.reminder = { skipped: true, already: true };
      }

      row.contracts = contracts.map((c) => c.label?.slice(0, 60));
      row.eligible = eligible.map((c) => c.label?.slice(0, 60));
      row.email = email || null;
      row.gym = gym;
    } catch (err) {
      logWarn('Échéancier — analyse membre échouée', { member_id: cand.member_id, error: err.message });
      row.error = err.message;
    }
    results.push(row);
  }
  saveState(state);

  logInfo('Échéancier — phase RÉSILIATION (10e tentative)');
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
    const due = shouldCancel(mem, classified, { force });
    if (!due) {
      row.skipped = true;
      const attempts = Number(mem.attempt_count || 0);
      row.reason = attempts > 0 ? `attente_tentative_${attempts}/10` : 'pas_encore_10e';
      if (attempts > 0 && attempts < 10) waitingAttempts += 1;
      continue;
    }
    if (!row.eligible || !row.eligible.length) {
      row.skipped = true;
      row.reason = row.reason || 'no_eligible_contract';
      logWarn('Échéancier — dû pour résil mais aucun contrat actif', {
        member_id: cand.member_id,
        name: cand.name || null,
      });
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
  state.last_scan_at = new Date().toISOString();
  saveState(state);

  const skipped = results.filter((r) => r.skipped || r.dry_run).length;
  const failed = results.filter((r) => r.error).length;
  logInfo(
    `Échéancier — scan terminé · ${candidates.length} impayés · ${mailedReminder} relances · ${cancelled} résil · ${waitingAttempts} en cours (tentatives) · ${countedAttempts} +1 aujourd’hui · ${noEmail} sans email`
  );
  logInfo('Échéancier — scan stats', {
    candidates: candidates.length,
    processed: results.length,
    cancelled,
    skipped,
    failed,
    mailed_reminder: mailedReminder,
    waiting_attempts: waitingAttempts,
    counted_attempts: countedAttempts,
    no_email: noEmail,
    dry_run: isDry,
    kind: kind || 'startup',
  });
  return {
    ok: true,
    candidates: candidates.length,
    dry_run: isDry,
    cancelled,
    mailed_reminder: mailedReminder,
    waiting_attempts: waitingAttempts,
    counted_attempts: countedAttempts,
    no_email: noEmail,
    results,
  };
}

module.exports = {
  runEcheancierScan,
  isEligibleContractLabel,
  dryRun,
  openEcheancierImpayes,
  parseUnpaidRows,
  collectUnpaidAcrossMonths,
  fetchMemberContactApi,
};
