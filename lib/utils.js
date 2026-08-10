const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadJson(relativePath, { optional = false } = {}) {
  const full = path.join(ROOT, relativePath);
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    if (optional || (process.env.VERCEL && err.code === 'ENOENT')) {
      return null;
    }
    throw err;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  const scale = Number(
    process.env.BOT_DELAY_SCALE != null && process.env.BOT_DELAY_SCALE !== ''
      ? process.env.BOT_DELAY_SCALE
      : process.env.DECIPLUS_FAST === '1'
        ? 0.3
        : 0.5
  );
  let min = Number(minMs);
  let max = Number(maxMs);
  if (!Number.isFinite(min)) min = Number(process.env.BOT_MIN_DELAY_MS) || 150;
  if (!Number.isFinite(max)) max = Number(process.env.BOT_MAX_DELAY_MS) || 400;
  min = Math.max(40, Math.round(min * (Number.isFinite(scale) ? scale : 0.5)));
  max = Math.max(min + 40, Math.round(max * (Number.isFinite(scale) ? scale : 0.5)));
  const ms = min + Math.floor(Math.random() * (max - min + 1));
  return sleep(ms);
}

function redactHeaders(headers) {
  const copy = { ...headers };
  for (const key of Object.keys(copy)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower.includes('token')) {
      copy[key] = '[REDACTED]';
    }
  }
  return copy;
}

function safeParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(value, max = 4000) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

module.exports = {
  ROOT,
  loadJson,
  ensureDir,
  timestamp,
  sleep,
  randomDelay,
  redactHeaders,
  safeParseJson,
  truncate,
};
