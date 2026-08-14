'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyUnpaid,
  shouldCancel,
  currentYearMonth,
  previousYearMonth,
} = require('../lib/echeancier-policy');

describe('echeancier-policy', () => {
  const now = new Date(2026, 7, 14); // 14 août 2026

  it('relance si impayé du mois en cours', () => {
    const c = classifyUnpaid(
      { unpaid_count: 1, months: ['2026-08'], timestamps: [now.getTime()] },
      now
    );
    assert.equal(c.hasCurrent, true);
    assert.equal(c.wantsReminder, true);
    assert.equal(c.wantsContentieux, false);
  });

  it('contentieux si encore impayé le mois suivant', () => {
    const c = classifyUnpaid(
      { unpaid_count: 2, months: ['2026-07', '2026-08'] },
      now
    );
    assert.equal(c.hasPrevious, true);
    assert.equal(c.wantsContentieux, true);
    assert.equal(previousYearMonth(now), '2026-07');
    assert.equal(currentYearMonth(now), '2026-08');
  });

  it('résilie 24h après le mail contentieux', () => {
    const classified = classifyUnpaid({ unpaid_count: 2, months: ['2026-07'] }, now);
    assert.equal(
      shouldCancel({ cancel_after: '2026-08-13T10:00:00.000Z' }, classified, {
        now: new Date('2026-08-14T10:00:00.000Z'),
      }),
      true
    );
    assert.equal(
      shouldCancel({ cancel_after: '2026-08-15T10:00:00.000Z' }, classified, {
        now: new Date('2026-08-14T10:00:00.000Z'),
      }),
      false
    );
  });

  it('force cancel pour le test des 2 fiches', () => {
    const classified = classifyUnpaid({ unpaid_count: 1, months: ['2026-08'] }, now);
    assert.equal(shouldCancel({}, classified, { force: true }), true);
  });
});
