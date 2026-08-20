const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, randomDelay } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { launchChromiumWithRetry } = require('./playwright-launch');
const { isChooseZoneScreen, selectSiteInPicker, clickSellOnSite } = require('./deciplus-zone');
const { dismissDeciplusModals } = require('./ui');

const SESSION_DIR = process.env.BOT_SESSION_DIR || path.join(ROOT, 'data', 'session');
const STORAGE_FILE = path.join(SESSION_DIR, 'storage-state.json');
const AUTH_COOLDOWN_MS = Number(process.env.BOT_AUTH_COOLDOWN_MS || 10 * 60 * 1000);

let loginInFlight = null;
let authBlockedUntil = 0;

function isAuthBlocked() {
  return Date.now() < authBlockedUntil;
}

function getAuthBlockedMessage() {
  const minutes = Math.ceil((authBlockedUntil - Date.now()) / 60000);
  return `Connexion Deciplus en cooldown (${minutes} min) — évite les demandes de code email en rafale`;
}

function isMfaAuthError(message = '') {
  return /code.*email|DECIPLUS_EMAIL_CODE|vérification|verification|otp|mfa|cooldown/i.test(message);
}

function blockAuthRetries(reason) {
  authBlockedUntil = Date.now() + AUTH_COOLDOWN_MS;
  logWarn('Connexion Deciplus en cooldown', {
    reason,
    cooldown_min: Math.round(AUTH_COOLDOWN_MS / 60000),
  });
}

function clearAuthCooldown() {
  authBlockedUntil = 0;
}

function assertAuthAllowed() {
  if (isAuthBlocked()) {
    throw new Error(getAuthBlockedMessage());
  }
}

async function getAccessToken(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      return await page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem('auth') || '{}').token || null;
        } catch {
          return null;
        }
      });
    } catch (err) {
      if (!/Execution context was destroyed|navigation|Target closed/i.test(err.message)) {
        return null;
      }
      await page.waitForTimeout(400);
    }
  }
  return null;
}

function isSessionExpiredUrl(url = '') {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('sessionexpired') ||
    u.includes('session_expired') ||
    /login\.php/i.test(u) ||
    u.includes('/login') ||
    u.includes('signin') ||
    u.includes('connexion')
  );
}

/** Ping API staff — seul vrai signal « session encore acceptée ». */
async function isAccessTokenValid(page, token) {
  if (!token) return false;
  try {
    const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
    const referer = new URL('nextgen/home', base).href;
    const response = await page.context().request.get(
      'https://api.deciplus.pro/staff/v1/product/getAvailableProducts?all=true',
      {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'x-access-token': token,
          'Deciplus-Client-Type': 'manager',
          Referer: referer,
        },
        timeout: 20000,
      }
    );
    return response.ok();
  } catch {
    return false;
  }
}

async function clearDeadAuth(page) {
  await page
    .evaluate(() => {
      try {
        localStorage.removeItem('auth');
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
}

/** Invalide cookies + localStorage (JWT API peut vivre alors que la session PHP legacy est morte). */
async function wipeBrowserAuth(page) {
  await clearDeadAuth(page);
  await page
    .evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
  await page.context().clearCookies().catch(() => {});
}

/**
 * Les pages legacy (select.php / joueurs.php) dépendent des cookies PHP,
 * pas seulement du token API nextgen.
 */
async function isLegacySessionAlive(page) {
  try {
    // Sur choose-zone, select.php est inaccessible — ce n’est pas une session PHP morte
    if (/choose-zone/i.test(page.url()) || (await isChooseZoneScreen(page))) {
      return false;
    }

    const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
    const origin = new URL(page.url().startsWith('http') ? page.url() : base).origin;
    await page.goto(`${origin}/nextgen/legacy?path=${encodeURIComponent('/select.php')}`, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(Number(process.env.DECIPLUS_NAV_TIMEOUT || 90000), 45000),
    });
    await page.waitForTimeout(Number(process.env.DECIPLUS_NAV_SETTLE_MS || 600));
    if (isSessionExpiredUrl(page.url())) return false;
    if (/choose-zone/i.test(page.url()) || (await isChooseZoneScreen(page))) {
      return false;
    }

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (isSessionExpiredUrl(page.url())) return false;
      if (/choose-zone/i.test(page.url()) || (await isChooseZoneScreen(page))) {
        return false;
      }
      for (const frame of page.frames()) {
        if ((await frame.locator('#i_nom, #buttonNew, #i_tel').count().catch(() => 0)) > 0) {
          return true;
        }
      }
      if ((await page.locator('#i_nom, #buttonNew, #i_tel').count().catch(() => 0)) > 0) {
        return true;
      }
      await page.waitForTimeout(350);
    }
    return false;
  } catch {
    return false;
  }
}

async function isVerificationScreen(page) {
  const url = page.url();
  if (/verif|validation|otp|2fa|mfa|authenticate/i.test(url)) return true;

  // Deciplus affiche souvent le 2FA sur la même page login (pas d’URL dédiée)
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  if (/V[ée]rifions votre identit|code envoy[ée].*adresse|renseigner.*code/i.test(bodyText)) {
    return true;
  }

  const hints = [
    'text=/V[ée]rifions votre identit/i',
    'text=/code.*(e-?mail|mail|sms)/i',
    'text=/vérification/i',
    'text=/validation du code/i',
    'text=/saisissez.*code/i',
    'input[name="code"]:visible',
    'input[name="otp"]:visible',
    'input[name="validationCode"]:visible',
    'input[autocomplete="one-time-code"]:visible',
    'input[inputmode="numeric"]:visible',
  ];

  for (const sel of hints) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      return true;
    }
  }
  // Champ Deciplus souvent présent en hidden puis affiché — détecter le bouton Valider du 2FA
  const validateOtp = page.locator('button:has-text("Valider"), input[value="Valider"]').first();
  if (
    /code envoy/i.test(bodyText) &&
    (await validateOtp.count()) > 0 &&
    (await validateOtp.isVisible().catch(() => false))
  ) {
    return true;
  }
  return false;
}

async function fillVisible(page, selectors, value, { timeout = 15000 } = {}) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      if ((await el.count()) > 0 && (await el.isVisible()) && (await el.isEnabled())) {
        await el.fill(value, { timeout });
        return true;
      }
    } catch {
      /* try next selector */
    }
  }
  return false;
}

async function injectAuthToken(page, token) {
  await page.evaluate((accessToken) => {
    let auth = {};
    try {
      auth = JSON.parse(localStorage.getItem('auth') || '{}');
    } catch {
      auth = {};
    }
    auth.token = accessToken;
    localStorage.setItem('auth', JSON.stringify(auth));
  }, token);
  logInfo('Token Deciplus injecté depuis DECIPLUS_AUTH_TOKEN');
}

async function resolveEmailVerificationCode(opts = {}) {
  const manual = String(process.env.DECIPLUS_EMAIL_CODE || process.env.DECIPLUS_OTP || '').trim();
  if (manual) return { code: manual, source: 'env' };

  const { isImapOtpConfigured, fetchDeciplusEmailCode } = require('./deciplus-otp-imap');
  if (!isImapOtpConfigured()) {
    throw new Error(
      'Deciplus demande un code de vérification email. ' +
        'Configurer DECIPLUS_IMAP_USER + DECIPLUS_IMAP_PASS (lecture auto), ' +
        'ou DECIPLUS_EMAIL_CODE=123456 (manuel), ' +
        'ou exporter la session (npm run session:export).'
    );
  }

  const code = await fetchDeciplusEmailCode({
    notBeforeMs: opts.notBeforeMs || Date.now() - 60_000,
    maxWaitMs: opts.maxWaitMs,
  });
  if (!code) {
    throw new Error(
      'Code email Deciplus introuvable dans la boîte IMAP — vérifier DECIPLUS_IMAP_USER/PASS ' +
        'ou coller DECIPLUS_EMAIL_CODE manuellement.'
    );
  }
  return { code, source: 'imap' };
}

async function handleEmailVerification(page, opts = {}) {
  const { code, source } = await resolveEmailVerificationCode(opts);

  logInfo('Saisie code vérification Deciplus…', { source });

  // Champ visible Deciplus = #userValidationCode ; hidden sync = #validationCode
  const visibleCode = page.locator('#userValidationCode').first();
  let ok = false;
  if ((await visibleCode.count()) > 0) {
    await visibleCode.click({ timeout: 5000 }).catch(() => {});
    await visibleCode.fill('');
    await visibleCode.fill(code);
    ok = true;
  }
  if (!ok) {
    ok = await fillVisible(page, [
      'input[name="code"]',
      'input[name="otp"]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
    ], code);
  }
  // Toujours synchroniser le hidden Deciplus
  const hidden = page.locator('input[name="validationCode"], #validationCode').first();
  if ((await hidden.count()) > 0) {
    await hidden.evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, code);
    ok = true;
  }
  if (!ok) {
    throw new Error('Champ code vérification Deciplus introuvable (#userValidationCode)');
  }

  const validateBtn = page
    .locator(
      '.swal2-confirm, button:has-text("Valider"), button.swal2-confirm, input[value="Valider"]'
    )
    .first();
  if ((await validateBtn.count()) > 0) {
    await validateBtn.click({ noWaitAfter: true, timeout: 15000 }).catch(async () => {
      await validateBtn.evaluate((el) => el.click()).catch(() => {});
    });
  }

  await Promise.race([
    page.waitForURL(/choose-zone|nextgen|home|select\.php/i, { timeout: 45000 }),
    page.waitForFunction(() => {
      try {
        return Boolean(JSON.parse(localStorage.getItem('auth') || '{}').token);
      } catch {
        return false;
      }
    }, { timeout: 45000 }),
  ]).catch(() => {});
  await page.waitForTimeout(1500);
  await randomDelay(process.env.BOT_MIN_DELAY_MS, process.env.BOT_MAX_DELAY_MS);
}

async function launchBrowser() {
  ensureDir(SESSION_DIR);

  const browser = await launchChromiumWithRetry();
  const contextOptions = {
    viewport: { width: 1280, height: 720 },
    locale: 'fr-FR',
  };
  if (fs.existsSync(STORAGE_FILE)) {
    contextOptions.storageState = STORAGE_FILE;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  return { browser, context, page, loadedStorageMtimeMs: getStorageMtimeMs() };
}

function getStorageMtimeMs() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) return 0;
    return fs.statSync(STORAGE_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function hashStorageState(state) {
  try {
    const crypto = require('crypto');
    const cookies = (state.cookies || [])
      .map((c) => `${c.name}=${c.value}@${c.domain}`)
      .sort()
      .join('|');
    const origins = (state.origins || [])
      .map((o) => {
        const auth = (o.localStorage || []).find((x) => x.name === 'auth');
        return `${o.origin}:${auth?.value || ''}`;
      })
      .sort()
      .join('|');
    return crypto.createHash('sha256').update(`${cookies}::${origins}`).digest('hex');
  } catch {
    return null;
  }
}

function readDiskStorageHash() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) return null;
    return hashStorageState(JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Ne pas écraser un storage-state.json fraîchement uploadé (changement de session).
 * Ne réécrit pas si le contenu auth est inchangé (évite boucle mtime / reload).
 * Ne persiste pas une session morte (sans token) par-dessus un fichier valide.
 */
async function saveSession(context, opts = {}) {
  ensureDir(SESSION_DIR);
  const loadedMtimeMs = opts.loadedMtimeMs;
  const diskMtime = getStorageMtimeMs();
  if (!opts.force && loadedMtimeMs != null && diskMtime > Number(loadedMtimeMs) + 50) {
    logWarn('Session disque plus récente — pas d\'écrasement (export / changement session)');
    return { skipped: true, reason: 'newer_on_disk', mtimeMs: diskMtime };
  }

  const nextState = await context.storageState();
  const nextHash = hashStorageState(nextState);
  const diskHash = readDiskStorageHash();

  const hasAuthToken = (state) => {
    try {
      for (const o of state.origins || []) {
        const auth = (o.localStorage || []).find((x) => x.name === 'auth');
        if (!auth?.value) continue;
        const parsed = JSON.parse(auth.value);
        if (parsed?.token) return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  };

  let diskHasToken = false;
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      diskHasToken = hasAuthToken(JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8')));
    }
  } catch {
    diskHasToken = false;
  }
  if (opts.requireAuth !== false && diskHasToken && !hasAuthToken(nextState)) {
    logWarn('Session navigateur sans token — conservation du storage-state disque');
    return { skipped: true, reason: 'dead_session', mtimeMs: diskMtime };
  }

  if (nextHash && diskHash && nextHash === diskHash) {
    return { skipped: true, reason: 'unchanged', mtimeMs: diskMtime || getStorageMtimeMs() };
  }

  fs.writeFileSync(STORAGE_FILE, JSON.stringify(nextState, null, 2), 'utf8');
  logInfo('Session Deciplus sauvegardée');
  return { skipped: false, mtimeMs: getStorageMtimeMs(), hash: nextHash };
}

function isSessionRecoverableError(message = '') {
  // Ne pas traiter « joueurs.php / formulaire » comme session morte :
  // souvent l’UI nextgen/iframe, alors que le token est encore valide.
  return /session expir|token.*introuvable|relancer login|not logged|login\.php|Unauthorized|\b401\b|storage-state|connexion.*échou|Déconnexion|session Deciplus|déjà pas connect|auth.*expir|cookie|Execution context was destroyed|context.*destroyed|frame.*detached|imapflow|mailparser|code email|DECIPLUS_IMAP|cooldown|session inactive|choose-zone|s[ée]lection site|écran zone/i.test(
    String(message || '')
  );
}

async function isLoggedIn(page) {
  if (await isVerificationScreen(page)) return false;

  const url = page.url();
  if (isSessionExpiredUrl(url)) return false;

  const token = await getAccessToken(page);
  if (!token) {
    const indicators = [
      'text=Membres',
      'text=Dashboard',
      'text=Tableau de bord',
      '[data-testid="dashboard"]',
    ];
    for (const sel of indicators) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return true;
    }
    return false;
  }

  // Token présent ≠ session valide (JWT mort reste souvent en localStorage)
  return isAccessTokenValid(page, token);
}

async function handleChooseZone(page, siteLabel) {
  const label =
    String(siteLabel || '').trim() ||
    String(process.env.DECIPLUS_DEFAULT_SITE || 'Minimes').trim();

  // Après login / reload session, l'écran zone peut arriver avec un léger délai
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await isChooseZoneScreen(page)) break;
    if (/choose-zone/i.test(page.url())) break;
    await page.waitForTimeout(400);
  }

  if (!(await isChooseZoneScreen(page)) && !/choose-zone/i.test(page.url())) {
    return false;
  }

  logInfo('Écran choix de site Deciplus détecté', { site: label });
  await dismissDeciplusModals(page).catch(() => {});
  const selected = await selectSiteInPicker(page, label);
  if (!selected) {
    logWarn('Sélection site Deciplus échouée sur l’écran zone', { site: label, url: page.url() });
    throw new Error(`Sélection site Deciplus échouée: ${label} (url=${page.url()})`);
  }
  const sold = await clickSellOnSite(page);
  if (!sold || (await isChooseZoneScreen(page)) || /choose-zone/i.test(page.url())) {
    logWarn('Impossible de quitter choose-zone — retry Accueil', { site: label });
    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/nextgen/home`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(Number(process.env.DECIPLUS_NAV_SETTLE_MS || 800));
    if (await isChooseZoneScreen(page) || /choose-zone/i.test(page.url())) {
      await dismissDeciplusModals(page).catch(() => {});
      const again = await selectSiteInPicker(page, label);
      if (again) await clickSellOnSite(page);
    }
  }
  if ((await isChooseZoneScreen(page)) || /choose-zone/i.test(page.url())) {
    throw new Error(`Toujours sur choose-zone après sélection site (${label})`);
  }
  logInfo('Site Deciplus prêt après choix de salle', { site: label });
  return true;
}

async function gotoDeciplus(page, pathPart = '', options = {}) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const timeout = Number(process.env.DECIPLUS_NAV_TIMEOUT || 90000);
  const target = pathPart ? new URL(pathPart, base).href : base;

  try {
    await page.goto(target, {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout,
    });
  } catch (err) {
    logWarn('Navigation Deciplus lente, retry commit', { url: target, error: err.message });
    await page.goto(target, { waitUntil: 'commit', timeout: Math.min(timeout, 45000) });
  }
  await page.waitForTimeout(Number(process.env.DECIPLUS_NAV_SETTLE_MS || 400));
}

async function submitLoginForm(page, user, pass) {
  // Deciplus manager = pseudo / passwd (pas username/password)
  const userSelectors = [
    'input[name="pseudo"]',
    '#pseudo',
    'input[name="username"]',
    'input[name="login"]',
    'input[name="user"]',
    'input[name="email"]',
    'input[type="email"]',
    '#username',
    '#login',
    '#email',
    'input[type="text"]',
  ];
  const passSelectors = [
    'input[name="passwd"]',
    '#passwd',
    'input[name="password"]',
    'input[type="password"]',
    '#password',
  ];
  const submitSelectors = [
    'button[name="submitLogin"]',
    'button.login__submit',
    'button:has-text("Connexion")',
    'button:has-text("Se connecter")',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  const userOk = await fillVisible(page, userSelectors, user);
  const passOk = await fillVisible(page, passSelectors, pass);
  if (!userOk || !passOk) {
    throw new Error('Formulaire de connexion Deciplus introuvable — page de vérification email ?');
  }

  let clicked = false;
  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ noWaitAfter: true, timeout: 15000 }).catch(async () => {
        await btn.evaluate((el) => el.click()).catch(() => {});
      });
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    await page
      .locator('button[name="submitLogin"], input[name="submitLogin"]')
      .first()
      .click({ noWaitAfter: true, timeout: 10000 })
      .catch(() => {});
  }

  await Promise.race([
    page.waitForURL(/choose-zone|nextgen|verif|otp|code|home|select\.php/i, { timeout: 45000 }),
    page.waitForLoadState('domcontentloaded', { timeout: 45000 }),
  ]).catch(() => {});
  await randomDelay(process.env.BOT_MIN_DELAY_MS, process.env.BOT_MAX_DELAY_MS);
}

async function performLogin(page, options = {}) {
  const url = process.env.DECIPLUS_URL;
  const user = process.env.DECIPLUS_USER;
  const pass = process.env.DECIPLUS_PASSWORD;
  const envToken = String(process.env.DECIPLUS_AUTH_TOKEN || '').trim();
  const siteLabel =
    options.siteLabel || process.env.DECIPLUS_DEFAULT_SITE || 'Minimes';
  const force = Boolean(options.force);

  if (!url || !user || !pass) {
    throw new Error('DECIPLUS_URL, DECIPLUS_USER et DECIPLUS_PASSWORD requis');
  }

  if (force) {
    logInfo('Login forcé — wipe cookies / token (session PHP legacy souvent morte)');
    await wipeBrowserAuth(page);
  }

  const hasStoredSession = fs.existsSync(STORAGE_FILE);

  if (!force && hasStoredSession && !envToken) {
    await gotoDeciplus(page, 'nextgen/choose-zone?nextUrl=/home');
    // Toujours résoudre la salle AVANT le probe legacy (sinon select.php = faux « session morte »)
    if (/choose-zone/i.test(page.url()) || (await isChooseZoneScreen(page))) {
      logInfo('Session persistée — écran choix de salle');
      await handleChooseZone(page, siteLabel);
    }
    const storedToken = await getAccessToken(page);
    if (storedToken && !isSessionExpiredUrl(page.url()) && (await isAccessTokenValid(page, storedToken))) {
      let legacyOk = await isLegacySessionAlive(page);
      // Probe peut renvoyer sur choose-zone si la zone n’est pas encore posée
      if (!legacyOk && (/choose-zone/i.test(page.url()) || (await isChooseZoneScreen(page)))) {
        logInfo('Legacy probe → choose-zone — sélection salle puis nouvel essai');
        await handleChooseZone(page, siteLabel);
        legacyOk = await isLegacySessionAlive(page);
      }
      if (!legacyOk) {
        // Soft recovery : home + zone avant wipe (évite un login OTP à chaque job)
        await gotoDeciplus(page, 'nextgen/choose-zone?nextUrl=/home');
        await handleChooseZone(page, siteLabel);
        legacyOk = await isLegacySessionAlive(page);
      }
      if (legacyOk) {
        logInfo('Déjà connecté via session persistée');
        return;
      }
      logWarn('Token API encore valide mais session PHP legacy morte — reconnexion');
      await wipeBrowserAuth(page);
    } else if (storedToken) {
      logWarn('Session persistée expirée (token local encore présent) — reconnexion');
      await wipeBrowserAuth(page);
    }
  }

  await gotoDeciplus(page, '');

  if (!force && envToken) {
    await injectAuthToken(page, envToken);
    await gotoDeciplus(page, 'nextgen/choose-zone?nextUrl=/home');
    const t = await getAccessToken(page);
    if (t && (await isAccessTokenValid(page, t)) && (await isLegacySessionAlive(page))) {
      logInfo('Connecté via DECIPLUS_AUTH_TOKEN');
      await handleChooseZone(page, siteLabel);
      return;
    }
    logWarn('DECIPLUS_AUTH_TOKEN ignoré — token invalide ou session legacy morte');
    await wipeBrowserAuth(page);
  }

  if (await isVerificationScreen(page)) {
    await handleEmailVerification(page, { notBeforeMs: Date.now() - 120_000 });
  }

  if (!force && (await isLoggedIn(page)) && (await isLegacySessionAlive(page))) {
    logInfo('Déjà connecté via session persistée');
    await handleChooseZone(page, siteLabel);
    return;
  }
  logInfo('Session inactive — login Deciplus');

  if (await isVerificationScreen(page)) {
    await handleEmailVerification(page, { notBeforeMs: Date.now() - 120_000 });
    if (await isLoggedIn(page)) {
      logInfo('Connexion Deciplus réussie (code email)');
      await handleChooseZone(page, siteLabel);
      return;
    }
  }

  const loginStartedAt = Date.now();
  await submitLoginForm(page, user, pass);

  // Le bandeau 2FA peut mettre 1–5 s à apparaître sur la même page
  let sawOtp = false;
  for (let i = 0; i < 12; i += 1) {
    if (await isVerificationScreen(page)) {
      sawOtp = true;
      break;
    }
    if (await getAccessToken(page)) break;
    await page.waitForTimeout(500);
  }

  if (sawOtp) {
    await handleEmailVerification(page, { notBeforeMs: loginStartedAt - 5_000 });
  }

  if (!(await isLoggedIn(page))) {
    if (await isVerificationScreen(page) || sawOtp) {
      throw new Error(
        'Code email Deciplus non validé — vérifier DECIPLUS_IMAP_* ou DECIPLUS_EMAIL_CODE'
      );
    }
    throw new Error('Échec connexion Deciplus — vérifier identifiants');
  }

  logInfo('Connexion Deciplus réussie');
  await handleChooseZone(page, siteLabel);
  if ((await isChooseZoneScreen(page)) || /choose-zone/i.test(page.url())) {
    throw new Error(`Toujours sur choose-zone après login (${siteLabel})`);
  }
}

async function login(page, options = {}) {
  assertAuthAllowed();
  if (loginInFlight) return loginInFlight;

  loginInFlight = (async () => {
    try {
      await performLogin(page, options);
    } catch (err) {
      if (isMfaAuthError(err.message)) {
        blockAuthRetries(err.message);
      }
      throw err;
    }
  })().finally(() => {
    loginInFlight = null;
  });

  return loginInFlight;
}

module.exports = {
  SESSION_DIR,
  STORAGE_FILE,
  launchBrowser,
  saveSession,
  isLoggedIn,
  isVerificationScreen,
  handleChooseZone,
  gotoDeciplus,
  getAccessToken,
  isAccessTokenValid,
  isSessionExpiredUrl,
  login,
  isAuthBlocked,
  clearAuthCooldown,
  wipeBrowserAuth,
  isLegacySessionAlive,
  isMfaAuthError,
  isSessionRecoverableError,
  getStorageMtimeMs,
};
