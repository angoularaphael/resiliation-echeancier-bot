/**
 * Aventure Balma : chercher la fiche sur Balma, recopier les infos,
 * créer un doublon Minimes (sans migrer ni résilier).
 */
const { logInfo, logWarn } = require('../lib/logger');
const { randomDelay } = require('../lib/utils');
const { getGymConfig } = require('../lib/normalize');
const { STATUS } = require('../lib/queue');
const { aventureBotPolicy } = require('../lib/aventure-policy');
const { applyMinimesDuplicateIdentity } = require('../lib/aventure-duplicate-address');
const { switchDeciplusSite } = require('./deciplus-zone');
const {
  findMemberByIdentity,
  searchMemberByName,
  CHANGE_MATCH_FIELDS,
  openMemberEditForm,
  openNewMemberForm,
  fillMemberForm,
  submitMemberForm,
  extractMemberId,
  resolveCreatedMemberId,
  resetMemberSearchContext,
  getMemberFormContext,
  clickCreerQuandMeme,
} = require('./member');

function getScopes(page) {
  return [page, ...(page.frames?.() || [])];
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
  if (!hit.found) return { found: false, reason: 'not_found', mismatch_fields: [] };
  const n = await countNameHits(page);
  if (n > 1) {
    logWarn('Homonyme Deciplus Balma — revue manuelle', { last_name: last, first_name: first, hits: n });
    return { found: false, reason: 'homonym', mismatch_fields: [], hits: n };
  }
  return hit;
}

async function readInput(scope, selector) {
  return scope.locator(selector).first().inputValue().catch(() => '');
}

async function readMemberProfile(page) {
  const ctx = await getMemberFormContext(page, { waitMs: 2000 });
  const scope =
    (await ctx.locator('form[name="db1_form"]').count()) > 0
      ? ctx.locator('form[name="db1_form"]').first()
      : ctx;
  const last_name = await readInput(scope, 'input[name="nom"]:not(#i_nom)');
  const first_name = await readInput(scope, 'input[name="prenom"]:not(#i_prenom)');
  const birthdate = await readInput(scope, 'input[name="date_naissance"]');
  let phone = await readInput(scope, 'input[name="telsms"]');
  if (!phone) phone = await readInput(scope, 'input[name="tel"]:not(#i_tel), input[name="telephone"]');
  const email = await readInput(scope, 'input[name="email"]:not(#i_email)');
  const address = await readInput(scope, 'input[name="adr1"]');
  const postal_code = await readInput(scope, 'input[name="codepostal"]');
  const city = await readInput(scope, 'input[name="ville"]');
  const gender = await readInput(scope, 'select[name="sexe"]');
  const country = await readInput(scope, 'input[name="pays"], select[name="pays"]');
  const zone_id = await readInput(scope, 'select[name="idz"]');
  return {
    last_name,
    first_name,
    birthdate,
    phone,
    email,
    address,
    postal_code,
    city,
    gender,
    country,
    zone_id,
  };
}

async function acceptDuplicateCreation(page) {
  return clickCreerQuandMeme(page, { timeoutMs: 12000 });
}

async function createMinimesDuplicate(page, customer, gymConfig, order, { excludeMemberId } = {}) {
  const excludeIds = [excludeMemberId].filter(Boolean);
  const patched = applyMinimesDuplicateIdentity(customer);
  logInfo('Doublon Minimes — prénom + Balma (filtre doublon Deciplus)', {
    from: customer.first_name,
    to: patched.first_name,
  });
  await resetMemberSearchContext(page);
  await openNewMemberForm(page, patched, { skipIdentityPrefill: true });
  await fillMemberForm(page, patched, gymConfig, order);
  const onDialog = async (dialog) => {
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    await submitMemberForm(page, { allowDuplicate: true, excludeIds });
    await acceptDuplicateCreation(page);
    const memberId = await resolveCreatedMemberId(page, patched, { excludeIds });
    if (memberId && String(memberId) === String(excludeMemberId || '')) {
      return { member_id: null, action: 'created_duplicate', reused_source_id: true };
    }
    if (memberId) return { member_id: memberId, action: 'created_duplicate' };
    return { member_id: null, action: 'created_duplicate' };
  } finally {
    page.off('dialog', onDialog);
  }
}

function mergeCustomer(identity, profile, order) {
  const paid = order.customer || {};
  return {
    last_name: profile.last_name || identity.last_name || paid.last_name,
    first_name: profile.first_name || identity.first_name || paid.first_name,
    birthdate: identity.birthdate || profile.birthdate || paid.birthdate,
    phone: paid.phone || profile.phone || identity.phone,
    email: paid.email || profile.email || identity.email,
    address: paid.address || profile.address,
    postal_code: paid.postal_code || profile.postal_code,
    city: paid.city || profile.city,
    gender: paid.gender || profile.gender,
    country: paid.country || profile.country || 'France',
  };
}

function isNoneOffer(id) {
  const raw = String(id || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, '-');
  return ['none', 'aucune', 'sans', 'sans-offre', 'no-offer', 'no_offer'].includes(raw);
}

function shouldCreateChosenOfferSale(order = {}) {
  const paid = String(order.payment?.status || '').toLowerCase() === 'paid';
  if (!paid) return false;
  const id = String(order.product_id || order.offer || '').trim();
  if (!id) return false;
  return !isNoneOffer(id);
}

async function createChosenOfferSale(page, memberId, gymConfig, order) {
  const { recordSale } = require('./sale');
  const { fetchDeciplusCatalog, resolveProductConfig } = require('./catalog');
  let catalog = [];
  try {
    catalog = await fetchDeciplusCatalog(page);
  } catch (err) {
    logWarn('Catalogue Deciplus indisponible pour vente Aventure', { error: err.message });
  }
  const productConfig = resolveProductConfig(order, catalog || []);
  const is259 = /saison|259|offre-saison|dp-100/i.test(
    `${order.product_id || ''} ${order.offer || ''} ${order.product_name || ''}`
  );
  if (is259) {
    productConfig.paiement_comptant = true;
    productConfig.requires_iban = false;
    productConfig.auto_badge = false;
  }
  productConfig.skip_rib_prompt = true;
  logInfo('Vente Aventure sur fiche Minimes', {
    member_id: memberId,
    product: order.product_id || order.offer,
  });
  return recordSale(page, order, productConfig, memberId, gymConfig, {
    badgeProductConfig: null,
  });
}

async function runBalmaSwitch(page, order) {
  const policy = aventureBotPolicy();
  const identity = {
    first_name: order.customer?.first_name || order.first_name,
    last_name: order.customer?.last_name || order.last_name,
    birthdate: order.customer?.birthdate || order.birthdate,
    phone: order.customer?.phone || order.phone,
    email: order.customer?.email || order.email,
  };
  const minimesConfig = getGymConfig(policy.create_gym) || getGymConfig('minimes');
  minimesConfig.key = policy.create_gym;
  const balmaConfig = getGymConfig(policy.search_gym) || getGymConfig('balma');

  await switchDeciplusSite(page, balmaConfig.deciplus_label || 'Balma');

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
          : 'Fiche adhérent introuvable sur Balma (nom / prénom)',
      mismatch: true,
      mismatch_reason: match.reason,
      cancelled: false,
      migrated: false,
    };
  }

  await openMemberEditForm(page, match.member_id).catch(() => {});
  const profile = await readMemberProfile(page);
  const customer = mergeCustomer(identity, profile, order);
  logInfo('Infos Balma lues pour doublon Minimes', {
    balma_member_id: match.member_id,
    has_email: Boolean(customer.email),
    has_phone: Boolean(customer.phone),
  });

  await switchDeciplusSite(page, minimesConfig.deciplus_label || 'Minimes');
  let created;
  try {
    created = await createMinimesDuplicate(page, customer, minimesConfig, {
      ...order,
      customer,
      gym: policy.create_gym,
    }, { excludeMemberId: match.member_id });
  } catch (err) {
    logWarn('Création doublon Minimes échouée', { error: err.message });
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'balma_switch',
      error: err.message,
      balma_member_id: match.member_id,
      cancelled: false,
      migrated: false,
    };
  }
  if (!created.member_id) {
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'balma_switch',
      error: 'Doublon Minimes créé mais ID introuvable',
      balma_member_id: match.member_id,
      cancelled: false,
      migrated: false,
    };
  }

  let sale = null;
  if (shouldCreateChosenOfferSale(order)) {
    sale = await createChosenOfferSale(page, created.member_id, minimesConfig, {
      ...order,
      gym: policy.create_gym,
      customer,
    }).catch((err) => {
      logWarn('Vente Aventure sur doublon Minimes échouée', { error: err.message });
      return { error: err.message };
    });
  }

  return {
    status: sale?.error ? STATUS.MANUAL_REVIEW : STATUS.SUCCESS,
    action: 'balma_switch',
    deciplus_member_id: created.member_id,
    balma_member_id: match.member_id,
    cancelled: false,
    migrated: false,
    duplicate: true,
    sale,
  };
}

module.exports = {
  findBalmaMember,
  readMemberProfile,
  acceptDuplicateCreation,
  createMinimesDuplicate,
  runBalmaSwitch,
  shouldCreateChosenOfferSale,
};
