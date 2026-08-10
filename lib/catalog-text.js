/**
 * Utilitaires catalogue Deciplus — sans Playwright (safe Vercel serverless).
 */
function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/€/g, 'e')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function inferSaleType(product) {
  const type = product.type || product.categoryId || '';
  if (type === 'decipass' || /badge/i.test(product.title)) return 'carte';
  if (['seances', 'seance'].includes(type)) return 'carte';
  if (type === 'abo' || product.categoryId === 'abo') return 'abonnement';
  return 'abonnement';
}

function buildDeciplusProductSearch(title, productId = null) {
  const name = String(title || '').replace(/\s+/g, ' ').trim();
  if (!name) return productId ? String(productId) : '';

  if (/association/i.test(name)) return 'ASSOCIATION';
  if (/baby boxe/i.test(name)) return 'BABY BOXE';
  if (/boxe educative/i.test(name)) return 'BOXE EDUCATIVE';

  if (/training camp/i.test(name)) {
    const price =
      name.match(/(\d+[,.]\d{2})\s*€/i)?.[1] ||
      name.match(/^(\d+[,.]?\d*)\s*€?\s*\/?/i)?.[1];
    if (price) return price.replace(',', '.');
    return 'Training camp';
  }

  if (/cours illimit/i.test(name)) {
    const price = name.match(/(\d+[,.]\d{2})/);
    if (price) return price[1].replace(',', '.');
    return 'Cours illimités';
  }

  if (/offre promo/i.test(name)) {
    const price = name.match(/(\d+[,.]\d{2}|\d+)\s*€?/i);
    if (price) {
      const p = price[1].replace(',', '.');
      return p.length <= 2 ? `OFFRE PROMO ${p.replace('.00', '')}` : p;
    }
    return 'OFFRE PROMO';
  }

  if (/offre a\s*29/i.test(name)) return 'OFFRE A 29';

  if (/comptant/i.test(name)) {
    const parts = name.split(/\s+/).slice(0, 3);
    return parts.join(' ');
  }

  const price = name.match(/(\d+[,.]\d{2})/);
  if (price) return price[1].replace(',', '.');

  const segments = name.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
  const shortestUseful = segments.find((s) => s.length >= 4 && s.length <= 35 && !/^offre/i.test(s));
  if (shortestUseful) return shortestUseful.replace(/\s*€.*$/i, '').trim();

  const stripped = name.replace(/\s*€.*$/i, '').trim();
  if (stripped.length <= 35) return stripped;

  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]} ${words[1]}`;
  return words[0] || stripped.slice(0, 20);
}

module.exports = {
  normalizeText,
  inferSaleType,
  buildDeciplusProductSearch,
};
