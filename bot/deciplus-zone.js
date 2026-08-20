const { randomDelay } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { dismissDeciplusModals, dismissJqueryUiOverlay } = require('./ui');
const { assertNotBalmaSale } = require('../lib/gym-slugs');

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSiteLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bst\b/g, 'saint')
    .replace(/\bste\b/g, 'sainte')
    .replace(/\bboxing center\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function siteLabelsMatch(candidate, target) {
  const a = normalizeSiteLabel(candidate);
  const b = normalizeSiteLabel(target);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

async function isChooseZoneScreen(page) {
  if (/choose-zone/i.test(page.url())) return true;
  const heading = page.locator('text=/Choisissez un site/i').first();
  return (await heading.count()) > 0 && (await heading.isVisible().catch(() => false));
}

async function pickSiteViaEvaluate(page, label) {
  return page
    .evaluate((want) => {
      const norm = (s) =>
        String(s || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      const wantN = norm(want);
      document.querySelectorAll('.modal-mask').forEach((el) => el.remove());

      const openers = [
        document.querySelector('.ari-select'),
        document.querySelector('.el-select'),
        document.querySelector('[class*="ari-select"]'),
        document.querySelector('button[aria-haspopup="listbox"]'),
      ].filter(Boolean);
      for (const sel of openers) {
        try {
          sel.click();
        } catch {
          /* ignore */
        }
      }

      const optSelectors = [
        '.ari-select-dropdown [role="option"]',
        '.ari-select-dropdown li',
        '.ari-select-dropdown .ari-option',
        '[role="listbox"] [role="option"]',
        '.ari-option',
        '.el-select-dropdown__item',
        '.el-option',
        'ul[role="listbox"] li',
        '.dropdown-menu li',
        '[class*="select"] [class*="option"]',
      ];
      const opts = [];
      for (const sel of optSelectors) {
        document.querySelectorAll(sel).forEach((el) => opts.push(el));
      }
      const unique = [...new Set(opts)];
      const hit = unique.find((el) => {
        const t = norm(el.textContent || '');
        return t && (t.includes(wantN) || wantN.includes(t));
      });
      if (!hit) {
        return {
          ok: false,
          options: unique.map((o) => (o.textContent || '').trim()).filter(Boolean).slice(0, 20),
        };
      }
      hit.click();
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { ok: true, site: (hit.textContent || '').trim() };
    }, label)
    .catch(() => ({ ok: false }));
}

async function trySelectSiteOnce(page, label, pattern) {
  await dismissDeciplusModals(page).catch(() => {});
  await dismissJqueryUiOverlay(page).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await randomDelay(250, 450);
  await dismissDeciplusModals(page).catch(() => {});

  const customSelect = page
    .locator('.ari-select, .el-select, [class*="ari-select"]')
    .first();
  if ((await customSelect.count()) > 0 && (await customSelect.isVisible().catch(() => false))) {
    const opened = await customSelect
      .click({ force: true, timeout: 8000 })
      .then(() => true)
      .catch(async () => {
        logWarn('Clic ari-select bloqué — dismiss modale puis retry');
        await dismissDeciplusModals(page).catch(() => {});
        return customSelect
          .click({ force: true, timeout: 8000 })
          .then(() => true)
          .catch(() => false);
      });

    if (!opened) {
      const picked = await pickSiteViaEvaluate(page, label);
      if (picked?.ok) {
        logInfo('Site Deciplus sélectionné (evaluate)', { site: picked.site });
        await randomDelay(400, 800);
        return true;
      }
      logWarn('Options site Deciplus introuvables', picked || {});
      return false;
    }
    await randomDelay(500, 900);

    const optionSelectors = [
      '.ari-select-dropdown [role="option"]',
      '.ari-select-dropdown .ari-option',
      '.ari-select-dropdown li',
      '[role="listbox"] [role="option"]',
      '.ari-option',
      'li[role="option"]',
      '.el-select-dropdown__item',
      '.el-option',
    ];

    for (const selOpt of optionSelectors) {
      const options = page.locator(selOpt);
      const count = await options.count();
      for (let i = 0; i < count; i += 1) {
        const opt = options.nth(i);
        if (!(await opt.isVisible().catch(() => false))) continue;
        const text = ((await opt.textContent().catch(() => '')) || '').trim();
        if (!siteLabelsMatch(text, label) && !pattern.test(text)) continue;
        await opt.click({ force: true }).catch(() => opt.click());
        await randomDelay(400, 800);
        logInfo('Site Deciplus sélectionné (ari-select)', { site: text });
        return true;
      }
    }

    const dropdown = page.locator('.ari-select-dropdown, [role="listbox"], .el-select-dropdown').first();
    if ((await dropdown.count()) > 0) {
      const option = dropdown.getByText(pattern).first();
      if ((await option.count()) > 0 && (await option.isVisible().catch(() => false))) {
        await option.click({ force: true });
        await randomDelay(400, 800);
        return true;
      }
    }

    // Dropdown ouvert mais options non cliquables via Playwright → evaluate
    const picked = await pickSiteViaEvaluate(page, label);
    if (picked?.ok) {
      logInfo('Site Deciplus sélectionné (evaluate après open)', { site: picked.site });
      await randomDelay(400, 800);
      return true;
    }
  }

  const option = page.getByText(pattern).last();
  if ((await option.count()) > 0 && (await option.isVisible().catch(() => false))) {
    await option.click({ force: true });
    await randomDelay(400, 800);
    return true;
  }

  const nativeSelect = page.locator('select').first();
  if ((await nativeSelect.count()) > 0) {
    const byLabel = await nativeSelect.selectOption({ label }).then(() => true).catch(() => false);
    if (byLabel) {
      await randomDelay(400, 800);
      return true;
    }

    const options = nativeSelect.locator('option');
    const count = await options.count();
    for (let i = 0; i < count; i += 1) {
      const opt = options.nth(i);
      const text = ((await opt.textContent().catch(() => '')) || '').trim();
      if (!siteLabelsMatch(text, label) && !pattern.test(text)) continue;
      const value = await opt.getAttribute('value');
      if (value == null || value === '') continue;
      await nativeSelect.selectOption(value);
      await randomDelay(400, 800);
      logInfo('Site Deciplus sélectionné (select natif)', { site: text, zone_id: value });
      return true;
    }
  }

  // Dernier repli evaluate même sans .ari-select visible
  const picked = await pickSiteViaEvaluate(page, label);
  if (picked?.ok) {
    logInfo('Site Deciplus sélectionné (evaluate fallback)', { site: picked.site });
    await randomDelay(400, 800);
    return true;
  }

  return false;
}

async function selectSiteInPicker(page, siteLabel) {
  const label = String(siteLabel || '').trim();
  if (!label) {
    logInfo('Aucune salle fournie pour le picker Deciplus — site session inchangé');
    return false;
  }
  const pattern = new RegExp(escapeRegExp(label), 'i');
  logInfo('Sélection site Deciplus', { site: label });

  if (/acces_interdit/i.test(page.url())) {
    logWarn('Picker site sur page interdite', { site: label, url: page.url() });
    return false;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (/acces_interdit/i.test(page.url())) {
      logWarn('Picker site sur page interdite', { site: label, url: page.url() });
      return false;
    }
    const ok = await trySelectSiteOnce(page, label, pattern);
    if (ok) return true;
    logWarn('Échec sélection site — nouvel essai', { site: label, attempt });
    await dismissDeciplusModals(page).catch(() => {});
    await randomDelay(600, 1100);
  }
  return false;
}

async function recoverFromForbiddenZone(page) {
  if (!isForbiddenZoneUrl(page.url())) return true;
  const origin = deciplusOrigin();
  for (const rel of ['nextgen/', 'select.php']) {
    await page.goto(`${origin}/${rel}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await randomDelay(400, 800);
    if (!isForbiddenZoneUrl(page.url())) return true;
  }
  return false;
}

async function clickSellOnSite(page) {
  if (isForbiddenZoneUrl(page.url())) {
    return recoverFromForbiddenZone(page);
  }
  if (!(await isChooseZoneScreen(page)) && !/choose-zone/i.test(page.url())) {
    return true;
  }

  const sellBtn = page.getByRole('button', { name: /Vendre sur ce site/i }).first();
  const sellLink = page.locator('a:has-text("Vendre sur ce site")').first();
  if ((await sellBtn.count()) > 0 && (await sellBtn.isVisible().catch(() => false))) {
    await sellBtn.click({ force: true });
  } else if ((await sellLink.count()) > 0 && (await sellLink.isVisible().catch(() => false))) {
    await sellLink.click({ force: true });
  } else {
    await page.goto(`${deciplusOrigin()}/nextgen/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  await page.waitForURL(/vente|nextgen\/vente|choose-zone|nextgen\/?$|manager|membres|accueil|home|select\.php/i, {
    timeout: 20000,
  }).catch(() => {});
  await randomDelay(600, 1100);
  if (isForbiddenZoneUrl(page.url())) return recoverFromForbiddenZone(page);
  if (await isChooseZoneScreen(page)) {
    await page.goto(`${deciplusOrigin()}/nextgen/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await randomDelay(600, 1000);
  }
  if (isForbiddenZoneUrl(page.url())) return recoverFromForbiddenZone(page);
  return isOnWorkingNextgen(page.url()) || !(await isChooseZoneScreen(page));
}

/**
 * Deciplus nextgen — écran « Choisissez un site » (composant .ari-select).
 * Doit TOUJOURS aboutir à /vente si l'écran zone est présent — sinon le catalogue produit n'apparaît pas.
 */
async function ensureDeciplusSaleZone(page, gymConfig = {}) {
  assertNotBalmaSale(gymConfig, {});
  if (!(await isChooseZoneScreen(page))) return false;

  const siteLabel =
    gymConfig.deciplus_label ||
    gymConfig.label ||
    process.env.DECIPLUS_DEFAULT_SITE ||
    '';

  if (!siteLabel) {
    throw new Error(
      'Écran « Choisissez un site » Deciplus sans salle commande — impossible d’ouvrir le catalogue vente'
    );
  }

  logInfo('Sélection site Deciplus pour vente', {
    site: siteLabel,
    gym: gymConfig.key || null,
    url: page.url(),
  });

  const selected = await selectSiteInPicker(page, siteLabel);
  if (!selected) {
    throw new Error(`Sélection site vente Deciplus impossible: "${siteLabel}" (url=${page.url()})`);
  }

  const sold = await clickSellOnSite(page);
  if (!sold) {
    throw new Error(`Bouton « Vendre sur ce site » introuvable (salle=${siteLabel})`);
  }

  // Si on est encore sur choose-zone, le catalogue ne chargera jamais
  if (await isChooseZoneScreen(page)) {
    logWarn('Toujours sur choose-zone après Vendre — nouvel essai');
    await clickSellOnSite(page);
  }

  if (await isChooseZoneScreen(page)) {
    throw new Error(
      `Toujours sur l’écran zone Deciplus après « Vendre sur ce site » (salle=${siteLabel}, url=${page.url()})`
    );
  }

  return true;
}

function deciplusOrigin(base = process.env.DECIPLUS_URL) {
  return new URL(base || 'https://boxingcenter.deciplus.pro/').origin;
}

/** Picker réel — jamais /home en premier (pas de .ari-select sur l’accueil). */
function zonePickerUrls(origin) {
  const o = String(origin || deciplusOrigin()).replace(/\/$/, '');
  return [
    `${o}/nextgen/choose-zone?nextUrl=/home`,
    `${o}/nextgen/choose-zone?nextUrl=/vente`,
    `${o}/nextgen/choose-zone`,
  ];
}

function isForbiddenZoneUrl(url) {
  return /acces_interdit/i.test(String(url || ''));
}

function isHomeWithoutPicker(url) {
  try {
    const u = new URL(String(url || ''), 'https://boxingcenter.deciplus.pro');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (/choose-zone/i.test(`${path}${u.search}`)) return false;
    return /\/nextgen\/home$/i.test(path) || /\/nextgen$/i.test(path);
  } catch {
    return false;
  }
}

function isOnWorkingNextgen(url) {
  try {
    const href = String(url || '');
    if (isForbiddenZoneUrl(href) || /choose-zone/i.test(href)) return false;
    const u = new URL(href, 'https://boxingcenter.deciplus.pro');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return /\/nextgen/i.test(path) || /select\.php/i.test(path) || /check\.php/i.test(path);
  } catch {
    return false;
  }
}

async function waitForZonePicker(page, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (isForbiddenZoneUrl(page.url())) return false;
    const widget = page.locator('.ari-select, .el-select, select').first();
    const heading = page.locator('text=/Choisissez un site/i').first();
    if (await widget.isVisible().catch(() => false)) return true;
    if (await heading.isVisible().catch(() => false)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function openChooseZonePicker(page, origin, timeout) {
  for (const url of zonePickerUrls(origin)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    await randomDelay(400, 800);
    if (isForbiddenZoneUrl(page.url())) {
      logWarn('Entrée zone Deciplus interdite — autre URL', { tried: url, url: page.url() });
      continue;
    }
    if (await waitForZonePicker(page, 8000)) return true;
    logWarn('URL zone sans picker', { tried: url, url: page.url() });
  }

  await page.goto(`${origin}/nextgen/home`, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
  await randomDelay(400, 800);
  if (isForbiddenZoneUrl(page.url())) return false;
  if (await waitForZonePicker(page, 2000)) return true;

  const openers = [
    page.locator('a[href*="choose-zone"]').first(),
    page.getByText(/Changer (de |le )?site/i).first(),
    page.getByRole('button', { name: /Changer (de |le )?site|Choisissez un site/i }).first(),
  ];
  for (const loc of openers) {
    if ((await loc.count()) === 0 || !(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ force: true }).catch(() => {});
    await randomDelay(600, 1100);
    if (await waitForZonePicker(page, 8000)) return true;
  }
  return isChooseZoneScreen(page);
}

async function switchDeciplusSite(page, siteLabel) {
  const label = String(siteLabel || '').trim();
  if (!label) return false;
  const origin = deciplusOrigin();
  const timeout = Number(process.env.DECIPLUS_NAV_TIMEOUT || 60000);
  const picker = await openChooseZonePicker(page, origin, timeout);
  if (!picker) {
    logWarn('Picker site Deciplus introuvable', { site: label, url: page.url() });
    return false;
  }
  const selected = await selectSiteInPicker(page, label);
  if (!selected) {
    logWarn('Changement de site Deciplus impossible', { site: label, url: page.url() });
    return false;
  }
  const sold = await clickSellOnSite(page).catch(() => false);
  if (isOnWorkingNextgen(page.url())) {
    logInfo('Site Deciplus actif', { site: label, url: page.url() });
    return true;
  }
  if (!sold || isForbiddenZoneUrl(page.url())) {
    logWarn('Changement de site Deciplus impossible', { site: label, url: page.url() });
    return false;
  }
  logInfo('Site Deciplus actif', { site: label });
  return true;
}

module.exports = {
  isChooseZoneScreen,
  selectSiteInPicker,
  clickSellOnSite,
  ensureDeciplusSaleZone,
  switchDeciplusSite,
  normalizeSiteLabel,
  siteLabelsMatch,
  zonePickerUrls,
  isForbiddenZoneUrl,
  isHomeWithoutPicker,
  isOnWorkingNextgen,
  deciplusOrigin,
};
