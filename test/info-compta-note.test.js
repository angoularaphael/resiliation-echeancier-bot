/**
 * Unit — note Info Compte/Paiement pour 4×.
 */
const assert = require('assert');
const { buildFourXInfoComptaNote, isFourXOrder } = require('../lib/info-compta-note');

const now = new Date(2026, 7, 10); // 10/08/2026

const note4x = buildFourXInfoComptaNote(
  {
    product_name: 'OFFRE PROMO 12 MOIS',
    payment: { amount: 259, payment_plan: '4x', method: 'payplug' },
  },
  { deciplus_product_name: 'OFFRE PROMO 12 MOIS', amount: 259 },
  now
);

assert.ok(isFourXOrder({ payment: { payment_plan: '4x' } }));
assert.ok(note4x.includes('OFFRE PROMO 12 MOIS — 4× sans frais'));
assert.ok(note4x.includes('Paiement immédiat : 64,75 € (10/08/2026)'));
assert.ok(note4x.includes('2ᵉ échéance : 64,75 € (09/09/2026)'));
assert.ok(note4x.includes('Total : 259 €'));

const noteOnce = buildFourXInfoComptaNote(
  { payment: { amount: 259, payment_plan: 'once' } },
  { deciplus_product_name: 'OFFRE PROMO 12 MOIS' },
  now
);
assert.strictEqual(noteOnce, '', 'comptant 1× → pas de note 4×');

const noteRib = buildFourXInfoComptaNote(
  { payment: { amount: 29, method: 'payplug', billing_plan: 'rib' } },
  { label: 'OFFRE DUO' },
  now
);
assert.strictEqual(noteRib, '', '29€ prélèvement → pas de note 4×');

console.log('ok — info-compta-note 4×');
