const { randomDelay } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { dismissDeciplusModals, dismissJqueryUiOverlay } = require('./ui');

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

async function clickSellOnSite(page) {
  await dismissDeciplusModals(page).catch(() => {});
  const sellBtn = page.getByRole('button', { name: /Vendre sur ce site|Accéder|Continuer|Valider/i }).first();
  if ((await sellBtn.count()) === 0) {
    const alt = page
      .locator(
        'button:has-text("Vendre"), button:has-text("Accéder"), button:has-text("Continuer"), a:has-text("Vendre sur ce site")'
      )
      .first();
    if ((await alt.count()) === 0 || !(await alt.isVisible().catch(() => false))) {
      // Dernier repli : quitter choose-zone vers l’accueil
      const origin = new URL(page.url()).origin;
      await page.goto(new URL('nextgen/', origin + '/').href, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await randomDelay(800, 1200);
      return !(await isChooseZoneScreen(page));
    }
    await alt.click({ force: true });
  } else {
    await sellBtn.click({ force: true });
  }

  await page.waitForURL(/vente|nextgen\/vente|choose-zone|nextgen\/?$|manager|membres|accueil|home/i, {
    timeout: 20000,
  }).catch(() => {});
  await randomDelay(800, 1500);

  // Si forced=true renvoie encore sur choose-zone, forcer l’accueil
  if (await isChooseZoneScreen(page)) {
    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/nextgen/home`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await randomDelay(600, 1000);
  }
  return !(await isChooseZoneScreen(page));
}

/**
 * Deciplus nextgen — écran « Choisissez un site » (composant .ari-select).
 * Doit TOUJOURS aboutir à /vente si l'écran zone est présent — sinon le catalogue produit n'apparaît pas.
 */
async function ensureDeciplusSaleZone(page, gymConfig = {}) {
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

async function switchDeciplusSite(page, siteLabel) {
  const label = String(siteLabel || '').trim();
  if (!label) return false;
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const origin = new URL(base).origin;
  const timeout = Number(process.env.DECIPLUS_NAV_TIMEOUT || 60000);
  const entries = [
    'nextgen/home',
    'nextgen/',
    'nextgen/choose-zone',
    'nextgen/choose-zone?nextUrl=/home',
  ];
  let opened = false;
  for (const rel of entries) {
    await page
      .goto(`${origin}/${rel}`, { waitUntil: 'domcontentloaded', timeout })
      .catch(() => {});
    await randomDelay(400, 800);
    if (/acces_interdit/i.test(page.url())) {
      logWarn('Entrée zone Deciplus interdite — autre URL', { site: label, tried: rel, url: page.url() });
      continue;
    }
    opened = true;
    break;
  }
  if (!opened) {
    logWarn('Changement de site Deciplus impossible', { site: label, url: page.url() });
    return false;
  }
  const selected = await selectSiteInPicker(page, label);
  if (!selected) {
    logWarn('Changement de site Deciplus impossible', { site: label, url: page.url() });
    return false;
  }
  await clickSellOnSite(page).catch(() => {});
  if (/acces_interdit/i.test(page.url())) {
    logWarn('Site Deciplus interdit après sélection', { site: label, url: page.url() });
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
};
