#!/usr/bin/env node
/**
 * Test scan échéancier (DRY_RUN par défaut).
 * Usage:
 *   node scripts/test-echeancier-scan.js
 *   ECHEANCIER_DRY_RUN=0 node scripts/test-echeancier-scan.js   # résil réelle — dangereux
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

require('dotenv').config();

// Réutilise la session/login BOXPLUS (RAPHAEL) si dispo — scan local
const boxplusEnv = path.join(__dirname, '..', '..', 'BOXPLUS', '.env');
if (fs.existsSync(boxplusEnv) && !process.env.ECHEANCIER_USE_OPS_LOGIN) {
  for (const line of fs.readFileSync(boxplusEnv, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^DECIPLUS_|^PLAYWRIGHT_BROWSERS_PATH$/.test(key)) continue;
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
process.env.ECHEANCIER_DRY_RUN = process.env.ECHEANCIER_DRY_RUN || '1';
process.env.BOT_ROLE = 'ops';

const { enqueue, listPending } = require('../lib/queue');
const { processOneJob } = require('../bot/index');
const { closeBrowser } = require('../bot/browser-pool');

(async () => {
  const session = path.join(__dirname, '..', 'data', 'session', 'storage-state.json');
  if (!fs.existsSync(session)) {
    console.error('Session Deciplus manquante:', session);
    process.exit(1);
  }

  console.log('=== TEST ÉCHÉANCIER ===');
  console.log({
    dry_run: process.env.ECHEANCIER_DRY_RUN,
    user: process.env.DECIPLUS_USER,
    limit: process.env.ECHEANCIER_LIMIT || 30,
  });

  const order = {
    order_id: `ECHEANCIER-TEST-${runId}`,
    action: 'echeancier',
    limit: Number(process.env.ECHEANCIER_LIMIT || 30),
    gym: 'minimes',
    product_name: 'Scan échéancier',
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
    console.error('FAIL échéancier');
    process.exit(1);
  }
  console.log(
    `\nOK scan — candidats: ${outcome?.result?.candidates ?? '?'} · dry_run=${process.env.ECHEANCIER_DRY_RUN}`
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
