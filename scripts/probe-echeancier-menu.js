#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const boxplusEnv = path.join(__dirname, '..', '..', 'BOXPLUS', '.env');
if (fs.existsSync(boxplusEnv)) {
  for (const line of fs.readFileSync(boxplusEnv, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    if (!/^DECIPLUS_/.test(k)) continue;
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

const { runWithSession, closeBrowser } = require('../bot/browser-pool');
const { login } = require('../bot/auth');

(async () => {
  const out = await runWithSession('probe', async (page) => {
    await login(page, { siteLabel: 'Minimes' });
    const origin = new URL(page.url()).origin;
    const urls = [
      'nextgen/',
      'nextgen/manager',
      'echeanciers.php',
      'nextgen/legacy?path=' + encodeURIComponent('/echeanciers.php'),
      'nextgen/legacy?path=' + encodeURIComponent('/manager/echeanciers'),
      'nextgen/legacy?path=' + encodeURIComponent('/manager.php?page=echeanciers'),
    ];
    const tried = [];
    for (const rel of urls) {
      await page
        .goto(new URL(rel, origin + '/').href, { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => {});
      await page.waitForTimeout(1000);
      const body = await page.locator('body').innerText().catch(() => '');
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a'))
          .map((a) => ({
            t: (a.innerText || '').trim().slice(0, 80),
            h: a.getAttribute('href') || '',
          }))
          .filter((x) => /ech[eé]ancier|manager|impay|encaisse/i.test(`${x.t} ${x.h}`))
          .slice(0, 50)
      );
      tried.push({
        href: page.url(),
        hasEch: /ech[eé]ancier/i.test(body),
        snippet: body.replace(/\s+/g, ' ').slice(0, 180),
        links,
      });
    }

    await page.goto(new URL('nextgen/', origin + '/').href, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1000);
    // Hover Manager
    const manager = page.getByText(/^Manager$/i).first();
    if ((await manager.count()) > 0) {
      await manager.hover().catch(() => {});
      await page.waitForTimeout(600);
    }
    const menus = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('a, button, span, li'))
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return [
        ...new Set(
          items.filter(
            (t) => /manager|ech[eé]ancier|impay|encaisse|caisse/i.test(t) && t.length < 100
          )
        ),
      ].slice(0, 80);
    });
    const allHrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.getAttribute('href'))
        .filter((h) => h && /ech|manager|impay/i.test(h))
        .slice(0, 60)
    );
    return { tried, menus, allHrefs, final: page.url() };
  });
  console.log(JSON.stringify(out, null, 2));
  await closeBrowser();
})().catch(async (err) => {
  console.error(err);
  try {
    await closeBrowser();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
