/**
 * PrestaShop order → payload BOXPLUS (même format que boutique / webhook).
 */
const { asArray } = require('./prestashop-client');
const { extractGymFromTexts, extractIbanFromTexts } = require('./gym-slugs');
const { normalizeGender } = require('./normalize');

function orderRows(order) {
  const rows = order?.associations?.order_rows?.order_row;
  return asArray(rows);
}

function addressTexts(address) {
  if (!address) return [];
  return ['alias', 'company', 'address1', 'address2', 'other', 'city']
    .map((field) => address[field])
    .filter(Boolean)
    .map(String);
}

function productTexts(rows) {
  const texts = [];
  for (const row of rows) {
    for (const field of ['product_name', 'product_reference', 'product_attribute_name']) {
      if (row[field]) texts.push(String(row[field]));
    }
  }
  return texts;
}

function mapPrestaShopOrder(order, { customer, address, messages = [], checkoutExtra = null } = {}) {
  const rows = orderRows(order);
  const main = rows[0] || {};
  const cartId = order.id_cart ? String(order.id_cart) : null;

  const messageTexts = [
    ...messages,
    order.gift_message,
    order.note,
    ...addressTexts(address),
    ...productTexts(rows),
  ].filter(Boolean);

  const gym =
    (checkoutExtra?.gym && String(checkoutExtra.gym)) ||
    extractGymFromTexts(messageTexts, process.env.PRESTASHOP_DEFAULT_GYM || 'minimes');

  const iban =
    checkoutExtra?.iban ||
    extractIbanFromTexts(messageTexts);

  const gender = normalizeGender(checkoutExtra?.gender);
  const birthdate = checkoutExtra?.birthdate || null;

  return {
    action: 'sale',
    order_id: `PS-${order.id}`,
    product_name: main.product_name || null,
    product_reference: main.product_reference || null,
    gym,
    customer: {
      first_name: customer?.firstname || customer?.first_name || '',
      last_name: customer?.lastname || customer?.last_name || '',
      email: customer?.email || '',
      phone: address?.phone_mobile || address?.phone || customer?.phone || '',
      birthdate,
      gender,
      address: address?.address1 || null,
      postal_code: address?.postcode || null,
      city: address?.city || null,
      country: address?.country || 'FR',
    },
    payment: {
      amount: Number(order.total_paid_tax_incl || order.total_paid || 0),
      method: order.payment || 'prestashop',
      status: 'paid',
      date: order.date_add || new Date().toISOString(),
      iban,
    },
    utm: {},
    source: 'prestashop',
    prestashop: {
      id: Number(order.id),
      id_cart: cartId,
      current_state: order.current_state,
    },
  };
}

module.exports = {
  mapPrestaShopOrder,
  orderRows,
};
