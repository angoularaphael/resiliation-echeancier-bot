/**
 * URLs publiques — prod Vercel box-plus.vercel.app, dev localhost.
 */
const PRODUCTION_STORE_URL = 'https://box-plus.vercel.app';

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function resolvePublicUrl(envVarName, { localPort, productionFallback = PRODUCTION_STORE_URL } = {}) {
  const fromEnv = process.env[envVarName];
  if (fromEnv && String(fromEnv).trim()) {
    return stripTrailingSlash(fromEnv);
  }

  if (process.env.VERCEL === '1' || process.env.VERCEL) {
    const vercelHost =
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_URL;
    if (vercelHost) {
      const host = vercelHost.replace(/^https?:\/\//, '');
      return `https://${host}`;
    }
  }

  if (localPort) {
    return `http://localhost:${localPort}`;
  }

  return stripTrailingSlash(productionFallback);
}

function getStoreUrl() {
  return resolvePublicUrl('STORE_URL', { localPort: 3040 });
}

/**
 * URL de retour Stripe / liens checkout.
 * En local (localhost), utilise l'hôte de la requête pour ne pas renvoyer vers Vercel.
 */
function getCheckoutBaseUrl(req) {
  const host = String(req?.get?.('host') || '').trim();
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    return `${proto}://${host}`;
  }
  return getStoreUrl();
}

function getBridgeUrl() {
  const botOrBridge =
    process.env.BOXPLUS_BOT_URL ||
    process.env.BOXPLUS_BRIDGE_URL;
  if (botOrBridge && String(botOrBridge).trim()) {
    return stripTrailingSlash(botOrBridge);
  }
  return resolvePublicUrl('BOXPLUS_BRIDGE_URL', { localPort: 3030, productionFallback: '' }) || null;
}

function getCatalogIngestUrl() {
  const explicit = process.env.STORE_INGEST_URL;
  if (explicit && String(explicit).trim()) {
    return stripTrailingSlash(explicit);
  }
  return `${getStoreUrl()}/api/admin/ingest-catalog`;
}

function isVercelProduction() {
  return Boolean(process.env.VERCEL === '1' || process.env.VERCEL);
}

module.exports = {
  PRODUCTION_STORE_URL,
  getStoreUrl,
  getCheckoutBaseUrl,
  getBridgeUrl,
  getCatalogIngestUrl,
  isVercelProduction,
  resolvePublicUrl,
};
