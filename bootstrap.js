#!/usr/bin/env node
'use strict';

/**
 * BotHosting — déposer ce fichier comme /home/container/index.js
 * (ou démarrer avec: node bootstrap.js)
 *
 * 1) charge .env racine
 * 2) git clone/pull du repo (BOT_REPO_URL)
 * 3) npm install (dont imapflow/mailparser)
 * 4) lance start.js de l’app
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ROOT_ENV = path.join(ROOT, '.env');

function loadRootEnv() {
  if (!fs.existsSync(ROOT_ENV)) return;
  for (const line of fs.readFileSync(ROOT_ENV, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
}

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env: process.env });
}

loadRootEnv();

const repo =
  process.env.BOT_REPO_URL ||
  process.env.BOT_GITHUB_REPO ||
  'https://github.com/angoularaphael/boxi-deci-bot.git';
const branch = process.env.BOT_REPO_BRANCH || 'main';
const appName = process.env.BOT_APP_DIR || 'boxi-deci-bot-app';
const APP_DIR = path.join(ROOT, appName);

console.log('[BOXPLUS] Bootstrap BotHosting', { repo, branch, app: appName });

if (!fs.existsSync(APP_DIR)) {
  run(`git clone --branch ${branch} ${repo} ${appName}`);
} else {
  try {
    run('git fetch --all', APP_DIR);
    run(`git reset --hard origin/${branch}`, APP_DIR);
  } catch (err) {
    console.warn('[BOXPLUS] git update échoué (on continue):', err.message);
  }
}

if (fs.existsSync(ROOT_ENV)) {
  fs.copyFileSync(ROOT_ENV, path.join(APP_DIR, '.env'));
  console.log('[BOXPLUS] .env copié vers l’app');
}

console.log('[BOXPLUS] npm install (app)…');
run('npm install --omit=dev --ignore-scripts', APP_DIR);
// Force explicite — évite node_modules partiel sans IMAP
run('npm install imapflow mailparser --omit=dev --no-fund --no-audit', APP_DIR);

process.chdir(APP_DIR);
require(path.join(APP_DIR, 'start.js'));
