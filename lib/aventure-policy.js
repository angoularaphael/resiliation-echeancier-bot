/**
 * Parcours Aventure Balma — règles métier (pas de migration, pas de résil).
 */
function aventureBotPolicy() {
  return {
    skip_cancel: true,
    skip_migrate: true,
    skip_restore: true,
    create_duplicate: true,
    search_gym: 'balma',
    create_gym: 'minimes',
    dispatch_after: 'payment',
  };
}

function isAventureOrder(order = {}) {
  const src = String(order.source || order.utm?.source || '').toLowerCase();
  return (
    order.aventure === true ||
    order.skip_dossier === true ||
    src === 'balma_retour' ||
    src.includes('balma_retour')
  );
}

module.exports = { aventureBotPolicy, isAventureOrder };
