#!/usr/bin/env node
/**
 * Lecture seule : liste les impayés Deciplus (aucun mail, aucune résil).
 *   node scripts/list-unpaid.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
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

process.env.ECHEANCIER_DRY_RUN = '1';
process.env.BOT_ROLE = 'ops';
if (process.env.DECIPLUS_HEADLESS == null) process.env.DECIPLUS_HEADLESS = 'true';

const { classifyUnpaid, currentYearMonth, previousYearMonth } = require('../lib/echeancier-policy');
const { runWithSession, closeBrowser } = require('../bot/browser-pool');
const { login } = require('../bot/auth');
const { openEcheancierImpayes, collectUnpaidAcrossMonths } = require('../bot/echeancier-scan');

(async () => {
  const now = new Date();
  const ym = currentYearMonth(now);
  const prev = previousYearMonth(now);
  console.log('=== LISTE IMPAYÉS (lecture seule) ===');
  console.log({ user: process.env.DECIPLUS_USER, mois: ym, mois_prec: prev });

  const candidates = await runWithSession('list-unpaid', async (page) => {
    await login(page, { siteLabel: 'Minimes' });
    await openEcheancierImpayes(page);
    return collectUnpaidAcrossMonths(page);
  });

  const rows = (candidates || []).map((c) => {
    const cl = classifyUnpaid(c, now);
    const consecutive =
      cl.hasPrevious && cl.hasCurrent && Number(cl.unpaidCount) >= 2;
    return {
      member_id: c.member_id,
      name: c.name || '',
      unpaid: cl.unpaidCount,
      months: cl.months,
      due_today: cl.dueToday,
      mois_en_cours: cl.hasCurrent,
      mois_precedent: cl.hasPrevious,
      deux_a_la_suite: consecutive,
    };
  });

  const two = rows.filter((r) => r.deux_a_la_suite);
  const oneCurrent = rows.filter((r) => r.mois_en_cours && !r.mois_precedent);
  const dueToday = rows.filter((r) => r.due_today);

  console.log('\n=== TOTAUX ===');
  console.log({
    impayes_detectes: rows.length,
    deux_echeances_a_la_suite: two.length,
    seulement_mois_en_cours: oneCurrent.length,
    impaye_aujourdhui: dueToday.length,
  });
  console.log('\n=== 2 À LA SUITE (mois précédent + mois en cours) ===');
  console.log(two.length ? JSON.stringify(two, null, 2) : '(aucun)');
  const blanc = rows.filter((r) => /blanc/i.test(r.name || ''));
  if (blanc.length) {
    console.log('\n=== BLANC ===');
    console.log(JSON.stringify(blanc, null, 2));
  }

  await closeBrowser().catch(() => {});
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
