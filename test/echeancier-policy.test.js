'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyUnpaid,
  shouldCancel,
  shouldSendReminder,
  shouldCountAttempt,
  currentYearMonth,
  previousYearMonth,
  maxAttempts,
  parisDayKey,
} = require('../lib/echeancier-policy');
const { reminderCopy } = require('../lib/echeancier-mail');
const { mapOffer, eurosToCents } = require('../lib/echeancier-offer');

describe('echeancier-policy', () => {
  const now = new Date(2026, 7, 14);

  it('relance si impayé du mois en cours', () => {
    const c = classifyUnpaid(
      { unpaid_count: 1, months: ['2026-08'], timestamps: [now.getTime()] },
      now
    );
    assert.equal(c.hasCurrent, true);
    assert.equal(c.wantsReminder, true);
    assert.equal(c.stillUnpaid, true);
  });

  it('un seul mail : déjà envoyé → plus de relance mail', () => {
    const classified = classifyUnpaid({ unpaid_count: 1, months: ['2026-08'] }, now);
    assert.equal(shouldSendReminder({}, classified, { isRelance: true }), true);
    assert.equal(
      shouldSendReminder({ reminder_at: '2026-08-14T15:00:00.000Z' }, classified, { isRelance: true }),
      false
    );
    assert.equal(shouldSendReminder({}, classified, { isRelance: false }), false);
  });

  it('compte une tentative par jour à 17h', () => {
    const classified = classifyUnpaid({ unpaid_count: 1, months: ['2026-08'] }, now);
    assert.equal(shouldCountAttempt({}, classified, { isRelance: true, now }), true);
    assert.equal(
      shouldCountAttempt({ last_attempt_day: parisDayKey(now) }, classified, { isRelance: true, now }),
      false
    );
    assert.equal(shouldCountAttempt({}, classified, { isRelance: false, now }), false);
  });

  it('résilie à la 10e tentative si toujours impayé', () => {
    const classified = classifyUnpaid({ unpaid_count: 2, months: ['2026-07', '2026-08'] }, now);
    assert.equal(shouldCancel({ attempt_count: 9 }, classified), false);
    assert.equal(shouldCancel({ attempt_count: 10 }, classified), true);
    assert.equal(maxAttempts(), 10);
    assert.equal(previousYearMonth(now), '2026-07');
    assert.equal(currentYearMonth(now), '2026-08');
  });

  it('force cancel pour un test limité', () => {
    const classified = classifyUnpaid({ unpaid_count: 1, months: ['2026-08'] }, now);
    assert.equal(shouldCancel({}, classified, { force: true }), true);
  });
});

describe('echeancier-mail', () => {
  it('vouvoie et reste poli', () => {
    const copy = reminderCopy({
      prenom: 'Solenne',
      amountCents: 3899,
      offerLabel: '38,99 €',
      payUrl: 'https://boutique.boxingcenter.fr/regulariser?t=abc',
      gym: 'minimes',
    });
    assert.match(copy.html, /vous /i);
    assert.match(copy.html, /vous remercions/i);
    assert.doesNotMatch(copy.html, /\bton\b|\btu\b|\btes\b/i);
    assert.doesNotMatch(copy.text, /\bton\b|\btu\b|\btes\b/i);
    assert.match(copy.html, /regulariser/);
  });
});

describe('echeancier-offer', () => {
  it('mappe 29 / 36 / 44', () => {
    assert.equal(mapOffer({ productName: 'OFFRE A 29,99€', amountCents: 2999 }).key, '29');
    assert.equal(mapOffer({ productName: 'Etudiants 36,99€' }).key, '36');
    assert.equal(mapOffer({ productName: '44,99€/4 semaines' }).key, '44');
    assert.equal(eurosToCents(38.99), 3899);
    assert.equal(eurosToCents(3899), 3899);
  });
});
