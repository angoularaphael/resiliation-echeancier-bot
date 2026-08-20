'use strict';

const assert = require('assert');
const {
  isBalmaSaleTarget,
  assertNotBalmaSale,
  BALMA_SALE_ERROR,
} = require('../lib/gym-slugs');

assert.equal(isBalmaSaleTarget({ key: 'balma' }), true);
assert.equal(isBalmaSaleTarget({ deciplus_label: 'Balma' }), true);
assert.equal(isBalmaSaleTarget({}, { gym: 'balma' }), true);
assert.equal(isBalmaSaleTarget({ deciplus_zone_id: '1' }), true);
assert.equal(isBalmaSaleTarget({ key: 'minimes', deciplus_label: 'Minimes', deciplus_zone_id: '2' }), false);
assert.equal(isBalmaSaleTarget({}, { gym: 'minimes' }), false);

assert.throws(() => assertNotBalmaSale({ key: 'balma' }, {}), (err) => err.message === BALMA_SALE_ERROR);

console.log('gym-slugs-balma-sale.test.js ok');
