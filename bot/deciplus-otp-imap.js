'use strict';

/**
 * Lit automatiquement le code email Deciplus (2FA / session) via IMAP.
 * Env :
 *   DECIPLUS_IMAP_USER / DECIPLUS_IMAP_PASS  (prioritaires)
 *   ou IMAP_USER / IMAP_PASS                 (repli, ex. même boîte que mail-bot)
 *   DECIPLUS_IMAP_HOST (défaut imap.gmail.com)
 *   DECIPLUS_IMAP_PORT (défaut 993)
 */

const { logInfo, logWarn } = require('../lib/logger');

function imapConfig() {
  const user = String(
    process.env.DECIPLUS_IMAP_USER || process.env.IMAP_USER || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '');
  // Mot de passe d’app Gmail : espaces d’affichage ignorés
  const pass = String(
    process.env.DECIPLUS_IMAP_PASS || process.env.IMAP_PASS || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '');
  return {
    host: process.env.DECIPLUS_IMAP_HOST || process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.DECIPLUS_IMAP_PORT || process.env.IMAP_PORT || 993),
    user,
    pass,
  };
}

function isImapOtpConfigured() {
  const { user, pass } = imapConfig();
  return Boolean(user && pass);
}

function extractOtpCode(text = '') {
  // Deciplus envoie souvent « 807 803 » avec espace fine (U+202F) entre les 3+3
  const raw = String(text || '')
    .replace(/[\u00A0\u202F\u2007\u2009]/g, ' ')
    .replace(/\s+/g, ' ');

  // Zone prioritaire : après « code unique » / « code suivant »
  const afterHint = raw.match(
    /code\s+unique[^0-9]{0,80}(\d{3}\s*\d{3}|\d{6}|\d{4,8})/i
  );
  if (afterHint?.[1]) return afterHint[1].replace(/\s+/g, '');

  const labeled = raw.match(
    /(?:code|otp|validation|vérification|verification)[^0-9]{0,40}(\d{3}\s*\d{3}|\d{6})\b/i
  );
  if (labeled?.[1]) return labeled[1].replace(/\s+/g, '');

  // 3+3 avec espace (ex. 807 803)
  const spaced = raw.match(/(?<!\d)(\d{3})\s+(\d{3})(?!\d)/);
  if (spaced) return `${spaced[1]}${spaced[2]}`;

  // 6 chiffres collés — ignorer années 20xx isolées
  const sixes = [...raw.matchAll(/(?<!\d)(\d{6})(?!\d)/g)].map((m) => m[1]);
  const notYear = sixes.find((c) => !/^20\d{2}/.test(c) && c !== '000000');
  if (notYear) return notYear;
  if (sixes[0]) return sixes[0];

  return null;
}

function looksLikeDeciplusOtpMail({ subject = '', from = '', text = '' } = {}) {
  const blob = `${subject}\n${from}\n${text}`.toLowerCase();
  if (/deciplus|boxing\s*center|boxingcenter/.test(blob)) return true;
  if (/(code|otp|vérification|verification|connexion|login|authent)/i.test(blob) && /\d{4,8}/.test(blob)) {
    return true;
  }
  return false;
}

/**
 * Poll IMAP jusqu’à trouver un code récent.
 * @param {{ maxWaitMs?: number, pollMs?: number, sinceMs?: number, notBeforeMs?: number }} opts
 */
async function fetchDeciplusEmailCode(opts = {}) {
  if (!isImapOtpConfigured()) {
    return null;
  }

  let ImapFlow;
  let simpleParser;
  try {
    const { ensureOtpDeps } = require('../lib/ensure-deps');
    ensureOtpDeps();
    ImapFlow = require('imapflow').ImapFlow;
    simpleParser = require('mailparser').simpleParser;
  } catch (err) {
    logWarn(
      'imapflow/mailparser absents — npm install imapflow mailparser (lecture auto code Deciplus)',
      { error: err.message }
    );
    return null;
  }

  const cfg = imapConfig();
  const maxWaitMs = Number(opts.maxWaitMs || process.env.DECIPLUS_OTP_WAIT_MS || 90000);
  const pollMs = Number(opts.pollMs || process.env.DECIPLUS_OTP_POLL_MS || 4000);
  const sinceMs = Number(opts.sinceMs || 15 * 60 * 1000);
  // Ignore les mails antérieurs au login (évite de rejouer un vieux code)
  const notBeforeMs = Number(opts.notBeforeMs || 0);
  const startedAt = Date.now();
  let attempt = 0;

  logInfo('Lecture IMAP du code email Deciplus…', {
    user: cfg.user,
    host: cfg.host,
    max_wait_s: Math.round(maxWaitMs / 1000),
  });

  while (Date.now() - startedAt < maxWaitMs) {
    attempt += 1;
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: true,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    // Évite un crash process si Gmail coupe la socket après logout / return
    client.on('error', () => {});

    let foundCode = null;
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const since = new Date(Date.now() - sinceMs);
        const uids = (await client.search({ since }, { uid: true })) || [];
        if (uids.length) {
          const dated = [];
          for await (const msg of client.fetch(uids, { uid: true, internalDate: true }, { uid: true })) {
            dated.push({ uid: msg.uid, date: msg.internalDate || new Date(0) });
          }
          dated.sort((a, b) => new Date(b.date) - new Date(a.date));
          const batch = dated.slice(0, 12).map((d) => d.uid);

          for await (const msg of client.fetch(
            batch,
            { uid: true, source: true, envelope: true, internalDate: true },
            { uid: true }
          )) {
            const parsed = await simpleParser(msg.source, {
              skipTextToHtml: false,
              skipImageLinks: true,
            });
            const subject = String(parsed.subject || msg.envelope?.subject || '');
            const from = String(
              parsed.from?.text ||
                (msg.envelope?.from || []).map((f) => f.address || '').join(' ') ||
                ''
            );
            const text = [parsed.text, parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '']
              .filter(Boolean)
              .join('\n');
            const mailAt = new Date(msg.internalDate || 0).getTime();
            if (notBeforeMs && mailAt + 2000 < notBeforeMs) continue;
            if (!looksLikeDeciplusOtpMail({ subject, from, text })) continue;
            const code = extractOtpCode(`${subject}\n${text}`);
            if (!code) continue;
            const ageSec = Math.round((Date.now() - mailAt) / 1000);
            logInfo('Code email Deciplus trouvé via IMAP', {
              subject: subject.slice(0, 80),
              age_s: ageSec,
              attempt,
            });
            foundCode = code;
            break;
          }
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logWarn('IMAP code Deciplus — tentative échouée', {
        attempt,
        error: err.message,
      });
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }

    if (foundCode) return foundCode;

    await new Promise((r) => setTimeout(r, pollMs));
  }

  logWarn('Aucun code email Deciplus trouvé dans la boîte IMAP', {
    user: cfg.user,
    waited_s: Math.round((Date.now() - startedAt) / 1000),
  });
  return null;
}

module.exports = {
  isImapOtpConfigured,
  extractOtpCode,
  looksLikeDeciplusOtpMail,
  fetchDeciplusEmailCode,
};
