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
  BAD_BANK: 'bad_bank_details',
  DEBTOR_REFUSAL: 'debtor_refusal',
  NO_MANDATE: 'no_mandate',
  JSON_ERROR: 'json_syntax_error',
  UNKNOWN: 'unknown',
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
  if (/\bAC01\b|coordonn[ée]e?s?\s+bancaire.?s?\s+inexploit/i.test(t)) {
    return SEPA_REASON.BAD_BANK;
  }
  if (/\bMS02\b|refus du d[ée]biteur|sur ordre du client/i.test(t)) {
    return SEPA_REASON.DEBTOR_REFUSAL;
  }
  if (/\bMD01\b|pas d['’]?autorisation|absence de mandat/i.test(t)) {
    return SEPA_REASON.NO_MANDATE;
  }
  if (/json\s*syntax\s*error|erreur json/i.test(t)) {
    return SEPA_REASON.JSON_ERROR;
  }
  return SEPA_REASON.UNKNOWN;
}

function isImmediateSepaReason(reason) {
  return (
    reason === SEPA_REASON.BAD_BANK ||
    reason === SEPA_REASON.DEBTOR_REFUSAL ||
    reason === SEPA_REASON.NO_MANDATE ||
    reason === SEPA_REASON.JSON_ERROR
  );
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
  const sepaReasons = texts.map(classifySepaRemark);
  const known = sepaReasons.filter((r) => r !== SEPA_REASON.UNKNOWN);
  const hasImmediateSepaReason = sepaReasons.some(isImmediateSepaReason);
  const onlyInsufficientFunds =
    known.length > 0 && known.every((r) => r === SEPA_REASON.INSUFFICIENT_FUNDS);
  return {
    sepaReasons: [...new Set(sepaReasons.filter((r) => r !== SEPA_REASON.UNKNOWN))],
    hasImmediateSepaReason,
    onlyInsufficientFunds,
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
    wantsReminder: stillUnpaid && !sepa.hasImmediateSepaReason && unpaidCount < INSUFFICIENT_FUNDS_CANCEL_AT,
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
  if (classified.hasImmediateSepaReason) return false;
  if (Number(classified.unpaidCount || 0) >= INSUFFICIENT_FUNDS_CANCEL_AT) return false;
  if (alreadySentReminder(memberState)) return false;
  return true;
}

function shouldCountAttempt(memberState, classified, { isRelance = false, now = new Date() } = {}) {
  if (!isRelance) return false;
  if (!classified?.stillUnpaid) return false;
  if (memberState?.cancelled_at) return false;
  if (classified.hasImmediateSepaReason) return false;
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
 * Résilier si :
 * - AC01 (RIB inexploitable), MS02 (refus débiteur / ordre client), MD01 (absence de mandat),
 *   erreur JSON → immédiat ; fiche sans e-mail ni téléphone → immédiat aussi
 * - provision insuffisante (AM04) → seulement à 3 impayés
 * - autres motifs inconnus → 10e relance, ou 3 impayés
 */
function shouldCancel(memberState, classified, { force = false } = {}) {
  if (force && classified.unpaidCount >= 1) return true;
  if (memberState?.cancelled_at) return false;
  if (!classified?.stillUnpaid) return false;
  if (classified.hasImmediateSepaReason) return true;
  if (hasMissingContact(classified)) return true;
  if (Number(classified.unpaidCount || 0) >= INSUFFICIENT_FUNDS_CANCEL_AT) return true;
  if (classified.onlyInsufficientFunds) return false;
  const count = Number(memberState?.attempt_count || 0);
  return count >= maxAttempts();
}

function cancelWhy(classified = {}) {
  if (classified.hasImmediateSepaReason) {
    if ((classified.sepaReasons || []).includes(SEPA_REASON.DEBTOR_REFUSAL)) return 'sepa_debtor_refusal';
    if ((classified.sepaReasons || []).includes(SEPA_REASON.BAD_BANK)) return 'sepa_bad_bank';
    if ((classified.sepaReasons || []).includes(SEPA_REASON.NO_MANDATE)) return 'sepa_no_mandate';
    if ((classified.sepaReasons || []).includes(SEPA_REASON.JSON_ERROR)) return 'sepa_json_error';
    return 'sepa_immediate';
  }
  if (hasMissingContact(classified)) return 'missing_contact';
  if (Number(classified.unpaidCount || 0) >= INSUFFICIENT_FUNDS_CANCEL_AT) {
    return classified.onlyInsufficientFunds ? 'am04_three_unpaid' : 'three_unpaid';
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
  INSUFFICIENT_FUNDS_CANCEL_AT,
  isImmediateSepaReason,
  hasMemberContact,
  hasMissingContact,
};
