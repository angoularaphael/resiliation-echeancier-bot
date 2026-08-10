/**
 * Stocke les champs checkout (salle, IBAN, DOB…) envoyés par le JS du thème PrestaShop.
 */
const fs = require('fs');
const path = require('path');
const { ROOT, ensureDir } = require('./utils');
const { isValidGymSlug } = require('./gym-slugs');
const { normalizeIban, isValidFrenchIban } = require('./iban');

const STORE_DIR = path.join(ROOT, 'data', 'prestashop');
const STORE_FILE = path.join(STORE_DIR, 'checkout-by-cart.json');

function loadStore() {
  ensureDir(STORE_DIR);
  if (!fs.existsSync(STORE_FILE)) {
    return { carts: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return { carts: {} };
  }
}

function saveStore(data) {
  ensureDir(STORE_DIR);
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function saveCheckoutForCart(cartId, payload = {}) {
  const id = String(cartId || '').trim();
  if (!id) throw new Error('cart_id requis');

  const data = loadStore();
  const prev = data.carts[id] || {};
  const gym = payload.gym ? String(payload.gym).trim() : prev.gym;
  const iban = payload.iban ? normalizeIban(payload.iban) : prev.iban;

  if (gym && !isValidGymSlug(gym)) {
    throw new Error(`Salle invalide: ${gym}`);
  }
  if (iban && !isValidFrenchIban(iban)) {
    throw new Error('IBAN français invalide');
  }

  data.carts[id] = {
    gym: gym || null,
    iban: iban || null,
    birthdate: payload.birthdate || prev.birthdate || null,
    gender: payload.gender || prev.gender || null,
    updated_at: new Date().toISOString(),
  };
  saveStore(data);
  return data.carts[id];
}

function getCheckoutForCart(cartId) {
  const id = String(cartId || '').trim();
  if (!id) return null;
  const data = loadStore();
  return data.carts[id] || null;
}

function removeCheckoutForCart(cartId) {
  const id = String(cartId || '').trim();
  if (!id) return;
  const data = loadStore();
  delete data.carts[id];
  saveStore(data);
}

module.exports = {
  saveCheckoutForCart,
  getCheckoutForCart,
  removeCheckoutForCart,
  STORE_FILE,
};
