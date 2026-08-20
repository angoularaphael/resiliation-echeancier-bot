/**
 * Aventure Balma : chercher la fiche sur Balma, recopier les infos,
 * créer une fiche Minimes en création normale (prénom + Balma, sans mail/tel).
 */
const { logInfo, logWarn } = require('../lib/logger');
const { getGymConfig } = require('../lib/normalize');
const { STATUS } = require('../lib/queue');
const { aventureBotPolicy } = require('../lib/aventure-policy');
const { applyMinimesDuplicateIdentity } = require('../lib/aventure-duplicate-address');
const { switchDeciplusSite } = require('./deciplus-zone');
const {
  findMemberByIdentity,
  findAventureBalmaMember,
  openMemberEditForm,
  openNewMemberForm,
  fillMemberForm,
  submitMemberForm,
  resolveCreatedMemberId,
  resetMemberSearchContext,
  getMemberFormContext,
  uploadMemberPhoto,
  downloadMemberPhoto,
} = require('./member');

async function findBalmaMember(page, identity) {
  return findAventureBalmaMember(page, identity);
}

function balmaSwitchMatchError(match) {
  if (match.reason === 'need_email') {
    return 'Plusieurs fiches Balma correspondent à ce nom. Indique l’email de ta fiche Balma.';
  }
  if (match.reason === 'identity_mismatch') {
    return match.mismatch_fields?.includes('email')
      ? 'Plusieurs fiches correspondent : l’email ne matche aucune d’entre elles.'
      : 'Nom, prénom ou date de naissance ne correspondent pas à une fiche Balma.';
  }
  if (match.reason === 'missing_identity') {
    return 'Merci de renseigner nom, prénom et date de naissance.';
  }
  return 'Fiche adhérent introuvable sur Balma (nom, prénom, date de naissance).';
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
  const address2 = await readInput(scope, 'input[name="adr2"]');
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
    address2,
    postal_code,
    city,
    gender,
    country,
    zone_id,
  };
}

async function readMemberIban(page, memberId) {
  const { openRibForm, closeGreyboxIfOpen } = require('./wallet');
  const { normalizeIban, isValidFrenchIban } = require('../lib/iban');
  try {
    const ctx = await openRibForm(page, memberId, { forceFresh: true });
    const raw = await ctx.locator('input[name="iban"]').first().inputValue().catch(() => '');
    await closeGreyboxIfOpen(page);
    const iban = normalizeIban(raw);
    return isValidFrenchIban(iban) ? iban : '';
  } catch (err) {
    await closeGreyboxIfOpen(page).catch(() => {});
    logWarn('IBAN Balma illisible', { member_id: memberId, error: err.message });
    return '';
  }
}

async function createMinimesMember(page, customer, gymConfig, order, { excludeMemberId } = {}) {
  const excludeIds = [excludeMemberId].filter(Boolean);
  const patched = applyMinimesDuplicateIdentity(customer);
  const existing = await findMemberByIdentity(page, patched, {
    matchFields: ['last_name', 'first_name', 'birthdate'],
  }).catch(() => ({ found: false }));
  if (
    existing.found &&
    existing.member_id &&
    String(existing.member_id) !== String(excludeMemberId || '')
  ) {
    logInfo('Fiche Minimes Aventure déjà présente — réutilisation', {
      member_id: existing.member_id,
    });
    return { member_id: existing.member_id, action: 'reused' };
  }
  logInfo('Création Minimes — prénom + Balma, sans mail ni téléphone', {
    from: customer.first_name,
    to: patched.first_name,
    has_address: Boolean(patched.address),
  });
  await resetMemberSearchContext(page);
  await openNewMemberForm(page, patched, { skipIdentityPrefill: true });
  await fillMemberForm(page, patched, gymConfig, order);
  await clearMinimesContactFields(page);
  await submitMemberForm(page);
  const memberId = await resolveCreatedMemberId(page, patched, { excludeIds });
  if (memberId && String(memberId) === String(excludeMemberId || '')) {
    return { member_id: null, action: 'created', reused_source_id: true };
  }
  if (memberId) return { member_id: memberId, action: 'created' };
  return { member_id: null, action: 'created' };
}

async function clearMinimesContactFields(page) {
  const ctx = await getMemberFormContext(page);
  for (const sel of [
    'form[name="db1_form"] input[name="email"]:not(#i_email)',
    'form[name="db1_form"] input[name="telsms"]',
    'form[name="db1_form"] input[name="tel"]:not(#i_tel)',
  ]) {
    const el = ctx.locator(sel).first();
    if ((await el.count()) > 0) await el.fill('').catch(() => {});
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
    address2: paid.address2 || profile.address2,
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
  const { fetchDeciplusCatalog, resolveProductConfig, resolveBadgeProductConfig } = require('./catalog');
  const { applyBillingPlanToProductConfig } = require('../lib/billing-plan');
  const { assertNotBalmaSale } = require('../lib/gym-slugs');
  const minimesConfig = { ...(getGymConfig('minimes') || gymConfig), key: 'minimes' };
  assertNotBalmaSale(minimesConfig, { ...order, gym: 'minimes' });
  const switched = await switchDeciplusSite(page, minimesConfig.deciplus_label || 'Minimes');
  if (!switched) throw new Error('Impossible d’ouvrir Minimes pour la vente Aventure');
  let catalog = [];
  try {
    catalog = await fetchDeciplusCatalog(page);
  } catch (err) {
    logWarn('Catalogue Deciplus indisponible pour vente Aventure', { error: err.message });
  }
  const productConfig = applyBillingPlanToProductConfig(
    resolveProductConfig(order, catalog || []),
    order
  );
  const hint = `${order.product_id || ''} ${order.offer || ''} ${order.product_name || ''}`;
  const is259 = /saison|259|offre-saison|dp-100/i.test(hint);
  const is29 = /offre-duo|offre_29|dp-104|\b29\b/i.test(hint);
  if (is259) {
    productConfig.paiement_comptant = true;
    productConfig.requires_iban = false;
    productConfig.auto_badge = false;
  }
  productConfig.skip_rib_prompt = true;

  let badgeProductConfig = null;
  if (!is259 && productConfig.auto_badge) {
    try {
      const giftBadge =
        String(order.source || '').toLowerCase() === 'balma_retour' && is29;
      badgeProductConfig = resolveBadgeProductConfig(
        catalog || [],
        giftBadge
          ? {
              badge_timing: 'immediate',
              badge_method: 'comptant',
              paiement_comptant: true,
              prelevement_delay_days: 0,
            }
          : {
              badge_timing: order.badge_timing || order.payment?.badge_timing || 'deferred',
              badge_method: order.badge_method || order.payment?.badge_method || 'iban',
            }
      );
    } catch (err) {
      logWarn('Badge Aventure non ajouté', { error: err.message });
    }
  }

  logInfo('Vente Aventure sur fiche Minimes', {
    member_id: memberId,
    product: order.product_id || order.offer,
    badge: Boolean(badgeProductConfig),
    badge_offert: is29 && String(order.source || '').toLowerCase() === 'balma_retour',
  });
  return recordSale(page, order, productConfig, memberId, minimesConfig, {
    badgeProductConfig,
  });
}

async function copyBalmaExtrasToMinimes(page, minimesId, extras, customer, gymConfig) {
  const out = { photo: null, iban: null };
  if (extras.photoPath) {
    try {
      out.photo = await uploadMemberPhoto(page, extras.photoPath, extras.photoBase64 || null, minimesId);
      logInfo('Photo Balma recopiée sur Minimes', { member_id: minimesId, ok: Boolean(out.photo?.ok) });
    } catch (err) {
      logWarn('Photo Balma non recopiée', { error: err.message });
      out.photo = { ok: false, error: err.message };
    }
  }
  if (extras.iban) {
    try {
      const { setMemberIban } = require('./wallet');
      await setMemberIban(page, minimesId, extras.iban, customer, gymConfig);
      out.iban = { ok: true };
      logInfo('RIB Balma recopié sur Minimes', { member_id: minimesId });
    } catch (err) {
      logWarn('RIB Balma non recopié', { error: err.message });
      out.iban = { ok: false, error: err.message };
    }
  }
  if (extras.photoCleanup && extras.photoPath) {
    try {
      require('fs').unlinkSync(extras.photoPath);
    } catch {
      /* ignore */
    }
  }
  return out;
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

  await switchDeciplusSite(page, balmaConfig.deciplus_label || 'Balma').then((ok) => {
    if (!ok) throw new Error('Impossible d’ouvrir la salle Balma sur Deciplus');
  });

  const knownId = String(order.deciplus_member_id || order.customer?.deciplus_member_id || '').trim();
  const match = knownId
    ? { found: true, member_id: knownId }
    : await findBalmaMember(page, identity);
  if (!match.found) {
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'balma_switch',
      error: balmaSwitchMatchError(match),
      mismatch: true,
      mismatch_reason: match.reason,
      mismatch_fields: match.mismatch_fields || [],
      cancelled: false,
      migrated: false,
    };
  }

  await openMemberEditForm(page, match.member_id).catch(() => {});
  const profile = await readMemberProfile(page);
  const customer = mergeCustomer(identity, profile, order);
  const extras = {
    iban: await readMemberIban(page, match.member_id),
    photoPath: null,
    photoBase64: null,
    photoCleanup: false,
  };
  const photo = await downloadMemberPhoto(page, match.member_id).catch((err) => {
    logWarn('Photo Balma illisible', { error: err.message });
    return null;
  });
  if (photo?.path) {
    extras.photoPath = photo.path;
    extras.photoBase64 = photo.dataUrl || null;
    extras.photoCleanup = Boolean(photo.cleanup);
  }
  logInfo('Infos Balma lues pour création Minimes', {
    balma_member_id: match.member_id,
    has_address: Boolean(customer.address),
    has_iban: Boolean(extras.iban),
    has_photo: Boolean(extras.photoPath),
  });

  await switchDeciplusSite(page, minimesConfig.deciplus_label || 'Minimes').then((ok) => {
    if (!ok) throw new Error('Impossible d’ouvrir la salle Minimes sur Deciplus');
  });
  let created;
  try {
    created = await createMinimesMember(
      page,
      customer,
      minimesConfig,
      {
        ...order,
        customer,
        gym: policy.create_gym,
      },
      { excludeMemberId: match.member_id }
    );
  } catch (err) {
    logWarn('Création Minimes échouée', { error: err.message });
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
      error: 'Fiche Minimes créée mais ID introuvable',
      balma_member_id: match.member_id,
      cancelled: false,
      migrated: false,
    };
  }

  const extrasResult = await copyBalmaExtrasToMinimes(
    page,
    created.member_id,
    extras,
    applyMinimesDuplicateIdentity(customer),
    minimesConfig
  );

  let sale = null;
  if (shouldCreateChosenOfferSale(order)) {
    sale = await createChosenOfferSale(page, created.member_id, minimesConfig, {
      ...order,
      gym: policy.create_gym,
      customer,
    }).catch((err) => {
      logWarn('Vente Aventure sur fiche Minimes échouée', { error: err.message });
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
    extras: extrasResult,
    sale,
  };
}

module.exports = {
  findBalmaMember,
  readMemberProfile,
  createMinimesMember,
  createMinimesDuplicate: createMinimesMember,
  runBalmaSwitch,
  shouldCreateChosenOfferSale,
};
