'use strict';

/**
 * Job Aventure unique au démarrage OPS :
 * vérif fiche Balma COMMENT / migax, puis création Minimes (prénom + Balma, sans mail).
 */
function buildCommentMigaxSeedOrder() {
  return {
    order_id: 'AVENTURE-SEED-COMMENT-MIGAX',
    action: 'balma_switch',
    gym: 'minimes',
    source: 'balma_retour',
    aventure: true,
    offer: 'none',
    product_id: 'none',
    product_name: 'Fiche Aventure COMMENT migax',
    sale_type: 'none',
    requires_payment: false,
    requires_iban: false,
    customer: {
      first_name: 'migax',
      last_name: 'COMMENT',
      birthdate: '2001-09-30',
      email: 'migax72520@buloan.com',
      phone: '0666666666',
      address: '12211',
      postal_code: '12211',
      city: 'Toulouse',
      country: 'France',
      gender: 'M',
    },
    payment: { status: 'unpaid', amount: 0, method: 'none' },
  };
}

function seedCommentMigaxJob() {
  const { enqueue } = require('./queue');
  const { normalizeOrder } = require('./normalize');
  return enqueue(normalizeOrder(buildCommentMigaxSeedOrder()));
}

module.exports = { buildCommentMigaxSeedOrder, seedCommentMigaxJob };
