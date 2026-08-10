/**
 * Envoie une commande vers le bot BotHosting (file persistante côté bot).
 */
async function forwardJobToBot(order) {
  const { getStoreUrl } = require('./app-urls');
  const base = (process.env.BOXPLUS_BOT_URL || '').replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || process.env.BRIDGE_SECRET || '';
  if (!base) return { forwarded: false, reason: 'no_bot_url' };

  const res = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sync-secret': secret,
    },
    body: JSON.stringify({
      ...order,
      status_callback_base: order.status_callback_base || getStoreUrl(),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Bot ingest HTTP ${res.status}`);
  }
  return { forwarded: true, ...body };
}

module.exports = { forwardJobToBot };
