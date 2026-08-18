#!/usr/bin/env node
/**
 * Phase 2 — Bot RPA Deciplus : traite la file d'attente BOXPLUS.
 */
require('dotenv').config();
// Même si lancé sans start.js (BotHosting) — installer imapflow/mailparser
try {
  const { ensureOtpDeps } = require('../lib/ensure-deps');
  const otp = ensureOtpDeps();
  if (!otp.ok) {
    console.warn('[BOXPLUS] WARN: IMAP OTP deps absentes — login 2FA échouera jusqu’à npm install');
  }
} catch (err) {
  console.warn('[BOXPLUS] WARN: ensure-deps:', err.message);
}
// Mode rapide par défaut (vérif / résiliation / changement) — désactiver avec DECIPLUS_FAST=0
if (process.env.DECIPLUS_FAST == null || process.env.DECIPLUS_FAST === '') {
  process.env.DECIPLUS_FAST = '1';
}

const { login, isMfaAuthError, isSessionRecoverableError, isAuthBlocked } = require('./auth');
const {
  runWithSession,
  closeBrowser,
  sessionFileChanged,
  syncLoadedStorageMtime,
  hasActiveBrowser,
} = require('./browser-pool');
const { findOrCreateMember, resetMemberSearchContext, uploadMemberPhoto } = require('./member');
const { recordSale } = require('./sale');
const { setMemberIban, openMemberCheck } = require('./wallet');
const { isValidFrenchIban } = require('../lib/iban');
const {
  listPending,
  updateJob,
  removeJob,
  markProcessed,
  isProcessed,
  getProcessedRecord,
  STATUS,
  getQueueStats,
  requeueInterruptedJobs,
  finalizeExhaustedJobs,
} = require('../lib/queue');
const {
  normalizeOrder,
  validateOrder,
  getGymConfig,
} = require('../lib/normalize');
const { fetchDeciplusCatalog, resolveProductConfig, resolveBadgeProductConfig } = require('./catalog');
const { applyBillingPlanToProductConfig } = require('../lib/billing-plan');
const { logInfo, logError, logWarn, sendAlert } = require('../lib/logger');
const { sleep } = require('../lib/utils');
const {
  maybeKeepSessionAlive,
  forceRefreshSession,
  touchKeepAliveClock,
} = require('./session-keepalive');

function isTestMemberEmail(email) {
  const e = String(email || '').toLowerCase();
  return (
    /@boxplus-test\.local$/i.test(e) ||
    /^test\.essai\./i.test(e) ||
    /@example\.com$/i.test(e)
  );
}

/** Email admin direct (BotHosting) — ne dépend pas de Vercel. */
async function sendNewMemberAlertDirect(payload) {
  const apiKey = String(process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  const adminTo = (
    process.env.ADMIN_EMAIL ||
    process.env.SUPER_ADMIN_EMAIL ||
    process.env.ALERT_EMAIL ||
    ''
  ).trim();
  if (!adminTo || !apiKey.startsWith('xkeysib-')) return false;
  const html = `<p><strong>Nouveau membre créé dans Deciplus</strong></p>
    <p>Commande : ${payload.order_id || '—'}</p>
    <p>Membre Deciplus : ${payload.member_id || '—'}</p>
    <p>Nom : ${payload.first_name || ''} ${payload.last_name || ''}</p>
    <p>Email : ${payload.email || '—'}</p>
    <p>Salle : ${payload.gym || '—'}</p>
    <p>Offre : ${payload.product_name || '—'}</p>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: {
        name: process.env.BREVO_SENDER_NAME || 'Boxing Center',
        email: process.env.BREVO_SENDER_EMAIL || 'suzinabot@gmail.com',
      },
      to: [{ email: adminTo }],
      subject: `[Nouveau membre] ${payload.first_name || ''} ${payload.last_name || ''} — ${payload.order_id || ''}`.trim(),
      htmlContent: html,
    }),
  });
  return res.ok;
}

async function notifyBoutiqueNewMember(order, memberId) {
  const email = order.customer?.email || order.email;
  if (isTestMemberEmail(email)) {
    logInfo('Alerte nouveau membre ignorée (email test)', { order_id: order.order_id, email });
    return;
  }

  const payload = {
    order_id: order.order_id,
    member_id: memberId,
    email,
    first_name: order.customer?.first_name,
    last_name: order.customer?.last_name,
    gym: order.gym,
    product_name: order.product_name,
  };

  // 1) Direct Brevo depuis le bot (prod BotHosting)
  let sent = false;
  try {
    sent = await sendNewMemberAlertDirect(payload);
    if (sent) logInfo('Email nouveau membre envoyé (Brevo direct)', { order_id: order.order_id });
  } catch (err) {
    logWarn('Email nouveau membre Brevo direct échoué', { error: err.message });
  }

  // 2) Relais boutique Vercel (si configuré)
  const base = (process.env.BOXPLUS_STORE_URL || process.env.STORE_URL || '').replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  if (!base || !secret) {
    if (!sent) logWarn('Alerte nouveau membre — STORE_URL/SYNC_SECRET manquants et Brevo non envoyé');
    return;
  }
  try {
    const res = await fetch(`${base}/api/internal/new-member-alert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-secret': secret,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logWarn('Alerte nouveau membre boutique échouée', { status: res.status });
    } else if (!sent) {
      logInfo('Email nouveau membre relayé via boutique', { order_id: order.order_id });
    }
  } catch (err) {
    logWarn('Alerte nouveau membre boutique non envoyée', { error: err.message });
  }
}

const MAX_RETRIES = Number(process.env.BOT_MAX_RETRIES || 3);
const POLL_MS = Number(process.env.BOT_POLL_MS || 2000);
const CATALOG_PUSH_MS = Number(process.env.BOT_CATALOG_PUSH_MS || 6 * 60 * 60 * 1000);
const CATALOG_TTL_MS = Number(process.env.BOT_CATALOG_TTL_MS || 10 * 60 * 1000);
const STALE_PROCESSING_MS = Number(process.env.BOT_STALE_PROCESSING_MS || 15 * 60 * 1000);

let catalogCache = { at: 0, data: null };

async function getCachedCatalog(page) {
  if (catalogCache.data && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.data;
  }
  const data = await fetchDeciplusCatalog(page);
  catalogCache = { at: Date.now(), data };
  return data;
}

async function maybePushCatalog() {
  if (String(process.env.BOT_CATALOG_PUSH_ENABLED || 'true').toLowerCase() === 'false') return;
  if (listPending().length > 0) {
    logWarn('Sync catalogue reportée — jobs en cours (une seule session Deciplus)');
    return;
  }
  try {
    await runWithSession('catalog-sync', async (page, context) => {
      await login(page);
      const { syncAndPushCatalog } = require('../lib/catalog-sync');
      await syncAndPushCatalog({ page, context, force: true, saveFile: true });
    });
  } catch (err) {
    logWarn('Sync/push catalogue en échec', { error: err.message });
  }
}

async function processCancelJob(page, order) {
  const { cancelSale } = require('./cancel-sale');
  const { findMemberByIdentity, searchMember } = require('./member');

  const identity = {
    first_name: order.customer?.first_name || order.first_name,
    last_name: order.customer?.last_name || order.last_name,
    birthdate: order.customer?.birthdate || order.birthdate,
    phone: order.customer?.phone || order.phone,
    email: order.customer?.email || order.email,
    address: order.customer?.address || order.address,
    postal_code: order.customer?.postal_code || order.postal_code,
    city: order.customer?.city || order.city,
  };

  const storeBase = (
    order.status_callback_base ||
    process.env.BOXPLUS_STORE_URL ||
    process.env.STORE_URL ||
    ''
  ).replace(/\/$/, '');
  const storeSecret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';

  const pushCancelStatus = async (
    status,
    { reason = null, mismatchFields = [], cancelledCount = null, memberId = null } = {}
  ) => {
    if (!storeBase || !storeSecret) return false;
    try {
      const res = await fetch(`${storeBase}/api/internal/cancel-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': storeSecret },
        body: JSON.stringify({
          order_id: order.order_id,
          status,
          reason,
          mismatch_fields: mismatchFields,
          cancelled_count: cancelledCount,
          deciplus_member_id: memberId,
          customer: identity,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        logWarn('Statut résiliation boutique échoué', {
          status: res.status,
          body: String(bodyText).slice(0, 240),
        });
      }
      return res.ok;
    } catch (err) {
      logWarn('Statut résiliation boutique non envoyé', { error: err.message });
      return false;
    }
  };

  // Fallback autonome (BotHosting n'a pas le module storefront)
  const sendMismatchEmailDirect = async (mismatchFields = []) => {
    const apiKey = String(process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
    if (!identity.email || !apiKey.startsWith('xkeysib-')) return false;
    const labels = { last_name: 'Nom', first_name: 'Prénom', phone: 'Téléphone', birthdate: 'Date de naissance' };
    const fields = mismatchFields.map((f) => labels[f]).filter(Boolean);
    const html = `<p>Bonjour ${identity.first_name || ''},</p>
      <p>Nous avons bien reçu votre demande de résiliation, mais <strong>les informations renseignées ne correspondent pas</strong> à celles enregistrées sur votre fiche adhérent Boxing Center.</p>
      <p>Pour des raisons de sécurité, une seule information incorrecte (nom, prénom, téléphone ou date de naissance) empêche le traitement automatique.</p>
      ${fields.length ? `<p>Champ(s) en cause : <strong>${fields.join(', ')}</strong>.</p>` : ''}
      <p>Merci de vérifier vos informations puis de renouveler la demande depuis <a href="https://boutique.boxingcenter.fr/gerer-abonnement">Gérer mon abonnement</a>.</p>
      <p>Sportivement,<br/>Boxing Center</p>`;
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: {
            name: process.env.BREVO_SENDER_NAME || 'Boxing Center',
            email: process.env.BREVO_SENDER_EMAIL || 'suzinabot@gmail.com',
          },
          to: [{ email: identity.email }],
          subject: 'Résiliation — informations à vérifier — Boxing Center',
          htmlContent: html,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const notifyMismatch = async (reason, mismatchFields = []) => {
    try {
      // Le storefront envoie l'email + met à jour le statut (spinner front)
      let sent = await pushCancelStatus('mismatch', { reason, mismatchFields });
      if (!sent) {
        sent = await sendMismatchEmailDirect(mismatchFields);
        if (sent) logInfo('Email mismatch résiliation envoyé (Brevo direct)', { email: identity.email });
      }
      if (!sent) {
        logWarn('Email mismatch résiliation — aucun canal disponible', { reason });
      }
    } catch (err) {
      logWarn('Email mismatch résiliation non envoyé', { error: err.message, reason });
    }
  };

  let memberId = order.deciplus_member_id || null;
  if (!memberId && (identity.first_name || identity.last_name)) {
    const { CHANGE_MATCH_FIELDS } = require('./member');
    const cancelReason = String(order.cancel_reason || '').toLowerCase();
    // Changement d’abo : même règle que verify_identity (nom/prénom/naissance, pas téléphone)
    const matchFields =
      cancelReason === 'change_to_comptant' || cancelReason.startsWith('change_')
        ? CHANGE_MATCH_FIELDS
        : undefined;
    const match = await findMemberByIdentity(page, identity, { matchFields });
    if (!match.found) {
      await notifyMismatch(match.reason || 'identity_mismatch', match.mismatch_fields || []);
      return {
        status: STATUS.MANUAL_REVIEW,
        action: 'cancel',
        error:
          'Les informations renseignées ne correspondent pas à la fiche adhérent. Un e-mail a été envoyé pour demander de vérifier les données.',
        cancel_reason: order.cancel_reason,
        mismatch: true,
        mismatch_reason: match.reason || 'identity_mismatch',
        mismatch_fields: match.mismatch_fields || [],
      };
    }
    memberId = match.member_id;
  }
  if (!memberId && identity.email) {
    const byEmail = await searchMember(page, identity.email);
    if (byEmail.found) memberId = byEmail.member_id;
  }
  if (!memberId && identity.phone) {
    const byPhone = await searchMember(page, identity.phone);
    if (byPhone.found) memberId = byPhone.member_id;
  }
  if (!memberId) {
    // Pas de champs ciblés : on n’a pas pu comparer à une fiche
    await notifyMismatch('not_found', []);
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'cancel',
      error:
        'Les informations renseignées ne correspondent pas à la fiche adhérent. Un e-mail a été envoyé pour demander de vérifier les données.',
      cancel_reason: order.cancel_reason,
      mismatch: true,
    };
  }

  // Identité OK → le front peut afficher « résiliation sera traitée » sans attendre Deciplus
  await pushCancelStatus('verified', { memberId });

  try {
    const result = await cancelSale(page, memberId, {
      cancelDate: order.cancel_date || order.effective_date || null,
      cancelReason: order.cancel_reason || null,
    });
    await pushCancelStatus('done', { cancelledCount: result?.cancelled_count ?? null, memberId });
    return {
      status: STATUS.SUCCESS,
      action: 'cancel',
      deciplus_member_id: memberId,
      cancel_reason: order.cancel_reason,
      ...result,
    };
  } catch (err) {
    await pushCancelStatus('error', { reason: err.message, memberId });
    throw err;
  }
}

async function processSaleJob(page, order, jobMeta = {}) {
  const t0 = Date.now();
  const mark = (label) => logInfo(`Timing bot · ${label}`, { order_id: order.order_id, ms: Date.now() - t0 });
  const filePath = jobMeta.file || null;
  const checkpoint = jobMeta.checkpoint || order.checkpoint || {};

  const saveCheckpoint = (patch) => {
    if (!filePath) return;
    try {
      const next = { ...(checkpoint || {}), ...patch, at: new Date().toISOString() };
      Object.assign(checkpoint, next);
      updateJob(filePath, { checkpoint: next });
    } catch (err) {
      logWarn('Checkpoint job non enregistré', { order_id: order.order_id, error: err.message });
    }
  };

  const catalog = await getCachedCatalog(page);
  mark('catalog');
  const productConfig = applyBillingPlanToProductConfig(
    resolveProductConfig(order, catalog),
    order
  );
  if (!order.gym) {
    return {
      status: STATUS.MANUAL_REVIEW,
      error: 'Salle (gym) manquante sur la commande',
    };
  }
  const gymConfig = getGymConfig(order.gym);

  let badgeProductConfig = null;
  if (productConfig.auto_badge) {
    try {
      badgeProductConfig = resolveBadgeProductConfig(catalog, {
        badge_timing: 'deferred',
        badge_method: 'iban',
      });
    } catch (err) {
      logWarn('Badge non ajouté automatiquement', { order_id: order.order_id, error: err.message });
    }
  }

  // Changement d’abo / reprise : l’id membre est déjà connu — ne pas re-chercher
  let memberId =
    checkpoint.deciplus_member_id ||
    order.deciplus_member_id ||
    order.customer?.deciplus_member_id ||
    null;
  let memberResult = {
    member_id: memberId,
    action: memberId ? (checkpoint.deciplus_member_id ? 'checkpoint_resume' : 'order_member_id') : null,
  };

  if (!memberId) {
    memberResult = await findOrCreateMember(page, order, gymConfig);
    mark('member');

    if (memberResult.duplicate) {
      await sendAlert(`Doublon Deciplus — commande ${order.order_id}`, {
        order_id: order.order_id,
        message: memberResult.message,
      });
      return {
        status: STATUS.MANUAL_REVIEW,
        error: memberResult.message,
        deciplus_member_id: memberResult.member_id || null,
      };
    }

    memberId = memberResult.member_id;
    if (!memberId) {
      return {
        status: STATUS.MANUAL_REVIEW,
        error: 'member_id Deciplus manquant après création — membre non visible / non finalisé',
        member_action: memberResult.action,
      };
    }
    saveCheckpoint({ step: 'member', deciplus_member_id: memberId });
    if (memberResult.action === 'created') {
      // Info only — do not sendAlert (that logs ERROR + admin webhook noise).
      logInfo('Nouveau membre Deciplus créé — pas d’alerte admin', {
        order_id: order.order_id,
        member_id: memberId,
      });
    }
  } else {
    logInfo('Reprise job — membre déjà créé', { order_id: order.order_id, member_id: memberId });
    mark('member_resume');
  }

  let photoResult = null;
  if (!checkpoint.photo_done && (order.photo_path || order.photo_base64)) {
    // Attendre la fin des redirections de création membre avant l'appel API photo.
    // Ne pas rouvrir la fiche ici : cela détruisait le contexte pendant page.evaluate.
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(600);
    photoResult = await uploadMemberPhoto(
      page,
      order.photo_path,
      order.photo_base64,
      memberId
    ).catch((err) => ({
      ok: false,
      reason: err.message,
    }));
    mark('photo');
    if (!photoResult?.ok) {
      logWarn('Photo non uploadée dans Deciplus', {
        order_id: order.order_id,
        reason: photoResult?.reason,
        body: photoResult?.body,
      });
    } else {
      saveCheckpoint({ step: 'photo', deciplus_member_id: memberId, photo_done: true });
      if (memberId) {
        await openMemberCheck(page, memberId).catch(() => {});
      }
    }
  }

  let saleResult = { sale_id: checkpoint.deciplus_sale_id || null };

  const needsIban =
    productConfig.requires_iban === true && productConfig.paiement_comptant !== true;
  const iban = order.payment.iban;

  if (!checkpoint.iban_done) {
    if (needsIban && productConfig.sale_type !== 'none') {
      if (!iban) {
        return {
          status: STATUS.MANUAL_REVIEW,
          error: 'IBAN requis pour cette offre',
          deciplus_member_id: memberId,
        };
      }
      if (!isValidFrenchIban(iban)) {
        return {
          status: STATUS.MANUAL_REVIEW,
          error: 'IBAN français invalide',
          deciplus_member_id: memberId,
        };
      }
      if (memberId) {
        await setMemberIban(page, memberId, iban, order.customer, gymConfig);
        mark('iban');
        saveCheckpoint({ step: 'iban', deciplus_member_id: memberId, iban_done: true });
      }
    } else if (iban && memberId) {
      if (!isValidFrenchIban(iban)) {
        return {
          status: STATUS.MANUAL_REVIEW,
          error: 'IBAN français invalide',
          deciplus_member_id: memberId,
        };
      }
      await setMemberIban(page, memberId, iban, order.customer, gymConfig);
      mark('iban');
      saveCheckpoint({ step: 'iban', deciplus_member_id: memberId, iban_done: true });
    }
  }

  if (checkpoint.sale_done) {
    logInfo('Reprise job — vente déjà enregistrée', {
      order_id: order.order_id,
      sale_id: checkpoint.deciplus_sale_id || null,
    });
    saleResult = {
      sale_id: checkpoint.deciplus_sale_id || null,
      action: 'checkpoint_resume',
      badge_action: checkpoint.badge_action || null,
    };
  } else if (productConfig.requires_payment !== false && order.payment.status === 'paid') {
    saleResult = await recordSale(page, order, productConfig, memberId, gymConfig, {
      badgeProductConfig,
    });
    mark('sale');
    saveCheckpoint({
      step: 'sale',
      deciplus_member_id: memberId,
      sale_done: true,
      deciplus_sale_id: saleResult.sale_id || null,
      badge_action: saleResult.badge_action || null,
    });
  } else if (productConfig.sale_type === 'none') {
    saleResult = { action: 'trial_only' };
    saveCheckpoint({ step: 'sale', deciplus_member_id: memberId, sale_done: true });
  }

  const finalStatus =
    saleResult.manual_review ? STATUS.MANUAL_REVIEW : STATUS.SUCCESS;

  if (
    finalStatus === STATUS.SUCCESS &&
    (order.notify_change_complete || order.raw?.notify_change_complete)
  ) {
    await notifyMembershipChangeComplete(order, memberId).catch((err) => {
      logWarn('Notification fin changement abo échouée', {
        order_id: order.order_id,
        error: err.message,
      });
    });
  }

  await resetMemberSearchContext(page).catch((err) => {
    logWarn('Retour select.php après job ignoré', { order_id: order.order_id, error: err.message });
  });

  mark('done');
  return {
    status: finalStatus,
    action: 'sale',
    deciplus_member_id: memberId || null,
    deciplus_sale_id: saleResult.sale_id || null,
    member_action: memberResult.action,
    sale_action: saleResult.action,
    badge_action: saleResult.badge_action || null,
    badge_error: saleResult.badge_error || null,
    photo_uploaded: Boolean(photoResult?.ok || checkpoint.photo_done),
  };
}

/** E-mail client à la fin du job changement prélèvement → comptant. */
async function notifyMembershipChangeComplete(order, memberId) {
  const email = order.customer?.email || order.email;
  if (!email || /@boxplus-test\.local$/i.test(String(email))) {
    logInfo('Email changement abo ignoré (test / sans email)', { order_id: order.order_id });
    return;
  }
  const productName =
    order.change_product_name || order.product_name || order.raw?.change_product_name || 'abonnement comptant';
  const payload = {
    order_id: order.order_id,
    member_id: memberId,
    email,
    first_name: order.customer?.first_name,
    last_name: order.customer?.last_name,
    product_name: productName,
    gym: order.gym,
  };

  // 1) Brevo direct (BotHosting)
  const apiKey = String(process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (apiKey.startsWith('xkeysib-')) {
    const html = `<p>Bonjour ${payload.first_name || ''},</p>
      <p>Bonne nouvelle : votre passage en <strong>${productName}</strong> est <strong>bien enregistré et actif</strong>.</p>
      <p>Votre ancien prélèvement a été coupé et le nouvel abonnement comptant est en place. Il peut mettre <strong>quelques minutes</strong> à apparaître partout côté club.</p>
      <p>À bientôt sur le ring,<br/>Boxing Center</p>`;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: {
          name: process.env.BREVO_SENDER_NAME || 'Boxing Center',
          email: process.env.BREVO_SENDER_EMAIL || 'suzinabot@gmail.com',
        },
        to: [{ email }],
        subject: 'Votre abonnement comptant est actif — Boxing Center',
        htmlContent: html,
      }),
    });
    if (res.ok) {
      logInfo('Email changement abo envoyé (Brevo direct)', { order_id: order.order_id });
      return;
    }
    logWarn('Brevo direct changement abo échoué', { status: res.status });
  }

  // 2) Relais boutique
  const base = (process.env.BOXPLUS_STORE_URL || process.env.STORE_URL || '').replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  if (!base || !secret) return;
  const res = await fetch(`${base}/api/internal/change-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    logWarn('Relais email changement abo boutique échoué', { status: res.status });
  } else {
    logInfo('Email changement abo relayé via boutique', { order_id: order.order_id });
  }
}

async function processJob(page, job) {
  const order = normalizeOrder(job);
  const errors = validateOrder(order);
  if (errors.length) {
    throw new Error(`Validation: ${errors.join(', ')}`);
  }

  const jobId = order.job_id;
  if (isProcessed(jobId)) {
    return { status: STATUS.DUPLICATE, duplicate: true, action: order.action };
  }

  const role = String(process.env.BOT_ROLE || 'ops').toLowerCase();
  const action = String(order.action || 'sale').toLowerCase();
  const isChangeSale =
    action === 'sale' &&
    (order.notify_change_complete || String(order.source || '').includes('change'));

  if (role === 'ops') {
    const allowed =
      action === 'cancel' ||
      action === 'verify_identity' ||
      action === 'echeancier' ||
      action === 'encaisser' ||
      action === 'balma_switch' ||
      isChangeSale;
    if (!allowed) {
      throw new Error(`Bot ops refuse l’action « ${action} » (réservé aux ventes inscriptions)`);
    }
  }

  if (order.action === 'cancel') {
    return processCancelJob(page, order);
  }

  if (order.action === 'verify_identity') {
    return processVerifyIdentityJob(page, order);
  }

  if (order.action === 'echeancier') {
    const { runEcheancierScan } = require('./echeancier-scan');
    const scan = await runEcheancierScan(page, {
      limit: Number(order.limit || process.env.ECHEANCIER_LIMIT || 30),
      cancelLimit: Number(order.cancel_limit || order.limit || process.env.ECHEANCIER_LIMIT || 30),
      forceCancel:
        order.force_cancel === true ||
        String(order.force_cancel || process.env.ECHEANCIER_FORCE_CANCEL || '') === '1',
      kind: order.echeancier_kind || '',
    });
    return { status: STATUS.SUCCESS, action: 'echeancier', ...scan };
  }

  if (order.action === 'encaisser') {
    const { encaisserEcheance } = require('./encaisser-echeance');
    const amountCents =
      Number(order.amount_cents) ||
      Math.round(Number(order.payment?.amount || 0) * 100) ||
      0;
    const result = await encaisserEcheance(page, {
      memberId: order.deciplus_member_id,
      name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
      amountCents,
    });
    return { status: result.ok ? STATUS.SUCCESS : STATUS.MANUAL_REVIEW, action: 'encaisser', ...result };
  }

  if (order.action === 'balma_switch') {
    const { runBalmaSwitch } = require('./migrate-gym');
    return runBalmaSwitch(page, order);
  }

  return processSaleJob(page, order, {
    file: job.file,
    checkpoint: job.checkpoint || {},
  });
}

/** Vérif identité seule (changement d’abo / pré-check) — même statut mismatch que résiliation. */
async function processVerifyIdentityJob(page, order) {
  const { findMemberByIdentity, CHANGE_MATCH_FIELDS } = require('./member');
  const identity = {
    first_name: order.customer?.first_name || order.first_name,
    last_name: order.customer?.last_name || order.last_name,
    birthdate: order.customer?.birthdate || order.birthdate,
    phone: order.customer?.phone || order.phone,
    email: order.customer?.email || order.email,
  };
  const storeBase = (
    order.status_callback_base ||
    process.env.BOXPLUS_STORE_URL ||
    process.env.STORE_URL ||
    ''
  ).replace(/\/$/, '');
  const storeSecret = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';

  const pushStatus = async (status, { mismatchFields = [], reason = null, memberId = null } = {}) => {
    if (!storeBase || !storeSecret) return false;
    try {
      const res = await fetch(`${storeBase}/api/internal/cancel-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': storeSecret },
        body: JSON.stringify({
          order_id: order.order_id,
          status,
          reason,
          mismatch_fields: mismatchFields,
          deciplus_member_id: memberId,
          customer: identity,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const matchMode = String(order.verify_mode || order.match_mode || 'change').toLowerCase();
  // Changement d’abo : nom + prénom + date de naissance (pas le téléphone)
  const matchFields =
    matchMode === 'cancel' || matchMode === 'full' ? undefined : CHANGE_MATCH_FIELDS;
  const match = await findMemberByIdentity(page, identity, { matchFields });
  if (!match.found) {
    await pushStatus('mismatch', {
      mismatchFields: match.mismatch_fields || [],
      reason: match.reason || 'identity_mismatch',
      memberId: match.member_id || null,
    });
    return {
      status: STATUS.MANUAL_REVIEW,
      action: 'verify_identity',
      mismatch: true,
      mismatch_reason: match.reason || 'identity_mismatch',
      mismatch_fields: match.mismatch_fields || [],
    };
  }
  await pushStatus('verified', { memberId: match.member_id });
  return {
    status: STATUS.SUCCESS,
    action: 'verify_identity',
    deciplus_member_id: match.member_id,
    verified: true,
  };
}

function rejectJob(job, filePath, error) {
  const jobId = job.job_id || job.order_id;
  markProcessed(jobId, { status: STATUS.REJECTED, error, action: job.action || 'sale' });
  removeJob(filePath);
  logWarn('Job rejeté (données invalides, pas de connexion Deciplus)', {
    job_id: jobId,
    order_id: job.order_id,
    error,
  });
}

async function processOneJob(job) {
  const filePath = job.file;
  const jobId = job.job_id || job.order_id;
  const priorAttempts = Number(job.attempts || 0);

  if (isProcessed(jobId)) {
    removeJob(filePath);
    logWarn('Fichier orphelin supprimé (job déjà traité)', { job_id: jobId });
    return { ok: true, skipped: true };
  }

  if (priorAttempts >= MAX_RETRIES) {
    const error =
      job.last_error && /impossible à traiter/i.test(job.last_error)
        ? job.last_error
        : `Job impossible à traiter après ${priorAttempts} tentatives${job.last_error ? ` — ${job.last_error}` : ''}`;
    markProcessed(jobId, {
      status: STATUS.MANUAL_REVIEW,
      error,
      action: job.action || 'sale',
      deciplus_member_id: job.checkpoint?.deciplus_member_id || null,
      deciplus_sale_id: job.checkpoint?.deciplus_sale_id || null,
    });
    removeJob(filePath);
    logWarn('Job impossible à traiter — stop', { job_id: jobId, attempts: priorAttempts });
    await sendAlert(`Job impossible à traiter après ${priorAttempts} tentatives — ${jobId}`, {
      job_id: jobId,
      order_id: job.order_id,
      error,
    });
    return { ok: false, impossible: true, error };
  }

  const order = normalizeOrder(job);
  const validationErrors = validateOrder(order);
  if (validationErrors.length) {
    rejectJob(job, filePath, validationErrors.join(', '));
    return { ok: false, rejected: true, error: validationErrors.join(', ') };
  }

  updateJob(filePath, { status: STATUS.PROCESSING, started_at: new Date().toISOString() });

  try {
    if (!order.gym) {
      throw new Error('Validation: salle (gym) manquante sur la commande — impossible de choisir le site Deciplus');
    }
    const gymConfig = getGymConfig(order.gym);
    const siteLabel = gymConfig.deciplus_label || gymConfig.label;
    logInfo('Salle commande → Deciplus', {
      job_id: jobId,
      order_id: order.order_id,
      gym: order.gym,
      site: siteLabel,
    });

    if (sessionFileChanged()) {
      logWarn('Session changée avant job — rechargement navigateur');
      await closeBrowser();
      syncLoadedStorageMtime();
    }

    const outcome = await runWithSession('job', async (page) => {
      await login(page, { siteLabel });
      return processJob(page, job);
    });

    markProcessed(jobId, outcome);
    removeJob(filePath);

    logInfo('Job Deciplus traité', {
      job_id: jobId,
      order_id: job.order_id,
      action: outcome.action || job.action || 'sale',
      status: outcome.status,
    });

    touchKeepAliveClock();
    return { ok: true, result: outcome };
  } catch (err) {
    if (err.message.startsWith('Validation:')) {
      rejectJob(job, filePath, err.message.replace(/^Validation:\s*/, ''));
      return { ok: false, rejected: true, error: err.message };
    }

    // Toute tentative compte (y compris session) — max 3 puis stop
    const attempts = priorAttempts + 1;
    const sessionErr = isSessionRecoverableError(err.message);
    const browserGone = /browser has been closed|Target page, context or browser/i.test(err.message);
    const mfaErr = isMfaAuthError(err.message);

    // Erreur liée session → refresh immédiat (sans attendre le ping 1h30) puis retry job
    let sessionRecovered = false;
    if (sessionErr || browserGone) {
      logWarn('Erreur liée session — refresh immédiat puis reprise du job', {
        job_id: jobId,
        error: err.message,
        auth_cooldown: isAuthBlocked(),
      });
      await closeBrowser().catch(() => {});
      // Si cooldown MFA déjà actif (IMAP KO), ne pas spammer un nouveau login
      if (!isAuthBlocked() || !mfaErr) {
        sessionRecovered = await forceRefreshSession().catch(() => false);
      }
    }

    // MFA/IMAP : plus de noRetry immédiat — le cooldown évite le spam OTP ; on retente jusqu’à MAX
    const exhausted = attempts >= MAX_RETRIES;
    const status = exhausted ? STATUS.MANUAL_REVIEW : STATUS.ERROR;
    const lastError = exhausted
      ? `Job impossible à traiter après ${attempts} tentatives — ${err.message}`
      : err.message;

    updateJob(filePath, {
      status,
      last_error: lastError,
      attempts,
      ...(sessionRecovered ? { session_refreshed_at: new Date().toISOString() } : {}),
    });

    if (status === STATUS.MANUAL_REVIEW) {
      await sendAlert(`Job impossible à traiter après ${attempts} tentatives — ${jobId}`, {
        job_id: jobId,
        order_id: job.order_id,
        action: job.action,
        error: lastError,
      });
      markProcessed(jobId, {
        status,
        error: lastError,
        action: job.action || 'sale',
        deciplus_member_id: job.checkpoint?.deciplus_member_id || null,
        deciplus_sale_id: job.checkpoint?.deciplus_sale_id || null,
      });
      removeJob(filePath);
    } else if (sessionRecovered) {
      logInfo('Session renouvelée — job remis en file pour retry', {
        job_id: jobId,
        attempts,
      });
    }

    logError('Erreur traitement job', { job_id: jobId, order_id: job.order_id, error: lastError });

    return { ok: false, error: lastError, impossible: exhausted, session_recovered: sessionRecovered };
  }
}

async function runLoop(once = false) {
  const { startBotServer } = require('./server');
  startBotServer();

  const recovered = requeueInterruptedJobs(Number(process.env.BOT_REQUEUE_MS || 0), {
    includeSessionErrors: true,
  });
  if (recovered) {
    logInfo('Jobs non terminés repris au démarrage', { count: recovered });
  }

  const exhausted = finalizeExhaustedJobs(MAX_RETRIES);
  if (exhausted) {
    logWarn('Jobs impossibles à traiter finalisés', { count: exhausted });
  }

  logInfo('Bot Deciplus démarré', getQueueStats());

  // Scan échéancier quotidien à 17h00 (Europe/Paris) — désactiver avec ECHEANCIER_CRON_HOUR=-1
  const echeancierHour = Number(process.env.ECHEANCIER_CRON_HOUR ?? 17);
  const echeancierTz = String(process.env.ECHEANCIER_CRON_TZ || 'Europe/Paris').trim() || 'Europe/Paris';
  const echeancierMs = Number(process.env.ECHEANCIER_CRON_MS ?? 0);
  const startupScan = String(process.env.ECHEANCIER_STARTUP_SCAN || '1') !== '0';

  const enqueueScan = (reason = 'cron') => {
    try {
      const { enqueue, listPending } = require('../lib/queue');
      const already = listPending().some(
        (j) => String(j.action || j.raw?.action || '').toLowerCase() === 'echeancier'
      );
      if (already) {
        logInfo('Échéancier — job déjà en file, skip', { reason });
        return;
      }
      const { normalizeOrder } = require('../lib/normalize');
      enqueue(
        normalizeOrder({
          order_id: `ECHEANCIER-${reason.toUpperCase()}-${Date.now()}`,
          action: 'echeancier',
          echeancier_kind: reason,
          product_name: 'Scan échéancier impayés',
          requires_payment: false,
          requires_iban: false,
          sale_type: 'none',
          gym: 'minimes',
        })
      );
      logInfo('Échéancier — job enfilé', { reason });
    } catch (err) {
      logWarn('Échéancier — enqueue échoué', { error: err.message, reason });
    }
  };

  function zonedParts(date, timeZone) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value])
    );
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    };
  }

  if (echeancierHour >= 0 && echeancierHour <= 23) {
    let lastScanDay = '';
    const tick = () => {
      try {
        const p = zonedParts(new Date(), echeancierTz);
        const dayKey = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
        // Premier tick à partir de l’heure cible (toute la fenêtre horaire) — évite de rater
        // le scan si le process redémarre après xx:01 ou si le tick tombe hors minute 0–1.
        if (p.hour === echeancierHour && lastScanDay !== dayKey) {
          lastScanDay = dayKey;
          enqueueScan('cron17h');
        }
      } catch (err) {
        logWarn('Échéancier — tick cron échoué', { error: err.message });
      }
    };
    logInfo('Échéancier — cron quotidien armé', {
      hour: echeancierHour,
      tz: echeancierTz,
      window: `dès ${echeancierHour}h00 (${echeancierTz})`,
    });
    const t = setInterval(tick, 30_000);
    if (t.unref) t.unref();
    if (startupScan) {
      const now = zonedParts(new Date(), echeancierTz);
      if (now.hour === echeancierHour) {
        lastScanDay = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
        enqueueScan('cron17h');
      } else {
        enqueueScan('startup');
      }
    }
    tick();
  } else if (echeancierMs > 0) {
    // Repli legacy : intervalle ms
    setTimeout(() => enqueueScan('interval'), Number(process.env.ECHEANCIER_CRON_DELAY_MS || 600000));
    const t = setInterval(() => enqueueScan('interval'), echeancierMs);
    if (t.unref) t.unref();
  }

  const catalogDelay = Number(process.env.BOT_CATALOG_PUSH_DELAY_MS || 120000);
  setTimeout(() => {
    maybePushCatalog().catch(() => {});
  }, catalogDelay);

  const catalogTimer = setInterval(() => {
    maybePushCatalog().catch(() => {});
  }, CATALOG_PUSH_MS);
  if (catalogTimer.unref) catalogTimer.unref();

  const keepaliveTimer = setInterval(() => {
    maybeKeepSessionAlive().catch(() => {});
  }, Number(process.env.BOT_KEEPALIVE_CHECK_MS || 60000));
  if (keepaliveTimer.unref) keepaliveTimer.unref();

  do {
    // Jobs restés « processing » (crash, kill, changement session) → reprise
    requeueInterruptedJobs(STALE_PROCESSING_MS);

    if (sessionFileChanged()) {
      if (hasActiveBrowser()) {
        logWarn('storage-state.json modifié — fermeture navigateur pour charger la nouvelle session');
        await closeBrowser();
      }
      // Aligner l'horloge même sans navigateur ouvert — sinon spam WARN à chaque poll
      syncLoadedStorageMtime();
    }

    const pending = listPending();
    if (pending.length === 0) {
      if (once) break;
      await maybeKeepSessionAlive();
      await sleep(POLL_MS);
      continue;
    }

    const job = pending[0];
    logInfo('Traitement job', {
      job_id: job.job_id,
      order_id: job.order_id,
      action: job.action || 'sale',
      checkpoint: job.checkpoint?.step || null,
    });
    try {
      await processOneJob(job);
    } catch (err) {
      logError('Erreur fatale boucle bot', { error: err.message });
      await closeBrowser();
    }
  } while (!once);

  await closeBrowser();
  logInfo('Bot Deciplus arrêté', getQueueStats());
}

if (require.main === module) {
  const once = process.argv.includes('--once');
  runLoop(once).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { processJob, processOneJob, runLoop, processCancelJob, processSaleJob };
