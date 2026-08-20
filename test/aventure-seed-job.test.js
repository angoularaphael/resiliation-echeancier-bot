'use strict';

const assert = require('assert');
const { buildCommentMigaxSeedOrder } = require('../lib/aventure-seed-job');
const { normalizeOrder } = require('../lib/normalize');

function shouldCreateChosenOfferSale(order = {}) {
  const paid = String(order.payment?.status || '').toLowerCase() === 'paid';
  if (!paid) return false;
  const id = String(order.product_id || order.offer || '').trim();
  if (!id) return false;
  const raw = id
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, '-');
  return !['none', 'aucune', 'sans', 'sans-offre', 'no-offer', 'no_offer'].includes(raw);
}

function run() {
  const raw = buildCommentMigaxSeedOrder();
  assert.strictEqual(raw.offer, 'offre-duo');
  assert.strictEqual(raw.product_id, 'offre-duo');
  assert.strictEqual(raw.payment.status, 'paid');
  assert.strictEqual(raw.payment.amount, 29);

  const order = normalizeOrder(raw);
  assert.strictEqual(order.offer, 'offre-duo');
  assert.strictEqual(order.product_id, 'offre-duo');
  assert.strictEqual(order.payment.status, 'paid');
  assert.strictEqual(order.payment.amount, 29);
  assert.strictEqual(shouldCreateChosenOfferSale(order), true, 'job 29 paid must trigger Minimes sale');
}

run();
console.log('aventure-seed-job.test.js ok');
