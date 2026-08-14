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

function contentieuxDelayMs() {
  const hours = Number(process.env.ECHEANCIER_CONTENTIEUX_HOURS ?? 24);
  if (!Number.isFinite(hours) || hours < 0) return 24 * 3600 * 1000;
  return hours * 3600 * 1000;
}

/**
 * Relance = impayé du jour / mois en cours.
 * Contentieux = encore impayé le mois suivant (mois antérieur toujours dans la liste).
 * Résiliation = 24h après le mail contentieux, date effective = aujourd’hui (mois en cours).
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
  return {
    ym,
    prev,
    months,
    hasCurrent,
    hasPrevious,
    dueToday,
    wantsReminder: dueToday || hasCurrent,
    wantsContentieux: hasPrevious || unpaidCount >= 2,
    unpaidCount,
  };
}

function shouldCancel(memberState, classified, { force = false, now = new Date() } = {}) {
  if (force && classified.unpaidCount >= 1) return true;
  if (memberState?.cancelled_at) return false;
  const after = memberState?.cancel_after ? Date.parse(memberState.cancel_after) : NaN;
  if (Number.isFinite(after) && now.getTime() >= after) return true;
  return false;
}

function nextCancelAfter(now = new Date()) {
  return new Date(now.getTime() + contentieuxDelayMs()).toISOString();
}

module.exports = {
  currentYearMonth,
  previousYearMonth,
  isDueToday,
  classifyUnpaid,
  shouldCancel,
  nextCancelAfter,
  contentieuxDelayMs,
};
