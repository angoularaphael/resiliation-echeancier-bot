/**
 * Migration Deciplus Balma → Minimes.
 * Ordre coach : sauvegarder abo (produit + dates) → résilier → impayés →
 * changer le site → remettre le même abo aux mêmes dates.
 */
const { randomDelay, loadJson } = require('../lib/utils');
const { logInfo, logWarn } = require('../lib/logger');
const { openMemberCheck } = require('./wallet');
const { findActiveContracts, cancelSale, formatFrDate } = require('./cancel-sale');
const { deleteUnpaidOnMember } = require('./unpaid-clean');
const {
  searchMemberByName,
  CHANGE_MATCH_FIELDS,
  findMemberByIdentity,
} = require('./member');
const { getGymConfig } = require('../lib/normalize');
const { STATUS } = require('../lib/queue');

const BALMA_MATCH_FIELDS = ['last_name', 'first_name'];

function getSelectors() {
  try {
    return loadJson('config/deciplus-selectors.json');
  } catch {
    return {};
  }
}

function getScopes(page) {
  return [page, ...(page.frames?.() || [])];
}

function parseFrDates(text) {
  const matches = String(text || '').match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  return {
    start: matches[0] || null,
    end: matches[1] || null,
    next: matches[2] || matches[1] || null,
  };
}

function productSearchFromLabel(label) {
  return String(label || '')
    .replace(/\s+/g, ' ')
    .replace(/\d{2}\/\d{2}\/\d{4}/g, '')
    .replace(/\b(badge|impayé|résilié)\b/gi, '')
    .trim()
    .slice(0, 48);
}

async function countNameHits(page) {
  const ids = new Set();
  for (const ctx of getScopes(page)) {
    const links = ctx.locator('a[href*="idj="], a[href*="idj%3D"]');
    const n = await links.count().catch(() => 0);
    for (let i = 0; i < n; i += 1) {
      const href = (await links.nth(i).getAttribute('href').catch(() => '')) || '';
      const id = (href.match(/idj(?:=|%3D)(\d+)/i) || [])[1];
      if (id) ids.add(id);
    }
  }
  return ids.size;
}

async function findBalmaMember(page, identity) {
  const last = String(identity.last_name || '').trim();
  const first = String(identity.first_name || '').trim();
  if (!last || !first) {
    return { found: false, reason: 'missing_identity', mismatch_fields: ['last_name', 'first_name'] };
  }

  if (identity.birthdate) {
    const full = await findMemberByIdentity(page, identity, {
      matchFields: identity.phone ? undefined : CHANGE_MATCH_FIELDS,
    });
    if (full.found) return full;
  }

  const hit = await searchMemberByName(page, last, first);
  if (!hit.found) {
    return { found: false, reason: 'not_found', mismatch_fields: [] };
  }
  const n = await countNameHits(page);
  if (n > 1) {
    logWarn('Homonyme Deciplus — revue manuelle', {
      last_name: last,
      first_name: first,
      hits: n,
    });
    return { found: false, reason: 'homonym', mismatch_fields: [], hits: n };
  }
  return hit;
}

async function snapshotContracts(page, memberId, gymConfig) {
  await openMemberCheck(page, memberId, gymConfig);
  const contracts = await findActiveContracts(page).catch(() => []);
  const snapshots = [];
  for (const c of contracts) {
    if (c.isBadge) continue;
    const dates = parseFrDates(c.label);
    snapshots.push({
      idc: c.idc,
      label: c.label,
      search: productSearchFromLabel(c.label),
      start: dates.start,
      end: dates.end,
      next: dates.next,
      isBadge: Boolean(c.isBadge),
    });
  }
  logInfo('Abo sauvegardés avant migration', {
    member_id: memberId,
    count: snapshots.length,
    labels: snapshots.map((s) => s.search),
  });
  return snapshots;
}

async function clickFirstVisible(builders) {
  for (const build of builders) {
    try {
      const loc = build();
      const n = await loc.count();
      if (n > 0 && (await loc.first().isVisible().catch(() => false))) {
        await loc.first().click({ force: true });
        await randomDelay(500, 900);
        return true;
      }
    } catch {
      /* sélecteur invalide sur ce contexte */
    }
  }
  return false;
}

async function clickMigrateIcon(page) {
  const builders = [];
  for (const ctx of getScopes(page)) {
    builders.push(
      () => ctx.locator('div.bouton_change_zone'),
      () => ctx.locator('[title="Migrer ce membre"]'),
      () => ctx.locator('[onclick="sendToZone"], [onclick*="sendToZone("]')
    );
  }
  return clickFirstVisible(builders);
}

async function openMoveMemberPage(page, memberId) {
  const { gotoDeciplus } = require('./auth');
  const qs = `moveMember.php?idj=${encodeURIComponent(memberId)}`;
  const paths = [
    `nextgen/legacy?path=${encodeURIComponent(`/${qs}`)}`,
    qs,
  ];
  for (const rel of paths) {
    await gotoDeciplus(page, rel).catch(() => {});
    await randomDelay(500, 900);
    for (const ctx of getScopes(page)) {
      if ((await ctx.locator('select#idz, #moveMemCheck').count().catch(() => 0)) > 0) {
        return true;
      }
    }
  }
  return false;
}

async function pickMinimesInMigratePicker(page, gymConfig = {}) {
  const label = gymConfig.deciplus_label || 'Minimes';
  const zoneId = String(gymConfig.deciplus_zone_id || '2');
  const needle = new RegExp(String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  for (const ctx of getScopes(page)) {
    const picker = ctx.locator('select#idz').first();
    if ((await picker.count()) === 0) continue;
    const byValue = await picker.selectOption(zoneId).then(() => true).catch(() => false);
    if (byValue) {
      logInfo('Site destination Deciplus (idz)', { zone_id: zoneId, site: label });
      return true;
    }
    const options = await picker.locator('option').all();
    for (const opt of options) {
      const text = ((await opt.textContent().catch(() => '')) || '').trim();
      if (!needle.test(text)) continue;
      const value = await opt.getAttribute('value');
      if (!value) continue;
      await picker.selectOption(value);
      logInfo('Site destination Deciplus (label)', { site: text, zone_id: value });
      return true;
    }
  }
  return false;
}

async function confirmMigrate(page) {
  page.once('dialog', async (dialog) => {
    await dialog.accept().catch(() => {});
  });
  const builders = [];
  for (const ctx of getScopes(page)) {
    builders.push(
      () => ctx.locator('input.fichemembre_button[value*="Changer le site"]'),
      () => ctx.locator('input[onclick*="sendToZone"][value*="Changer"]'),
      () => ctx.locator('input[type="button"][value*="Changer le site de ce membre"]')
    );
  }
  const ok = await clickFirstVisible(builders);
  if (ok) await randomDelay(1000, 1600);
  return ok;
}

async function migrateMemberToGym(page, memberId, gymConfig) {
  await openMemberCheck(page, memberId, gymConfig).catch(() => {});
  await randomDelay(400, 700);
  let onMovePage = false;
  if (await clickMigrateIcon(page)) {
    await randomDelay(700, 1200);
    for (const ctx of getScopes(page)) {
      if ((await ctx.locator('select#idz, #moveMemCheck').count().catch(() => 0)) > 0) {
        onMovePage = true;
        break;
      }
    }
  }
  if (!onMovePage) {
    onMovePage = await openMoveMemberPage(page, memberId);
  }
  if (!onMovePage) {
    const api = await migrateMemberViaApi(page, memberId, gymConfig);
    if (api.ok) {
      logInfo('Migration salle Deciplus', {
        member_id: memberId,
        to: gymConfig.deciplus_label || 'Minimes',
        via: api.via,
      });
      return { ok: true, gym: gymConfig.key || 'minimes', via: api.via };
    }
    throw new Error('Page CHANGEMENT DE SITE (moveMember.php) introuvable');
  }

  const picked = await pickMinimesInMigratePicker(page, gymConfig);
  if (!picked) {
    logWarn('Site Minimes non sélectionné dans #idz — on tente le bouton quand même');
  }
  const confirmed = await confirmMigrate(page);
  if (!confirmed) {
    const api = await migrateMemberViaApi(page, memberId, gymConfig);
    if (api.ok) {
      return { ok: true, gym: gymConfig.key || 'minimes', via: api.via };
    }
    throw new Error('Bouton « Changer le site de ce membre » introuvable');
  }
  logInfo('Migration salle Deciplus', {
    member_id: memberId,
    to: gymConfig.deciplus_label || 'Minimes',
    zone_id: gymConfig.deciplus_zone_id || '2',
    via: 'moveMember.php',
  });
  return { ok: true, gym: gymConfig.key || 'minimes' };
}

async function migrateMemberViaApi(page, memberId, gymConfig) {
  const { getAccessToken } = require('./auth');
  const token = await getAccessToken(page);
  if (!token) return { ok: false, reason: 'no_token' };
  const zoneId = Number(gymConfig.deciplus_zone_id || 2);
  const headers = {
    'x-access-token': token,
    'Deciplus-Client-Type': 'manager',
    'Content-Type': 'application/json',
  };
  const url = `https://api.deciplus.pro/staff/v1/member/${memberId}`;
  for (const method of ['PATCH', 'PUT']) {
    const res = await page.context().request.fetch(url, {
      method,
      headers,
      data: { zoneId },
    });
    const status = res.status();
    logInfo('Migration salle API Deciplus', { member_id: memberId, method, status, zoneId });
    if (status >= 200 && status < 300) return { ok: true, via: `api_${method.toLowerCase()}`, status };
  }
  const legacy = await page.context().request.fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Deciplus-Client-Type': 'manager_legacy' },
    data: { zoneId },
  });
  logInfo('Migration salle API legacy', { member_id: memberId, status: legacy.status(), zoneId });
  if (legacy.ok()) return { ok: true, via: 'api_legacy', status: legacy.status() };
  return { ok: false, reason: `api_${legacy.status()}` };
}

async function restoreContracts(page, memberId, snapshots, gymConfig, order) {
  if (!snapshots.length) {
    return { restored: 0, skipped: true };
  }
  const { recordSale } = require('./sale');
  const { fetchDeciplusCatalog, resolveProductConfig } = require('./catalog');
  let catalog = null;
  try {
    catalog = await fetchDeciplusCatalog(page);
  } catch (err) {
    logWarn('Catalogue Deciplus indisponible pour restore abo', { error: err.message });
  }

  let restored = 0;
  for (const snap of snapshots) {
    if (!snap.search) continue;
    const fakeOrder = {
      ...order,
      product_name: snap.search,
      deciplus_product_search: snap.search,
      gym: gymConfig.key || 'minimes',
      payment: {
        ...(order.payment || {}),
        status: 'paid',
        amount: order.payment?.amount || 1,
      },
      paiement_comptant: false,
    };
    let productConfig;
    try {
      productConfig = resolveProductConfig(fakeOrder, catalog || []);
    } catch (err) {
      logWarn('Restore abo — produit introuvable', {
        search: snap.search,
        error: err.message,
      });
      continue;
    }
    productConfig.restore_start_fr = snap.start;
    productConfig.restore_end_fr = snap.end;
    productConfig.skip_rib_prompt = true;
    try {
      await recordSale(page, fakeOrder, productConfig, memberId, gymConfig, {
        badgeProductConfig: null,
      });
      restored += 1;
    } catch (err) {
      logWarn('Restore abo échoué', { search: snap.search, error: err.message });
    }
  }
  logInfo('Abo remis après migration', { member_id: memberId, restored, total: snapshots.length });
  return { restored };
}

async function runBalmaSwitch(page, order) {
  const identity = {
    first_name: order.customer?.first_name || order.first_name,
    last_name: order.customer?.last_name || order.last_name,
    birthdate: order.customer?.birthdate || order.birthdate,
    phone: order.customer?.phone || order.phone,
    email: order.customer?.email || order.email,
  };
  const gymConfig = getGymConfig(order.gym || 'minimes') || getGymConfig('minimes');
  gymConfig.key = order.gym || 'minimes';

  const knownId = String(order.deciplus_member_id || order.customer?.deciplus_member_id || '').trim();
  const match = knownId
    ? { found: true, member_id: knownId }
    : await findBalmaMember(page, identity);
  if (!match.found) {
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'balma_switch',
      error:
        match.reason === 'homonym'
          ? 'Plusieurs fiches au même nom — traitement manuel'
          : 'Fiche adhérent introuvable (nom / prénom)',
      mismatch: true,
      mismatch_reason: match.reason,
    };
  }
  const memberId = match.member_id;

  const snapshots =
    Array.isArray(order.snapshots) && order.snapshots.length
      ? order.snapshots
      : await snapshotContracts(page, memberId, gymConfig);

  if (!order.skip_cancel) {
    await cancelSale(page, memberId, {
      cancelDate: order.cancel_date || formatFrDate(new Date()),
      cancel_reason: 'balma_switch',
      skipComptantGuard: true,
    }).catch((err) => {
      logWarn('Résiliation avant migration — poursuite', { error: err.message, member_id: memberId });
    });
  }

  const unpaid = await deleteUnpaidOnMember(page, memberId, gymConfig).catch((err) => {
    logWarn('Nettoyage impayés — poursuite', { error: err.message, member_id: memberId });
    return { deleted: 0, remaining: null };
  });

  await migrateMemberToGym(page, memberId, gymConfig);

  const restore = await restoreContracts(page, memberId, snapshots, gymConfig, order).catch(
    (err) => {
      logWarn('Restore abo après migration échoué', { error: err.message, member_id: memberId });
      return { restored: 0 };
    }
  );

  return {
    status: STATUS.SUCCESS,
    action: 'balma_switch',
    deciplus_member_id: memberId,
    snapshots,
    unpaid,
    restore,
  };
}

module.exports = {
  BALMA_MATCH_FIELDS,
  findBalmaMember,
  snapshotContracts,
  migrateMemberToGym,
  restoreContracts,
  runBalmaSwitch,
  parseFrDates,
  productSearchFromLabel,
};
