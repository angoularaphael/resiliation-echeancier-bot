/**
 * Deciplus bloque une 2e fiche si nom + prénom + naissance + adresse
 * sont identiques. Sur le doublon Minimes on suffixe le prénom avec « Balma ».
 */

function parseGymAddress(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(.+?),\s*(\d{5})\s+(.+)$/);
  if (!m) return null;
  return { address: m[1].trim(), postal_code: m[2], city: m[3].trim() };
}

function appendBalmaToFirstName(firstName) {
  const raw = String(firstName || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return 'Balma';
  if (/(^|\s)balma$/i.test(raw)) return raw;
  return `${raw} Balma`;
}

function applyMinimesDuplicateIdentity(customer = {}) {
  return {
    ...customer,
    first_name: appendBalmaToFirstName(customer.first_name),
    email: '',
    phone: '',
  };
}

function applyMinimesAddressForDuplicate(customer = {}, gymConfig = {}) {
  const parsed =
    parseGymAddress(gymConfig.address) || {
      address: '12 rue de Fenouillet',
      postal_code: '31200',
      city: 'Toulouse',
    };
  return {
    ...applyMinimesDuplicateIdentity(customer),
    address: parsed.address,
    postal_code: parsed.postal_code,
    city: parsed.city,
    address2: customer.address2 || gymConfig.label || 'Boxing Center Minimes',
  };
}

function identityAddressLine(customer = {}) {
  return [customer.address, customer.postal_code, customer.city]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function duplicateAddressDiffers(balmaCustomer, minimesCustomer) {
  return identityAddressLine(balmaCustomer) !== identityAddressLine(minimesCustomer);
}

module.exports = {
  parseGymAddress,
  appendBalmaToFirstName,
  applyMinimesDuplicateIdentity,
  applyMinimesAddressForDuplicate,
  identityAddressLine,
  duplicateAddressDiffers,
};
