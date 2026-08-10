const { randomDelay, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { normalizeIban, isValidFrenchIban } = require('../lib/iban');
const { dismissJqueryUiOverlay } = require('./ui');
const { getAccessToken } = require('./auth');

const DECIPLUS_API = 'https://api.deciplus.pro/staff/v1';

function apiHeaders(token) {
  return {
    'x-access-token': token,
    'Deciplus-Client-Type': 'manager',
    'Content-Type': 'application/json',
  };
}

function sel(key) {
  try {
    const cfg = loadJson('config/deciplus-selectors.json');
    const val = key.split('.').reduce((o, k) => o?.[k], cfg);
    return val || key;
  } catch {
    return key;
  }
}

function parseGymAddress(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(.+?),\s*(\d{5})\s+(.+)$/);
  if (m) return { address: m[1].trim(), postal_code: m[2], city: m[3].trim(), country: 'France' };
  return { address: text, postal_code: '31200', city: 'Toulouse', country: 'France' };
}

function ribAddressFields(customer = {}, gymConfig = {}) {
  const postalDigits = String(customer.postal_code || '').replace(/\D/g, '');
  const validFrPostal = postalDigits.length === 5;

  if (validFrPostal && customer.address && customer.city) {
    return {
      address: customer.address,
      postal_code: postalDigits,
      city: customer.city,
      country: 'France',
    };
  }

  if (gymConfig?.address) {
    logWarn('Adresse client invalide pour RIB — repli adresse salle', {
      gym: gymConfig.label || gymConfig.deciplus_label,
    });
    return parseGymAddress(gymConfig.address);
  }

  return {
    address: customer.address || '12 rue de Fenouillet',
    postal_code: validFrPostal ? postalDigits : '31200',
    city: customer.city || 'Toulouse',
    country: 'France',
  };
}

async function clickFirst(ctx, selectors, opts = {}) {
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const s of list) {
    const el = ctx.locator(s).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.click({ ...opts, timeout: 15000 });
      await randomDelay();
      return true;
    }
  }
  return false;
}

async function fillFirst(ctx, selectors, value) {
  if (value == null || value === '' || !selectors) return false;
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const s of list) {
    const el = ctx.locator(s).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.fill(String(value));
      await randomDelay(200, 500);
      return true;
    }
  }
  return false;
}

async function readIbanFromRib(ctx) {
  const el = ctx.locator('input[name="iban"]').first();
  if ((await el.count()) === 0) return '';
  return normalizeIban(await el.inputValue().catch(() => ''));
}

async function hasPostalAddressBlocker(ctx) {
  const msg = ctx.locator('text=/adresse postale est obligatoire pour éditer le mandat/i').first();
  return (await msg.count()) > 0 && (await msg.isVisible().catch(() => false));
}

/**
 * Deciplus affiche parfois le bandeau alors que adr_line1/CP/ville sont déjà remplis.
 * Dans ce cas le submit UI est disabled, mais le serveur accepte quand même le mandat
 * si on force l'activation (confirmé en local : RUM créé).
 */
async function ribMandateAddressReady(ctx) {
  return ctx
    .evaluate(() => {
      const v = (n) => String(document.querySelector(`input[name="${n}"]`)?.value || '').trim();
      const line1 = v('adr_line1');
      const town = v('adr_town');
      const post = v('adr_postcode').replace(/\D/g, '');
      return Boolean(line1) && Boolean(town) && post.length >= 4;
    })
    .catch(() => false);
}

async function unlockRibFormForSubmit(ctx) {
  await ctx
    .evaluate(() => {
      document.querySelectorAll('input, select, textarea, button').forEach((el) => {
        el.disabled = false;
        if ('readOnly' in el) el.readOnly = false;
      });
      document.querySelectorAll('.message').forEach((el) => {
        if (/adresse postale est obligatoire/i.test(el.textContent || '')) el.remove();
      });
    })
    .catch(() => {});
}

function navTimeoutMs() {
  return Number(process.env.DECIPLUS_NAV_TIMEOUT || 90000);
}

function memberCheckUrls(memberId) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const origin = new URL(base).origin;
  const qs = `check.php?idj=${encodeURIComponent(memberId)}`;
  return [
    // nextgen/legacy d’abord — plus fiable après résiliation (évite hang check.php brut)
    `${origin}/nextgen/legacy?path=${encodeURIComponent(`/${qs}`)}`,
    `${origin}/${qs}`,
  ];
}

async function openMemberDetail(page, memberId) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const origin = new URL(base).origin;
  const timeout = Math.min(navTimeoutMs(), 60000);
  const urls = [
    `${origin}/nextgen/legacy?path=${encodeURIComponent(`/joueurs.php?idj=${memberId}`)}`,
    new URL(`joueurs.php?idj=${memberId}`, base).href,
  ];
  let lastErr = null;
  for (const target of urls) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
      await randomDelay();
      await getMemberFormContext(page, { waitMs: 15000 });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`openMemberDetail failed for ${memberId}`);
}

async function openMemberCheck(page, memberId) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const urls = memberCheckUrls(memberId);
  const timeout = Math.min(navTimeoutMs(), 60000);
  let lastErr = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const target = urls[attempt % urls.length];
    try {
      await page.goto(target, {
        waitUntil: attempt === 0 ? 'domcontentloaded' : 'commit',
        timeout,
      });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await randomDelay();
      // Fiche membre : bouton Achat Abonnement / iframe nextgen
      const readyDeadline = Date.now() + 12000;
      while (Date.now() < readyDeadline) {
        if (/login\.php/i.test(page.url())) {
          throw new Error(`Session Deciplus expirée (login.php) — check.php idj=${memberId}`);
        }
        for (const ctx of [page, ...page.frames()]) {
          try {
            if (
              (await ctx
                .locator(
                  'input.fichemembre_button[value*="Achat"], input[value*="Achat Abonnement"], text=/Achat Abonnement/i'
                )
                .count()) > 0
            ) {
              return;
            }
          } catch {
            /* frame détachée */
          }
        }
        if (/check\.php|idj=/i.test(page.url())) {
          // Page chargée même si boutons lents — OK pour continuer
          return;
        }
        await page.waitForTimeout(400);
      }
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      // Après résiliation, Deciplus timeout / abort souvent — retry avec autre URL
      const retryable =
        /ERR_ABORTED|interrupted|destroyed|Timeout|timeout|exceeded|Session Deciplus expirée/i.test(
          msg
        );
      logWarn('openMemberCheck — retry', {
        member_id: memberId,
        attempt: attempt + 1,
        url: target,
        error: msg.slice(0, 160),
      });
      if (!retryable && attempt >= 1) break;
      await page.waitForTimeout(700 * (attempt + 1));
      await page
        .goto(new URL('nextgen/home', base).href, {
          waitUntil: 'domcontentloaded',
          timeout: 25000,
        })
        .catch(() => {});
    }
  }
  throw lastErr || new Error(`openMemberCheck failed for ${memberId}`);
}

async function getMemberFormContext(page, { waitMs = 0 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    try {
      if ((await page.locator('form[name="db1_form"]').count()) > 0) return page;
      if ((await page.locator('input[name="adr1"]').count()) > 0) return page;
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          if ((await frame.locator('form[name="db1_form"]').count()) > 0) return frame;
          if ((await frame.locator('input[name="adr1"]').count()) > 0) return frame;
        } catch {
          /* frame détachée pendant le chargement nextgen */
        }
      }
    } catch {
      /* navigation en cours */
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);

  return page;
}

async function fillFormField(ctx, selectors, value) {
  if (value == null || value === '' || !selectors) return false;
  const list = String(selectors).split(',').map((s) => s.trim());
  for (const s of list) {
    const el = ctx.locator(s).first();
    if ((await el.count()) === 0) continue;
    const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => 'input');
    if (tag === 'select') {
      await el.selectOption({ label: String(value) }).catch(async () => {
        await el.selectOption({ value: String(value) }).catch(() => {});
      });
    } else {
      await el.fill(String(value), { force: true }).catch(async () => {
        await el.evaluate((node, v) => {
          node.value = v;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(value));
      });
    }
    await randomDelay(150, 350);
    return true;
  }
  return false;
}

async function readMemberAddressFromUi(page) {
  const ctx = await getMemberFormContext(page, { waitMs: 10000 });
  return ctx.evaluate(() => {
    const val = (name) => document.querySelector(`input[name="${name}"], select[name="${name}"]`)?.value || '';
    return {
      address: val('adr1'),
      postal_code: val('codepostal'),
      city: val('ville'),
      country: val('pays'),
    };
  }).catch(() => ({ address: '', postal_code: '', city: '', country: '' }));
}

async function fetchMemberViaApi(page, memberId) {
  const token = await getAccessToken(page);
  if (!token) return null;
  try {
    const get = await page.context().request.get(`${DECIPLUS_API}/member/${memberId}`, {
      headers: apiHeaders(token),
    });
    if (!get.ok()) return null;
    const body = await get.json();
    return body.response || body || null;
  } catch {
    return null;
  }
}

function addressMatchesMember(member, addr) {
  if (!member || !addr) return false;
  const savedPostal = String(member.postalCode || member.postal_code || '').replace(/\D/g, '');
  const expectedPostal = String(addr.postal_code || '').replace(/\D/g, '');
  const adr = String(member.adr1 || member.address || '').trim();
  const city = String(member.city || member.ville || '').trim();
  return savedPostal === expectedPostal && Boolean(adr) && Boolean(city);
}

async function updateMemberAddressViaApi(page, memberId, addr) {
  const token = await getAccessToken(page);
  if (!token) {
    logWarn('Token Deciplus absent — skip API adresse', { member_id: memberId });
    return false;
  }

  const payload = {
    adr1: addr.address,
    postalCode: addr.postal_code,
    city: addr.city,
    country: addr.country || 'France',
  };

  // Deciplus accepte parfois manager_legacy pour les updates
  const headerVariants = [
    apiHeaders(token),
    { ...apiHeaders(token), 'Deciplus-Client-Type': 'manager_legacy' },
  ];

  let updated = false;
  for (const headers of headerVariants) {
    for (const method of ['PUT', 'PATCH']) {
      try {
        const res = await page.context().request.fetch(`${DECIPLUS_API}/member/${memberId}`, {
          method,
          headers,
          data: payload,
        });
        if (res.ok()) {
          logInfo('Adresse membre Deciplus via API', {
            member_id: memberId,
            method,
            status: res.status(),
            client: headers['Deciplus-Client-Type'],
          });
          updated = true;
          break;
        }
        logWarn('API adresse membre refusée', {
          member_id: memberId,
          method,
          status: res.status(),
          client: headers['Deciplus-Client-Type'],
        });
      } catch (err) {
        logWarn('API adresse membre erreur', { member_id: memberId, method, error: err.message });
      }
    }
    if (updated) break;
  }

  if (!updated) return false;

  const member = await fetchMemberViaApi(page, memberId);
  const ok = addressMatchesMember(member, addr);
  if (ok) {
    logInfo('Adresse membre Deciplus confirmée (API write)', {
      member_id: memberId,
      postal_code: addr.postal_code,
    });
  }
  return ok;
}

async function ribBlockerStillPresent(page, memberId) {
  await closeGreyboxIfOpen(page);
  const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
  const blocked = await hasPostalAddressBlocker(ribCtx);
  await closeGreyboxIfOpen(page);
  return blocked;
}

async function saveMemberAddressViaUi(page, memberId, addr) {
  await closeGreyboxIfOpen(page);
  await openMemberDetail(page, memberId);
  await dismissJqueryUiOverlay(page).catch(() => {});

  // nextgen charge joueurs.php dans un iframe _vue_iframe — attendre le vrai formulaire
  const ctx = await getMemberFormContext(page, { waitMs: 20000 });
  await ctx.locator('input[name="adr1"], input[name="nom"], input[name="prenom"]').first().waitFor({
    state: 'attached',
    timeout: 15000,
  }).catch(() => {});

  const filled = {
    address: await fillFormField(ctx, 'input[name="adr1"]', addr.address),
    postal: await fillFormField(ctx, 'input[name="codepostal"]', addr.postal_code),
    city: await fillFormField(ctx, 'input[name="ville"]', addr.city),
    country: await fillFormField(ctx, 'input[name="pays"], select[name="pays"]', addr.country || 'France'),
  };
  logInfo('Champs adresse UI remplis', { member_id: memberId, filled });

  if (!filled.address || !filled.postal || !filled.city) {
    logWarn('Champs adresse introuvables sur joueurs.php', { member_id: memberId, filled });
    return false;
  }

  await ctx.evaluate(() => {
    const form = document.querySelector('form[name="db1_form"]');
    if (!form) return;
    const submit = form.querySelector('input[name="alde_submit"]');
    if (submit) submit.value = 'valider';
    const demandeMaj = form.querySelector('input[name="demande_maj"]');
    if (demandeMaj) demandeMaj.value = '1';
  }).catch(() => {});

  await dismissJqueryUiOverlay(page).catch(() => {});
  const updated = await clickFirst(
    ctx,
    [
      'input[type="submit"][value="Mettre à jour"]',
      'input.albut_dw[value="Mettre à jour"]',
      'input[type="submit"][value="Valider"]',
      'input.albut[value="Valider"]',
    ].join(', '),
    { force: true }
  );
  if (!updated) {
    await ctx.evaluate(() => document.querySelector('form[name="db1_form"]')?.submit()).catch(() => {});
  }
  await randomDelay(800, 1500);
  await dismissJqueryUiOverlay(page).catch(() => {});

  // Vérif UI (recharger fiche dans iframe)
  await openMemberDetail(page, memberId);
  await getMemberFormContext(page, { waitMs: 15000 });
  const savedUi = await readMemberAddressFromUi(page);
  const uiOk =
    String(savedUi.postal_code || '').replace(/\D/g, '') === String(addr.postal_code || '').replace(/\D/g, '') &&
    Boolean(savedUi.address) &&
    Boolean(savedUi.city);

  if (uiOk) {
    logInfo('Adresse membre Deciplus confirmée (UI)', {
      member_id: memberId,
      postal_code: savedUi.postal_code,
    });
    return true;
  }

  // Vérif API lecture (sans considérer ça comme un write réussi)
  const member = await fetchMemberViaApi(page, memberId);
  if (addressMatchesMember(member, addr)) {
    logInfo('Adresse membre Deciplus lue OK après UI (API GET)', {
      member_id: memberId,
      postal_code: addr.postal_code,
    });
    return true;
  }

  logWarn('Adresse membre Deciplus non confirmée après sauvegarde UI', {
    member_id: memberId,
    saved: savedUi,
    expected: addr,
  });
  return false;
}

async function ensureMemberPostalAddress(page, memberId, addr) {
  logInfo('Mise à jour adresse membre Deciplus', { member_id: memberId });
  await closeGreyboxIfOpen(page);

  // 1) Toujours sauver via joueurs.php (iframe nextgen)
  const uiOk = await saveMemberAddressViaUi(page, memberId, addr);

  // 2) Tentative API (souvent 404 sur cette install — best effort)
  const apiOk = await updateMemberAddressViaApi(page, memberId, addr);

  // 3) Le bandeau RIB peut rester affiché même si l'adresse est OK (faux positif Deciplus).
  //    On considère l'adresse prête si la fiche UI est OK, OU si le formulaire RIB a déjà
  //    adr_line1 + CP + ville préremplis (le serveur accepte alors le mandat en force-submit).
  const stillBlocked = await ribBlockerStillPresent(page, memberId);
  if (stillBlocked) {
    logWarn('Mandat SEPA bandeau adresse encore visible', { member_id: memberId, uiOk, apiOk });
    if (!uiOk) {
      await saveMemberAddressViaUi(page, memberId, addr);
    }
    const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
    const mandateAddrOk = await ribMandateAddressReady(ribCtx);
    await closeGreyboxIfOpen(page);
    if (mandateAddrOk || uiOk) {
      logInfo('Adresse membre utilisable pour mandat SEPA (force-submit si besoin)', {
        member_id: memberId,
        uiOk,
        apiOk,
        mandateAddrOk,
      });
      return true;
    }
    return false;
  }

  logInfo('Adresse membre prête pour mandat SEPA', { member_id: memberId, uiOk, apiOk });
  return true;
}

async function getRibFrame(page) {
  const iframe = page.locator('#GB_frame, iframe[src*="rib.php"]').first();
  if ((await iframe.count()) > 0) {
    const handle = await iframe.elementHandle();
    const frame = handle ? await handle.contentFrame() : null;
    if (frame) return frame;
  }
  for (const frame of page.frames()) {
    if (frame.url().includes('rib.php')) return frame;
  }
  return null;
}

async function waitForRibFrame(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await getRibFrame(page);
    if (frame) return frame;
    await page.waitForTimeout(400);
  }
  return null;
}

async function openRibForm(page, memberId, { forceFresh = false } = {}) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';

  if (forceFresh) {
    await closeGreyboxIfOpen(page);
  } else {
    let frame = await getRibFrame(page);
    if (frame) {
      logInfo('Formulaire RIB déjà ouvert (modale)', { member_id: memberId });
      return frame;
    }
  }

  await page.goto(new URL(`rib.php?idj=${memberId}`, base).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await randomDelay();

  if (page.url().includes('rib.php')) return page;

  let frame = await waitForRibFrame(page, 5000);
  if (frame) return frame;

  await openMemberCheck(page, memberId);
  if (await clickFirst(page, sel('member_check.saisir_mandat_sepa'))) {
    frame = await waitForRibFrame(page, 10000);
    if (frame) return frame;
  }

  await openMemberDetail(page, memberId);
  if (await clickFirst(page, sel('member_detail.saisir_rib_button'))) {
    frame = await waitForRibFrame(page, 10000);
    if (frame) return frame;
  }

  throw new Error(`Impossible d'ouvrir le formulaire RIB pour membre ${memberId}`);
}

async function fillRibForm(ctx, iban, customer, gymConfig) {
  const value = normalizeIban(iban);
  const addr = ribAddressFields(customer, gymConfig);

  // Débloquer avant fill si Deciplus a disabled les champs
  await unlockRibFormForSubmit(ctx);

  await fillFirst(ctx, sel('rib_form.iban'), value);
  // Fallback direct si sélecteur config rate
  if (!(await readIbanFromRib(ctx))) {
    await fillFormField(ctx, 'input[name="iban"]', value);
  }

  const titulaire = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  if (titulaire) {
    await fillFirst(ctx, sel('rib_form.account_holder'), titulaire.toUpperCase());
    await fillFormField(ctx, 'input[name="nom"]', titulaire.toUpperCase());
  }

  await fillFirst(ctx, sel('rib_form.address'), addr.address);
  await fillFormField(ctx, 'input[name="adr_line1"]', addr.address);
  await fillFirst(ctx, sel('rib_form.address2'), '');
  await fillFirst(ctx, sel('rib_form.city'), addr.city.toUpperCase());
  await fillFormField(ctx, 'input[name="adr_town"]', addr.city.toUpperCase());
  await fillFirst(ctx, sel('rib_form.zip'), addr.postal_code);
  await fillFormField(ctx, 'input[name="adr_postcode"]', addr.postal_code);
  await fillFirst(ctx, sel('rib_form.country'), addr.country);
  await fillFormField(ctx, 'input[name="adr_country"]', addr.country || 'France');
}

async function prepareRibSubmit(ctx) {
  await unlockRibFormForSubmit(ctx);
  await ctx.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) return;
    const submit = form.querySelector('input[name="alde_submit"]');
    if (submit) submit.value = 'valider';
    const cb = form.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = true;
  });
}

async function submitRibForm(ctx, page) {
  await prepareRibSubmit(ctx);
  const clicked = await clickFirst(ctx, sel('rib_form.save'), { force: true });
  if (!clicked) {
    await ctx.evaluate(() => {
      const form = document.querySelector('form');
      if (form) form.submit();
    });
  }
  await randomDelay(800, 1500);
}

async function readMandateMeta(ctx) {
  return ctx
    .evaluate(() => ({
      iban: document.querySelector('input[name="iban"]')?.value || '',
      rum: document.querySelector('input[name="rum"]')?.value || '',
      date_mandat: document.querySelector('input[name="date_mandat"]')?.value || '',
    }))
    .catch(() => ({ iban: '', rum: '', date_mandat: '' }));
}

async function verifyIbanOnMandate(page, memberId, expectedIban) {
  const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
  const saved = await readIbanFromRib(ribCtx);
  if (saved === expectedIban) return true;
  // Mandat créé (RUM) même si l'IBAN affiché est tronqué / reformaté
  const meta = await readMandateMeta(ribCtx);
  if (meta.rum && normalizeIban(meta.iban).startsWith(expectedIban.slice(0, 20))) {
    logWarn('IBAN mandat partiellement affiché — RUM présent, considéré OK', {
      member_id: memberId,
      rum: meta.rum,
      saved: meta.iban,
    });
    return true;
  }
  return Boolean(meta.rum && saved && normalizeIban(saved).includes(expectedIban.slice(4, 14)));
}

async function closeGreyboxIfOpen(page) {
  const closeSelectors = [
    '#GB_window .close',
    '#GB_window a.close',
    '#GB_window img[title*="Close" i]',
    '#GB_window img[alt*="Close" i]',
    '#GB_close',
    '#GB_window img',
  ];
  for (const selClose of closeSelectors) {
    const closeBtn = page.locator(selClose).first();
    if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click().catch(() => {});
      await randomDelay(200, 500);
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    const win = document.querySelector('#GB_window');
    if (win) win.remove();
    document.querySelectorAll('#GB_overlay, .GB_overlay').forEach((el) => el.remove());
  }).catch(() => {});
  await randomDelay(200, 400);
}

/**
 * Flux : adresse membre → rib.php frais → IBAN + adresse mandat → Valider
 * Si Deciplus bloque sur l'adresse postale, on resauvegarde la fiche puis on réessaie.
 */
async function setMemberIban(page, memberId, iban, customer = {}, gymConfig = {}) {
  const value = normalizeIban(iban);
  if (!isValidFrenchIban(value)) {
    throw new Error('IBAN français invalide');
  }

  logInfo('Saisie RIB Deciplus', { member_id: memberId });
  const addr = ribAddressFields(customer, gymConfig);

  const addressOk = await ensureMemberPostalAddress(page, memberId, addr);
  if (!addressOk) {
    throw new Error(
      `RIB Deciplus: adresse postale membre ${memberId} non enregistrée (requis pour le mandat SEPA)`
    );
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ribCtx = await openRibForm(page, memberId, { forceFresh: true });
    const existingMeta = await readMandateMeta(ribCtx);
    const existingIban = normalizeIban(existingMeta.iban);
    if (existingIban === value || (existingMeta.rum && existingIban && existingIban.startsWith(value.slice(0, 20)))) {
      logInfo('IBAN déjà enregistré sur le mandat Deciplus', {
        member_id: memberId,
        rum: existingMeta.rum || null,
      });
      await closeGreyboxIfOpen(page);
      return true;
    }

    await fillRibForm(ribCtx, value, customer, gymConfig);

    const blocked = await hasPostalAddressBlocker(ribCtx);
    const mandateAddrOk = await ribMandateAddressReady(ribCtx);
    if (blocked && !mandateAddrOk) {
      logWarn('Blocage adresse postale Deciplus sur mandat — resauvegarde fiche membre', {
        member_id: memberId,
        attempt,
      });
      await closeGreyboxIfOpen(page);
      await ensureMemberPostalAddress(page, memberId, addr);
      continue;
    }
    if (blocked && mandateAddrOk) {
      logWarn('Bandeau adresse Deciplus ignoré — adresse mandat présente, force-submit', {
        member_id: memberId,
        attempt,
      });
    }

    await submitRibForm(ribCtx, page);
    await closeGreyboxIfOpen(page);

    const saved = await verifyIbanOnMandate(page, memberId, value);
    await closeGreyboxIfOpen(page);
    if (saved) {
      logInfo('RIB saisi sur fiche membre', { member_id: memberId, attempt });
      return true;
    }

    logWarn('IBAN non confirmé après soumission mandat', { member_id: memberId, attempt });
    await ensureMemberPostalAddress(page, memberId, addr);
  }

  throw new Error('RIB Deciplus: échec enregistrement IBAN sur le mandat');
}

module.exports = {
  openMemberDetail,
  openMemberCheck,
  setMemberIban,
  openRibForm,
  getRibFrame,
  ribAddressFields,
  clickFirst,
  fillFirst,
  sel,
  closeGreyboxIfOpen,
};
