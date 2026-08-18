/**
 * Ventes Deciplus — toutes offres (DUO, Saison, Badge, Essai)
 * Sans module Caisse → via check.php + nextgen/vente
 */
const path = require('path');
const { randomDelay, ensureDir, timestamp } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { openMemberCheck, clickFirst, fillFirst, sel, closeGreyboxIfOpen } = require('./wallet');
const { cancelSale } = require('./cancel-sale');
const { ensureDeciplusSaleZone, isChooseZoneScreen } = require('./deciplus-zone');
const { dismissJqueryUiOverlay } = require('./ui');
const { buildDeciplusProductSearch, buildSearchTokens, normalizeText } = require('./catalog');

function isBadgeSale(productConfig) {
  return (
    productConfig.sale_type === 'carte' ||
    /badge/i.test(String(productConfig.label || productConfig.deciplus_product_name || ''))
  );
}

function formatFrDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

async function findPaiementComptantCheckbox(page) {
  const scopes = [];
  const gb = page.locator('#GB_window').first();
  if ((await gb.count()) > 0 && (await gb.isVisible().catch(() => false))) scopes.push(gb);
  const dialog = page.locator('[role="dialog"]').first();
  if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) scopes.push(dialog);
  if (!scopes.length) scopes.push(page);

  for (const scope of scopes) {
    const selectors = [
      'label:has-text("Paiement Comptant") >> .. >> input[type="checkbox"]',
      'label:has-text("Paiement Comptant") >> xpath=following::input[@type="checkbox"][1]',
      ':text("Paiement Comptant") >> xpath=ancestor::*[1]/following::input[@type="checkbox"][1]',
    ];
    for (const selector of selectors) {
      const cb = scope.locator(selector).first();
      if ((await cb.count()) > 0) return cb;
    }
    const dialogCb = scope.locator('input[type="checkbox"]').first();
    if ((await dialogCb.count()) > 0 && scope !== page) return dialogCb;
  }
  return null;
}

async function uncheckPaiementComptantInput(cb) {
  await cb.evaluate((el) => {
    if (!el.checked) return;
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function isPaiementComptantChecked(page) {
  const cb = await findPaiementComptantCheckbox(page);
  if (!cb) return null;
  return cb.isChecked().catch(() => null);
}

function buildSearchCandidates(productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label || '';
  const candidates = new Set();

  if (productConfig.deciplus_product_search) {
    candidates.add(productConfig.deciplus_product_search);
  }
  candidates.add(buildDeciplusProductSearch(name, productConfig.deciplus_product_id));

  for (const token of buildSearchTokens(name)) {
    candidates.add(token);
  }

  if (productConfig.deciplus_reference) {
    candidates.add(String(productConfig.deciplus_reference));
    candidates.add(String(productConfig.deciplus_reference).replace(/^0+/, ''));
  }
  if (productConfig.deciplus_product_id) {
    candidates.add(String(productConfig.deciplus_product_id));
  }

  for (const value of [
    name,
    name.replace(/\s*€.*$/i, '').trim(),
  ]) {
    if (value) candidates.add(value);
  }

  const price = name.match(/(\d+[,.]\d{2})/);
  if (price) {
    candidates.add(price[1]);
    candidates.add(price[1].replace('.', ','));
  }

  return [...candidates].filter(Boolean);
}

async function openProductCategory(page, productConfig) {
  const isCarte =
    productConfig.sale_type === 'carte' ||
    /badge|decipass|carte/i.test(String(productConfig.label || productConfig.deciplus_product_name || ''));

  const patterns = isCarte
    ? [/Cartes/i, /prépay/i, /Decipass/i]
    : [/^Abonnements$/i, /Abonnement/i];

  for (const pat of patterns) {
    const el = page.getByText(pat).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click();
      await randomDelay(900, 1400);
      logInfo('Catégorie catalogue Deciplus', { category: String(pat) });
      return true;
    }
  }
  return false;
}

async function getProductTileLocator(page) {
  const selectors = [
    '.product-wrapper-title',
    '.product-wrapper .product-wrapper-title',
    '[class*="product-wrapper-title"]',
    '[class*="product-card"] [class*="title"]',
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector);
    if ((await loc.count()) > 0) return loc;
  }
  return page.locator('.product-wrapper-title');
}

async function scoreProductTile(text, productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label || '';
  const normalized = normalizeText(text);
  const targetName = normalizeText(name);
  let score = 0;

  if (normalized === targetName) score += 200;
  else if (normalized.includes(targetName) || targetName.includes(normalized)) score += 120;

  const amount = Number(productConfig.amount);
  if (Number.isFinite(amount) && amount > 0) {
    const priceVariants = [
      String(amount),
      String(amount).replace('.', ','),
      amount.toFixed(2),
      amount.toFixed(2).replace('.', ','),
    ];
    for (const pv of priceVariants) {
      if (text.includes(pv)) score += 80;
    }
  }

  if (/training camp/i.test(name) && /training camp/i.test(text)) score += 40;
  if (/badge/i.test(name) && /badge/i.test(text)) score += 100;
  if (/association/i.test(name) && /association/i.test(text)) score += 60;

  const targetTokens = normalizeText(name).split(' ').filter((t) => t.length > 3);
  const textTokens = new Set(normalizeText(text).split(' '));
  const overlap = targetTokens.filter((t) => textTokens.has(t)).length;
  score += overlap * 15;

  return score;
}

async function clickProductResult(page, productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label || '';
  const tiles = await getProductTileLocator(page);
  const count = await tiles.count();

  let bestTile = null;
  let bestScore = 0;

  for (let i = 0; i < count; i += 1) {
    const tile = tiles.nth(i);
    if (!(await tile.isVisible().catch(() => false))) continue;
    const text = (await tile.innerText().catch(() => '')).trim();
    if (!text) continue;
    const score = await scoreProductTile(text, productConfig);
    if (score > bestScore) {
      bestScore = score;
      bestTile = tile;
    }
  }

  if (bestTile && bestScore >= 40) {
    await bestTile.click();
    logInfo('Produit Deciplus sélectionné', {
      name,
      score: bestScore,
      search: productConfig.deciplus_product_search,
    });
    return true;
  }

  const exact = tiles.filter({ hasText: name }).first();
  if ((await exact.count()) > 0 && (await exact.isVisible().catch(() => false))) {
    await exact.click();
    return true;
  }

  const partial = page.getByText(new RegExp(escapeRegExp(name.slice(0, 24)), 'i')).first();
  if ((await partial.count()) > 0 && (await partial.isVisible().catch(() => false))) {
    await partial.click();
    return true;
  }

  return false;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listVisibleProducts(page) {
  const tiles = await getProductTileLocator(page);
  const count = Math.min(await tiles.count(), 8);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const text = (await tiles.nth(i).innerText().catch(() => '')).trim();
    if (text) out.push(text.slice(0, 60));
  }
  return out;
}

const PRODUCT_SEARCH_SELECTOR =
  'input[placeholder*="Rechercher un produit"], input[placeholder*="Rechercher"], input[placeholder*="prestation"], input[placeholder*="Produit"]';

/**
 * check.php nextgen charge la fiche dans un iframe _vue_iframe.
 * Les boutons Achat sont des input.fichemembre_button[value=...].
 */
async function getMemberCheckContext(page, { waitMs = 20000 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  const achatSel =
    'input.fichemembre_button[value="Achat Abonnement"], input[type="button"][value="Achat Abonnement"]';
  do {
    try {
      if ((await page.locator(achatSel).count()) > 0) return page;
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          if ((await frame.locator(achatSel).count()) > 0) return frame;
          if ((await frame.locator('input.fichemembre_button').count()) > 0) return frame;
        } catch {
          /* detached */
        }
      }
    } catch {
      /* nav */
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return page;
}

/**
 * Le catalogue nextgen/vente peut être dans la page ou un iframe.
 */
async function resolveVenteCatalogContext(page, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scopes = [page];
    try {
      for (const frame of page.frames()) {
        if (frame !== page.mainFrame()) scopes.push(frame);
      }
    } catch {
      /* frames change during nav */
    }

    for (const ctx of scopes) {
      try {
        const input = ctx.locator(PRODUCT_SEARCH_SELECTOR).first();
        if ((await input.count()) === 0) continue;
        if (await input.isVisible().catch(() => false)) return ctx;
        await input.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
        if (await input.isVisible().catch(() => false)) return ctx;
      } catch {
        /* frame detached */
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function selectProductInCatalog(page, productConfig) {
  const name = productConfig.deciplus_product_name || productConfig.label;
  const searchCandidates = buildSearchCandidates(productConfig);

  const ctx = (await resolveVenteCatalogContext(page, { timeoutMs: 5000 })) || page;
  const searchInput = ctx.locator(PRODUCT_SEARCH_SELECTOR).first();
  await searchInput.waitFor({ state: 'visible', timeout: 20000 });

  await openProductCategory(ctx, productConfig);

  for (const search of searchCandidates) {
    await searchInput.fill('');
    await randomDelay(250, 450);
    await searchInput.fill(search);
    await searchInput.press('Enter').catch(() => {});
    await randomDelay(1500, 2500);

    if (await clickProductResult(ctx, productConfig)) {
      await randomDelay();
      logInfo('Produit Deciplus trouvé dans le catalogue UI', { search, name });
      return true;
    }

    logWarn('Recherche produit Deciplus sans résultat', {
      search,
      name,
      visible: await listVisibleProducts(ctx),
    });
  }

  throw new Error(`Produit Deciplus introuvable: "${name}"`);
}

async function badgeDomEvaluate(ctx, operation, value = null) {
  return ctx.evaluate(
    ({ op, val }) => {
      function deepWalk(root, fn) {
        if (!root) return;
        fn(root);
        if (root.shadowRoot) deepWalk(root.shadowRoot, fn);
        for (const child of root.children || []) deepWalk(child, fn);
      }

      function deepQueryAll(root, selector) {
        const out = [];
        deepWalk(root, (node) => {
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(selector)) out.push(el);
          }
        });
        return out;
      }

      function deepText(node) {
        if (!node) return '';
        let text = node.innerText || node.textContent || '';
        if (node.shadowRoot) text += ` ${deepText(node.shadowRoot)}`;
        for (const child of node.children || []) text += ` ${deepText(child)}`;
        return text;
      }

      function setNativeInputValue(input, v) {
        if (!input) return false;
        input.focus();
        input.click();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, v);
        else input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        return String(input.value || '').trim() === v;
      }

      function findPaiementComptantSwitch() {
        const spans = deepQueryAll(document.body, 'span').filter((el) =>
          /Paiement Comptant/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        for (const span of spans) {
          let parent = span.parentElement;
          for (let depth = 0; depth < 8 && parent; depth += 1) {
            const sw = parent.querySelector('.el-switch');
            if (sw) return sw;
            parent = parent.parentElement;
          }
        }
        return (
          deepQueryAll(document.body, '.el-switch').find((sw) => {
            const row = sw.closest('.col-12, .row, div');
            return row && /Paiement Comptant/i.test(row.textContent || '');
          }) || null
        );
      }

      function turnOffElSwitch(sw) {
        if (!sw) return false;
        if (!sw.classList.contains('is-checked')) return true;
        const core = sw.querySelector('.el-switch__core');
        if (core) core.click();
        else {
          const input = sw.querySelector('input.el-switch__input, input[role="switch"]');
          if (input) input.click();
          else sw.click();
        }
        return !sw.classList.contains('is-checked');
      }

      function turnOnElSwitch(sw) {
        if (!sw) return false;
        if (sw.classList.contains('is-checked')) return true;
        const core = sw.querySelector('.el-switch__core');
        if (core) core.click();
        else {
          const input = sw.querySelector('input.el-switch__input, input[role="switch"]');
          if (input) input.click();
          else sw.click();
        }
        return sw.classList.contains('is-checked');
      }

      function findBadgeDateInputs() {
        const editors = deepQueryAll(
          document.body,
          '.el-date-editor input.el-input__inner, .el-date-editor input, input.el-input__inner'
        ).filter((input) => {
          if (input.type === 'checkbox' || input.type === 'hidden') return false;
          const r = input.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });

        const dateLike = editors.filter((input) =>
          /^\d{2}\/\d{2}\/\d{4}$/.test(String(input.value || '').trim())
        );
        if (dateLike.length >= 2) return dateLike;

        const valideNode = deepQueryAll(document.body, 'span, label, div, b, strong').find((el) =>
          /^Valide du$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        if (valideNode) {
          let parent = valideNode.parentElement;
          for (let depth = 0; depth < 10 && parent; depth += 1) {
            const near = deepQueryAll(parent, '.el-date-editor input, input.el-input__inner').filter(
              (input) => input.type !== 'checkbox' && input.type !== 'hidden'
            );
            if (near.length >= 2) return near;
            parent = parent.parentElement;
          }
        }
        return editors;
      }

      function clickAppliquerButton() {
        const candidates = [
          ...deepQueryAll(document.body, 'button.ari-button-filled, button.ari-button'),
          ...deepQueryAll(document.body, 'button'),
          ...deepQueryAll(document.body, 'input[type="button"], input[type="submit"]'),
        ];
        for (const btn of candidates) {
          const label = String(btn.textContent || btn.value || '').replace(/\s+/g, ' ').trim();
          if (!/^Appliquer$/i.test(label)) continue;
          const r = btn.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          btn.click();
          return true;
        }
        return false;
      }

      if (op === 'readText') return deepText(document.body).replace(/\s+/g, ' ');
      if (op === 'turnOffComptant') return turnOffElSwitch(findPaiementComptantSwitch());
      if (op === 'turnOnComptant') return turnOnElSwitch(findPaiementComptantSwitch());
      if (op === 'isComptantOn') {
        const sw = findPaiementComptantSwitch();
        return Boolean(sw && sw.classList.contains('is-checked'));
      }
      if (op === 'readAu') {
        const inputs = findBadgeDateInputs();
        return inputs.length >= 2 ? String(inputs[1].value || '').trim() : null;
      }
      if (op === 'fillAu') {
        const inputs = findBadgeDateInputs();
        if (inputs.length < 2) return false;
        return setNativeInputValue(inputs[1], val);
      }
      if (op === 'fillDu') {
        const inputs = findBadgeDateInputs();
        if (inputs.length < 1) return false;
        return setNativeInputValue(inputs[0], val);
      }
      if (op === 'clickAppliquer') return clickAppliquerButton();
      if (op === 'clickModifierDateFin') {
        const candidates = [
          ...deepQueryAll(document.body, 'button.p-button, button, [role="button"], a'),
        ];
        for (const btn of candidates) {
          const label = String(
            btn.textContent || btn.getAttribute('aria-label') || ''
          ).replace(/\s+/g, ' ').trim();
          if (!/Modifier la date de fin/i.test(label)) continue;
          const r = btn.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          btn.click();
          return true;
        }
        return false;
      }
      if (op === 'isDateFinDialogOpen') {
        const text = deepText(document.body).replace(/\s+/g, ' ');
        return (
          /Derni[eè]re [eé]ch[eé]ance apr[eè]s/i.test(text) &&
          /Modifier la date de fin/i.test(text)
        );
      }
      if (op === 'closePicker') {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const title = deepQueryAll(document.body, 'span, h1, h2, h3, div').find((el) =>
          /^Configuration de Badge$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        title?.click();
        return true;
      }
      if (op === 'recapReady') {
        const text = deepText(document.body).replace(/\s+/g, ' ');
        if (/en dehors de la dur[ée]e de validit[ée]/i.test(text)) return false;
        if (/Paiement imm[ée]diat/i.test(text) && /34[,.]99/.test(text)) return false;
        return /Pr[eé]l[eè]vement Automatique/i.test(text) && /Date de paiement/i.test(text);
      }
      if (op === 'markPaymentDate') {
        // Marque l'input « Date de paiement » pour saisie clavier Playwright
        const mark = (input) => {
          if (!input) return false;
          const r = input.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          input.setAttribute('data-bc-paydate', '1');
          return true;
        };
        const payLbl = deepQueryAll(document.body, 'span, label, div, b, strong, td, th, p').find((el) =>
          /^Date de paiement$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        if (payLbl) {
          const labelRect = payLbl.getBoundingClientRect();
          const dateInputs = deepQueryAll(
            document.body,
            '.el-date-editor input.el-input__inner, .el-date-editor input'
          )
            .filter((input) => {
              const r = input.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && !input.disabled;
            })
            .sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              const center = (r) => r.top + r.height / 2;
              return Math.abs(center(ra) - center(labelRect)) - Math.abs(center(rb) - center(labelRect));
            });
          if (mark(dateInputs[0])) return true;
        }
        const eds = deepQueryAll(
          document.body,
          '.el-date-editor input.el-input__inner, .el-date-editor input, input.el-input__inner'
        ).filter((input) => {
          if (input.type === 'checkbox' || input.type === 'hidden') return false;
          const r = input.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (eds.length >= 1) return mark(eds[0]);
        return false;
      }
      if (op === 'fillPaymentDate') {
        const setInput = (input) => {
          if (!input) return false;
          const r = input.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          input.focus();
          const proto = window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(input, val);
          else input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          return String(input.value || '').trim() === val;
        };

        // Champ proche du libellé « Date de paiement »
        const payLabel = deepQueryAll(document.body, 'span, label, div, b, strong, td, th, p').find((el) =>
          /^Date de paiement$/i.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())
        );
        if (payLabel) {
          const labelRect = payLabel.getBoundingClientRect();
          const dateInputs = deepQueryAll(
            document.body,
            '.el-date-editor input.el-input__inner, .el-date-editor input'
          )
            .filter((input) => {
              const r = input.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && !input.disabled;
            })
            .sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              const center = (r) => r.top + r.height / 2;
              return Math.abs(center(ra) - center(labelRect)) - Math.abs(center(rb) - center(labelRect));
            });
          if (setInput(dateInputs[0])) return true;
        }

        // Repli : date inputs visibles hors « Valide du »
        const editors = deepQueryAll(
          document.body,
          '.el-date-editor input.el-input__inner, .el-date-editor input, input.el-input__inner'
        ).filter((input) => {
          if (input.type === 'checkbox' || input.type === 'hidden') return false;
          const r = input.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        // Souvent : [Valide du, au, Date de paiement] → 3e ; sinon 2e si seulement 2
        if (editors.length >= 1 && setInput(editors[0])) return true;
        return false;
      }
      return null;
    },
    { op: operation, val: value }
  );
}

async function clickPaiementComptantToggleOff(scope) {
  if (typeof scope.evaluate !== 'function') return false;
  return badgeDomEvaluate(scope, 'turnOffComptant');
}

async function clickPaiementComptantToggleOn(scope) {
  if (typeof scope.evaluate !== 'function') return false;
  return badgeDomEvaluate(scope, 'turnOnComptant');
}

async function isElSwitchComptantOn(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  return badgeDomEvaluate(ctx, 'isComptantOn');
}

async function ensurePaiementComptantOn(page, { strict = false } = {}) {
  const ctx = await resolveDeciplusWorkPage(page);
  for (let pass = 0; pass < 5; pass += 1) {
    await clickPaiementComptantToggleOn(ctx);
    await randomDelay(400, 700);
    if (await isElSwitchComptantOn(page)) {
      logInfo('Paiement Comptant — activé (el-switch)');
      return true;
    }
  }
  const msg = 'Paiement Comptant non activé';
  if (strict) throw new Error(msg);
  logWarn(msg);
  return false;
}

async function ensurePaiementComptantOff(page, { strict = false } = {}) {
  const ctx = await resolveDeciplusWorkPage(page);

  for (let pass = 0; pass < 5; pass += 1) {
    await clickPaiementComptantToggleOff(ctx);
    await randomDelay(500, 900);

    if (!(await isElSwitchComptantOn(page))) {
      logInfo('Paiement Comptant — désactivé (el-switch)');
      return true;
    }

    const cb = await findPaiementComptantCheckbox(page);
    if (cb) {
      const checked = await cb.isChecked().catch(() => null);
      if (checked === false) {
        logInfo('Paiement Comptant — désactivé');
        return true;
      }
      if (checked === true) {
        await uncheckPaiementComptantInput(cb).catch(() => {});
        await cb.uncheck({ force: true, timeout: 5000 }).catch(() => {});
        await randomDelay(400, 700);
      }
    }
  }

  if (await isBadgeConfigModalOpen(page)) {
    const text = await readBadgeConfigModalText(page);
    if (/Pr[eé]l[eè]vement Automatique/i.test(text) && !modalShowsImmediateBadgePayment(text)) {
      logInfo('Paiement Comptant — désactivé (modale badge)');
      return true;
    }
  }

  if (await isElSwitchComptantOn(page)) {
    const msg = 'Paiement Comptant toujours activé';
    if (strict) throw new Error(msg);
    logWarn(msg);
    return false;
  }

  logInfo('Paiement Comptant — désactivé');
  return true;
}

function resolveBadgePrelevementDelayDays(productConfig = {}) {
  // Défaut : 3 jours ≈ 72h après l'abonnement (date de PAIEMENT uniquement)
  const min = Number(
    productConfig.prelevement_delay_days_min ||
      process.env.BADGE_PRELEVEMENT_DELAY_MIN ||
      3
  );
  const max = Number(
    productConfig.prelevement_delay_days_max ||
      process.env.BADGE_PRELEVEMENT_DELAY_MAX ||
      3
  );
  const raw = Number(
    productConfig.prelevement_delay_days ||
      process.env.BADGE_PRELEVEMENT_DELAY_DAYS ||
      3
  );
  const delay = Number.isFinite(raw) ? raw : 3;
  const lo = Number.isFinite(min) ? min : 3;
  const hi = Number.isFinite(max) ? Math.max(lo, max) : lo;
  return Math.min(hi, Math.max(lo, delay));
}

/** Validité badge : mois à compter de l’échéance (ex. 09/08/2026 → 09/09/2027 = 13 mois). */
function resolveBadgeValidityMonths(productConfig = {}) {
  const raw = Number(
    productConfig.badge_validity_months ||
      process.env.BADGE_VALIDITY_MONTHS ||
      13
  );
  return Number.isFinite(raw) && raw >= 1 ? raw : 13;
}

/** @deprecated — conservé pour compat ; préférer resolveBadgeValidityMonths */
function resolveBadgeValidityExtraDays(productConfig = {}) {
  const months = resolveBadgeValidityMonths(productConfig);
  return Math.max(0, months * 30 - 3);
}

/**
 * Badge différé :
 * - début = aujourd’hui
 * - échéance / débit = J+3 (~72h)
 * - fin = échéance + 13 mois (ex. 09/08/2026 → 09/09/2027)
 */
function badgeScheduleDates(delayDays = 3, validityMonthsOrExtra = null) {
  const startDate = new Date();
  startDate.setHours(12, 0, 0, 0);
  const payDate = new Date(startDate);
  payDate.setDate(payDate.getDate() + delayDays);

  let months = resolveBadgeValidityMonths();
  if (typeof validityMonthsOrExtra === 'number' && validityMonthsOrExtra >= 1) {
    // Ancien appel badgeScheduleDates(3, extraDays) avec extraDays < 60 → ignorer, garder mois
    // Nouvel appel explicite : validityMonths >= 1 et typiquement 12–24
    if (validityMonthsOrExtra >= 6) months = validityMonthsOrExtra;
  }

  const endDate = new Date(payDate);
  endDate.setMonth(endDate.getMonth() + months);

  return {
    startDate,
    payDate,
    endDate,
    startStr: formatFrDate(startDate),
    payStr: formatFrDate(payDate),
    endStr: formatFrDate(endDate),
    validity_months: months,
  };
}

/** @deprecated — utiliser badgeScheduleDates */
function badgeValidityDates(_validityDays = 6) {
  return badgeScheduleDates(3);
}

function badgePaymentDateParts(delayDays = 3) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + delayDays);
  return { date, str: formatFrDate(date) };
}

/** @deprecated préférer badgeScheduleDates */
function badgeContractDates(delayDays = 3) {
  return badgeScheduleDates(delayDays);
}

function badgeEndDate(_extraDays = 3) {
  const { endDate, endStr } = badgeScheduleDates(3);
  return { endDate, endStr, iso: endDate.toISOString().slice(0, 10) };
}

function parseFrDate(str) {
  const m = String(str || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function isFrDateAtLeast(actual, expected) {
  const a = parseFrDate(actual);
  const e = parseFrDate(expected);
  return Boolean(a && e && a.getTime() >= e.getTime());
}

async function captureBadgeDebugScreenshot(page, label) {
  try {
    const dir = path.join(process.env.BOT_DATA_DIR || 'data', 'logs');
    ensureDir(dir);
    const file = path.join(dir, `badge-${label}-${timestamp()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    logWarn('Badge — capture debug', { screenshot: file });
    return file;
  } catch {
    return null;
  }
}

async function captureSaleDebugScreenshot(page, label) {
  try {
    const dir = path.join(process.env.BOT_DATA_DIR || 'data', 'logs');
    ensureDir(dir);
    const file = path.join(dir, `sale-${label}-${timestamp()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

async function resolveDeciplusWorkPage(page) {
  for (const frame of page.frames()) {
    const name = frame.name() || '';
    if (/GB_frame/i.test(name)) {
      try {
        const hit = await frame.evaluate(() => {
          const text = String(document.body?.innerText || '');
          return /Configuration de Badge|Paiement Comptant/i.test(text);
        });
        if (hit) return frame;
      } catch {
        /* ignore */
      }
    }
  }

  for (const frame of page.frames()) {
    try {
      const hit = await frame.evaluate(() => {
        const text = String(document.body?.innerText || '');
        return /Configuration de Badge/i.test(text) && /Paiement Comptant/i.test(text);
      });
      if (hit) return frame;
    } catch {
      /* ignore detached/cross-origin frames */
    }
  }

  for (const frame of page.frames()) {
    if (/nextgen\/vente|\/vente/i.test(frame.url())) return frame;
  }

  return page;
}

async function getBadgeConfigModal(page) {
  if (!(await isBadgeConfigModalOpen(page))) return null;
  return resolveDeciplusWorkPage(page);
}

async function isBadgeConfigModalOpen(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  const text = await badgeDomEvaluate(ctx, 'readText');
  return (
    /Configuration de Badge/i.test(text) &&
    /Paiement Comptant/i.test(text) &&
    /Valide\s+du/i.test(text)
  );
}

async function waitForBadgeConfigModal(page, timeoutMs = 15000, { tryReopen = true } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isBadgeConfigModalOpen(page)) return true;
    await page.waitForTimeout(250);
  }

  await page.getByText(/Configuration de Badge|Paiement Comptant/i).first()
    .waitFor({ state: 'visible', timeout: 3000 })
    .catch(() => {});
  if (await getBadgeConfigModal(page)) return true;

  if (tryReopen) {
    await clickBadgeConfigEntry(page);
    await randomDelay(800, 1200);
    return waitForBadgeConfigModal(page, 8000, { tryReopen: false });
  }
  return isBadgeConfigModalOpen(page);
}

async function clickBadgeConfigEntry(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  const targets = [
    ctx.locator('text=/Prestation/i').locator('xpath=ancestor::*[1]').getByText(/^Badge$/i).first(),
    ctx.locator('div, tr, li, section').filter({ hasText: /^Badge$/ }).filter({ hasText: /34[,.]99/ }).first(),
    ctx.getByText(/^Badge$/i).last(),
  ];
  for (const el of targets) {
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true }).catch(() => {});
    return true;
  }
  return false;
}

async function reopenBadgeConfigModal(page) {
  await clickBadgeConfigEntry(page);
  await randomDelay(400, 700);
  return waitForBadgeConfigModal(page, 8000, { tryReopen: false });
}

async function ensureBadgeConfigModalForSale(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  if (await waitForBadgeConfigModal(page, 6000, { tryReopen: false })) return true;

  await clickBadgeConfigEntry(page);
  await randomDelay(400, 700);
  if (await waitForBadgeConfigModal(page, 6000, { tryReopen: false })) return true;

  const tile = ctx.locator('.product-wrapper-title, [class*="product-wrapper"]').filter({ hasText: /^Badge$/i }).first();
  if ((await tile.count()) > 0 && (await tile.isVisible().catch(() => false))) {
    await tile.click({ force: true }).catch(() => {});
    await randomDelay(500, 800);
  }

  await waitForBadgeConfigModal(page, 8000, { tryReopen: false });
  return isBadgeConfigModalOpen(page);
}

async function waitForBadgeModalClosed(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isBadgeConfigModalOpen(page))) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

function extractBadgePaymentDate(text) {
  const m = String(text || '').match(/Date de paiement\s*(\d{2}\/\d{2}\/\d{4})/i);
  return m ? m[1] : null;
}

function modalShowsImmediateBadgePayment(text) {
  return /Paiement imm[ée]diat/i.test(text) && /34[,.]99/.test(text);
}

function minBadgePaymentDate(delayDays = 3) {
  const d = new Date();
  // Tolérance J+(delay-1) pour fuseau / arrondi Deciplus (ex. 72h → à partir de J+2)
  d.setDate(d.getDate() + Math.max(1, Number(delayDays) - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

async function readBadgeConfigModalText(page) {
  if (!(await isBadgeConfigModalOpen(page))) return '';
  const ctx = await resolveDeciplusWorkPage(page);
  return badgeDomEvaluate(ctx, 'readText');
}

async function readBadgeAuValueFromModal(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  return badgeDomEvaluate(ctx, 'readAu');
}

async function clickBadgeModalAppliquer(page) {
  const ctx = await resolveDeciplusWorkPage(page);
  const clicked = await badgeDomEvaluate(ctx, 'clickAppliquer');
  if (clicked) await randomDelay(600, 1000);
  return clicked;
}

async function clickDeepLabel(ctx, labelPattern, { exact = false, preferClass = null } = {}) {
  if (typeof ctx?.evaluate !== 'function') return false;
  return ctx.evaluate(
    ({ patternStr, exactMatch, classHint }) => {
      const pattern = new RegExp(patternStr, exactMatch ? '' : 'i');

      function deepWalk(root, fn) {
        if (!root) return;
        fn(root);
        if (root.shadowRoot) deepWalk(root.shadowRoot, fn);
        for (const child of root.children || []) deepWalk(child, fn);
      }

      function deepQueryAll(root, selector) {
        const out = [];
        deepWalk(root, (node) => {
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(selector)) out.push(el);
          }
        });
        return out;
      }

      function normText(el) {
        return String(el.innerText || el.textContent || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function isVisible(el) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function matches(label) {
        if (exactMatch) return pattern.test(label) && label.length <= 24;
        return pattern.test(label);
      }

      const prioritized = classHint
        ? deepQueryAll(document.body, `[class*="${classHint}"]`)
        : [];

      const selector =
        'button, [role="button"], a, div.verticalDocumentBar, div[class*="verticalDocumentBar"], div[class*="paymentModes"], div[class*="DocumentBar"], span, div';
      const candidates = [...prioritized, ...deepQueryAll(document.body, selector)];

      let best = null;
      let bestScore = -1;

      for (const el of candidates) {
        const label = normText(el);
        if (!label || !matches(label)) continue;
        if (!isVisible(el)) continue;
        if (/Facture|Reçu|Contrat/i.test(label) && /Terminer/i.test(label) && label.length > 16) {
          continue;
        }

        const r = el.getBoundingClientRect();
        let score = r.top;
        if (classHint && String(el.className || '').includes(classHint)) score += 10000;
        if (/^>?[\s>]*Terminer$/i.test(label)) score += 5000;
        if (label.length <= 12) score += 1000;

        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }

      if (best) {
        best.scrollIntoView({ block: 'center', inline: 'center' });
        best.click();
        return true;
      }
      return false;
    },
    {
      patternStr: labelPattern.source,
      exactMatch: exact,
      classHint: preferClass,
    }
  );
}

async function clickVenteFooterAction(page, labelPattern, opts = {}) {
  const work = await resolveDeciplusWorkPage(page);
  const scopes = [work, page, ...(page.frames?.() || [])];
  const seen = new Set();
  for (const ctx of scopes) {
    const key = ctx.url?.() || String(ctx);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await ctx.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      if (await clickDeepLabel(ctx, labelPattern, opts)) return true;
    } catch {
      /* frame détachée */
    }
  }
  return false;
}

async function venteUiSnapshot(page) {
  const work = await resolveDeciplusWorkPage(page);
  const scopes = [work, page, ...(page.frames?.() || [])];
  const seen = new Set();
  const result = [];
  for (const ctx of scopes) {
    const url = ctx.url?.() || '';
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const labels = await ctx.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], [class*="DocumentBar"]'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map((el) => String(el.innerText || el.value || el.textContent || '').trim())
          .filter(Boolean)
          .slice(0, 30)
      );
      const text = await ctx
        .evaluate(() => String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200))
        .catch(() => '');
      result.push({ url, labels, text });
    } catch {
      /* frame détachée */
    }
  }
  return result;
}

async function clickTerminerVente(page) {
  await randomDelay(800, 1200);

  const work = await resolveDeciplusWorkPage(page);
  const scopes = [work, page, ...(page.frames?.() || [])];
  const seen = new Set();

  for (const ctx of scopes) {
    const key = ctx.url?.() || String(ctx);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      await ctx.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});

      const viaDom = await clickDeepLabel(ctx, /\bTerminer\b/i, {
        preferClass: 'verticalDocumentBar',
      });
      if (viaDom) return true;

      const bar = ctx.locator('[class*="verticalDocumentBar"]').filter({ hasText: /Terminer/i }).last();
      if ((await bar.count()) > 0 && (await bar.isVisible().catch(() => false))) {
        await bar.scrollIntoViewIfNeeded().catch(() => {});
        await bar.click({ force: true });
        return true;
      }

      const terminerText = ctx.getByText(/^>?[\s>]*Terminer$/i).last();
      if ((await terminerText.count()) > 0 && (await terminerText.isVisible().catch(() => false))) {
        await terminerText.scrollIntoViewIfNeeded().catch(() => {});
        await clickParentClickable(terminerText);
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

async function clickParentClickable(locator) {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) {
    await locator.click({ force: true });
    return;
  }
  await handle.evaluate((el) => {
    let node = el;
    for (let i = 0; i < 6 && node; i += 1) {
      const cls = String(node.className || '');
      if (/verticalDocumentBar|DocumentBar|paymentModes|col-auto/i.test(cls)) {
        node.scrollIntoView({ block: 'center', inline: 'center' });
        node.click();
        return;
      }
      node = node.parentElement;
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  });
}

async function isBadgeDateFinDialogOpen(page) {
  const scopes = [page, ...(page.frames?.() || [])];
  for (const ctx of scopes) {
    try {
      if (await badgeDomEvaluate(ctx, 'isDateFinDialogOpen')) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

async function handleBadgeModifierDateFinDialog(page, { timeoutMs = 15000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scopes = [await resolveDeciplusWorkPage(page), page, ...(page.frames?.() || [])];
    for (const ctx of scopes) {
      try {
        if (await badgeDomEvaluate(ctx, 'clickModifierDateFin')) {
          logInfo('Badge — « Modifier la date de fin » (popup échéance)');
          await randomDelay(800, 1200);
          if (await isBadgeConfigModalOpen(page)) {
            await clickBadgeModalAppliquer(page);
            await randomDelay(600, 1000);
          }
          return true;
        }
      } catch {
        /* ignore */
      }
    }

    if (!(await isBadgeDateFinDialogOpen(page))) {
      return false;
    }
    await page.waitForTimeout(400);
  }

  if (await isBadgeDateFinDialogOpen(page)) {
    const clicked = await clickFirst(page, sel('payment_finalize.modifier_date_fin_popup'));
    if (clicked) {
      logInfo('Badge — « Modifier la date de fin » (fallback sélecteur)');
      await randomDelay(800, 1200);
      return true;
    }
    throw new Error('Badge — popup « Modifier la date de fin » visible mais bouton introuvable');
  }

  return false;
}

async function waitForBadgeModalRecapReady(page, delayDays = 3, timeoutMs = 15000) {
  const minPay = minBadgePaymentDate(delayDays);
  const maxPay = new Date();
  maxPay.setDate(maxPay.getDate() + delayDays + 2);
  maxPay.setHours(23, 59, 59, 999);
  const ctx = await resolveDeciplusWorkPage(page);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await badgeDomEvaluate(ctx, 'recapReady')) {
      const text = await readBadgeConfigModalText(page);
      const payDate = extractBadgePaymentDate(text);
      const parsed = parseFrDate(payDate);
      if (parsed && parsed >= minPay && parsed <= maxPay) return true;
    }

    const text = await readBadgeConfigModalText(page);
    if (text && !/en dehors de la dur[ée]e de validit[ée]/i.test(text)) {
      if (/Pr[eé]l[eè]vement Automatique/i.test(text) && !modalShowsImmediateBadgePayment(text)) {
        const payDate = extractBadgePaymentDate(text);
        const parsed = parseFrDate(payDate);
        if (parsed && parsed >= minPay && parsed <= maxPay) return true;
      }
    }

    await page.waitForTimeout(500);
  }
  return false;
}

async function verifyVentePageBadgeDeferred(page, delayDays = 3) {
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (modalShowsImmediateBadgePayment(text)) return false;

  const minPay = minBadgePaymentDate(delayDays);
  const maxPay = new Date();
  maxPay.setDate(maxPay.getDate() + delayDays + 2);
  maxPay.setHours(23, 59, 59, 999);
  const payDate = extractBadgePaymentDate(text);
  const parsed = parseFrDate(payDate);
  if (parsed && parsed >= minPay && parsed <= maxPay) return true;

  // Sans date lisible : ne pas valider un échéancier à 1 mois
  return false;
}

async function getBadgeEditorScopes(page) {
  const modal = await getBadgeConfigModal(page);
  if (modal) return [modal];

  const locators = [
    page.locator('#GB_window').first(),
    page.locator('[role="dialog"]').first(),
    page.locator('.swal2-popup').first(),
    page.locator('.modal-content').first(),
  ];
  const out = [];
  for (const scope of locators) {
    if ((await scope.count()) > 0 && (await scope.isVisible().catch(() => false))) {
      out.push(scope);
    }
  }
  return out;
}

async function fillDateFieldByDom(page, labelText, value) {
  return page.evaluate(
    ({ label, val }) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const candidates = [...document.querySelectorAll('label, span, td, th, div, p, b, strong')].filter(
        (el) => norm(el.textContent) === target || norm(el.textContent).startsWith(`${target} `)
      );
      for (const node of candidates) {
        let root = node.parentElement;
        for (let depth = 0; depth < 6 && root; depth += 1) {
          const inputs = [...root.querySelectorAll('input:not([type="hidden"])')].filter(
            (input) => input.offsetParent !== null
          );
          if (inputs.length > 0) {
            const input = inputs.length > 1 && /fin/i.test(label) ? inputs[inputs.length - 1] : inputs[0];
            input.focus();
            input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          root = root.parentElement;
        }
      }
      return false;
    },
    { label: labelText, val: value }
  );
}

async function fillDateFieldByLabel(scope, labelPattern, value) {
  const labelText = labelPattern.source.replace(/\\b.*$/i, '').replace(/^\//, '').replace(/\\i$/i, '');

  const locators = [
    scope.getByLabel(labelPattern).first(),
    scope.getByText(labelPattern).locator('xpath=following::input[1]').first(),
    scope.locator('tr').filter({ hasText: labelPattern }).locator('input').first(),
    scope.locator('div').filter({ has: scope.getByText(labelPattern) }).locator('input').first(),
  ];

  for (const el of locators) {
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true }).catch(() => {});
    await el.fill('').catch(() => {});
    await el.fill(value).catch(() => {});
    await el.press('Tab').catch(() => {});
    const current = (await el.inputValue().catch(() => '')).trim();
    if (current.includes(value.slice(0, 5)) || current === value) return true;
  }

  if (/fin/i.test(labelText)) {
    const filled = await fillFirst(
      scope,
      'input[name="dfin"], input[name="date_fin"], input[name="datefin"], input[name="dateFin"], input[id*="dfin"], input[id*="date_fin"]',
      value
    );
    if (filled) return true;
  }

  if (typeof scope.evaluate === 'function') {
    return fillDateFieldByDom(scope, labelText, value);
  }
  return false;
}

async function uncheckKeepDuration(scope) {
  const selectors = [
    sel('sale_config_modal.conserver_duree'),
    'label:has-text("Conserver la durée") input[type="checkbox"]',
  ];
  for (const selector of selectors) {
    const cb = scope.locator(selector).first();
    if ((await cb.count()) === 0) continue;
    const checked = await cb.isChecked().catch(() => null);
    if (checked === true) {
      await cb.uncheck({ force: true }).catch(async () => {
        await cb.evaluate((el) => {
          el.checked = false;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    }
    return true;
  }
  return false;
}

async function ensureContractModifyAction(scope) {
  const finVisible = scope.getByText(/Date de fin/i).first();
  if ((await finVisible.count()) > 0 && (await finVisible.isVisible().catch(() => false))) {
    return true;
  }

  const actionHeader = scope.getByText(/Action souhaitée/i).first();
  if ((await actionHeader.count()) === 0 || !(await actionHeader.isVisible().catch(() => false))) {
    return false;
  }

  const selects = scope.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator('option').allTextContents();
    const modIndex = options.findIndex((o) => /modifier/i.test(o));
    if (modIndex >= 0) {
      await select.selectOption({ index: modIndex }).catch(() => {});
      await randomDelay(400, 700);
      return true;
    }
  }

  const modBtn = scope.getByRole('button', { name: /^Modifier$/i }).first();
  if ((await modBtn.count()) > 0 && (await modBtn.isVisible().catch(() => false))) {
    await modBtn.click();
    await randomDelay(400, 700);
    return true;
  }
  return false;
}

async function focusBadgeContractInSale(page) {
  const selectors = [
    'text=/Prestation\\s*:\\s*Badge/i',
    ':text("Prestation") >> xpath=ancestor::*[1] >> text=Badge',
    '[class*="contract"]:has-text("Badge")',
    'text=/Contrat n°.*Badge/i',
  ];
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click();
      await randomDelay(500, 800);
      return true;
    }
  }

  const badgeTile = page.getByText(/^Badge$/i).last();
  if ((await badgeTile.count()) > 0 && (await badgeTile.isVisible().catch(() => false))) {
    await badgeTile.click();
    await randomDelay(500, 800);
    return true;
  }
  return false;
}

async function ensureMemberCheckForBadgeEdit(page, memberId) {
  if (!memberId) return false;

  if (!page.url().includes('check.php')) {
    await openMemberCheck(page, memberId);
    await randomDelay(1500, 2200);
  } else {
    await randomDelay(800, 1200);
  }
  await focusBadgeContractInSale(page);
  return page.url().includes('check.php');
}

async function applyContractDateChange(scope) {
  const applied = await clickFirst(
    scope,
    [
      'button:has-text("Appliquer"):not(:has-text("Quitter"))',
      sel('sale_config_modal.appliquer'),
      sel('contract_actions.appliquer_quitter'),
      'button:has-text("Appliquer")',
    ].join(', ')
  );
  if (applied) await randomDelay(600, 1000);
  return applied;
}

async function fillBadgeContractDates(page, scheduleOrDays) {
  const schedule =
    scheduleOrDays && typeof scheduleOrDays === 'object' && scheduleOrDays.startStr
      ? scheduleOrDays
      : badgeScheduleDates(3);
  const { startStr, endStr } = schedule;
  await focusBadgeContractInSale(page);

  for (const scope of await getBadgeEditorScopes(page)) {
    await ensureContractModifyAction(scope);
    await uncheckKeepDuration(scope);

    await fillDateFieldByLabel(scope, /Date de début/i, startStr);
    const finFilled = await fillDateFieldByLabel(scope, /Date de fin/i, endStr);
    if (!finFilled) continue;

    if (await applyContractDateChange(scope)) {
      logInfo('Badge — dates contrat appliquées', {
        date_debut: startStr,
        date_fin: endStr,
        validity_months: schedule.validity_months || null,
      });
      return true;
    }
  }

  return false;
}

async function findModifierDateFinControl(page) {
  const patterns = [
    sel('sale_config_modal.modifier_date_fin'),
    'button:has-text("Modifier la date de fin")',
    'a:has-text("Modifier la date de fin")',
    '[role="button"]:has-text("Modifier la date de fin")',
    'text=/Modifier la date de fin/i',
    'text=/Modifier.*date.*fin/i',
  ];

  for (const pattern of patterns) {
    const el = page.locator(pattern).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      return el;
    }
  }

  const roleBtn = page.getByRole('button', { name: /Modifier la date de fin/i }).first();
  if ((await roleBtn.count()) > 0 && (await roleBtn.isVisible().catch(() => false))) {
    return roleBtn;
  }

  const roleLink = page.getByRole('link', { name: /Modifier la date de fin/i }).first();
  if ((await roleLink.count()) > 0 && (await roleLink.isVisible().catch(() => false))) {
    return roleLink;
  }

  return null;
}

async function fillBadgeEndDateFields(page, scheduleOrDays) {
  const schedule =
    scheduleOrDays && typeof scheduleOrDays === 'object' && scheduleOrDays.endStr
      ? scheduleOrDays
      : badgeScheduleDates(3);
  const { endStr } = schedule;

  for (const scope of await getBadgeEditorScopes(page)) {
    await uncheckKeepDuration(scope);
    const filled = await fillDateFieldByLabel(scope, /Date de fin/i, endStr);
    if (filled) {
      logInfo('Badge — date de fin saisie (validité)', {
        date_fin: endStr,
        validity_months: schedule.validity_months || null,
      });
      return true;
    }
  }

  return false;
}

async function confirmBadgeDateModal(page) {
  return clickFirst(
    page,
    [
      sel('contract_actions.appliquer_quitter'),
      sel('sale_config_modal.appliquer'),
      'button:has-text("Appliquer et Quitter")',
      'button:has-text("Appliquer")',
      'button:has-text("Valider")',
    ].join(', ')
  );
}

async function adjustBadgeEndDate(page, scheduleOrDays) {
  const schedule =
    scheduleOrDays && typeof scheduleOrDays === 'object' && scheduleOrDays.endStr
      ? scheduleOrDays
      : badgeScheduleDates(3);
  const control = await findModifierDateFinControl(page);
  if (!control) return false;
  await control.click({ force: true }).catch(() => {});
  await randomDelay(600, 1000);
  if (await fillBadgeEndDateFields(page, schedule) && (await confirmBadgeDateModal(page))) {
    return true;
  }
  return fillBadgeContractDates(page, schedule);
}

async function adjustBadgeEndDateWithRetry(page, scheduleOrDays, { attempts = 12, intervalMs = 1000 } = {}) {
  const schedule =
    scheduleOrDays && typeof scheduleOrDays === 'object' && scheduleOrDays.endStr
      ? scheduleOrDays
      : badgeScheduleDates(3);
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await adjustBadgeEndDate(page, schedule)) return true;
    } catch (err) {
      logWarn('Badge — ajustement date de fin interrompu', { error: err.message, attempt: i + 1 });
    }
    if (await fillBadgeEndDateFields(page, schedule)) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

async function readBadgeAuValueViaDom(scope) {
  if (typeof scope.evaluate !== 'function') return null;
  return scope.evaluate(() => {
    const isVisible = (el) => el && el.offsetParent !== null;
    const readInput = (input) => String(input?.value || '').trim();

    const modalRoot =
      document.querySelector('#GB_window') ||
      document.querySelector('[role="dialog"]') ||
      [...document.querySelectorAll('*')].find((el) =>
        /Configuration de Badge/i.test(String(el.textContent || '').slice(0, 80))
      )?.closest('div');

    const searchRoots = modalRoot ? [modalRoot, document.body] : [document.body];

    for (const root of searchRoots) {
      const inputs = [...root.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
      const dateLike = inputs.filter((input) =>
        /^\d{2}\/\d{2}\/\d{4}$/.test(String(input.value || '').trim())
      );
      if (dateLike.length >= 2) return readInput(dateLike[1]);

      const valideNode = [...root.querySelectorAll('*')].find(
        (el) => /^Valide du$/i.test(String(el.textContent || '').trim())
      );
      if (valideNode) {
        let parent = valideNode.parentElement;
        for (let depth = 0; depth < 8 && parent; depth += 1) {
          const near = [...parent.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
          if (near.length >= 2) return readInput(near[1]);
          parent = parent.parentElement;
        }
      }

      const auNode = [...root.querySelectorAll('*')].find(
        (el) => /^au$/i.test(String(el.textContent || '').trim())
      );
      if (auNode) {
        let parent = auNode.parentElement;
        for (let depth = 0; depth < 6 && parent; depth += 1) {
          const near = [...parent.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
          if (near.length >= 1) return readInput(near[0]);
          parent = parent.parentElement;
        }
      }
    }
    return null;
  });
}

async function readBadgeAuValue(scope) {
  const selectors = [
    sel('sale_config_modal.valide_au_input'),
    sel('sale_config_modal.valide_au_alt'),
    ':text("Valide du") >> xpath=following::input[2]',
    ':text-is("au") >> xpath=following::input[1]',
  ];

  for (const selector of selectors) {
    if (!selector || selector.includes(',')) continue;
    const el = scope.locator(selector).first();
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    const current = (await el.inputValue().catch(() => '')).trim();
    if (current) return current;
  }

  return readBadgeAuValueViaDom(scope);
}

async function fillBadgeAuDateViaDom(scope, endStr) {
  if (typeof scope.evaluate !== 'function') return false;
  return scope.evaluate(
    ({ val, helper }) => {
      const isVisible = (el) => el && el.offsetParent !== null;
      const setInput = (input) => {
        if (!input || !isVisible(input)) return false;
        input.focus();
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, val);
        else input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        return String(input.value || '').trim() === val;
      };

      const modalRoot =
        document.querySelector('#GB_window') ||
        document.querySelector('[role="dialog"]') ||
        [...document.querySelectorAll('*')].find((el) =>
          /Configuration de Badge/i.test(String(el.textContent || '').slice(0, 80))
        )?.closest('div');

      const searchRoots = modalRoot ? [modalRoot, document.body] : [document.body];

      for (const root of searchRoots) {
        const inputs = [...root.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
        const dateLike = inputs.filter((input) =>
          /^\d{2}\/\d{2}\/\d{4}$/.test(String(input.value || '').trim())
        );
        if (dateLike.length >= 2 && setInput(dateLike[1])) return true;

        const valideNode = [...root.querySelectorAll('*')].find(
          (el) => /^Valide du$/i.test(String(el.textContent || '').trim())
        );
        if (valideNode) {
          let parent = valideNode.parentElement;
          for (let depth = 0; depth < 8 && parent; depth += 1) {
            const near = [...parent.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
            if (near.length >= 2 && setInput(near[1])) return true;
            parent = parent.parentElement;
          }
        }

        const auNode = [...root.querySelectorAll('*')].find(
          (el) => /^au$/i.test(String(el.textContent || '').trim())
        );
        if (auNode) {
          let parent = auNode.parentElement;
          for (let depth = 0; depth < 6 && parent; depth += 1) {
            const near = [...parent.querySelectorAll('input:not([type="hidden"])')].filter(isVisible);
            if (near.length >= 1 && setInput(near[0])) return true;
            parent = parent.parentElement;
          }
        }
      }
      return false;
    },
    { val: endStr, helper: true }
  );
}

async function fillBadgeAuDateViaKeyboard(page, scope, endStr) {
  const keyboard = page.keyboard;
  const selectors = [
    sel('sale_config_modal.valide_au_input'),
    sel('sale_config_modal.valide_au_alt'),
    ':text("Valide du") >> xpath=following::input[2]',
    ':text-is("au") >> xpath=following::input[1]',
  ];

  for (const selector of selectors) {
    if (!selector || selector.includes(',')) continue;
    const el = scope.locator(selector).first();
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ clickCount: 3, force: true }).catch(() => {});
    await keyboard.press('Control+A').catch(() => {});
    await keyboard.type(endStr, { delay: 40 }).catch(() => {});
    await keyboard.press('Tab').catch(() => {});
    const current = (await el.inputValue().catch(() => '')).trim();
    if (isFrDateAtLeast(current, endStr)) return true;
  }

  return false;
}

async function fillBadgeAuDate(page, scope, endStr) {
  const selectors = [
    sel('sale_config_modal.valide_au_input'),
    sel('sale_config_modal.valide_au_alt'),
    ':text("Valide du") >> xpath=following::input[2]',
    ':text-is("au") >> xpath=following::input[1]',
  ];

  for (const selector of selectors) {
    if (!selector || selector.includes(',')) continue;
    const el = scope.locator(selector).first();
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true }).catch(() => {});
    await el.fill('').catch(() => {});
    await el.fill(endStr).catch(() => {});
    await el.press('Tab').catch(() => {});
    const current = (await el.inputValue().catch(() => '')).trim();
    if (isFrDateAtLeast(current, endStr)) return true;
  }

  if (await fillBadgeAuDateViaDom(scope, endStr)) return true;
  if (await fillBadgeAuDateViaKeyboard(page, scope, endStr)) return true;

  const readback = await readBadgeAuValue(scope);
  return isFrDateAtLeast(readback, endStr);
}

async function fillBadgeValideDuDate(scope, startStr) {
  const el = scope.locator(sel('sale_config_modal.valide_du_input')).first();
  if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false))) {
    return fillDateFieldByLabel(scope, /Valide du/i, startStr);
  }
  await el.click({ force: true }).catch(() => {});
  await el.fill(startStr).catch(() => {});
  await el.press('Tab').catch(() => {});
  return true;
}

async function nudgeBadgeModalRecap(page) {
  const modal = await getBadgeConfigModal(page);
  if (!modal) return;
  await modal.getByText(/Configuration de Badge|Récap|Valide du/i).first().click({ force: true }).catch(() => {});
  await randomDelay(400, 700);
}

async function waitForBadgeWarningGone(page, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await readBadgeConfigModalText(page);
    if (!text || !/en dehors de la dur[ée]e de validit[ée]/i.test(text)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function verifyBadgeConfigModalReady(page, delayDays = 7) {
  return waitForBadgeModalRecapReady(page, delayDays, 2000);
}

async function verifyBadgeDeferredSetup(page, delayDays = 7) {
  if (await isBadgeConfigModalOpen(page)) {
    return waitForBadgeModalRecapReady(page, delayDays, 2000);
  }
  return verifyVentePageBadgeDeferred(page, delayDays);
}

async function fillBadgeDatesInConfigModal(page, delayDays = 3, productConfig = {}) {
  await waitForBadgeConfigModal(page, 15000);

  const ctx = await resolveDeciplusWorkPage(page);
  const months = resolveBadgeValidityMonths(productConfig);
  const { startStr, endStr, payStr, validity_months } = badgeScheduleDates(delayDays, months);

  await badgeDomEvaluate(ctx, 'fillDu', startStr);
  let filledAu = await badgeDomEvaluate(ctx, 'fillAu', endStr);
  await fillBadgePaymentDate(page, payStr);
  await randomDelay(500, 800);
  await page.keyboard.press('Escape').catch(() => {});
  await badgeDomEvaluate(ctx, 'closePicker');
  await randomDelay(800, 1200);

  if (!filledAu) {
    filledAu = await fillBadgeAuDateViaDom(ctx, endStr);
  }
  if (!filledAu) {
    filledAu = await fillBadgeAuDateViaKeyboard(page, ctx, endStr);
  }

  await randomDelay(1200, 1800);
  await waitForBadgeWarningGone(page);

  const auReadback = await readBadgeAuValueFromModal(page);
  const ready = await waitForBadgeModalRecapReady(page, delayDays, 12000);

  logInfo('Badge — validité 13 mois + paiement ~72h', {
    valide_du: startStr,
    valide_au: endStr,
    date_paiement: payStr,
    au_readback: auReadback,
    delay_days: delayDays,
    validity_months,
    filled_au: filledAu,
    prelevement_ok: ready,
  });
  return ready;
}

async function waitForModifierDateFinPopup(page, scheduleOrDays, { attempts = 6, intervalMs = 600 } = {}) {
  const schedule =
    scheduleOrDays && typeof scheduleOrDays === 'object' && scheduleOrDays.endStr
      ? scheduleOrDays
      : badgeScheduleDates(3);
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await adjustBadgeEndDate(page, schedule)) return true;
    } catch (err) {
      logWarn('Badge — popup date de fin', { error: err.message, attempt: i + 1 });
    }
    if (await fillBadgeContractDates(page, schedule)) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

async function dismissPostApplyDialogs(page, { allowRib = false } = {}) {
  await handleBadgeModifierDateFinDialog(page).catch(() => false);
  await clickFirst(page, sel('sale_config_modal.ignorer_continuer')).catch(() => {});
  if (allowRib) {
    await clickFirst(page, sel('sale_config_modal.saisir_rib')).catch(() => {});
  }
  await randomDelay(400, 700);
}

async function finalizeBadgePayment(page) {
  await dismissPostApplyDialogs(page, { allowRib: false });
  await randomDelay(250, 450);

  // Après Appliquer différé, Deciplus peut exiger un mode de paiement avant Clôturer
  await clickFirst(page, sel('payment_finalize.virement')).catch(() => {});
  await randomDelay(200, 350);

  let clotured = await clickVenteFooterAction(page, /Cl[ôo]turer(\s+la\s+note)?/i);
  if (!clotured) {
    clotured = await clickFirst(page, sel('payment_finalize.cloturer'));
  }
  if (!clotured) {
    // Repli : bouton visible dans footer / barre
    clotured = await clickFirst(
      page,
      'button:has-text("Clôturer"), button:has-text("Cloturer"), input[value*="Clôturer"], input[value*="Cloturer"]',
      { force: true }
    );
  }
  if (!clotured) {
    throw new Error('Badge — « Clôturer la note » introuvable');
  }
  logInfo('Badge — note clôturée');
  await randomDelay(500, 800);

  let done = await clickTerminerVente(page);
  if (!done) {
    done = await clickVenteFooterAction(page, /\bTerminer\b/i, { preferClass: 'verticalDocumentBar' });
  }
  if (!done) {
    done = await clickFirst(page, sel('payment_finalize.terminer'));
  }
  if (!done) {
    throw new Error('Badge — bouton « Terminer » introuvable');
  }

  logInfo('Paiement finalisé Deciplus', { mode: 'prelevement_differe', badge_differe: true });
}

async function configureBadgeDeferredDates(page, scheduleOrDays) {
  const schedule =
    scheduleOrDays && typeof scheduleOrDays === 'object' && scheduleOrDays.endStr
      ? scheduleOrDays
      : badgeScheduleDates(3);
  if (await waitForModifierDateFinPopup(page, schedule)) return true;
  if (await fillBadgeContractDates(page, schedule)) return true;

  if (await fillBadgeEndDateFields(page, schedule) && (await applyContractDateChange(page))) {
    return true;
  }

  logWarn('Badge — panneau date introuvable sur vente', {
    url: page.url(),
    has_action: (await page.getByText(/Action souhaitée/i).count()) > 0,
    has_date_fin: (await page.getByText(/Date de fin/i).count()) > 0,
    has_virement: (await page.getByText(/Virement/i).count()) > 0,
  });
  return false;
}

async function fillBadgePaymentDate(page, dateStr) {
  // Saisie clavier réelle : le datepicker Element-UI ignore parfois la valeur DOM,
  // le v-model ne se met à jour qu'avec une frappe + Enter.
  const typed = await typeBadgePaymentDate(page, dateStr).catch(() => false);
  if (typed) return true;

  const ctx = await resolveDeciplusWorkPage(page);
  const ok = await badgeDomEvaluate(ctx, 'fillPaymentDate', dateStr);
  if (ok) {
    logInfo('Badge — Date de paiement forcée (repli DOM)', { date_paiement: dateStr });
  }
  return Boolean(ok);
}

async function typeBadgePaymentDate(page, dateStr) {
  const ctx = await resolveDeciplusWorkPage(page);
  const marked = await badgeDomEvaluate(ctx, 'markPaymentDate');
  if (!marked) return false;
  try {
    const input = ctx.locator('input[data-bc-paydate="1"]').first();
    if ((await input.count()) === 0) return false;
    await input.click({ force: true });
    await input.press('Control+a').catch(() => {});
    await input.fill('').catch(() => {});
    await input.type(dateStr, { delay: 40 });
    await input.press('Enter');
    await randomDelay(300, 600);
    const value = ((await input.inputValue().catch(() => '')) || '').trim();
    const okTyped = value === dateStr;
    if (okTyped) {
      logInfo('Badge — Date de paiement saisie au clavier', { date_paiement: dateStr });
    }
    return okTyped;
  } finally {
    await ctx
      .evaluate(() => {
        document
          .querySelectorAll('input[data-bc-paydate]')
          .forEach((el) => el.removeAttribute('data-bc-paydate'));
      })
      .catch(() => {});
  }
}

async function applyBadgeConfigModal(page, productConfig, _memberId = null) {
  await randomDelay(400, 700);
  await ensureBadgeConfigModalForSale(page);

  if (!(await isBadgeConfigModalOpen(page))) {
    await captureBadgeDebugScreenshot(page, 'modal-missing');
    throw new Error('Badge — modale Configuration de Badge introuvable');
  }

  const delayDays = resolveBadgePrelevementDelayDays(productConfig);
  const months = resolveBadgeValidityMonths(productConfig);
  const timing = String(productConfig.badge_timing || 'deferred').toLowerCase();
  const immediate = timing === 'immediate' || productConfig.paiement_comptant === true;
  const schedule = badgeScheduleDates(delayDays, months);
  const startStr = schedule.startStr;
  const endStr = schedule.endStr;
  const payStr = immediate ? startStr : schedule.payStr;

  if (immediate) {
    logInfo('Badge — paiement immédiat (Comptant)', {
      badge_timing: timing,
      badge_method: productConfig.badge_method || null,
    });
  } else {
    await ensurePaiementComptantOff(page, { strict: true });
    await randomDelay(200, 400);
    const ctx = await resolveDeciplusWorkPage(page);
    await badgeDomEvaluate(ctx, 'fillDu', startStr).catch(() => false);
    await badgeDomEvaluate(ctx, 'fillAu', endStr).catch(() => false);
    await fillBadgePaymentDate(page, payStr);
    await randomDelay(200, 400);
  }

  const clicked = await clickBadgeModalAppliquer(page);
  if (!clicked) {
    const fallback = await clickFirst(
      page,
      [
        'button.ari-button-filled:has-text("Appliquer")',
        'button.ari-button:has-text("Appliquer")',
        'button:has-text("Appliquer"):not(:has-text("Quitter"))',
        sel('sale_config_modal.appliquer'),
      ].join(', '),
      { force: true }
    );
    if (!fallback) {
      await captureBadgeDebugScreenshot(page, 'appliquer-missing');
      throw new Error('Badge — bouton Appliquer introuvable dans Configuration de Badge');
    }
  }

  await randomDelay(500, 800);

  let dateFinOk = false;
  let payDateOk = false;

  if (!immediate) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const textModal = (await readBadgeConfigModalText(page).catch(() => '')) || '';
      const venteText =
        textModal ||
        ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 4000);
      const payDate = extractBadgePaymentDate(venteText);
      const minPay = minBadgePaymentDate(delayDays);
      const maxPay = new Date();
      maxPay.setDate(maxPay.getDate() + delayDays + 2);
      maxPay.setHours(23, 59, 59, 999);
      const parsed = parseFrDate(payDate);
      const inWindow = parsed && parsed >= minPay && parsed <= maxPay;
      if (inWindow) {
        payDateOk = true;
        dateFinOk = true;
        break;
      }
      if (attempt === 0) {
        if (!(await isBadgeConfigModalOpen(page))) {
          await reopenBadgeConfigModal(page).catch(() => false);
        }
        const ctx2 = await resolveDeciplusWorkPage(page);
        await badgeDomEvaluate(ctx2, 'fillDu', startStr).catch(() => false);
        await badgeDomEvaluate(ctx2, 'fillAu', endStr).catch(() => false);
        await fillBadgePaymentDate(page, payStr);
        await clickBadgeModalAppliquer(page).catch(() => false);
        await randomDelay(400, 700);
      }
    }
  } else {
    payDateOk = true;
    dateFinOk = true;
  }

  await waitForBadgeModalClosed(page, 8000);
  // Ne jamais ouvrir « Saisir le RIB » sur le badge différé — bloque Clôturer
  await dismissPostApplyDialogs(page, { allowRib: false });
  await randomDelay(300, 500);

  // Repli lent (Action souhaitée / Modifier date) seulement si la date n'est pas OK
  let deferredOk = Boolean(payDateOk);
  if (!immediate && !payDateOk) {
    await configureBadgeDeferredDates(page, schedule).catch((err) => {
      logWarn('Badge — dates contrat post-Appliquer', { error: err.message });
    });
    deferredOk = await verifyBadgeDeferredSetup(page, delayDays).catch(() => false);
  }

  logInfo(
    immediate
      ? 'Badge — Configuration appliquée (paiement immédiat)'
      : 'Badge — Configuration appliquée (échéance J+72h, validité 13 mois)',
    {
      delay_days: immediate ? 0 : delayDays,
      validity_months: months,
      date_debut: startStr,
      date_fin: endStr,
      date_paiement: payStr,
      date_fin_ok: Boolean(dateFinOk),
      pay_date_ok: Boolean(payDateOk),
      deferred_ok: Boolean(deferredOk),
      badge_timing: timing,
      badge_method: productConfig.badge_method || null,
    }
  );

  if (!immediate && !payDateOk && !deferredOk) {
    logWarn('Badge — Date de paiement peut encore être au défaut Deciplus (ex. fin de mois)', {
      expected: payStr,
    });
  }
}

async function togglePaiementComptantOff(page) {
  return ensurePaiementComptantOff(page);
}

async function openSaleFlow(page, productConfig, gymConfig, saleKind) {
  await closeGreyboxIfOpen(page);
  await dismissJqueryUiOverlay(page).catch(() => {});

  // check.php est dans nextgen/legacy iframe (_vue_iframe) — boutons = input.fichemembre_button
  const checkCtx = await getMemberCheckContext(page, { waitMs: 20000 });
  const buttonKey = saleKind === 'carte' ? 'member_check.achat_carte' : 'member_check.achat_abonnement';
  const clicked = await clickFirst(checkCtx, sel(buttonKey), { force: true });
  if (!clicked) {
    // Repli : clic via evaluate dans l'iframe
    const fallbackValue = saleKind === 'carte' ? 'Achat Carte' : 'Achat Abonnement';
    const forced = await checkCtx
      .evaluate((value) => {
        const btn = document.querySelector(
          `input.fichemembre_button[value="${value}"], input[type="button"][value="${value}"]`
        );
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      }, fallbackValue)
      .catch(() => false);
    if (!forced) {
      throw new Error(`Bouton vente Deciplus introuvable (${buttonKey}) — url=${page.url()}`);
    }
  }

  await page.waitForURL(/nextgen|vente|choose-zone/, { timeout: 20000 }).catch(() => {});
  await randomDelay(800, 1500);

  // Critical : sans sortir de choose-zone, le champ « Rechercher un produit » n'existe pas
  await ensureDeciplusSaleZone(page, gymConfig);

  if (await isChooseZoneScreen(page)) {
    throw new Error(
      `Catalogue vente bloqué sur choose-zone (salle=${gymConfig.deciplus_label || gymConfig.label || '?'}, url=${page.url()})`
    );
  }

  await page.waitForURL(/vente/, { timeout: 20000 }).catch(() => {});
  await randomDelay(1000, 2000);

  const catalogCtx = await resolveVenteCatalogContext(page, { timeoutMs: 25000 });
  if (!catalogCtx) {
    throw new Error(
      `Catalogue Deciplus (recherche produit) introuvable après ouverture vente — url=${page.url()}`
    );
  }

  await selectProductInCatalog(page, productConfig);
}

async function applyConfigModal(page, productConfig, memberId = null) {
  if (isBadgeSale(productConfig)) {
    return applyBadgeConfigModal(page, productConfig, memberId);
  }

  await page.locator('[role="dialog"]').first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});

  if (productConfig.paiement_comptant === true) {
    // Offre déjà payée Stripe : laisser / forcer Paiement Comptant ON, pas de RIB
    await ensurePaiementComptantOn(page, { strict: true });
  } else if (productConfig.paiement_comptant === false) {
    await ensurePaiementComptantOff(page);
  }

  if (productConfig.restore_start_fr || productConfig.restore_end_fr) {
    const dateCtx = await resolveDeciplusWorkPage(page);
    if (productConfig.restore_start_fr) {
      await badgeDomEvaluate(dateCtx, 'fillDu', productConfig.restore_start_fr).catch(() => false);
    }
    if (productConfig.restore_end_fr) {
      await badgeDomEvaluate(dateCtx, 'fillAu', productConfig.restore_end_fr).catch(() => false);
    }
    logInfo('Vente Deciplus — dates abo restaurées', {
      start: productConfig.restore_start_fr,
      end: productConfig.restore_end_fr,
    });
  }

  if (
    productConfig.requires_iban &&
    !productConfig.skip_rib_prompt &&
    productConfig.paiement_comptant !== true
  ) {
    await clickFirst(page, sel('sale_config_modal.saisir_rib')).catch(() => {});
  }

  const work = await resolveDeciplusWorkPage(page);
  let applied = await clickFirst(work, sel('sale_config_modal.appliquer'), {
    force: true,
  }).catch(() => false);
  if (!applied) {
    applied = await clickVenteFooterAction(page, /\bAppliquer\b/i, { exact: true });
  }
  if (!applied) {
    throw new Error('Vente Deciplus — bouton « Appliquer » introuvable');
  }
  logInfo('Vente Deciplus — configuration appliquée');
  await randomDelay(600, 1000);
  let ignored = await clickFirst(work, sel('sale_config_modal.ignorer_continuer'), {
    force: true,
  }).catch(() => false);
  if (!ignored) {
    ignored = await clickVenteFooterAction(page, /Ignorer et continuer/i, {
      exact: true,
    }).catch(() => false);
  }
  if (ignored) {
    logInfo('Vente Deciplus — étape RIB ignorée');
    await randomDelay(600, 1000);
  }
}

async function finalizePayment(page, productConfig) {
  const mode = productConfig.payment_mode || 'virement';
  const badge = isBadgeSale(productConfig);

  if (badge) {
    await finalizeBadgePayment(page);
    return;
  }

  // Comptant Stripe : Deciplus est déjà soldé via Paiement Comptant — Clôturer / Terminer
  if (productConfig.paiement_comptant === true) {
    const work = await resolveDeciplusWorkPage(page);
    let cardRecorded = await clickFirst(work, sel('payment_finalize.carte_bancaire'), {
      force: true,
    }).catch(() => false);
    if (!cardRecorded) {
      cardRecorded = await clickVenteFooterAction(page, /Carte Bancaire/i, {
        exact: true,
      });
    }
    if (!cardRecorded) {
      throw new Error('Vente comptant — mode de paiement « Carte Bancaire » introuvable');
    }
    logInfo('Vente comptant — règlement CB enregistré');
    await randomDelay(800, 1200);

    let clotured = await clickVenteFooterAction(page, /Cl[ôo]turer(\s+la\s+note)?/i);
    if (!clotured) {
      clotured = await clickFirst(work, sel('payment_finalize.cloturer'), { force: true }).catch(
        () => false
      );
    }
    let done = false;
    if (clotured) {
      await randomDelay(800, 1200);
      done = await clickTerminerVente(page);
      if (!done) {
        done = await clickVenteFooterAction(page, /\bTerminer\b/i, {
          preferClass: 'verticalDocumentBar',
        });
      }
    }

    // Selon la version Deciplus, « Appliquer » enregistre immédiatement la vente
    // comptant et aucun footer Clôturer/Terminer n'est affiché. La vérification
    // stricte du contrat exécutée juste après décide alors du succès réel.
    if (!done) {
      logWarn('Vente comptant — aucun footer de finalisation, vérification du contrat requise', {
        ui: await venteUiSnapshot(page).catch(() => []),
        screenshot: await captureSaleDebugScreenshot(page, 'comptant-finalize-missing'),
      });
    }
    logInfo('Paiement finalisé Deciplus', { mode: 'comptant', badge_differe: false });
    return;
  }

  if (mode === 'virement') {
    await clickFirst(page, sel('payment_finalize.virement'));
  } else if (mode === 'card' || mode === 'cb') {
    await clickFirst(page, sel('payment_finalize.carte_bancaire'));
  }

  await clickFirst(page, sel('payment_finalize.cloturer'));
  await clickFirst(page, sel('payment_finalize.terminer'));
  logInfo('Paiement finalisé Deciplus', { mode, badge_differe: badge });
}

async function buyAbonnement(page, productConfig, gymConfig) {
  await openSaleFlow(page, productConfig, gymConfig, 'abonnement');
  await applyConfigModal(page, productConfig);
  await finalizePayment(page, productConfig);

  return { action: 'abonnement_created', sale_type: 'abonnement' };
}

async function buyCarteBadge(page, productConfig, gymConfig, memberId = null) {
  await openSaleFlow(page, productConfig, gymConfig, 'carte');
  await applyConfigModal(page, productConfig, memberId);
  await finalizePayment(page, productConfig);

  return { action: 'carte_badge_created', sale_type: 'carte' };
}

async function annotateMember(page, order, productConfig, memberId = null) {
  const { buildFourXInfoComptaNote } = require('../lib/info-compta-note');
  try {
    const { getMemberFormContext, openMemberEditForm } = require('./member');
    if (memberId) {
      await openMemberEditForm(page, memberId).catch(() => {});
      await page.waitForTimeout(800);
    } else {
      const ficheLink = page.locator('a').filter({ hasText: /Fiche d[eé]taill/i }).first();
      if ((await ficheLink.count()) > 0 && (await ficheLink.isVisible().catch(() => false))) {
        await ficheLink.click().catch(() => {});
        await page.waitForTimeout(800);
      }
    }

    const ctx = await getMemberFormContext(page, { waitMs: 6000 });
    const ta = ctx
      .locator('textarea[name="info_compta"], input[name="info_compta"], textarea#info_compta')
      .first();
    if ((await ta.count()) === 0) {
      logWarn('Annotation — champ info_compta introuvable');
      return;
    }

    const current = String((await ta.inputValue().catch(() => '')) || '');
    const fourXNote = buildFourXInfoComptaNote(order, productConfig);

    if (fourXNote) {
      await ta.fill(fourXNote);
      logInfo('Info Compte/Paiement — note 4× sans frais écrite', {
        order_id: order?.order_id,
        member_id: memberId,
        chars: fourXNote.length,
      });
    } else if (/Source:\s*|Produit:\s*|UTM\s|Commande:\s*|Montant PrestaShop|4× sans frais|4x sans frais/i.test(current)) {
      await ta.fill('');
      logInfo('Note info_compta nettoyée (pas de 4×)');
    } else {
      return;
    }

    const update = ctx
      .locator(
        'input[type="submit"][value*="Mettre"], button:has-text("Mettre à jour"), input[name="update"], input[type="submit"][value*="Valider"]'
      )
      .first();
    if ((await update.count()) > 0) {
      await update.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  } catch (err) {
    logWarn('Annotation info_compta ignorée', { error: err.message });
  }
}

async function verifyCreatedContract(page, memberId, { badge = false, label = '' } = {}) {
  const { findActiveContracts } = require('./cancel-sale');
  const maxAttempts = badge ? 4 : 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await closeGreyboxIfOpen(page).catch(() => {});
    await openMemberCheck(page, memberId).catch(() => {});
    await randomDelay(badge ? 500 : 700, badge ? 800 : 1100);
    const contracts = await findActiveContracts(page).catch(() => []);
    const contract = contracts.find((item) => Boolean(item.isBadge) === Boolean(badge));
    if (contract) {
      logInfo('Contrat Deciplus vérifié après vente', {
        member_id: memberId,
        idc: contract.idc,
        expected: label || (badge ? 'Badge' : 'Abonnement'),
        contract: contract.label,
      });
      return contract;
    }
    await page.waitForTimeout(badge ? 500 : 800);
  }
  throw new Error(
    `Vente Deciplus non confirmée : contrat ${badge ? 'badge' : 'abonnement'} absent de la fiche membre ${memberId}`
  );
}

async function recordSale(page, order, productConfig, memberId, gymConfig = {}, options = {}) {
  if (productConfig.create_sale === false || productConfig.sale_type === 'none') {
    logInfo('Essai — fiche membre seulement', { order_id: order.order_id });
    if (memberId) await openMemberCheck(page, memberId);
    return { sale_id: null, action: 'skipped_essai' };
  }

  if (!memberId) {
    logWarn('Pas de member_id', { order_id: order.order_id });
    return { sale_id: null, action: 'no_member_id', manual_review: true };
  }

  await closeGreyboxIfOpen(page);
  await dismissJqueryUiOverlay(page).catch(() => {});
  await openMemberCheck(page, memberId);
  await dismissJqueryUiOverlay(page).catch(() => {});
  await annotateMember(page, order, productConfig, memberId).catch((err) => {
    logWarn('Annotation fiche membre ignorée', { error: err.message });
  });
  // Après Mettre à jour, revenir sur check.php (iframe) pour Achat Abonnement / Carte
  await closeGreyboxIfOpen(page);
  await openMemberCheck(page, memberId);
  await randomDelay(1000, 1800);

  let result;
  const { badgeProductConfig } = options;

  if (productConfig.sale_type === 'carte') {
    result = await buyCarteBadge(page, productConfig, gymConfig, memberId);
    const badgeContract = await verifyCreatedContract(page, memberId, {
      badge: true,
      label: productConfig.name || productConfig.title || 'Badge',
    });
    result.sale_id = badgeContract.idc;
    const enforce = await enforceBadgeEcheance(page, memberId, productConfig).catch((err) => ({
      ok: false,
      reason: err.message,
    }));
    result.badge_echeance_ok = enforce.ok;
    if (!enforce.ok) {
      result.manual_review = true;
      result.badge_error = `Échéance badge J+${resolveBadgePrelevementDelayDays(productConfig)} non confirmée (${enforce.reason || 'inconnue'})`;
    }
  } else if (productConfig.sale_type === 'abonnement') {
    result = await buyAbonnement(page, productConfig, gymConfig);
    const subscriptionContract = await verifyCreatedContract(page, memberId, {
      badge: false,
      label: productConfig.name || productConfig.title || order.product_name,
    });
    result.sale_id = subscriptionContract.idc;

    if (badgeProductConfig) {
      logInfo('Création badge après abonnement', { member_id: memberId, order_id: order.order_id });
      await closeGreyboxIfOpen(page);
      await openMemberCheck(page, memberId);
      await randomDelay(400, 700);
      try {
        const badgeResult = await buyCarteBadge(page, badgeProductConfig, gymConfig, memberId);
        result.badge_action = badgeResult.action;
        const badgeContract = await verifyCreatedContract(page, memberId, {
          badge: true,
          label: badgeProductConfig.name || badgeProductConfig.title || 'Badge',
        });
        result.badge_sale_id = badgeContract.idc;
        const enforce = await enforceBadgeEcheance(page, memberId, badgeProductConfig).catch(
          (err) => ({ ok: false, reason: err.message })
        );
        result.badge_echeance_ok = enforce.ok;
        if (!enforce.ok) {
          result.manual_review = true;
          result.badge_error = `Échéance badge J+${resolveBadgePrelevementDelayDays(badgeProductConfig)} non confirmée (${enforce.reason || 'inconnue'})`;
        }
      } catch (err) {
        logWarn('Badge non créé — prélèvement différé requis', {
          order_id: order.order_id,
          member_id: memberId,
          error: err.message,
        });
        result.badge_action = 'badge_failed';
        result.badge_error = err.message;
        result.manual_review = true;
      }
    }
  } else {
    return { sale_id: null, action: 'unknown_sale_type', manual_review: true };
  }

  logInfo('Vente Deciplus enregistrée', {
    order_id: order.order_id,
    offer: order.offer,
    sale_type: productConfig.sale_type,
    badge_action: result.badge_action || null,
  });

  return { sale_id: result.sale_id || null, ...result, member_id: memberId };
}

/**
 * Vérification post-vente : ouvre le contrat badge et force l'échéance à J+delayDays
 * via « Reporter » si Deciplus a gardé sa date par défaut (ex. fin de mois).
 */
async function enforceBadgeEcheance(page, memberId, badgeConfig = {}) {
  const timing = String(badgeConfig.badge_timing || 'deferred').toLowerCase();
  if (timing === 'immediate' || badgeConfig.paiement_comptant === true) {
    return { ok: true, skipped: true };
  }
  const delayDays = resolveBadgePrelevementDelayDays(badgeConfig);
  const schedule = badgeScheduleDates(delayDays, resolveBadgeValidityMonths(badgeConfig));
  const expected = schedule.payStr;
  const expectedIso = schedule.payDate.toISOString().slice(0, 10);

  const { findActiveContracts, contractUrl } = require('./cancel-sale');
  await closeGreyboxIfOpen(page);
  await openMemberCheck(page, memberId);
  await randomDelay(500, 800);

  const contracts = await findActiveContracts(page).catch(() => []);
  const badge = contracts.find((c) => c.isBadge);
  if (!badge) {
    logWarn('Badge — contrat introuvable pour vérification échéance', { member_id: memberId });
    return { ok: false, reason: 'badge_contract_not_found' };
  }

  // Si la fiche affiche déjà la bonne date, pas besoin d'ouvrir le contrat
  const ficheText = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 8000);
  if (ficheText.includes(expected) && /badge/i.test(ficheText)) {
    logInfo('Badge — échéance déjà correcte sur la fiche', { expected, member_id: memberId });
    return { ok: true, expected, via: 'member_check' };
  }

  await page
    .goto(contractUrl(badge.idc), { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch(() => {});
  await page.getByText(/Échéances/i).first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
  await randomDelay(800, 1200);

  const contractText = ((await page.locator('body').innerText().catch(() => '')) || '')
    .replace(/\s+/g, ' ')
    .trim();
  const dueSection = contractText.match(
    /date de l['’]échéance\s+état\s+montant[\s\S]{0,220}?(\d{2}\/\d{2}\/\d{4})/i
  );
  const currentDate = dueSection?.[1] || null;

  if (/Suspendu/i.test(contractText)) {
    const resume = page
      .locator(
        'i.fa-play-circle[title*="Reprendre" i], i.fa-play-circle[title*="Réactiver" i], [class*="play-circle" i]'
      )
      .last();
    if ((await resume.count()) > 0 && (await resume.isVisible().catch(() => false))) {
      await resume.click({ force: true }).catch(() => {});
      await randomDelay(600, 900);
      logInfo('Badge — échéance suspendue réactivée avant vérification');
    }
  }

  if (currentDate === expected) {
    logInfo('Badge — échéance déjà correcte sur le contrat', {
      member_id: memberId,
      idc: badge.idc,
      date_echeance: expected,
    });
    return { ok: true };
  }

  // La page contrat compacte les actions : ouvrir d'abord le détail des échéances.
  const allPayments = page.getByText(/voir toutes les échéances/i).first();
  if ((await allPayments.count()) > 0 && (await allPayments.isVisible().catch(() => false))) {
    await allPayments.click({ force: true }).catch(() => {});
    await randomDelay(900, 1400);
  }

  // Bouton « Reporter » sur la première échéance en attente
  let reporter = page
    .locator(
      'button:has-text("Reporter"), a:has-text("Reporter"), input[value*="Reporter"], [title*="Reporter" i], [aria-label*="Reporter" i]'
    )
    .first();
  if ((await reporter.count()) === 0 || !(await reporter.isVisible().catch(() => false))) {
    logWarn('Badge — bouton Reporter introuvable sur le contrat', {
      member_id: memberId,
      idc: badge.idc,
      expected,
      current: currentDate,
      row: dueSection?.[0]?.slice(0, 240) || '',
      ui: await venteUiSnapshot(page).catch(() => []),
      screenshot: await captureSaleDebugScreenshot(page, 'badge-contract-reporter-missing'),
    });
    return { ok: false, reason: 'reporter_not_found' };
  }
  await reporter.click({ force: true }).catch(() => {});
  await randomDelay(900, 1500);

  // Renseigner la nouvelle date dans la popup (input date ISO ou texte JJ/MM/AAAA)
  const filled = await page
    .evaluate(
      ({ fr, iso }) => {
        const setVal = (el, value) => {
          const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
          const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const dialogs = Array.from(
          document.querySelectorAll('[role="dialog"], .modal, .el-dialog, .ari-modal, .greybox, body')
        );
        for (const scope of dialogs) {
          const inputs = Array.from(scope.querySelectorAll('input')).filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !el.disabled && el.type !== 'hidden';
          });
          for (const el of inputs) {
            const hint = `${el.type} ${el.placeholder || ''} ${el.name || ''} ${el.className || ''}`;
            if (el.type === 'date') {
              setVal(el, iso);
              return true;
            }
            if (/date|jj\/mm|echeance|échéance/i.test(hint) || /\d{2}\/\d{2}\/\d{4}/.test(el.value)) {
              setVal(el, fr);
              return true;
            }
          }
        }
        return false;
      },
      { fr: expected, iso: expectedIso }
    )
    .catch(() => false);

  if (!filled) {
    logWarn('Badge — champ date Reporter introuvable', { member_id: memberId, idc: badge.idc });
  }

  await clickFirst(
    page,
    'button:has-text("Valider"), button:has-text("Confirmer"), button:has-text("Appliquer"), button:has-text("Enregistrer"), input[value*="Valider"]',
    { force: true }
  ).catch(() => {});
  await randomDelay(1200, 2000);

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await randomDelay(900, 1400);
  const updatedText = ((await page.locator('body').innerText().catch(() => '')) || '')
    .replace(/\s+/g, ' ')
    .trim();
  const updatedDate =
    updatedText.match(
      /date de l['’]échéance\s+état\s+montant[\s\S]{0,220}?(\d{2}\/\d{2}\/\d{4})/i
    )?.[1] || null;
  const ok = updatedDate === expected;
  if (ok) {
    logInfo('Badge — échéance reportée à J+' + delayDays, {
      member_id: memberId,
      idc: badge.idc,
      date_echeance: expected,
    });
  } else {
    logWarn('Badge — report échéance non confirmé', {
      member_id: memberId,
      idc: badge.idc,
      expected,
      actual: updatedDate,
      ui: await venteUiSnapshot(page).catch(() => []),
      screenshot: await captureSaleDebugScreenshot(page, 'badge-report-not-confirmed'),
    });
  }
  return { ok, reason: ok ? null : 'not_confirmed' };
}

async function cancelSaleOnMember(page, memberId) {
  return cancelSale(page, memberId);
}

module.exports = {
  recordSale,
  enforceBadgeEcheance,
  openSaleFlow,
  togglePaiementComptantOff,
  cancelSale: cancelSaleOnMember,
  buyAbonnement,
  buyCarteBadge,
};
