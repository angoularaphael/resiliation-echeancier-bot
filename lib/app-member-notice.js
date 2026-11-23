'use strict';

const crypto = require('crypto');
const { logWarn } = require('./logger');

function bridgeBase() {
  return String(process.env.APP_BRIDGE_PUBLIC_URL || '').replace(/\/$/, '');
}

async function notifyMemberApp({ eventId, email, kind, title, body }) {
  const base = bridgeBase();
  const secret = process.env.SHOP_BRIDGE_SECRET || '';
  if (!base || !secret || !email) return { delivered: false, reason: 'bridge_absent' };
  const payload = JSON.stringify({ event_id: eventId, email, kind, title, body });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  try {
    const res = await fetch(`${base}/internal/member-notice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bc-timestamp': timestamp,
        'x-bc-signature': signature,
      },
      body: payload,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return { delivered: false, reason: `http_${res.status}` };
    return await res.json();
  } catch (err) {
    logWarn('Avis app non envoye', { event_id: eventId, error: err.message });
    return { delivered: false, reason: 'reseau' };
  }
}

module.exports = { notifyMemberApp };
