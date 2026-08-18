const { loadJson } = require('./utils');
const { normalizeIban, isValidFrenchIban } = require('./iban');
const { isTrialOrder, buildProductConfig } = require('./catalog-sale');
const { requiresIbanForPlan, normalizeBillingPlan } = require('./billing-plan');

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length === 10) return `+33${digits.slice(1)}`;
  if (digits.startsWith('33') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('+')) return digits;
  return digits.length >= 9 ? `+${digits}` : digits;
}

function normalizeGender(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (['m', 'male', 'homme', 'h'].includes(v)) return 'M';
  if (['f', 'female', 'femme', 'f'].includes(v)) return 'F';
  return v || null;
}

function extractProductName(input) {
  if (input.product_name) return String(input.product_name).trim();
  if (input.deciplus_product_name) return String(input.deciplus_product_name).trim();
  if (input.product?.name) return String(input.product.name).trim();
  if (Array.isArray(input.products) && input.products[0]?.name) {
    return String(input.products[0].name).trim();
  }
  return null;
}

function extractProductReference(input) {
  if (input.product_reference) return String(input.product_reference).trim();
  if (input.product?.reference) return String(input.product.reference).trim();
  if (Array.isArray(input.products) && input.products[0]?.reference) {
    return String(input.products[0].reference).trim();
  }
  return null;
}

function normalizeAction(input) {
  const raw = String(input.action || input.event || input.type || 'sale').toLowerCase();
  if (['cancel', 'cancelled', 'cancellation', 'refund', 'refunded', 'annulation'].includes(raw)) {
    return 'cancel';
  }
  if (['verify', 'verify_identity', 'identity_check', 'check_identity'].includes(raw)) {
    return 'verify_identity';
  }
  if (['echeancier', 'echeancier_scan', 'scan_echeancier', 'impayes', 'unpaid_scan'].includes(raw)) {
    return 'echeancier';
  }
  if (['encaisser', 'encaisser_echeance', 'collect_unpaid', 'cash_in'].includes(raw)) {
    return 'encaisser';
  }
  if (['balma_switch', 'balma_migrate', 'migrate_balma'].includes(raw)) {
    return 'balma_switch';
  }
  return 'sale';
}

function getJobId(order) {
  if (order.action === 'cancel') return `${order.order_id}#cancel`;
  if (order.action === 'verify_identity') return `${order.order_id}#verify`;
  if (order.action === 'echeancier') return `${order.order_id}#echeancier`;
  if (order.action === 'encaisser') return `${order.order_id}#encaisser`;
  if (order.action === 'balma_switch') return `${order.order_id}#balma_switch`;
  return order.order_id;
}

function normalizeOrder(input) {
  const productName = extractProductName(input);
  const productReference = extractProductReference(input);
  const action = normalizeAction(input);
  const offer = String(
    input.offer || productReference || productName || input.product || ''
  )
    .toLowerCase()
    .trim();
  const gymRaw = String(input.gym || input.salle || '').toLowerCase().replace(/\s+/g, '-');
  const gym = action === 'balma_switch' && !gymRaw ? 'minimes' : gymRaw;

  const customer = input.customer || {};
  const payment = input.payment || {};
  const utm = input.utm || {};

  const order = {
    order_id: String(input.order_id || input.reference || ''),
    action,
    job_id: input.job_id || null,
    offer,
    product_name: productName,
    product_reference: productReference,
    product_id: input.product_id || null,
    deciplus_id: input.deciplus_id || null,
    deciplus_product_search: input.deciplus_product_search || null,
    sale_type: input.sale_type || null,
    requires_iban: input.requires_iban,
    billing_plan: input.billing_plan || payment.billing_plan || null,
    payment_plan: input.payment_plan || payment.payment_plan || null,
    paiement_comptant:
      input.paiement_comptant === true ||
      payment.payment_plan === 'once' ||
      payment.payment_plan === '4x' ||
      input.payment_plan === 'once' ||
      input.payment_plan === '4x' ||
      undefined,
    deciplus_member_id: input.deciplus_member_id ? String(input.deciplus_member_id) : null,
    photo_path: input.photo_path || null,
    photo_base64: input.photo_base64 || null,
    cancel_reason: input.cancel_reason || input.reason || null,
    verify_mode: input.verify_mode || input.match_mode || null,
    notify_change_complete: Boolean(input.notify_change_complete),
    change_product_name: input.change_product_name || null,
    cancel_date: input.cancel_date || input.effective_date || null,
    sale_date: input.sale_date || input.effective_date || null,
    effective_date: input.effective_date || null,
    status_callback_base: input.status_callback_base || null,
    limit: input.limit != null ? Number(input.limit) : null,
    cancel_limit: input.cancel_limit != null ? Number(input.cancel_limit) : null,
    force_cancel: input.force_cancel === true || input.force_cancel === '1' || input.force_cancel === 1,
    echeancier_kind: input.echeancier_kind || input.kind || null,
    amount_cents: input.amount_cents != null ? Number(input.amount_cents) : null,
    gym,
    customer: {
      first_name: String(
        customer.first_name || customer.prenom || input.first_name || input.prenom || ''
      ).trim(),
      last_name: String(
        customer.last_name || customer.nom || input.last_name || input.nom || ''
      ).trim(),
      email: String(customer.email || input.email || '')
        .trim()
        .toLowerCase(),
      phone: normalizePhone(
        customer.phone || customer.telephone || customer.mobile || input.phone || input.telephone
      ),
      birthdate:
        customer.birthdate || customer.date_naissance || input.birthdate || input.date_naissance || null,
      gender: normalizeGender(customer.gender || customer.sexe),
      address: customer.address || customer.adresse || null,
      postal_code: customer.postal_code || customer.code_postal || null,
      city: customer.city || customer.ville || null,
      country: customer.country || customer.pays || 'FR',
      emergency_contact: customer.emergency_contact || null,
      medical_info: customer.medical_info || null,
    },
    payment: {
      amount: Number(
        payment.amount ??
          payment.montant ??
          (input.price_cents != null && Number(input.price_cents) > 0
            ? Number(input.price_cents) / 100
            : 0)
      ),
      method: payment.method || payment.moyen || input.payment_method || 'card',
      status: payment.status || payment.statut || 'paid',
      date: payment.date || new Date().toISOString(),
      iban: payment.iban ? normalizeIban(payment.iban) : null,
      billing_plan: payment.billing_plan || input.billing_plan || null,
      payment_plan: payment.payment_plan || input.payment_plan || null,
      recurring: payment.recurring || null,
      stripe_subscription_id: payment.stripe_subscription_id || null,
      stripe_session_id: payment.stripe_session_id || input.stripe_session_id || null,
      payplug_payment_id: payment.payplug_payment_id || input.payplug_payment_id || null,
    },
    utm: {
      source: utm.source || utm.utm_source || null,
      medium: utm.medium || utm.utm_medium || null,
      campaign: utm.campaign || utm.utm_campaign || null,
      content: utm.content || utm.utm_content || null,
      term: utm.term || utm.utm_term || null,
    },
    source: input.source || 'prestashop',
    raw: input,
  };

  order.job_id = order.job_id || getJobId(order);
  return order;
}

function validateCancelOrder(order) {
  const errors = [];
  if (!order.order_id) errors.push('order_id manquant');
  const hasIdentity =
    order.customer?.first_name &&
    order.customer?.last_name &&
    order.customer?.birthdate &&
    order.customer?.phone;
  if (!order.deciplus_member_id && !hasIdentity) {
    errors.push(
      'deciplus_member_id ou nom, prénom, téléphone et date de naissance requis pour annulation'
    );
  }
  return errors;
}

function validateVerifyOrder(order) {
  const errors = [];
  if (!order.order_id) errors.push('order_id manquant');
  // Changement d’abo : nom + prénom + naissance (+ email ou tél pour retrouver la fiche)
  if (!order.customer?.first_name) errors.push('prénom manquant');
  if (!order.customer?.last_name) errors.push('nom manquant');
  if (!order.customer?.birthdate) errors.push('date de naissance manquante');
  if (!order.customer?.email && !order.customer?.phone) {
    errors.push('email ou téléphone requis pour retrouver la fiche');
  }
  return errors;
}

function validateOrder(order) {
  if (order.action === 'cancel') return validateCancelOrder(order);
  if (order.action === 'verify_identity') return validateVerifyOrder(order);
  if (order.action === 'echeancier') {
    const errors = [];
    if (!order.order_id) errors.push('order_id manquant');
    return errors;
  }
  if (order.action === 'encaisser') {
    const errors = [];
    if (!order.order_id) errors.push('order_id manquant');
    if (!order.deciplus_member_id) errors.push('deciplus_member_id manquant');
    return errors;
  }
  if (order.action === 'balma_switch') {
    const errors = [];
    if (!order.order_id) errors.push('order_id manquant');
    if (!order.customer?.first_name) errors.push('prénom manquant');
    if (!order.customer?.last_name) errors.push('nom manquant');
    return errors;
  }
  const errors = [];
  if (!order.order_id) errors.push('order_id manquant');
  if (!order.customer.first_name) errors.push('prénom manquant');
  if (!order.customer.last_name) errors.push('nom manquant');
  if (!order.customer.email && !order.customer.phone) errors.push('email ou téléphone requis');

  const trial = isTrialOrder(order);
  if (!trial && !order.product_name) {
    errors.push('product_name manquant (nom du produit PrestaShop = nom Deciplus)');
  }

  if (order.payment.status === 'paid' && !order.payment.amount && !trial) {
    errors.push('montant manquant pour vente payée');
  }
  if (order.payment.iban && !isValidFrenchIban(order.payment.iban)) {
    errors.push('IBAN français invalide');
  }

  const paymentPlan =
    order.payment_plan || order.payment?.payment_plan || null;
  const comptantLike =
    order.paiement_comptant === true ||
    paymentPlan === 'once' ||
    paymentPlan === '4x' ||
    order.requires_iban === false ||
    /comptant/i.test(order.product_name || '') ||
    /OFFRE\s*PROMO\s*12\s*MOIS/i.test(order.product_name || '');

  const billingPlan = normalizeBillingPlan(
    order.payment?.billing_plan || order.billing_plan,
    {
      requires_iban: order.requires_iban,
      name: order.product_name,
      id: order.product_id,
      supports_installment_choice: comptantLike || undefined,
    }
  );
  const needsIban =
    !trial &&
    !comptantLike &&
    requiresIbanForPlan(
      {
        requires_iban: order.requires_iban !== false,
        name: order.product_name || '',
        id: order.product_id,
      },
      billingPlan
    ) &&
    order.payment.status === 'paid';

  if (needsIban && !order.payment.iban) {
    errors.push('IBAN requis pour cette offre');
  }
  return errors;
}

/** @deprecated Utiliser resolveProductConfig(order, catalog) dans bot/catalog.js */
function getProductConfig(offer, overrides = {}) {
  const order = {
    offer,
    product_name: overrides.deciplus_product_name || offer,
    payment: { amount: overrides.amount ?? 0, status: 'paid' },
  };
  return buildProductConfig(order, overrides.deciplus_product_name ? {
    id: 0,
    title: overrides.deciplus_product_name,
    type: overrides.sale_type === 'carte' ? 'decipass' : 'abo',
    categoryId: overrides.sale_type === 'carte' ? 'decipass' : 'abo',
    price: overrides.amount || 0,
  } : null);
}

function getGymConfig(gymSlug) {
  const gyms = loadJson('config/gym-mapping.json');
  const key = Object.keys(gyms).find(
    (k) => k === gymSlug || gyms[k].deciplus_label.toLowerCase().replace(/\s+/g, '-') === gymSlug
  );
  if (!key) throw new Error(`Salle inconnue: ${gymSlug}`);
  return { key, ...gyms[key] };
}

function buildInternalNote(_order) {
  // Plus de note technique type « Source: … | Produit: … | UTM … | Commande: … »
  return '';
}

module.exports = {
  normalizePhone,
  normalizeGender,
  normalizeOrder,
  validateOrder,
  validateCancelOrder,
  getJobId,
  getProductConfig,
  getGymConfig,
  buildInternalNote,
  normalizeIban,
  isValidFrenchIban,
};
