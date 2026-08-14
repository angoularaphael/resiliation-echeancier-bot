#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (browsersDir) {
  const abs = path.isAbsolute(browsersDir) ? browsersDir : path.join(__dirname, '..', browsersDir);
  const ok = fs.existsSync(abs) && fs.readdirSync(abs).some((n) => /chromium/i.test(n));
  if (!ok) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
      process.env.USERPROFILE || '',
      'AppData',
      'Local',
      'ms-playwright'
    );
  }
}
const { runWithSession, closeBrowser } = require('../bot/browser-pool');
const { login } = require('../bot/auth');
const { fetchMemberContactApi } = require('../bot/echeancier-scan');

const id = process.argv[2] || '15914';
(async () => {
  const contact = await runWithSession('probe-email', async (page) => {
    await login(page, { siteLabel: 'Minimes' });
    return fetchMemberContactApi(page, id);
  });
  console.log({ member_id: id, has_email: Boolean(contact.email), prenom: contact.firstName, nom: contact.lastName });
  await closeBrowser().catch(() => {});
})().catch(async (err) => {
  console.error(err);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
