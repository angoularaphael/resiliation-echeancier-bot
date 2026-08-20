'use strict';

const { logInfo, logWarn } = require('../lib/logger');
const { boxingCenterGymsExceptBalma } = require('../lib/gym-slugs');
const { getGymConfig } = require('../lib/normalize');
const { switchDeciplusSite } = require('./deciplus-zone');
const { findMemberByIdentity } = require('./member');

async function memberZoneLooksBalma(page) {
  const balmaZone = String(getGymConfig('balma')?.deciplus_zone_id || '1');
  const scopes = [page, ...(page.frames?.() || [])];
  for (const ctx of scopes) {
    const val = await ctx
      .locator('form[name="db1_form"] select[name="idz"]')
      .first()
      .inputValue()
      .catch(() => '');
    if (val) return String(val) === balmaZone;
  }
  return false;
}

/**
 * Identité résil / changement d’abo : 5 salles Boxing Center.
 * Balma seulement si includeBalma (fiche vraiment sur Balma).
 */
async function findMemberOnBoxingCenterGyms(page, identity, options = {}) {
  const slugs = boxingCenterGymsExceptBalma(options.preferredGym);
  if (options.includeBalma && !slugs.includes('balma')) {
    slugs.unshift('balma');
  }
  let last = { found: false, reason: 'not_found', mismatch_fields: [] };
  for (const slug of slugs) {
    const gym = getGymConfig(slug);
    const label = gym?.deciplus_label || gym?.label;
    const switched = await switchDeciplusSite(page, label).catch((err) => {
      logWarn('Site BC non ouvert pour vérif', { gym: slug, error: err.message });
      return false;
    });
    if (!switched) continue;
    const match = await findMemberByIdentity(page, identity, options);
    if (!match.found) {
      last = match;
      continue;
    }
    if (!options.includeBalma && (await memberZoneLooksBalma(page))) {
      logInfo('Fiche Balma ignorée (résil / changement)', { member_id: match.member_id, gym: slug });
      last = { found: false, reason: 'balma_skipped', member_id: match.member_id };
      continue;
    }
    logInfo('Fiche trouvée hors Balma', { member_id: match.member_id, gym: slug });
    return { ...match, gym: slug };
  }
  return last;
}

module.exports = { findMemberOnBoxingCenterGyms, memberZoneLooksBalma };
