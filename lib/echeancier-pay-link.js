'use strict';

const crypto = require('crypto');
const { getStoreUrl } = require('./app-urls');

function paySecret() {
  return String(process.env.SYNC_SECRET || process.env.ECHEANCIER_PAY_SECRET || '').trim();
}

function signPayToken(payload) {
  const secret = paySecret();
  if (!secret) throw new Error('SYNC_SECRET manquant pour le lien de paiement');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyPayToken(token) {
  const secret = paySecret();
  if (!secret) return null;
  const raw = String(token || '').trim();
  const dot = raw.lastIndexOf('.');
  if (dot < 8) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const exp = Number(payload.x || payload.exp || 0);
  if (exp && Date.now() / 1000 > exp) return null;
  return payload;
}

function buildPayUrl(fields) {
  const exp = Math.floor(Date.now() / 1000) + 21 * 24 * 3600;
  const token = signPayToken({
    m: String(fields.member_id || ''),
    e: String(fields.email || ''),
    p: String(fields.prenom || ''),
    n: String(fields.nom || ''),
    a: Number(fields.amount_cents) || 0,
    g: String(fields.gym || 'minimes'),
    o: String(fields.offer || 'other'),
    x: exp,
  });
  const base = String(process.env.BOXPLUS_STORE_URL || process.env.STORE_URL || getStoreUrl()).replace(
    /\/$/,
    ''
  );
  return `${base}/regulariser?t=${encodeURIComponent(token)}`;
}

module.exports = {
  paySecret,
  signPayToken,
  verifyPayToken,
  buildPayUrl,
};
