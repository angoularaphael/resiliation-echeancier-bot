'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.SYNC_SECRET = process.env.SYNC_SECRET || 'test-secret-echeancier';

const { signPayToken, verifyPayToken, buildPayUrl } = require('../lib/echeancier-pay-link');

describe('echeancier-pay-link', () => {
  it('signe et vérifie un token', () => {
    const token = signPayToken({ m: '18492', a: 3899, g: 'minimes', o: '44', x: Math.floor(Date.now() / 1000) + 60 });
    const payload = verifyPayToken(token);
    assert.equal(payload.m, '18492');
    assert.equal(payload.a, 3899);
  });

  it('rejette une signature altérée', () => {
    const token = signPayToken({ m: '1', a: 1000, x: Math.floor(Date.now() / 1000) + 60 });
    assert.equal(verifyPayToken(token + 'x'), null);
  });

  it('construit l’URL /regulariser', () => {
    const url = buildPayUrl({
      member_id: '1',
      email: 'a@b.c',
      prenom: 'Solenne',
      nom: 'Hortala',
      amount_cents: 3899,
      gym: 'minimes',
      offer: 'other',
    });
    assert.match(url, /\/regulariser\?t=/);
  });
});
