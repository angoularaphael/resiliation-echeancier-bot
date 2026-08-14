'use strict';

const { extractGymFromTexts } = require('./gym-slugs');

const OFFERS = {
  '29': { key: '29', label: '29,99 €', product_id: 'offre-duo', cents: 2999 },
  '36': { key: '36', label: '36,99 €', product_id: 'etudiants-4-semaines', cents: 3699 },
  '44': { key: '44', label: '44,99 €', product_id: '44-99-4-semaines', cents: 4499 },
};

function eurosToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (Number.isInteger(n) && n >= 200) return n;
  return Math.round(n * 100);
}

function mapOffer({ productName = '', amountCents = 0 } = {}) {
  const t = String(productName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const cents = Number(amountCents) || 0;

  if (/duo|\boffre\s*a?\s*29|29[,.]?99|dp-104|offre-duo|offre_29/.test(t) || cents === 2999 || cents === 2900) {
    return OFFERS['29'];
  }
  if (/etudiant|36[,.]?99|36[,.]99/.test(t) || cents === 3699 || cents === 3600) {
    return OFFERS['36'];
  }
  if (/44[,.]?99/.test(t) || cents === 4499 || cents === 4400) {
    return OFFERS['44'];
  }
  if (cents === 2999) return OFFERS['29'];
  if (cents === 3699) return OFFERS['36'];
  if (cents === 4499) return OFFERS['44'];
  return {
    key: 'other',
    label: cents ? `${(cents / 100).toFixed(2).replace('.', ',')} €` : 'échéance',
    product_id: null,
    cents: cents || 0,
  };
}

function gymFromUnpaid(row = {}, fallback = 'minimes') {
  return extractGymFromTexts(
    [
      row.gym,
      row.site,
      row.site_name,
      row.zone,
      row.zone_name,
      row.club,
      ...(row.samples || []),
    ],
    fallback
  );
}

function formatEurosFromCents(cents) {
  const n = Number(cents) || 0;
  return `${(n / 100).toFixed(2).replace('.', ',')} €`;
}

module.exports = {
  OFFERS,
  eurosToCents,
  mapOffer,
  gymFromUnpaid,
  formatEurosFromCents,
};
