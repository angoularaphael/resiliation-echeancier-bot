const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir, timestamp } = require('./utils');

const LOG_DIR =
  process.env.BOXPLUS_LOG_DIR ||
  (process.env.VERCEL ? '/tmp/boxplus-logs' : path.join(ROOT, 'logs'));

function writeLog(entry) {
  try {
    ensureDir(LOG_DIR);
    const file = path.join(LOG_DIR, `boxplus-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const line = JSON.stringify({ ...entry, logged_at: new Date().toISOString() });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    /* serverless : logs fichier optionnels */
  }
}

function logInfo(message, meta = {}) {
  const entry = { level: 'info', message, ...meta };
  const extras = [];
  if (meta.order_id) extras.push(`order: ${meta.order_id}`);
  if (typeof meta.renewed === 'boolean') extras.push(`renewed: ${meta.renewed}`);
  console.log(`[BOXPLUS] ${message}${extras.length ? ` (${extras.join(', ')})` : ''}`);
  writeLog(entry);
}

function logError(message, meta = {}) {
  const entry = { level: 'error', message, ...meta };
  console.error(`[BOXPLUS] ERROR: ${message}`, meta);
  writeLog(entry);
}

function logWarn(message, meta = {}) {
  const entry = { level: 'warn', message, ...meta };
  console.warn(`[BOXPLUS] WARN: ${message}`, meta);
  writeLog(entry);
}

async function sendAlert(message, meta = {}) {
  logError(message, meta);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, meta }),
    });
  } catch (err) {
    logError('Alert webhook failed', { error: err.message });
  }
}

module.exports = {
  LOG_DIR,
  writeLog,
  logInfo,
  logError,
  logWarn,
  sendAlert,
};
