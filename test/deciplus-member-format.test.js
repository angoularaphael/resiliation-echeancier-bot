'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  phoneForDeciplus,
  expandDeciplusUrl,
  extractMemberIdFromUrl,
  isNewMemberUrl,
} = require('../lib/deciplus-member-format');

describe('phoneForDeciplus', () => {
  it('garde un mobile FR classique', () => {
    assert.equal(phoneForDeciplus('06 12 34 56 78'), '0612345678');
  });

  it('normalise +33', () => {
    assert.equal(phoneForDeciplus('+33612345678'), '0612345678');
  });

  it('corrige saisie 11 chiffres sans 0 (cas nowa)', () => {
    assert.equal(phoneForDeciplus('76233478493'), '0762334784');
  });

  it('ajoute 0 si 9 chiffres', () => {
    assert.equal(phoneForDeciplus('612345678'), '0612345678');
  });
});

describe('extractMemberIdFromUrl / legacy nextgen', () => {
  it('extrait idj depuis check.php', () => {
    assert.equal(
      extractMemberIdFromUrl('https://boxingcenter.deciplus.pro/check.php?idj=21013'),
      '21013'
    );
  });

  it('extrait idj depuis nextgen/legacy?path=', () => {
    const url =
      'https://boxingcenter.deciplus.pro/nextgen/legacy?path=%2Fcheck.php%3Fidj%3D21013';
    assert.equal(extractMemberIdFromUrl(url), '21013');
  });

  it('détecte idj=new encodé (bug Valider vs Mettre à jour)', () => {
    const url =
      'https://boxingcenter.deciplus.pro/nextgen/legacy?path=%2Fjoueurs.php%3Fidj%3Dnew';
    assert.equal(isNewMemberUrl(url), true);
    assert.equal(extractMemberIdFromUrl(url), null);
  });

  it('select.php sans id → pas de faux positif', () => {
    assert.equal(
      extractMemberIdFromUrl(
        'https://boxingcenter.deciplus.pro/nextgen/legacy?path=%2Fselect.php'
      ),
      null
    );
  });

  it('expand décode le path', () => {
    const expanded = expandDeciplusUrl(
      'https://boxingcenter.deciplus.pro/nextgen/legacy?path=%2Fjoueurs.php%3Fidj%3Dnew'
    );
    assert.match(expanded, /idj=new/);
  });
});
