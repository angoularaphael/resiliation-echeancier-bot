/**
 * buildProductConfig — PayPlug 1ʳᵉ échéance ≠ comptant.
 */
const assert = require('assert');
const { buildProductConfig } = require('../lib/catalog-sale');

const duo = { id: 104, title: 'OFFRE DUO', price: 29, reference: 'dp-104' };
const saison = { id: 200, title: 'OFFRE PROMO 12 MOIS', price: 259, reference: 'saison' };
const comptantTitle = { id: 50, title: 'ABO 12 MOIS COMPTANT', price: 480 };

function run() {
  const ribPayplug = buildProductConfig(
    {
      product_name: 'Offre Duo 29',
      offer: 'offre-duo',
      payment: { amount: 29, method: 'payplug', billing_plan: 'rib' },
    },
    duo
  );
  assert.strictEqual(ribPayplug.paiement_comptant, false, '29€ PayPlug rib must NOT be comptant');
  assert.strictEqual(ribPayplug.auto_badge, true, '29€ must auto_badge');
  assert.strictEqual(ribPayplug.requires_iban, true, '29€ must require IBAN');

  const etu = buildProductConfig(
    {
      product_name: 'Étudiant 36,99',
      payment: { amount: 36.99, method: 'payplug', billing_plan: 'rib' },
    },
    { id: 88, title: 'ETUDIANT 36,99', price: 36.99 }
  );
  assert.strictEqual(etu.paiement_comptant, false, '36,99 PayPlug must NOT be comptant');
  assert.strictEqual(etu.auto_badge, true, '36,99 must auto_badge');

  const x4 = buildProductConfig(
    {
      product_name: 'Offre saison 259',
      payment: { amount: 259, method: 'payplug', payment_plan: '4x' },
    },
    saison
  );
  assert.strictEqual(x4.paiement_comptant, true, '259 4× must be comptant');
  assert.strictEqual(x4.auto_badge, false, '259 4× no auto badge');

  const once = buildProductConfig(
    {
      product_name: 'Offre saison 259',
      payment: { amount: 259, method: 'payplug', payment_plan: 'once' },
    },
    saison
  );
  assert.strictEqual(once.paiement_comptant, true, '259 1× must be comptant');

  const titled = buildProductConfig(
    { product_name: 'Abo comptant', payment: { amount: 480, method: 'payplug' } },
    comptantTitle
  );
  assert.strictEqual(titled.paiement_comptant, true, 'title COMPTANT must be comptant');

  console.log('ok — catalog-sale PayPlug / rib / 4x');
}

run();
