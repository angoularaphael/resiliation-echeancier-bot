const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir } = require('./utils');
const { logInfo, logWarn } = require('./logger');
const { getJobId } = require('./normalize');

const QUEUE_DIR =
  process.env.BOXPLUS_QUEUE_DIR ||
  (process.env.VERCEL ? '/tmp/boxplus-queue' : path.join(ROOT, 'data', 'queue'));
const PROCESSED_FILE = path.join(QUEUE_DIR, 'processed-orders.json');

const STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  ERROR: 'error',
  DUPLICATE: 'duplicate',
  MANUAL_REVIEW: 'manual_review',
  REJECTED: 'rejected',
};

function initQueue() {
  ensureDir(QUEUE_DIR);
  if (!fs.existsSync(PROCESSED_FILE)) {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify({ orders: {} }, null, 2), 'utf8');
  }
}

function loadProcessed() {
  initQueue();
  return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
}

function saveProcessed(data) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function sanitizeJobFilename(jobId) {
  return String(jobId).replace(/[^a-zA-Z0-9_-]+/g, '__');
}

function isProcessed(jobId) {
  const data = loadProcessed();
  return Boolean(data.orders[jobId]);
}

function getProcessedRecord(jobId) {
  const data = loadProcessed();
  return data.orders[jobId] || null;
}

function markProcessed(jobId, result) {
  const data = loadProcessed();
  data.orders[jobId] = {
    status: result.status,
    action: result.action || null,
    deciplus_member_id: result.deciplus_member_id || null,
    deciplus_sale_id: result.deciplus_sale_id || null,
    processed_at: new Date().toISOString(),
    error: result.error || null,
  };
  saveProcessed(data);
}

function markSaleCancelled(orderId) {
  const data = loadProcessed();
  if (data.orders[orderId]) {
    data.orders[orderId].cancelled_at = new Date().toISOString();
    data.orders[orderId].cancel_status = STATUS.SUCCESS;
  }
  saveProcessed(data);
}

function enqueue(order) {
  initQueue();
  const jobId = order.job_id || getJobId(order);
  if (!order.order_id && !jobId) throw new Error('order_id requis');

  if (isProcessed(jobId)) {
    logWarn('Job déjà traité (idempotence)', { job_id: jobId });
    return { queued: false, reason: 'already_processed', job_id: jobId, order_id: order.order_id };
  }

  const file = path.join(QUEUE_DIR, `${sanitizeJobFilename(jobId)}.json`);
  if (fs.existsSync(file)) {
    return { queued: false, reason: 'already_queued', job_id: jobId, order_id: order.order_id };
  }

  const payload = {
    ...order,
    job_id: jobId,
    status: STATUS.PENDING,
    created_at: new Date().toISOString(),
    attempts: 0,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  logInfo('Job ajouté à la file', { job_id: jobId, order_id: order.order_id, action: order.action || 'sale' });
  return { queued: true, job_id: jobId, order_id: order.order_id, file };
}

function listPending() {
  initQueue();
  const maxRetries = Number(process.env.BOT_MAX_RETRIES || 3);
  return fs
    .readdirSync(QUEUE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'processed-orders.json')
    .map((f) => {
      const full = path.join(QUEUE_DIR, f);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      return { file: full, ...data };
    })
    .filter((item) => {
      const jobId = item.job_id || item.order_id;
      if (jobId && isProcessed(jobId)) return false;
      const attempts = Number(item.attempts || 0);
      // Déjà épuisé : ne plus retenter en boucle
      if (attempts >= maxRetries) return false;
      return item.status === STATUS.PENDING || item.status === STATUS.ERROR;
    })
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function isSessionRelatedError(message = '') {
  return /session expir|token.*introuvable|relancer login|not logged|login\.php|Unauthorized|\b401\b|storage-state|connexion.*échou|Déconnexion|session Deciplus|auth.*expir|cookie|browser has been closed|Target page|cooldown|identifiant/i.test(
    String(message || '')
  );
}

/**
 * Jobs « processing » après crash / Ctrl+C, et ERROR liés à la session,
 * repassent en pending pour reprise au démarrage / boucle.
 */
function requeueInterruptedJobs(maxAgeMs = 2 * 60 * 1000, { includeSessionErrors = true } = {}) {
  initQueue();
  let count = 0;
  for (const f of fs.readdirSync(QUEUE_DIR)) {
    if (!f.endsWith('.json') || f === 'processed-orders.json') continue;
    const full = path.join(QUEUE_DIR, f);
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    const jobId = data.job_id || data.order_id;
    if (jobId && isProcessed(jobId)) {
      removeJob(full);
      continue;
    }

    const age = Date.now() - new Date(data.updated_at || data.created_at || 0).getTime();
    const attempts = Number(data.attempts || 0);
    const maxRetries = Number(process.env.BOT_MAX_RETRIES || 3);
    if (attempts >= maxRetries) continue;

    const isStaleProcessing = data.status === STATUS.PROCESSING && age >= maxAgeMs;
    const isSessionError =
      includeSessionErrors &&
      data.status === STATUS.ERROR &&
      isSessionRelatedError(data.last_error || '');

    if (!isStaleProcessing && !isSessionError) continue;

    updateJob(full, {
      status: STATUS.PENDING,
      last_error:
        data.last_error ||
        (isSessionError
          ? 'Erreur session — reprise automatique'
          : 'Job interrompu — reprise automatique'),
    });
    count += 1;
    logWarn('Job remis en file', {
      job_id: jobId,
      order_id: data.order_id,
      reason: isSessionError ? 'session_error' : 'interrupted_processing',
    });
  }
  return count;
}

function updateJob(filePath, patch) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const next = { ...data, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function removeJob(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function findJobFile(jobId) {
  initQueue();
  const id = String(jobId || '').trim();
  if (!id) return null;
  const direct = path.join(QUEUE_DIR, `${sanitizeJobFilename(id)}.json`);
  if (fs.existsSync(direct)) {
    return { file: direct, data: JSON.parse(fs.readFileSync(direct, 'utf8')) };
  }
  for (const f of fs.readdirSync(QUEUE_DIR)) {
    if (!f.endsWith('.json') || f === 'processed-orders.json') continue;
    const full = path.join(QUEUE_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (data.job_id === id || data.order_id === id) return { file: full, data };
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Annule un job en file (pending/processing/error) — ne relancera plus. */
function cancelJob(jobId, reason = 'Annulé manuellement') {
  initQueue();
  const id = String(jobId || '').trim();
  if (!id) return { ok: false, error: 'job_id requis' };

  const found = findJobFile(id);
  const existing = getProcessedRecord(id);
  if (!found) {
    if (existing) {
      return {
        ok: true,
        already: true,
        job_id: id,
        status: existing.status,
        error: existing.error || null,
      };
    }
    // Marquer quand même pour bloquer une reprise / re-enqueue
    markProcessed(id, { status: STATUS.REJECTED, error: reason, action: 'sale' });
    logWarn('Job annulé (absent de la file — marquage anti-reprise)', { job_id: id, reason });
    return { ok: true, cancelled: true, job_id: id, was_queued: false };
  }

  const data = found.data;
  markProcessed(id, {
    status: STATUS.REJECTED,
    error: reason,
    action: data.action || 'sale',
    deciplus_member_id: data.checkpoint?.deciplus_member_id || data.deciplus_member_id || null,
    deciplus_sale_id: data.checkpoint?.deciplus_sale_id || data.deciplus_sale_id || null,
  });
  removeJob(found.file);
  logWarn('Job annulé et retiré de la file', {
    job_id: id,
    order_id: data.order_id,
    previous_status: data.status,
    reason,
  });
  return {
    ok: true,
    cancelled: true,
    job_id: id,
    order_id: data.order_id || id,
    previous_status: data.status,
    was_queued: true,
  };
}

function getQueueStats() {
  initQueue();
  const processed = loadProcessed();
  const pending = listPending();
  const counts = { pending: 0, error: 0, success: 0, manual_review: 0, duplicate: 0, cancelled: 0 };
  for (const job of pending) {
    counts[job.status === STATUS.ERROR ? 'error' : 'pending'] += 1;
  }
  for (const entry of Object.values(processed.orders)) {
    if (entry.status === STATUS.SUCCESS) {
      if (entry.action === 'cancel') counts.cancelled += 1;
      else counts.success += 1;
    } else if (entry.status === STATUS.MANUAL_REVIEW) counts.manual_review += 1;
    else if (entry.status === STATUS.DUPLICATE) counts.duplicate += 1;
    else if (entry.status === STATUS.ERROR) counts.error += 1;
    else if (entry.status === STATUS.REJECTED) counts.error += 1;
  }
  return { counts, pending_jobs: pending.length, processed_total: Object.keys(processed.orders).length };
}

/**
 * Jobs à attempts >= MAX_RETRIES : marqués impossibles et retirés de la file.
 */
function finalizeExhaustedJobs(maxRetries = Number(process.env.BOT_MAX_RETRIES || 3)) {
  initQueue();
  let count = 0;
  for (const f of fs.readdirSync(QUEUE_DIR)) {
    if (!f.endsWith('.json') || f === 'processed-orders.json') continue;
    const full = path.join(QUEUE_DIR, f);
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    const jobId = data.job_id || data.order_id;
    if (jobId && isProcessed(jobId)) {
      removeJob(full);
      continue;
    }
    const attempts = Number(data.attempts || 0);
    if (attempts < maxRetries) continue;
    if (data.status === STATUS.SUCCESS || data.status === STATUS.MANUAL_REVIEW) {
      removeJob(full);
      continue;
    }
    const error =
      data.last_error && /impossible à traiter/i.test(data.last_error)
        ? data.last_error
        : `Job impossible à traiter après ${attempts} tentatives${data.last_error ? ` — ${data.last_error}` : ''}`;
    markProcessed(jobId, {
      status: STATUS.MANUAL_REVIEW,
      error,
      action: data.action || 'sale',
      deciplus_member_id: data.checkpoint?.deciplus_member_id || null,
      deciplus_sale_id: data.checkpoint?.deciplus_sale_id || null,
    });
    removeJob(full);
    count += 1;
    logWarn('Job impossible à traiter — retiré de la file', {
      job_id: jobId,
      order_id: data.order_id,
      attempts,
    });
  }
  return count;
}

module.exports = {
  QUEUE_DIR,
  STATUS,
  enqueue,
  listPending,
  updateJob,
  removeJob,
  findJobFile,
  cancelJob,
  isProcessed,
  getProcessedRecord,
  markProcessed,
  markSaleCancelled,
  getQueueStats,
  requeueInterruptedJobs,
  finalizeExhaustedJobs,
};
