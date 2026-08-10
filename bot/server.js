/**
 * Serveur HTTP minimal — reçoit les commandes Vercel et les met en file locale.
 */
require('dotenv').config();

const express = require('express');
const { enqueue, getQueueStats, cancelJob, getProcessedRecord, findJobFile, STATUS } = require('../lib/queue');
const { normalizeOrder, validateOrder } = require('../lib/normalize');
const { logInfo, logError } = require('../lib/logger');

const PORT = Number(process.env.BOT_HTTP_PORT || process.env.PORT || 3050);
const SECRET = process.env.SYNC_SECRET || process.env.BRIDGE_SECRET || '';

function isAuthorized(req) {
  if (!SECRET) return false;
  const header = req.headers['x-sync-secret'] || req.headers['authorization'] || '';
  const token = String(header).replace(/^Bearer\s+/i, '').trim();
  return token === SECRET;
}

function createBotServer() {
  const app = express();
  app.use(express.json({ limit: '6mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'echeancier-resiliation-bot', role: process.env.BOT_ROLE || 'ops', stats: getQueueStats() });
  });

  app.post('/api/echeancier/scan', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const order = normalizeOrder({
        order_id: `ECHEANCIER-${Date.now()}`,
        action: 'echeancier',
        limit: req.body?.limit,
        product_name: 'Scan échéancier impayés',
        requires_payment: false,
        requires_iban: false,
        sale_type: 'none',
        gym: 'minimes',
      });
      const result = enqueue(order);
      logInfo('Scan échéancier demandé', { order_id: order.order_id });
      res.json({ ok: true, ...result });
    } catch (err) {
      logError('Scan échéancier enqueue échoué', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/jobs', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const order = normalizeOrder(req.body);
      const errors = validateOrder(order);
      if (errors.length) {
        return res.status(400).json({ ok: false, error: errors.join(', ') });
      }
      const result = enqueue(order);
      logInfo('Job reçu depuis boutique', {
        order_id: order.order_id,
        job_id: result.job_id,
        queued: result.queued,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      logError('Ingest job échoué', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/queue/stats', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    res.json({ ok: true, ...getQueueStats(), STATUS });
  });

  app.get('/api/jobs/:id', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const record = getProcessedRecord(req.params.id);
    res.json({ ok: true, job_id: req.params.id, processed: record || null });
  });

  app.post('/api/jobs/:id/cancel', (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const reason = String(req.body?.reason || 'cancelled_by_admin').slice(0, 200);
      const result = cancelJob(req.params.id, reason);
      if (!result.ok) return res.status(400).json(result);
      logInfo('Job annulé via API', { job_id: result.job_id, reason });
      res.json(result);
    } catch (err) {
      logError('Annulation job échouée', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return app;
}

function startBotServer() {
  const app = createBotServer();
  app.listen(PORT, '0.0.0.0', () => {
    logInfo(`Bot HTTP ingest → :${PORT}`);
  });
  return app;
}

module.exports = { createBotServer, startBotServer };
