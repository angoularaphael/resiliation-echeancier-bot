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
  remainingDays,
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
    assert.equal(remainingDays(1), 10);
    assert.equal(remainingDays(10), 1);
    assert.equal(previousYearMonth(now), '2026-07');
    assert.equal(currentYearMonth(now), '2026-08');
  });

  it('force cancel pour un test limité', () => {
    const classified = classifyUnpaid({ unpaid_count: 1, months: ['2026-08'] }, now);
    assert.equal(shouldCancel({}, classified, { force: true }), true);
  });
});

describe('echeancier-mail', () => {
  it('vouvoie, bouton payer et lien en clair', () => {
    const copy = reminderCopy({
      prenom: 'Solenne',
      amountCents: 2999,
      offerLabel: '29,99 €',
      payUrl: 'https://boutique.boxingcenter.fr/regulariser?t=abc',
      gym: 'minimes',
    });
    assert.match(copy.subject, /un clic pour régler/i);
    assert.match(copy.html, /Bonjour Solenne/);
    assert.match(copy.html, /Payer maintenant/);
    assert.match(copy.html, /carte bancaire/i);
    assert.match(copy.html, /PayPal/);
    assert.match(copy.html, /regulariser\?t=abc/);
    assert.match(copy.html, />10</);
    assert.match(copy.html, /jours pour payer/);
    assert.match(copy.html, /gerer-abonnement#resilier/);
    assert.match(copy.html, /Résilier avec David/);
    assert.match(copy.html, /identiques à ceux de votre inscription/);
    assert.equal(copy.daysLeft, 10);
    assert.match(copy.html, /\bvous\b|\bvotre\b/i);
    assert.doesNotMatch(copy.html, /(?:^|[\s>])(?:tu |ton |tes |toi)|t'|Salut /i);
    assert.doesNotMatch(copy.text, /(?:^|[\s>])(?:tu |ton |tes |toi)|t'|Salut /i);
  });

  it('Portet : PayPal uniquement', () => {
    const copy = reminderCopy({
      prenom: 'Léa',
      amountCents: 4499,
      offerLabel: '44,99 €',
      payUrl: 'https://boutique.boxingcenter.fr/regulariser?t=portet',
      gym: 'portet',
    });
    assert.match(copy.html, /PayPal/);
    assert.match(copy.html, /Payer maintenant/);
    assert.doesNotMatch(copy.html, /choisissez <strong>carte bancaire/i);
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
