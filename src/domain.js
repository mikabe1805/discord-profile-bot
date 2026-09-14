const MASS_MENTION = /@(everyone|here)\b/gi;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Convert a human interest name into the stable key stored in the directory. */
export function normalizeInterestSlug(value, { maxLength = 64 } = {}) {
  if (typeof value !== 'string') return '';
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized.slice(0, Math.max(1, maxLength)).replace(/-+$/g, '');
}

/** Parse the comma-separated form used by the command UI into unique interest slugs. */
export function parseInterests(value, { max = 10, maxLength = 64 } = {}) {
  if (typeof value !== 'string' || max <= 0) return [];
  const seen = new Set();
  for (const part of value.split(',')) {
    const slug = normalizeInterestSlug(part, { maxLength });
    if (slug) seen.add(slug);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * Keep member-authored text readable without allowing it to create a mass mention or
 * inject control characters into a Discord payload.
 */
export function safeDisplayText(value, { maxLength = 1024, fallback = '' } = {}) {
  if (value == null) return fallback;
  const cleaned = String(value)
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(MASS_MENTION, '@\u200b$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * Determine whether a boundary card is visible. This deliberately has no moderator
 * override: the owner chooses the audience.
 */
export function canViewBoundaries({
  ownerId,
  viewerId,
  privacyLevel = 'private',
  privacyRoleId = null,
  viewerRoleIds = [],
  viewerIsMember = true,
} = {}) {
  if (!ownerId || !viewerId) return false;
  if (ownerId === viewerId) return true;

  const level = privacyLevel === 'everyone' ? 'members'
    : privacyLevel === 'friends' ? 'private'
      : privacyLevel;
  if (level === 'members') return Boolean(viewerIsMember);
  if (level === 'role') return Boolean(viewerIsMember)
    && Boolean(privacyRoleId)
    && Array.isArray(viewerRoleIds)
    && viewerRoleIds.includes(privacyRoleId);
  return false;
}
