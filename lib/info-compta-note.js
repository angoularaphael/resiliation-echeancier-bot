/**
 * Texte « Info Compte/Paiement » pour les ventes 4× sans frais.
 */
function formatFrDate(d) {
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function addDays(base, days) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function isFourXOrder(order = {}, productConfig = {}) {
  const plan = String(order.payment?.payment_plan || order.payment_plan || '').toLowerCase();
  if (plan === '4x') return true;
  const hint = [
    order.product_name,
    order.offer,
    productConfig.label,
    productConfig.deciplus_product_name,
  ]
    .filter(Boolean)
    .join(' ');
  return /4\s*[x×]\s*sans\s*frais/i.test(hint) && plan !== 'once';
}

/**
 * @returns {string} empty if not 4× (comptant / prélèvement → pas de note 4×)
 */
function buildFourXInfoComptaNote(order = {}, productConfig = {}, now = new Date()) {
  if (!isFourXOrder(order, productConfig)) return '';

  const offerName =
    productConfig.deciplus_product_name ||
    productConfig.label ||
    order.product_name ||
    order.offer ||
    'Offre 12 mois';

  const total =
    Number(order.payment?.amount) ||
    Number(productConfig.amount) ||
    259;
  const quart = Math.round((total / 4) * 100) / 100;
  const quartLabel = quart.toFixed(2).replace('.', ',');

  const d0 = formatFrDate(now);
  const d1 = formatFrDate(addDays(now, 30));
  const d2 = formatFrDate(addDays(now, 60));
  const d3 = formatFrDate(addDays(now, 90));

  return [
    `${offerName} — 4× sans frais`,
    `Paiement immédiat : ${quartLabel} € (${d0})`,
    `2ᵉ échéance : ${quartLabel} € (${d1})`,
    `3ᵉ échéance : ${quartLabel} € (${d2})`,
    `4ᵉ échéance : ${quartLabel} € (${d3})`,
    `Total : ${String(total).replace('.', ',')} €`,
  ].join('\n');
}

module.exports = {
  isFourXOrder,
  buildFourXInfoComptaNote,
  formatFrDate,
  addDays,
};
