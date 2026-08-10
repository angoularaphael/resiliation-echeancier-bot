'use strict';

/**
 * Garantit imapflow + mailparser même si le process a été lancé via bot/index.js
 * (sans passer par start.js) — cas fréquent sur BotHosting.
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function moduleResolvable(name) {
  try {
    require.resolve(name, { paths: [ROOT, __dirname] });
    return true;
  } catch {
    return false;
  }
}

function ensureOtpDeps({ required = ['imapflow', 'mailparser'] } = {}) {
  const missing = required.filter((name) => !moduleResolvable(name));
  if (!missing.length) {
    return { ok: true, installed: false, missing: [] };
  }

  console.log(`[BOXPLUS] Dépendances OTP manquantes: ${missing.join(', ')} — npm install…`);
  try {
    execSync(`npm install ${missing.join(' ')} --omit=dev --no-fund --no-audit`, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    console.error('[BOXPLUS] npm install OTP échoué:', err.message);
    return { ok: false, installed: false, missing, error: err.message };
  }

  const still = required.filter((name) => !moduleResolvable(name));
  if (still.length) {
    console.error(`[BOXPLUS] Toujours absents après install: ${still.join(', ')}`);
    return { ok: false, installed: false, missing: still };
  }

  console.log('[BOXPLUS] Dépendances OTP OK (imapflow + mailparser)');
  return { ok: true, installed: true, missing: [] };
}

module.exports = { ensureOtpDeps, moduleResolvable, ROOT };
