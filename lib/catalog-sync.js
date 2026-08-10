/**
 * Sync catalogue Deciplus → catalog-live.json (Playwright + API Deciplus).
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { launchBrowser, login, saveSession } = require('../bot/auth');
const { fetchDeciplusCatalog } = require('../bot/catalog');
const { ROOT, ensureDir } = require('./utils');
const { getCatalogIngestUrl } = require('./app-urls');
const { logInfo, logError } = require('./logger');

const SYNC_FILE = path.join(ROOT, 'data', 'storefront', 'catalog-live.json');

function saveCatalogSnapshot(products, meta = {}) {
  ensureDir(path.dirname(SYNC_FILE));
  const payload = {
    synced_at: new Date().toISOString(),
    count: products.length,
    products,
    ...meta,
  };
  fs.writeFileSync(SYNC_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function syncCatalogFromDeciplus(options = {}) {
  const {
    force = true,
    saveFile = true,
    page: pageOption,
    sharedPage,
    context: contextOption,
    sharedContext,
  } = options;
  const resolvedPage = sharedPage || pageOption;
  const resolvedContext = sharedContext || contextOption;

  let browser;
  let context;
  let page;
  let ownsBrowser = false;

  try {
    if (resolvedPage) {
      page = resolvedPage;
      context = resolvedContext;
    } else {
      ({ browser, context, page } = await launchBrowser());
      ownsBrowser = true;
      await login(page);
      await saveSession(context);
    }

    const raw = await fetchDeciplusCatalog(page, { force });
    const { deciplusToStorefront, validateSync } = require('../storefront/lib/deciplus-sync');
    const products = deciplusToStorefront(raw);
    const validation = validateSync(products);

    const payload = {
      synced_at: new Date().toISOString(),
      count: products.length,
      products,
      deciplus_count: raw.length,
      validation,
      synced_by: 'bot-playwright',
    };

    if (saveFile) saveCatalogSnapshot(products, payload);

    logInfo('Catalogue Deciplus synchronisé', {
      products: products.length,
      validation_ok: validation.ok,
    });

    return { ok: true, payload, validation, count: products.length };
  } catch (err) {
    logError('Échec sync catalogue Deciplus', { error: err.message });
    return { ok: false, error: err.message };
  } finally {
    if (ownsBrowser && browser) await browser.close();
  }
}

async function pushCatalogToStore(payload) {
  const url = process.env.STORE_INGEST_URL || getCatalogIngestUrl();
  const secret = process.env.SYNC_SECRET;
  if (!url || !secret) {
    return { skipped: true, reason: 'STORE_INGEST_URL ou SYNC_SECRET manquant' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sync-secret': secret,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ingest boutique HTTP ${res.status}: ${text.slice(0, 120)}`);
  }

  logInfo('Catalogue poussé vers la boutique', { url, count: payload.count });
  return { ok: true };
}

async function syncAndPushCatalog(options = {}) {
  const result = await syncCatalogFromDeciplus({ force: true, saveFile: true, ...options });
  if (!result.ok) return result;

  try {
    await pushCatalogToStore(result.payload);
  } catch (err) {
    logError('Push catalogue boutique en échec', { error: err.message });
    return { ...result, push_ok: false, push_error: err.message };
  }

  return { ...result, push_ok: true };
}

module.exports = {
  syncCatalogFromDeciplus,
  pushCatalogToStore,
  syncAndPushCatalog,
  SYNC_FILE,
};
