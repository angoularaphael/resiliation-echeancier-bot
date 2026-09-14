'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function yearMonth(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function currentYearMonth(now = new Date()) {
  return yearMonth(now);
}

function previousYearMonth(now = new Date()) {
  return yearMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

function isDueToday(timestamps, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = start + 86400000;
  return (timestamps || []).some((t) => Number(t) >= start && Number(t) < end);
}

function maxAttempts() {
  const n = Number(process.env.ECHEANCIER_REMINDER_MAX ?? 10);
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.floor(n);
}

/** Jours restants avant résil auto (1re relance = 10, 10e jour = 1). */
function remainingDays(attemptCount) {
  const max = maxAttempts();
  const n = Math.max(1, Number(attemptCount) || 1);
  return Math.max(1, max - n + 1);
}

function parisDayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.ECHEANCIER_CRON_TZ || 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const SEPA_REASON = {
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  NO_MANDATE: 'no_mandate',
  DEBTOR_DISPUTE: 'debtor_dispute',
  DEBTOR_REFUSAL: 'debtor_refusal',
  BAD_BANK: 'bad_bank_details',
  CLOSED_ACCOUNT: 'closed_account',
  ACCOUNT_BLOCKED: 'account_blocked',
  INVALID_BANK_ID: 'invalid_bank_id',
  JSON_ERROR: 'json_syntax_error',
  UNKNOWN: 'unknown',
};

const REASON_POLICY = {
  [SEPA_REASON.INSUFFICIENT_FUNDS]: { cancelAt: 3, ribEmailAt: null },
  [SEPA_REASON.NO_MANDATE]: { cancelAt: 3, ribEmailAt: null },
  [SEPA_REASON.DEBTOR_DISPUTE]: { cancelAt: 1, ribEmailAt: null },
  [SEPA_REASON.DEBTOR_REFUSAL]: { cancelAt: 1, ribEmailAt: null },
  [SEPA_REASON.BAD_BANK]: { cancelAt: 2, ribEmailAt: 1 },
  [SEPA_REASON.CLOSED_ACCOUNT]: { cancelAt: 1, ribEmailAt: null },
  [SEPA_REASON.ACCOUNT_BLOCKED]: { cancelAt: 2, ribEmailAt: null },
  [SEPA_REASON.INVALID_BANK_ID]: { cancelAt: 2, ribEmailAt: 1 },
  [SEPA_REASON.JSON_ERROR]: { cancelAt: 1, ribEmailAt: null },
  [SEPA_REASON.UNKNOWN]: { cancelAt: 3, ribEmailAt: null },
};

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

function hasUsablePhone(s) {
  return String(s || '').replace(/\D/g, '').length >= 8;
}

function hasMemberContact(candidate = {}) {
  return isValidEmail(candidate.email) || hasUsablePhone(candidate.phone);
}

function hasMissingContact(candidate = {}) {
  if (candidate.missing_contact === true) return true;
  if (candidate.email === undefined && candidate.phone === undefined) return false;
  return !hasMemberContact(candidate);
}

const INSUFFICIENT_FUNDS_CANCEL_AT = 3;

/** Motifs Deciplus « Détail de l'échéance » (Remarques / Status). */
function classifySepaRemark(text) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return SEPA_REASON.UNKNOWN;
  if (/\bAM04\b|provision insuffisante|fonds? insuffisant/i.test(t)) {
    return SEPA_REASON.INSUFFICIENT_FUNDS;
  }
  if (/\bMD06\b|contestation d[ée]biteur|contestation d['’]une op[ée]ration autoris[ée]e/i.test(t)) {
    return SEPA_REASON.DEBTOR_DISPUTE;
  }
  if (/\bMS02\b|refus du d[ée]biteur|sur ordre du client/i.test(t)) {
    return SEPA_REASON.DEBTOR_REFUSAL;
  }
  if (/\bMS03\b|raison non communiqu[ée]e/i.test(t)) {
    return SEPA_REASON.DEBTOR_REFUSAL;
  }
  if (/\bAC01\b|coordonn[ée]e?s?\s+bancaire.?s?\s+inexploit/i.test(t)) {
    return SEPA_REASON.BAD_BANK;
  }
  if (/\bAC04\b|compte cl[ôo]tur[ée]/i.test(t)) {
    return SEPA_REASON.CLOSED_ACCOUNT;
  }
  if (/\bAC06\b|opposition sur compte|pr[ée]l[èe]vement sepa interdit/i.test(t)) {
    return SEPA_REASON.ACCOUNT_BLOCKED;
  }
  if (/\bRC01\b|code banque incorrect|identifiant bancaire incorrect/i.test(t)) {
    return SEPA_REASON.INVALID_BANK_ID;
  }
  if (/\bMD01\b|pas d['’]?autorisation|absence de mandat/i.test(t)) {
    return SEPA_REASON.NO_MANDATE;
  }
  if (/json\s*syntax\s*error|erreur json/i.test(t)) {
    return SEPA_REASON.JSON_ERROR;
  }
  return SEPA_REASON.UNKNOWN;
}

function resolveUnpaidPolicy(sepaReasons = []) {
  const known = [...new Set((sepaReasons || []).filter((r) => r && r !== SEPA_REASON.UNKNOWN))];
  const effective = known.length ? known : [SEPA_REASON.UNKNOWN];
  const cancelAt = Math.min(...effective.map((r) => REASON_POLICY[r].cancelAt));
  const ribHits = effective.map((r) => REASON_POLICY[r].ribEmailAt).filter((n) => n != null);
  const ribEmailAt = ribHits.length ? Math.min(...ribHits) : null;
  const onlyInsufficientFunds =
    effective.length > 0 && effective.every((r) => r === SEPA_REASON.INSUFFICIENT_FUNDS);
  const onlyNoMandate = effective.length > 0 && effective.every((r) => r === SEPA_REASON.NO_MANDATE);
  const waitOnlyUnpaidCount = effective.every(
    (r) => r === SEPA_REASON.INSUFFICIENT_FUNDS || r === SEPA_REASON.NO_MANDATE
  );
  return {
    cancelAt,
    ribEmailAt,
    onlyInsufficientFunds,
    onlyNoMandate,
    waitOnlyUnpaidCount,
    effectiveReasons: effective,
  };
}

function isImmediateSepaReason(reason) {
  return REASON_POLICY[reason]?.cancelAt === 1;
}

function collectRemarkTexts(candidate = {}) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s) out.push(s);
  };
  for (const r of candidate.remarks || []) push(r);
  for (const s of candidate.samples || []) push(s);
  push(candidate.remark);
  push(candidate.sepa_remark);
  push(candidate.status);
  return out;
}

function classifySepaFromCandidate(candidate = {}) {
  const texts = collectRemarkTexts(candidate);
  const sepaReasons = [...new Set(texts.map(classifySepaRemark).filter((r) => r !== SEPA_REASON.UNKNOWN))];
  const policy = resolveUnpaidPolicy(sepaReasons);
  return {
    sepaReasons,
    policy,
    hasImmediateSepaReason: policy.cancelAt === 1,
    onlyInsufficientFunds: policy.onlyInsufficientFunds,
    onlyNoMandate: policy.onlyNoMandate,
    waitOnlyUnpaidCount: policy.waitOnlyUnpaidCount,
  };
}

/**
 * Relance = encore impayé.
 * Un seul mail (le premier passage 17h).
 * Chaque 17h = une tentative. À la 10e, si inchangé → résiliation
 * (sauf provision insuffisante : 3 impayés).
 */
function classifyUnpaid(candidate, now = new Date()) {
  const ym = currentYearMonth(now);
  const prev = previousYearMonth(now);
  const months = [...(candidate.months || [])].filter(Boolean).sort();
  const timestamps = candidate.timestamps || [];
  const unpaidCount = Number(candidate.unpaid_count || 0);
  const hasCurrent = months.includes(ym) || (!months.length && unpaidCount >= 1);
  const hasPrevious = months.some((k) => k <= prev);
  const dueToday = isDueToday(timestamps, now);
  const stillUnpaid = unpaidCount >= 1 || hasCurrent || hasPrevious;
  const sepa = classifySepaFromCandidate(candidate);
  return {
    ym,
    prev,
    months,
    hasCurrent,
    hasPrevious,
    dueToday,
    wantsReminder:
      stillUnpaid &&
      !hasMissingContact(candidate) &&
      sepa.policy.cancelAt > 1 &&
      unpaidCount < sepa.policy.cancelAt,
    wantsContentieux: false,
    unpaidCount,
    stillUnpaid,
    email: candidate.email,
    phone: candidate.phone,
    ...sepa,
  };
}

function isRelanceRun(kind) {
  const k = String(kind || '').toLowerCase();
  return k.includes('cron') || k === '17h' || k === 'relance';
}

function alreadySentReminder(memberState) {
  return Boolean(memberState?.reminder_at);
}

function shouldSendReminder(memberState, classified, { isRelance = false } = {}) {
  if (!isRelance) return false;
  if (!classified?.stillUnpaid) return false;
  if (memberState?.cancelled_at) return false;
  if ((classified.policy?.cancelAt ?? 3) === 1) return false;
  if (Number(classified.unpaidCount || 0) >= (classified.policy?.cancelAt ?? 3)) return false;
  if (alreadySentReminder(memberState)) return false;
  return true;
}

function shouldCountAttempt(memberState, classified, { isRelance = false, now = new Date() } = {}) {
  if (!isRelance) return false;
  if (!classified?.stillUnpaid) return false;
  if (memberState?.cancelled_at) return false;
  if ((classified.policy?.cancelAt ?? 3) === 1) return false;
  const day = parisDayKey(now);
  if (String(memberState?.last_attempt_day || '') === day) return false;
  return true;
}

/** Deux échéances impayées d’affilée (mois précédent + mois en cours). */
function isTwoConsecutiveUnpaid(classified = {}) {
  return (
    Number(classified.unpaidCount || 0) >= 2 &&
    classified.hasPrevious === true &&
    classified.hasCurrent === true
  );
}

/**
 * Résilier selon REASON_POLICY (AM04/MD01 → 3, MD06/MS02/MS03/AC04 → 1,
 * AC01/RC01/AC06 → 2, etc.) ; fiche sans contact → immédiat ;
 * motifs inconnus → 3 impayés ou 10e relance.
 */
function shouldCancel(memberState, classified, { force = false } = {}) {
  if (force && classified.unpaidCount >= 1) return true;
  if (memberState?.cancelled_at) return false;
  if (!classified?.stillUnpaid) return false;
  if (hasMissingContact(classified)) return true;
  const cancelAt = classified.policy?.cancelAt ?? INSUFFICIENT_FUNDS_CANCEL_AT;
  if (Number(classified.unpaidCount || 0) >= cancelAt) return true;
  if (classified.waitOnlyUnpaidCount) return false;
  const count = Number(memberState?.attempt_count || 0);
  return count >= maxAttempts();
}

function cancelWhy(classified = {}) {
  if (hasMissingContact(classified)) return 'missing_contact';
  const cancelAt = classified.policy?.cancelAt ?? INSUFFICIENT_FUNDS_CANCEL_AT;
  const reasons = classified.sepaReasons || [];
  if (Number(classified.unpaidCount || 0) >= cancelAt) {
    if (cancelAt === 1) {
      if (reasons.includes(SEPA_REASON.DEBTOR_DISPUTE)) return 'sepa_debtor_dispute';
      if (reasons.includes(SEPA_REASON.DEBTOR_REFUSAL)) return 'sepa_debtor_refusal';
      if (reasons.includes(SEPA_REASON.CLOSED_ACCOUNT)) return 'sepa_closed_account';
      if (reasons.includes(SEPA_REASON.JSON_ERROR)) return 'sepa_json_error';
      return 'sepa_immediate';
    }
    if (cancelAt === 2) return 'two_unpaid';
    if (classified.onlyInsufficientFunds) return 'am04_three_unpaid';
    if (classified.onlyNoMandate) return 'md01_three_unpaid';
    return 'three_unpaid';
  }
  return 'ten_attempts';
}

module.exports = {
  currentYearMonth,
  previousYearMonth,
  isDueToday,
  classifyUnpaid,
  classifySepaRemark,
  classifySepaFromCandidate,
  shouldCancel,
  cancelWhy,
  isTwoConsecutiveUnpaid,
  shouldSendReminder,
  shouldCountAttempt,
  alreadySentReminder,
  isRelanceRun,
  maxAttempts,
  remainingDays,
  parisDayKey,
  SEPA_REASON,
  REASON_POLICY,
  INSUFFICIENT_FUNDS_CANCEL_AT,
  resolveUnpaidPolicy,
  isImmediateSepaReason,
  hasMemberContact,
  hasMissingContact,
};
