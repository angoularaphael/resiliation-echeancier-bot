'use strict';

const { logInfo, logWarn } = require('./logger');

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

function reminderCopy({ prenom }) {
  const who = prenom || 'Bonjour';
  const text =
    `${who},\n\n` +
    `Nous n’avons pas reçu le règlement de ton échéance à la date prévue.\n\n` +
    `Merci de régulariser dès que possible pour conserver ton accès aux salles Boxing Center.\n\n` +
    `Boxing Center — Toulouse`;
  const html = `<p>${who},</p>
<p>Nous n’avons pas reçu le règlement de <strong>ton échéance à la date du jour</strong>.</p>
<p>Merci de régulariser dès que possible pour conserver ton accès aux salles Boxing Center.</p>
<p>Boxing Center — Toulouse</p>`;
  return {
    subject: 'Relance — échéance impayée | Boxing Center',
    text,
    html,
  };
}

function contentieuxCopy({ prenom }) {
  const who = prenom || 'Bonjour';
  const text =
    `${who},\n\n` +
    `Ton échéance est toujours impayée le mois suivant.\n\n` +
    `Tu dois régulariser immédiatement. À défaut, le dossier passe au service contentieux et ton abonnement sera résilié sous 24 heures.\n\n` +
    `Boxing Center — Toulouse`;
  const html = `<p>${who},</p>
<p>Ton échéance est <strong>toujours impayée le mois suivant</strong>.</p>
<p>Tu dois <strong>régulariser immédiatement</strong>. À défaut, le dossier passe au <strong>service contentieux</strong> et ton abonnement sera <strong>résilié sous 24 heures</strong>.</p>
<p>Boxing Center — Toulouse</p>`;
  return {
    subject: 'Dernière relance — contentieux et résiliation sous 24h | Boxing Center',
    text,
    html,
  };
}

async function sendUnpaidReminder({ email, prenom }) {
  const copy = reminderCopy({ prenom });
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

async function sendContentieuxNotice({ email, prenom }) {
  const copy = contentieuxCopy({ prenom });
  try {
    const result = await sendBrevoEmail({ to: email, ...copy });
    if (result.sent) logInfo('Échéancier — mail contentieux envoyé', { email });
    else logWarn('Échéancier — mail contentieux non envoyé', { email, reason: result.reason });
    return result;
  } catch (err) {
    logWarn('Échéancier — mail contentieux échoué', { email, error: err.message });
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendUnpaidReminder,
  sendContentieuxNotice,
  reminderCopy,
  contentieuxCopy,
};
