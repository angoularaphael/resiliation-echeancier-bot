'use strict';

/**
 * Job Aventure au démarrage OPS :
 * vérif fiche Balma COMMENT / migax, création Minimes (prénom + Balma, sans mail),
 * puis vente OFFRE DUO 29 € + badge offert.
 */
const fs = require('fs');
const path = require('path');

function buildCommentMigaxSeedOrder() {
  return {
    order_id: 'AVENTURE-SEED-COMMENT-MIGAX-29',
    action: 'balma_switch',
    gym: 'minimes',
    source: 'balma_retour',
    aventure: true,
    offer: 'offre-duo',
    product_id: 'offre-duo',
    product_name: 'OFFRE DUO 29€',
    deciplus_product_search: 'OFFRE DUO 29',
    sale_type: 'abo',
    requires_payment: true,
    requires_iban: true,
    badge_timing: 'immediate',
    badge_method: 'comptant',
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
    payment: {
      status: 'paid',
      amount: 29,
      method: 'iban',
      badge_timing: 'immediate',
      badge_method: 'comptant',
    },
  };
}

function dropOldCommentSeeds() {
  const { QUEUE_DIR } = require('./queue');
  if (!QUEUE_DIR || !fs.existsSync(QUEUE_DIR)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(QUEUE_DIR)) {
    if (!f.endsWith('.json') || f === 'processed-orders.json') continue;
    if (!/AVENTURE-SEED-COMMENT-MIGAX/i.test(f)) continue;
    if (/MIGAX-29/i.test(f)) continue;
    fs.unlinkSync(path.join(QUEUE_DIR, f));
    n += 1;
  }
  return n;
}

function seedCommentMigaxJob() {
  const { enqueue } = require('./queue');
  const { normalizeOrder } = require('./normalize');
  dropOldCommentSeeds();
  return enqueue(normalizeOrder(buildCommentMigaxSeedOrder()));
}

module.exports = { buildCommentMigaxSeedOrder, seedCommentMigaxJob, dropOldCommentSeeds };
