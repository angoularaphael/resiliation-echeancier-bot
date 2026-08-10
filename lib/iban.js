/**
 * Validation IBAN français (obligatoire pour prélèvements Deciplus / Nuapay).
 */
function normalizeIban(raw) {
  return String(raw || '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function isValidFrenchIban(iban) {
  const value = normalizeIban(iban);
  if (!/^FR[0-9]{25}$/.test(value)) return false;

  // MOD-97 check
  const rearranged = value.slice(4) + value.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < expanded.length; i += 7) {
    remainder = Number(String(remainder) + expanded.slice(i, i + 7)) % 97;
  }
  return remainder === 1;
}

module.exports = { normalizeIban, isValidFrenchIban };
