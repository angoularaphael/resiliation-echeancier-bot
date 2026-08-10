#!/usr/bin/env node
/**
 * Point d'entrée BotHost / VPS — installe les deps et lance le bot Deciplus.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { installPlaywrightBrowser } = require('./lib/playwright-install');
const { ensureOtpDeps, moduleResolvable } = require('./lib/ensure-deps');

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname, env: process.env });
}

/** Toujours s’assurer des deps critiques (même si node_modules existe déjà). */
function ensureRequiredDeps() {
  const required = ['dotenv', 'express', 'playwright', 'imapflow', 'mailparser'];
  const missing = required.filter((name) => !moduleResolvable(name));
  const nodeModules = path.join(__dirname, 'node_modules');

  if (!fs.existsSync(nodeModules) || missing.length) {
    if (missing.length) {
      console.log(`[BOXPLUS] Dépendances manquantes: ${missing.join(', ')} — npm install…`);
    }
    run('npm install --omit=dev --ignore-scripts');
  }

  // Deuxième filet : install ciblée OTP (node_modules partiel / vieux volume)
  const otp = ensureOtpDeps();
  if (!otp.ok) {
    console.error('[BOXPLUS] Impossible d’installer imapflow/mailparser — lecture code email impossible');
    process.exit(1);
  }

  const stillMissing = required.filter((name) => !moduleResolvable(name));
  if (stillMissing.length) {
    console.error(
      `[BOXPLUS] Impossible d’installer: ${stillMissing.join(', ')}. Vérifier package.json / réseau.`
    );
    process.exit(1);
  }
  console.log('[BOXPLUS] Dépendances OK (dont imapflow + mailparser pour code email Deciplus)');
}

ensureRequiredDeps();

try {
  installPlaywrightBrowser();
} catch (err) {
  console.error('[BOXPLUS]', err.message);
  process.exit(1);
}

const bot = require('./bot/index.js');
const once = process.argv.includes('--once');
bot.runLoop(once).catch((err) => {
  console.error(err);
  process.exit(1);
});
