/**
 * Config vente Deciplus — sans Playwright (safe Vercel serverless).
 */
const { loadJson } = require('./utils');
const {
  normalizeText,
  inferSaleType,
  buildDeciplusProductSearch,
} = require('./catalog-text');

/** Produits boutique vendus en Deciplus via « Achat carte » (pas abonnement). */
const CARTE_PRODUCT_IDS = new Set([
  'seance-essai',
  'coaching-1',
  'coaching-5',
  'coaching-10',
]);

function isTrialOrder(order) {
  const amount = Number(order.payment?.amount ?? 0);
  if (amount > 0) return false;
  const name = normalizeText(order.product_name || order.offer);
  return name.includes('essai') || order.sale_type === 'none';
}

function isCarteMerchOrder(order) {
  const productId = String(order.product_id || order.product_reference || '').toLowerCase();
  if (CARTE_PRODUCT_IDS.has(productId) || productId.startsWith('coaching-')) return true;
  if (order.sale_type === 'carte' || order.sale_type === 'materiel') return true;
  const name = normalizeText(order.product_name || order.offer || productId);
  const amount = Number(order.payment?.amount ?? 0);
  if (amount > 0 && (name.includes('essai') || productId.includes('seance-essai'))) return true;
  if (amount > 0 && name.includes('coaching')) return true;
  return false;
}

function buildCarteFallbackConfig(order, defaults) {
  const typeDefaults = defaults.carte || defaults.abonnement;
  const productId = String(order.product_id || '').toLowerCase();
  const isEssai = productId.includes('seance-essai') ||
    normalizeText(order.product_name || order.offer).includes('essai');
  return {
    key: productId || (isEssai ? 'essai' : 'carte'),
    label: order.product_name || (isEssai ? "SEANCE D'ESSAI" : 'Carte'),
    deciplus_product_name:
      order.deciplus_product_name || order.product_name || (isEssai ? "SEANCE D'ESSAI" : null),
    deciplus_product_search:
      order.deciplus_product_search || (isEssai ? 'essai' : 'coaching'),
    amount: order.payment?.amount || (isEssai ? 10 : null),
    ...typeDefaults,
    sale_type: 'carte',
    paiement_comptant: true,
    requires_iban: false,
    skip_rib_prompt: true,
    create_sale: true,
    auto_badge: false,
  };
}

function buildProductConfig(order, matchedProduct = null) {
  const defaults = loadJson('config/sale-defaults.json');

  if (isTrialOrder(order)) {
    return {
      key: 'essai',
      label: order.product_name || 'Séance essai',
      sale_type: 'none',
      ...defaults.none,
    };
  }

  if (!matchedProduct) {
    if (isCarteMerchOrder(order)) {
      return buildCarteFallbackConfig(order, defaults);
    }
    throw new Error(
      `Produit introuvable dans Deciplus: "${order.product_name || order.offer}"`
    );
  }

  let saleType = inferSaleType(matchedProduct);
  // Boutique merch (essai 10€, packs coaching) → toujours Achat carte, même si
  // le produit Deciplus matché est typé « abo » dans le catalogue.
  if (isCarteMerchOrder(order)) {
    saleType = 'carte';
  }

  const typeDefaults = defaults[saleType] || defaults.abonnement;
  const paymentPlan = String(order.payment?.payment_plan || order.payment_plan || '').toLowerCase();
  const orderHint = [
    order.product_name,
    order.offer,
    order.payment?.billing_plan,
    paymentPlan,
    String(order.payment?.method || order.payment_method || '').toLowerCase(),
  ]
    .filter(Boolean)
    .join(' ');
  // Offre 259 € (1× / 4×) et titres « COMPTANT » → Paiement Comptant Deciplus.
  // Ne PAS utiliser method===payplug : la 1ʳᵉ échéance sans engagement est aussi PayPlug.
  const forceCarteComptant = saleType === 'carte' && isCarteMerchOrder(order);
  const comptant =
    forceCarteComptant ||
    /comptant/i.test(matchedProduct.title) ||
    paymentPlan === 'once' ||
    paymentPlan === '4x' ||
    /4\s*[x×]\s*sans\s*frais|1\s*[x×]\s*ou\s*4/i.test(orderHint) ||
    order.paiement_comptant === true;

  return {
    key: String(matchedProduct.id),
    label: matchedProduct.title,
    deciplus_product_name: matchedProduct.title,
    deciplus_product_search:
      order.deciplus_product_search ||
      buildDeciplusProductSearch(matchedProduct.title, matchedProduct.id),
    deciplus_product_id: matchedProduct.id,
    deciplus_reference: matchedProduct.reference || null,
    amount: order.payment?.amount || matchedProduct.price,
    ...typeDefaults,
    sale_type: saleType,
    paiement_comptant: comptant,
    // Comptant Stripe/PayPlug déjà payé : pas d'IBAN / RIB Deciplus, Paiement Comptant ON
    requires_iban: comptant ? false : typeDefaults.requires_iban,
    skip_rib_prompt: comptant ? true : typeDefaults.skip_rib_prompt,
    create_sale: true,
    auto_badge: saleType === 'abonnement' && !comptant,
  };
}

module.exports = {
  isTrialOrder,
  isCarteMerchOrder,
  buildProductConfig,
  CARTE_PRODUCT_IDS,
};
