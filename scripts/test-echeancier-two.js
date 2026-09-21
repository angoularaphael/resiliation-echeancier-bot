#!/usr/bin/env node
/**
 * Test : analyse puis résiliation selon motifs SEPA (AC01/MS02 immédiat, AM04 à 3).
 * LIVE par défaut (ECHEANCIER_DRY_RUN=1 pour lister seulement).
 *
 *   node scripts/test-echeancier-two.js
 *   ECHEANCIER_DRY_RUN=1 node scripts/test-echeancier-two.js
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

require('dotenv').config();

const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (browsersDir) {
  const abs = path.isAbsolute(browsersDir)
    ? browsersDir
    : path.join(__dirname, '..', browsersDir);
  const ok =
    fs.existsSync(abs) &&
    fs.readdirSync(abs).some((n) => /chromium/i.test(n));
  if (!ok) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      'AppData',
      'Local',
      'ms-playwright'
    );
    console.log('Playwright: cache local vide, repli', process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
}

const boxplusEnv = path.join(__dirname, '..', '..', 'BOXPLUS', '.env');
if (fs.existsSync(boxplusEnv)) {
  for (const line of fs.readFileSync(boxplusEnv, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^DECIPLUS_|^PLAYWRIGHT_BROWSERS_PATH$|^BREVO_/.test(key)) continue;
    if (process.env[key]) continue;
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

const runId = Date.now();
process.env.BOXPLUS_QUEUE_DIR =
  process.env.BOXPLUS_QUEUE_DIR || path.join(os.tmpdir(), `echeancier-q-${runId}`);
process.env.BOXPLUS_LOG_DIR =
  process.env.BOXPLUS_LOG_DIR || path.join(os.tmpdir(), `echeancier-log-${runId}`);
process.env.BOT_ROLE = 'ops';
const dryArg = process.argv.includes('--dry');
process.env.ECHEANCIER_DRY_RUN = dryArg ? '1' : '0';
if (!process.argv.includes('--headless')) process.env.DECIPLUS_HEADLESS = 'false';

const { enqueue, listPending } = require('../lib/queue');
const { processOneJob } = require('../bot/index');
const { closeBrowser } = require('../bot/browser-pool');

(async () => {
  console.log('=== TEST ÉCHÉANCIER : analyse puis 2 résiliations ===');
  console.log({
    dry_run: process.env.ECHEANCIER_DRY_RUN,
    user: process.env.DECIPLUS_USER,
    analyze_limit: 120,
    cancel_limit: 120,
    force_cancel: false,
    rule: '2 impayés consécutifs → résil ; MD06/MS02/JSON immédiat ; sinon 10 relances',
  });

  const order = {
    order_id: `ECHEANCIER-TWO-${runId}`,
    action: 'echeancier',
    limit: 120,
    cancel_limit: 120,
    force_cancel: false,
    gym: 'minimes',
    product_name: 'Scan échéancier 2 impayés',
    requires_payment: false,
    requires_iban: false,
    sale_type: 'none',
    customer: { first_name: 'Scan', last_name: 'Echeancier', email: 'scan@boxplus-test.local' },
  };

  enqueue(order);
  const job = listPending().find((j) => j.order_id === order.order_id);
  if (!job) throw new Error('job_not_queued');

  const outcome = await processOneJob(job);
  console.log('\n=== RÉSULTAT ===');
  console.log(JSON.stringify(outcome, null, 2));

  await closeBrowser().catch(() => {});

  const ok = Boolean(outcome?.ok || outcome?.result?.ok || outcome?.result?.status === 'success');
  if (!ok) {
    console.error('FAIL échéancier 2 fiches');
    process.exit(1);
  }
  console.log(
    `\nOK — candidats: ${outcome?.result?.candidates ?? '?'} · cancelled: ${outcome?.result?.cancelled ?? '?'}`
  );
  process.exit(0);
})().catch(async (err) => {
  console.error('FATAL:', err.message);
  try {
    await closeBrowser();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
