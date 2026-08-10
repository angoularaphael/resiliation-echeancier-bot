/**
 * Config vente Deciplus — sans Playwright (safe Vercel serverless).
 */
const { loadJson } = require('./utils');
const {
  normalizeText,
  inferSaleType,
  buildDeciplusProductSearch,
} = require('./catalog-text');

function isTrialOrder(order) {
  const name = normalizeText(order.product_name || order.offer);
  return order.payment.amount === 0 || name.includes('essai');
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
    throw new Error(
      `Produit introuvable dans Deciplus: "${order.product_name || order.offer}"`
    );
  }

  const saleType = inferSaleType(matchedProduct);
  const typeDefaults = defaults[saleType] || defaults.abonnement;
  const paymentPlan = String(order.payment?.payment_plan || order.payment_plan || '').toLowerCase();
  const method = String(order.payment?.method || order.payment_method || '').toLowerCase();
  const orderHint = [
    order.product_name,
    order.offer,
    order.payment?.billing_plan,
    paymentPlan,
    method,
  ]
    .filter(Boolean)
    .join(' ');
  // Offre 259 € (1× / 4×) et titres « COMPTANT » → Paiement Comptant Deciplus.
  // Ne PAS utiliser method===payplug : la 1ʳᵉ échéance sans engagement est aussi PayPlug.
  const comptant =
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
    amount: order.payment.amount || matchedProduct.price,
    ...typeDefaults,
    sale_type: saleType,
    paiement_comptant: comptant,
    // Comptant Stripe/PayPlug déjà payé : pas d'IBAN / RIB Deciplus, Paiement Comptant ON
    requires_iban: comptant ? false : typeDefaults.requires_iban,
    skip_rib_prompt: comptant ? true : typeDefaults.skip_rib_prompt,
    auto_badge: saleType === 'abonnement' && !comptant,
  };
}

module.exports = {
  isTrialOrder,
  buildProductConfig,
};
