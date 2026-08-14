'use strict';

const { logInfo, logWarn } = require('./logger');
const { formatEurosFromCents } = require('./echeancier-offer');

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

function greeting(prenom) {
  const p = String(prenom || '').trim();
  return p ? `Bonjour ${p},` : 'Madame, Monsieur,';
}

function paymentButtonsHtml({ payUrl, gym }) {
  if (!payUrl) return '';
  const isPortet = String(gym || '').toLowerCase() === 'portet';
  const btn = (label) =>
    `<p style="margin:24px 0"><a href="${payUrl}" style="display:inline-block;background:#0B1F3A;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:6px;font-weight:600">${label}</a></p>`;
  if (isPortet) {
    return `${btn('Régler mon échéance (PayPal)')}
<p style="font-size:13px;color:#5C6370">Pour la salle de Portet, le règlement s’effectue via PayPal (compte PayPal ou carte bancaire).</p>`;
  }
  return `${btn('Régler mon échéance')}
<p style="font-size:13px;color:#5C6370">Carte bancaire (PayPlug) ou PayPal — vous choisirez sur la page sécurisée.</p>`;
}

function reminderCopy({ prenom, amountCents, offerLabel, payUrl, gym } = {}) {
  const who = greeting(prenom);
  const amount = amountCents ? formatEurosFromCents(amountCents) : null;
  const offre = offerLabel && offerLabel !== 'échéance' ? ` (formule ${offerLabel})` : '';
  const amountLine = amount
    ? `Nous constatons qu’une échéance de <strong>${amount}</strong>${offre} n’a pas pu être encaissée à la date prévue.`
    : `Nous constatons qu’une échéance de votre abonnement n’a pas pu être encaissée à la date prévue.`;
  const amountText = amount
    ? `Nous constatons qu’une échéance de ${amount}${offre} n’a pas pu être encaissée à la date prévue.`
    : `Nous constatons qu’une échéance de votre abonnement n’a pas pu être encaissée à la date prévue.`;

  const text =
    `${who}\n\n` +
    `${amountText}\n\n` +
    `Afin de préserver votre accès aux salles Boxing Center, nous vous remercions de bien vouloir régulariser cette situation dès que possible` +
    (payUrl ? ` via le lien suivant :\n${payUrl}\n\n` : ` auprès de votre salle.\n\n`) +
    `Nous restons à votre entière disposition pour toute question.\n\n` +
    `Avec nos remerciements,\nL’équipe Boxing Center`;

  const html = `<p>${who}</p>
<p>${amountLine}</p>
<p>Afin de préserver votre accès aux salles Boxing Center, nous vous remercions de bien vouloir régulariser cette situation dès que possible.</p>
${paymentButtonsHtml({ payUrl, gym })}
<p>Nous restons à votre entière disposition pour toute question.</p>
<p>Avec nos remerciements,<br/>L’équipe Boxing Center</p>`;

  return {
    subject: 'Échéance en attente — Boxing Center',
    text,
    html,
  };
}

async function sendUnpaidReminder({ email, prenom, amountCents, offerLabel, payUrl, gym }) {
  const copy = reminderCopy({ prenom, amountCents, offerLabel, payUrl, gym });
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
