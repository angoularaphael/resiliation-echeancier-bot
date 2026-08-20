'use strict';

/**
 * Helpers purs (sans Playwright) — format téléphone + URLs Deciplus nextgen/legacy.
 */

/**
 * Normalise un téléphone FR en 10 chiffres (0XXXXXXXXX).
 * Ne tronque plus les numéros trop longs (sinon 07878787879 ≈ 0787878787).
 */
function phoneForDeciplus(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('33') && digits.length === 11) {
    digits = `0${digits.slice(2)}`;
  } else if (digits.startsWith('33') && digits.length === 12 && digits[2] === '0') {
    // 3306… → 06…
    digits = digits.slice(2);
  }

  if (digits.length === 9 && /^[1-9]/.test(digits)) {
    digits = `0${digits}`;
  }

  // Exactement 10 chiffres nationaux — pas de slice silencieux
  if (/^0\d{9}$/.test(digits)) return digits;
  return '';
}

function expandDeciplusUrl(url = '') {
  const raw = String(url || '');
  const parts = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) parts.push(decoded);
  } catch {
    /* ignore */
  }
  try {
    const u = new URL(raw);
    const pathParam = u.searchParams.get('path');
    if (pathParam) {
      parts.push(pathParam);
      try {
        parts.push(decodeURIComponent(pathParam));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return parts.join('\n');
}

function extractMemberIdFromUrl(url = '') {
  const haystack = expandDeciplusUrl(url);
  const patterns = [
    /check\.php\?[^#\s]*idj=(\d+)/i,
    /select\.php\?[^#\s]*idjnew=(\d+)/i,
    /select\.php\?[^#\s]*idj=(\d+)/i,
    /joueurs\.php\?[^#\s]*idj=(\d+)/i,
    /[?&]idjnew=(\d+)/i,
    /[?&]idj=(\d+)/i,
  ];
  for (const re of patterns) {
    const m = haystack.match(re);
    if (m && m[1] !== 'new') return m[1];
  }
  return null;
}

function isNewMemberUrl(url = '') {
  return /idj=new|idj%3Dnew/i.test(expandDeciplusUrl(url));
}

/** Saisie recherche Deciplus : majuscules, espaces normalisés (la fiche stocke TEST, pas Test). */
function nameForDeciplusSearch(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function namesMatch(a, b) {
  const na = String(a || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const nb = String(b || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return Boolean(na && nb && na === nb);
}

module.exports = {
  phoneForDeciplus,
  expandDeciplusUrl,
  extractMemberIdFromUrl,
  isNewMemberUrl,
  nameForDeciplusSearch,
  namesMatch,
};
