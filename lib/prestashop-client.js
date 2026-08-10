/**
 * Client PrestaShop Webservice (JSON) — lecture commandes, clients, messages.
 */
const { logWarn } = require('./logger');

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

class PrestaShopClient {
  constructor({ baseUrl, apiKey, timeoutMs = 15000 } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    if (!this.baseUrl || !this.apiKey) {
      throw new Error('PRESTASHOP_URL et PRESTASHOP_API_KEY requis');
    }
  }

  authHeader() {
    const token = Buffer.from(`${this.apiKey}:`).toString('base64');
    return `Basic ${token}`;
  }

  async request(path, { query = {} } = {}) {
    const params = new URLSearchParams({ output_format: 'JSON', ...query });
    const url = `${this.baseUrl}/api/${path}?${params}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: this.authHeader(),
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`PrestaShop API ${res.status} ${path}: ${text.slice(0, 160)}`);
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`PrestaShop API réponse non-JSON (${path})`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async getResource(type, id, { display = 'full' } = {}) {
    const data = await this.request(`${type}/${id}`, { display });
    return data[type] || data;
  }

  async listResource(type, { filter = {}, sort = null, limit = 50, display = 'full' } = {}) {
    const query = { display, limit: String(limit) };
    for (const [key, value] of Object.entries(filter)) {
      query[`filter[${key}]`] = value;
    }
    if (sort) query.sort = sort;

    const data = await this.request(type, query);
    return asArray(data[type]);
  }

  async getOrdersSince(minId, { paidStateIds = [], limit = 50 } = {}) {
    const filter = minId > 0 ? { id: `[>${minId}]` } : {};
    let orders = await this.listResource('orders', {
      filter,
      sort: '[id_ASC]',
      limit,
      display: 'full',
    });

    if (paidStateIds.length) {
      const allowed = new Set(paidStateIds.map(String));
      orders = orders.filter((o) => allowed.has(String(o.current_state)));
    }

    return orders;
  }

  async getCustomer(id) {
    if (!id) return null;
    try {
      return await this.getResource('customers', id, { display: 'full' });
    } catch (err) {
      logWarn('PrestaShop client introuvable', { id, error: err.message });
      return null;
    }
  }

  async getAddress(id) {
    if (!id) return null;
    try {
      return await this.getResource('addresses', id, { display: 'full' });
    } catch (err) {
      logWarn('PrestaShop adresse introuvable', { id, error: err.message });
      return null;
    }
  }

  async getMessagesByCart(cartId) {
    if (!cartId) return [];
    const rows = await this.listResource('messages', {
      filter: { id_cart: `[=${cartId}]` },
      display: 'full',
      limit: 20,
    });
    return rows.map((r) => r.message).filter(Boolean);
  }

  async getMessagesByOrder(orderId) {
    if (!orderId) return [];
    const rows = await this.listResource('messages', {
      filter: { id_order: `[=${orderId}]` },
      display: 'full',
      limit: 20,
    });
    return rows.map((r) => r.message).filter(Boolean);
  }
}

function createPrestaShopClientFromEnv() {
  const baseUrl = process.env.PRESTASHOP_URL;
  const apiKey = process.env.PRESTASHOP_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return new PrestaShopClient({ baseUrl, apiKey });
}

module.exports = {
  PrestaShopClient,
  createPrestaShopClientFromEnv,
  asArray,
};
