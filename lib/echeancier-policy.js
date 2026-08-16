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

/**
 * Relance = encore impayé.
 * Un seul mail (le premier passage 17h).
 * Chaque 17h = une tentative. À la 10e, si inchangé → résiliation.
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
  return {
    ym,
    prev,
    months,
    hasCurrent,
    hasPrevious,
    dueToday,
    wantsReminder: stillUnpaid,
    wantsContentieux: false,
    unpaidCount,
    stillUnpaid,
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
  if (alreadySentReminder(memberState)) return false;
  return true;
}

function shouldCountAttempt(memberState, classified, { isRelance = false, now = new Date() } = {}) {
  if (!isRelance) return false;
  if (!classified?.stillUnpaid) return false;
  if (memberState?.cancelled_at) return false;
  const day = parisDayKey(now);
  if (String(memberState?.last_attempt_day || '') === day) return false;
  return true;
}

function shouldCancel(memberState, classified, { force = false } = {}) {
  if (force && classified.unpaidCount >= 1) return true;
  if (memberState?.cancelled_at) return false;
  if (!classified?.stillUnpaid) return false;
  const count = Number(memberState?.attempt_count || 0);
  return count >= maxAttempts();
}

module.exports = {
  currentYearMonth,
  previousYearMonth,
  isDueToday,
  classifyUnpaid,
  shouldCancel,
  shouldSendReminder,
  shouldCountAttempt,
  alreadySentReminder,
  isRelanceRun,
  maxAttempts,
  remainingDays,
  parisDayKey,
};
