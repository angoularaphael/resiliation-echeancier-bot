/**
 * Catalogue Deciplus — récupéré automatiquement via l'API interne (pas de JSON manuel).
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { gotoDeciplus, getAccessToken } = require('./auth');
const {
  normalizeText,
  inferSaleType,
  buildDeciplusProductSearch,
} = require('../lib/catalog-text');
const { isTrialOrder, buildProductConfig } = require('../lib/catalog-sale');

const API_BASE = 'https://api.deciplus.pro/staff/v1';
const CATALOG_CACHE_MS = Number(process.env.BOT_CATALOG_CACHE_MS || 300000);
const CATALOG_FALLBACK_FILE = path.join(ROOT, 'data', 'storefront', 'catalog-live.json');

let catalogCache = { at: 0, products: [] };

async function ensureDeciplusAuth(page) {
  let token = await getAccessToken(page);

  if (token && page.url().includes('deciplus.pro')) {
    return token;
  }

  const warmPaths = token
    ? ['nextgen/home']
    : ['nextgen/home', 'select.php', 'check.php?idj=1'];

  for (const pathPart of warmPaths) {
    if (token && page.url().includes('deciplus.pro') && page.url().includes(pathPart.split('?')[0])) {
      break;
    }
    await gotoDeciplus(page, pathPart).catch((err) => {
      logWarn('Warm Deciplus ignoré', { path: pathPart, error: err.message });
    });
    token = token || (await getAccessToken(page));
    if (token) break;
  }

  return token;
}

function loadCatalogFallback() {
  if (!fs.existsSync(CATALOG_FALLBACK_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(CATALOG_FALLBACK_FILE, 'utf8'));
    if (!data.products?.length) return null;
    logWarn('Catalogue Deciplus — repli sur catalog-live.json', { count: data.products.length });
    return data.products.map((p) => ({
      id: p.deciplus_id,
      title: p.name,
      type: p.type || 'abo',
      categoryId: p.type || 'abo',
      categoryTitle: p.category,
      price: Number(p.deciplus_price || p.price_cents / 100 || 0),
      reference: p.reference,
    }));
  } catch {
    return null;
  }
}

async function fetchCatalogFromApi(page, token) {
  const base = process.env.DECIPLUS_URL || 'https://boxingcenter.deciplus.pro/';
  const url = `${API_BASE}/product/getAvailableProducts?all=true`;
  const referer = new URL('nextgen/home', base).href;
  const clientTypes = ['manager', 'manager_legacy'];

  let lastError = null;
  for (const clientType of clientTypes) {
    try {
      const response = await page.context().request.get(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'x-access-token': token,
          'Deciplus-Client-Type': clientType,
          Referer: referer,
        },
      });
      if (!response.ok()) {
        lastError = new Error(`Catalogue HTTP ${response.status()}`);
        continue;
      }
      const json = await response.json();
      return json.response || json;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Catalogue Deciplus inaccessible');
}

function flattenCatalog(response) {
  const products = [];
  for (const group of response || []) {
    const categoryId = group.id;
    const categoryTitle = group.title;
    for (const item of group.items || []) {
      if (item.enabled === 'N' || item.isArchived) continue;
      products.push({
        id: item.id,
        title: item.title,
        type: item.type || categoryId,
        categoryId,
        categoryTitle,
        price: Number(item.price || 0),
        reference: item.reference,
      });
    }
  }
  return products;
}

async function fetchDeciplusCatalog(page, { force = false } = {}) {
  const now = Date.now();
  if (!force && catalogCache.products.length && now - catalogCache.at < CATALOG_CACHE_MS) {
    return catalogCache.products;
  }

  const token = await ensureDeciplusAuth(page);
  if (!token) {
    const fallback = loadCatalogFallback();
    if (fallback) {
      catalogCache = { at: now, products: fallback };
      return fallback;
    }
    throw new Error('Token Deciplus introuvable — relancer login (session expirée)');
  }

  let data;
  try {
    data = await fetchCatalogFromApi(page, token);
  } catch (err) {
    logWarn('API catalogue Deciplus en échec', { error: err.message });
    const fallback = loadCatalogFallback();
    if (fallback) {
      catalogCache = { at: now, products: fallback };
      return fallback;
    }
    throw err;
  }

  const products = flattenCatalog(data);
  catalogCache = { at: now, products };
  logInfo('Catalogue Deciplus chargé', { count: products.length });
  return products;
}

function scoreMatch(query, product) {
  const q = normalizeText(query);
  const title = normalizeText(product.title);
  if (!q || !title) return 0;
  if (q === title) return 100;
  if (title.includes(q) || q.includes(title)) return 80;
  const qTokens = q.split(' ').filter(Boolean);
  const tTokens = new Set(title.split(' ').filter(Boolean));
  const overlap = qTokens.filter((t) => tTokens.has(t)).length;
  if (overlap >= 2) return 50 + overlap * 5;
  if (overlap === 1 && qTokens.length === 1) return 40;
  return 0;
}

function findProductInCatalog(catalog, order) {
  const candidates = [
    order.product_reference,
    order.product_name,
    order.deciplus_product_name,
    order.offer,
  ].filter(Boolean);

  let best = null;
  let bestScore = 0;

  for (const query of candidates) {
    for (const product of catalog) {
      let score = scoreMatch(query, product);
      if (String(query).startsWith('dp-') && String(product.id) === String(query).replace(/^dp-/, '')) {
        score = Math.max(score, 100);
      }
      if (String(query).match(/^\d+$/) && String(product.id) === String(query)) {
        score = Math.max(score, 100);
      }
      if (order.payment?.amount > 0 && product.price > 0) {
        const diff = Math.abs(product.price - order.payment.amount);
        if (diff < 1) score += 15;
        else if (diff < 5) score += 5;
      }
      if (score > bestScore) {
        bestScore = score;
        best = product;
      }
    }
  }

  const query = candidates[0] || '';
  if (!best || bestScore < 40) {
    logWarn('Produit Deciplus non trouvé dans le catalogue', { query, bestScore });
    return null;
  }

  logInfo('Produit Deciplus résolu', {
    query,
    matched: best.title,
    score: bestScore,
  });
  return best;
}

function buildSearchTokens(title) {
  const name = String(title || '').replace(/\s+/g, ' ').trim();
  const tokens = new Set();
  if (!name) return [];

  if (/association/i.test(name)) {
    tokens.add('ASSOCIATION');
    tokens.add('ASSOCIATION SPORTIVE');
    tokens.add('BOXING CENTER');
  }

  const withoutPrice = name.replace(/\s*€.*$/i, '').trim();
  const words = withoutPrice.split(/\s+/).filter((w) => w.length > 1);
  for (let len = Math.min(5, words.length); len >= 1; len -= 1) {
    tokens.add(words.slice(0, len).join(' '));
  }

  const price = name.match(/(\d+[,.]\d{2}|\d+)\s*€?/i);
  if (price) {
    tokens.add(price[1]);
    tokens.add(price[1].replace('.', ','));
  }

  return [...tokens].filter((t) => t.length >= 2 && t.length <= 45);
}

function findBadgeProduct(catalog) {
  if (!catalog?.length) return null;

  const exact = catalog.find((p) => normalizeText(p.title) === 'badge');
  if (exact) return exact;

  return (
    catalog.find(
      (p) =>
        /badge/i.test(p.title || '') &&
        (p.type === 'decipass' || p.categoryId === 'decipass' || p.type === 'seances')
    ) || catalog.find((p) => /^badge$/i.test(String(p.title || '').trim())) || null
  );
}

function resolveBadgeProductConfig(catalog, overrides = {}) {
  const matched = findBadgeProduct(catalog);
  if (!matched) {
    throw new Error('Produit Badge introuvable dans le catalogue Deciplus');
  }

  const defaults = loadJson('config/sale-defaults.json').carte;
  // Toujours différé ~72h / IBAN — plus de choix immédiat / carte
  const delayDays = Number(
    overrides.prelevement_delay_days || defaults.prelevement_delay_days || 3
  );

  return {
    key: String(matched.id),
    label: matched.title,
    deciplus_product_name: matched.title,
    deciplus_product_search: 'Badge',
    deciplus_product_id: matched.id,
    amount: Number(matched.price) || 34.99,
    ...defaults,
    sale_type: 'carte',
    paiement_comptant: false,
    badge_timing: 'deferred',
    badge_method: 'iban',
    prelevement_delay_days: delayDays,
    requires_iban: false,
    skip_rib_prompt: true,
    auto_badge: false,
  };
}

function resolveProductConfig(order, catalog) {
  if (isTrialOrder(order)) return buildProductConfig(order, null);
  if (order.deciplus_id) {
    const byId = catalog.find((p) => String(p.id) === String(order.deciplus_id));
    if (byId) return buildProductConfig(order, byId);
  }
  const matched = findProductInCatalog(catalog, order);
  return buildProductConfig(order, matched);
}

module.exports = {
  fetchDeciplusCatalog,
  findProductInCatalog,
  findBadgeProduct,
  resolveProductConfig,
  resolveBadgeProductConfig,
  buildProductConfig,
  normalizeText,
  inferSaleType,
  isTrialOrder,
  buildDeciplusProductSearch,
  buildSearchTokens,
};
