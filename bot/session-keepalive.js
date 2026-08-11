/**
 * Maintient la session Deciplus active (token ~4h) via ping périodique.
 * Défaut : toutes les 1h30 — si morte → login + IMAP OTP + sauvegarde session.
 * Vérifie aussi la session PHP legacy (select.php), pas seulement le JWT API.
 */
const {
  login,
  gotoDeciplus,
  getAccessToken,
  isAccessTokenValid,
  isLegacySessionAlive,
  isAuthBlocked,
  clearAuthCooldown,
  saveSession,
  wipeBrowserAuth,
  handleChooseZone,
} = require('./auth');
const { isChooseZoneScreen } = require('./deciplus-zone');
const { runWithSession, closeBrowser } = require('./browser-pool');
const { listPending } = require('../lib/queue');
const { logInfo, logWarn } = require('../lib/logger');

// Ping toutes les 1h30 (session Deciplus ~4h)
const KEEPALIVE_MS = Number(process.env.BOT_SESSION_KEEPALIVE_MS || 90 * 60 * 1000);
const KEEPALIVE_RETRY_MS = Number(process.env.BOT_SESSION_KEEPALIVE_RETRY_MS || 10 * 60 * 1000);

let lastKeepAliveSuccessAt = Date.now();
let lastKeepAliveAttemptAt = 0;
let inFlight = false;

function defaultSiteLabel() {
  return String(process.env.DECIPLUS_DEFAULT_SITE || 'Minimes').trim();
}

function touchKeepAliveClock() {
  lastKeepAliveSuccessAt = Date.now();
}

/**
 * Vérifie token API + session PHP legacy ; si mort → login forcé.
 * @param {{ forceLogin?: boolean }} opts
 */
async function refreshSessionIfNeeded(page, opts = {}) {
  const siteLabel = defaultSiteLabel();

  if (!opts.forceLogin) {
    await gotoDeciplus(page, 'nextgen/home');
    if (/choose-zone/i.test(page.url()) || (await isChooseZoneScreen(page))) {
      await handleChooseZone(page, siteLabel);
    }
    const token = await getAccessToken(page);
    const apiOk = Boolean(token && (await isAccessTokenValid(page, token)));
    if (apiOk && (await isLegacySessionAlive(page))) {
      return { token, renewed: false };
    }
    // API OK mais legacy KO souvent = zone non sélectionnée, pas une vraie mort de session
    if (apiOk && (/choose-zone/i.test(page.url()) || (await isChooseZoneScreen(page)))) {
      logInfo('Keepalive — choose-zone détecté, sélection salle sans wipe');
      await handleChooseZone(page, siteLabel);
      if (await isLegacySessionAlive(page)) {
        return { token, renewed: false };
      }
    }
    if (apiOk) {
      await gotoDeciplus(page, 'nextgen/home');
      await handleChooseZone(page, siteLabel);
      if (await isLegacySessionAlive(page)) {
        return { token, renewed: false };
      }
    }
    logWarn('Keepalive — session API/legacy morte — reconnexion forcée', {
      api_ok: apiOk,
    });
  }

  clearAuthCooldown();
  await wipeBrowserAuth(page);
  await login(page, { force: true, siteLabel });
  await gotoDeciplus(page, 'nextgen/home');
  await handleChooseZone(page, siteLabel);
  const token = await getAccessToken(page);
  if (!token || !(await isAccessTokenValid(page, token))) {
    return { token: null, renewed: true };
  }
  if (!(await isLegacySessionAlive(page))) {
    // Dernière chance zone avant d’abandonner le keepalive
    if (/choose-zone/i.test(page.url()) || (await isChooseZoneScreen(page))) {
      await handleChooseZone(page, siteLabel);
    }
    if (!(await isLegacySessionAlive(page))) {
      logWarn('Keepalive — login OK mais legacy select.php toujours inaccessible');
      return { token: null, renewed: true };
    }
  }
  return { token, renewed: true };
}

/** Ping périodique (file vide). Si OK → resauvegarde session ; si KO → login. */
async function maybeKeepSessionAlive() {
  if (inFlight) return;
  if (isAuthBlocked()) return;
  if (listPending().length > 0) return;

  const sinceSuccess = Date.now() - lastKeepAliveSuccessAt;
  if (sinceSuccess < KEEPALIVE_MS) return;

  const sinceAttempt = Date.now() - lastKeepAliveAttemptAt;
  if (sinceAttempt < KEEPALIVE_RETRY_MS) return;

  inFlight = true;
  lastKeepAliveAttemptAt = Date.now();
  try {
    const result = await runWithSession('keepalive', async (page) => refreshSessionIfNeeded(page));
    if (!result?.token) {
      logWarn('Keepalive — session Deciplus non rafraîchie');
      return;
    }

    const renewed = Boolean(result.renewed);
    // Message inline : BotHosting n’affiche souvent que la string, pas le meta
    logInfo(
      renewed
        ? 'Session Deciplus maintenue (keepalive) — reconnexion faite (renewed)'
        : 'Session Deciplus maintenue (keepalive) — session toujours bonne',
      {
        interval_min: Math.round(KEEPALIVE_MS / 60000),
        renewed,
      }
    );
    lastKeepAliveSuccessAt = Date.now();
  } catch (err) {
    logWarn('Keepalive session échoué', { error: err.message });
  } finally {
    inFlight = false;
  }
}

/**
 * Refresh immédiat (erreur job liée session) — ignore le délai 1h30.
 * Force un vrai login (wipe) même si le JWT API répond encore.
 */
async function forceRefreshSession() {
  if (inFlight) {
    const deadline = Date.now() + 120000;
    while (inFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  inFlight = true;
  lastKeepAliveAttemptAt = Date.now();
  clearAuthCooldown();
  try {
    await closeBrowser();
    const result = await runWithSession('session-force-refresh', async (page, context) => {
      const out = await refreshSessionIfNeeded(page, { forceLogin: true });
      if (out.token) {
        await saveSession(context, { force: true }).catch(() => {});
      }
      return out;
    });
    if (result?.token) {
      lastKeepAliveSuccessAt = Date.now();
      logInfo('Session Deciplus renouvelée (force après erreur job)');
      return true;
    }
    logWarn('Force refresh session — toujours pas de token / legacy');
    return false;
  } catch (err) {
    logWarn('Force refresh session échoué', { error: err.message });
    return false;
  } finally {
    inFlight = false;
    await closeBrowser().catch(() => {});
  }
}

module.exports = {
  maybeKeepSessionAlive,
  forceRefreshSession,
  touchKeepAliveClock,
  KEEPALIVE_MS,
  KEEPALIVE_RETRY_MS,
};
