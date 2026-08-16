'use strict';

const { logInfo, logWarn } = require('./logger');
const { formatEurosFromCents } = require('./echeancier-offer');
const { remainingDays } = require('./echeancier-policy');
const { getStoreUrl } = require('./app-urls');

function brevoKey() {
  return String(process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
}

function sender() {
  return {
    name: process.env.BREVO_SENDER_NAME || 'Boxing Center',
    email: process.env.BREVO_SENDER_EMAIL || 'suzinabot@gmail.com',
  };
}

async function sendBrevoEmail({ to, subject, html, text }) {
  const apiKey = brevoKey();
  if (!apiKey.startsWith('xkeysib-')) {
    return { sent: false, reason: 'brevo_not_configured' };
  }
  const email = String(to || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { sent: false, reason: 'email_invalide' };
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: sender(),
      to: [{ email }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Brevo HTTP ${res.status} ${errText}`.trim());
  }
  return { sent: true };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function greeting(prenom) {
  const p = String(prenom || '').trim();
  return p ? `Bonjour ${p},` : 'Bonjour,';
}

function storeBase() {
  return String(process.env.BOXPLUS_STORE_URL || process.env.STORE_URL || getStoreUrl()).replace(
    /\/$/,
    ''
  );
}

function davidCancelUrl() {
  return `${storeBase()}/gerer-abonnement#resilier`;
}

function deadlineBlock(daysLeft) {
  const n = Number(daysLeft) || 10;
  const jour = n > 1 ? 'jours' : 'jour';
  return `<div style="text-align:center;margin:22px 0;padding:18px 16px;background:#FFF5F5;border:2px solid #E8001C;border-radius:12px">
      <p style="margin:0;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:#E8001C">Régularisez avant résiliation</p>
      <p style="margin:6px 0 0;font-size:64px;line-height:1;font-weight:800;color:#E8001C">${n}</p>
      <p style="margin:8px 0 0;font-size:15px;color:#0C1829;font-weight:600">${jour} pour payer — ensuite l’abonnement sera résilié automatiquement</p>
    </div>`;
}

function davidBlock() {
  const url = escapeHtml(davidCancelUrl());
  return `<p style="text-align:center;margin:24px 0 8px">
      <a href="${url}" style="display:inline-block;background:#ffffff;color:#0C1829;border:2px solid #0C1829;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Résilier avec David</a>
    </p>
    <p style="font-size:13px;color:#5C6370;line-height:1.5">Si vous souhaitez partir : ouvrez David (conseiller résiliation). Le <strong>nom</strong>, le <strong>prénom</strong>, la <strong>date de naissance</strong> et le <strong>téléphone</strong> doivent être <strong>identiques à ceux de votre inscription</strong>.</p>`;
}

function paymentBlock({ payUrl, gym }) {
  if (!payUrl) {
    return '<p>Merci de vous rapprocher de votre salle pour régulariser.</p>';
  }
  const safeUrl = escapeHtml(payUrl);
  const isPortet = /portet/i.test(String(gym || ''));
  const how = isPortet
    ? 'Vous arrivez sur une page sécurisée : réglez avec <strong>PayPal</strong> (compte PayPal ou carte bancaire).'
    : 'Vous arrivez sur une page sécurisée : choisissez <strong>carte bancaire</strong> ou <strong>PayPal</strong> — cela prend moins d’une minute.';
  return `<p>${how}</p>
    <p style="text-align:center;margin:28px 0 12px">
      <a href="${safeUrl}" style="display:inline-block;background:#E8001C;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:16px 28px;border-radius:8px">Payer maintenant</a>
    </p>
    <p style="font-size:13px;color:#5C6370;word-break:break-all;line-height:1.5">Si le bouton ne s’affiche pas, copiez ce lien dans votre navigateur :<br/><a href="${safeUrl}" style="color:#E8001C">${safeUrl}</a></p>`;
}

function reminderCopy({ prenom, amountCents, offerLabel, payUrl, gym, attemptCount } = {}) {
  const who = greeting(prenom);
  const daysLeft = remainingDays(attemptCount);
  const amount = amountCents ? formatEurosFromCents(amountCents) : null;
  const offre = offerLabel && offerLabel !== 'échéance' ? ` (formule ${offerLabel})` : '';
  const offreHtml =
    offerLabel && offerLabel !== 'échéance' ? ` (formule ${escapeHtml(offerLabel)})` : '';
  const amountLine = amount
    ? `Une échéance de <strong>${escapeHtml(amount)}</strong>${offreHtml} n’a pas pu être encaissée à la date prévue.`
    : `Une échéance de votre abonnement n’a pas pu être encaissée à la date prévue.`;
  const amountText = amount
    ? `Une échéance de ${amount}${offre} n’a pas pu être encaissée à la date prévue.`
    : `Une échéance de votre abonnement n’a pas pu être encaissée à la date prévue.`;
  const cancelUrl = davidCancelUrl();
  const jour = daysLeft > 1 ? 'jours' : 'jour';

  const text =
    `${who}\n\n` +
    `${amountText}\n\n` +
    `Il vous reste ${daysLeft} ${jour} pour régulariser avant résiliation automatique.\n\n` +
    `Pour conserver votre accès aux 5 salles Boxing Center, réglez maintenant en ligne` +
    (payUrl ? ` :\n${payUrl}\n\n` : ` auprès de votre salle.\n\n`) +
    `Sur la page, choisissez carte bancaire ou PayPal.\n\n` +
    `Pour résilier : ${cancelUrl}\n` +
    `Les informations (nom, prénom, date de naissance, téléphone) doivent être identiques à celles de votre inscription.\n\n` +
    `Sportivement,\nL’équipe Boxing Center`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Échéance à régler</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#0C1829;max-width:600px;margin:0 auto;padding:24px;background:#f4f5f7">
  <div style="background:#0C1829;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
    <p style="margin:0;letter-spacing:0.12em;font-size:12px;color:#C8902F;text-transform:uppercase">Boxing Center — Échéance</p>
    <h1 style="margin:8px 0 0;font-size:24px;line-height:1.25">Il ne reste plus qu’à payer</h1>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px">
    <p>${escapeHtml(who)}</p>
    <p>${amountLine}</p>
    ${deadlineBlock(daysLeft)}
    <p>Pour <strong>conserver votre accès</strong> aux 5 salles, cliquez sur le bouton ci-dessous.</p>
    ${paymentBlock({ payUrl, gym })}
    ${davidBlock()}
    <p style="margin:28px 0 0">Sportivement,<br/><strong>L’équipe Boxing Center</strong></p>
  </div>
</body>
</html>`;

  return {
    subject: 'Votre échéance Boxing Center — un clic pour régler',
    text,
    html,
    daysLeft,
    cancelUrl,
  };
}

async function sendUnpaidReminder({ email, prenom, amountCents, offerLabel, payUrl, gym, attemptCount }) {
  const copy = reminderCopy({ prenom, amountCents, offerLabel, payUrl, gym, attemptCount });
  try {
    const result = await sendBrevoEmail({ to: email, ...copy });
    if (result.sent) logInfo('Échéancier — mail relance envoyé', { email });
    else logWarn('Échéancier — mail relance non envoyé', { email, reason: result.reason });
    return result;
  } catch (err) {
    logWarn('Échéancier — mail relance échoué', { email, error: err.message });
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendUnpaidReminder,
  reminderCopy,
};
