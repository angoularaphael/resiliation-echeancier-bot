/**
 * Slugs salles — alignés sur config/gym-mapping.json et checkout boutique.
 */
const GYM_SLUGS = ['st-cyprien', 'minimes', 'ramonville', 'portet', 'etats-unis', 'balma'];

const GYM_LABELS = {
  'st-cyprien': ['st-cyprien', 'st cyprien', 'saint-cyprien', 'saint cyprien', 'boxing center st-cyprien', 'boxing center st cyprien'],
  minimes: ['minimes', 'boxing center minimes'],
  ramonville: ['ramonville', 'boxing center ramonville'],
  portet: ['portet', 'portet-sur-garonne', 'boxing center portet'],
  'etats-unis': ['etats-unis', 'etats unis', 'boxing center etats-unis', 'boxing center etats unis'],
  balma: ['balma', 'boxing center balma'],
};

function stripAccents(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeGymText(raw) {
  let text = stripAccents(String(raw || '').toLowerCase().trim().replace(/<[^>]+>/g, ''));
  text = text.replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.includes(' ') && !text.includes('-')) {
    return text.replace(/\s+/g, '-');
  }
  return text;
}

function isValidGymSlug(slug) {
  return GYM_SLUGS.includes(String(slug));
}

function matchGymLabel(text) {
  const normalized = normalizeGymText(text);
  if (!normalized) return null;

  for (const [slug, aliases] of Object.entries(GYM_LABELS)) {
    for (const alias of aliases) {
      if (normalized === alias || normalized.includes(alias)) {
        return slug;
      }
    }
  }
  return null;
}

function matchGymSlug(raw) {
  const text = normalizeGymText(raw);
  if (!text) return null;
  if (isValidGymSlug(text)) return text;

  const explicit = text.match(/(?:gym|salle)\s*[:=]\s*([a-z0-9][a-z0-9-]*)/i);
  if (explicit) {
    const slug = normalizeGymText(explicit[1]);
    if (isValidGymSlug(slug)) return slug;
    const fromLabel = matchGymLabel(slug);
    if (fromLabel) return fromLabel;
  }

  return matchGymLabel(text);
}

function extractGymFromTexts(texts, defaultGym = 'minimes') {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const raw of list) {
    const slug = matchGymSlug(raw);
    if (slug) return slug;
  }
  const fallback = normalizeGymText(defaultGym);
  return isValidGymSlug(fallback) ? fallback : 'minimes';
}

function extractIbanFromTexts(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const raw of list) {
    const compact = String(raw || '').replace(/\s+/g, '').toLowerCase();
    const match = compact.match(/fr\d{2}[a-z0-9]{23}/i);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

module.exports = {
  GYM_SLUGS,
  GYM_LABELS,
  normalizeGymText,
  isValidGymSlug,
  matchGymSlug,
  matchGymLabel,
  extractGymFromTexts,
  extractIbanFromTexts,
};
