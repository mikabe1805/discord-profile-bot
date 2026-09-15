import { EmbedBuilder } from 'discord.js';
import { safeDisplayText } from './domain.js';
import { summarizeBoundaries } from './modules/boundaries/embed.js';

const EMBED_LIMITS = Object.freeze({
  title: 256,
  description: 4_096,
  fieldName: 256,
  fieldValue: 1_024,
  footer: 2_048,
});

function colorFromTheme(theme) {
  const value = theme?.primary_color || theme?.primaryColor;
  if (typeof value !== 'string') return 0x786752;
  const match = value.trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? Number.parseInt(match[1], 16) : 0x786752;
}

function avatarFor(member, user, fallback) {
  return member?.displayAvatarURL?.({ extension: 'png', size: 256 })
    || member?.user?.displayAvatarURL?.({ extension: 'png', size: 256 })
    || user?.displayAvatarURL?.({ extension: 'png', size: 256 })
    || fallback
    || null;
}

function nameFor(member, user, fallback) {
  return safeDisplayText(member?.displayName || user?.globalName || user?.username || fallback || 'Member', {
    maxLength: EMBED_LIMITS.title,
    fallback: 'Member',
  });
}

function imagePayload(image) {
  if (!image) return { imageUrl: null, files: [] };
  if (typeof image === 'string') return { imageUrl: image.startsWith('attachment://') || /^https?:\/\//i.test(image) ? image : null, files: [] };

  const attachment = image.attachment || image.path;
  const name = safeDisplayText(image.name || 'profile-image', { maxLength: 96, fallback: 'profile-image' })
    .replace(/[\\/:*?"<>|]/g, '-');
  if (!attachment) return { imageUrl: null, files: [] };
  return { imageUrl: `attachment://${name}`, files: [{ attachment, name }] };
}

function compactTags(tags) {
  const names = (Array.isArray(tags) ? tags : [])
    .map((tag) => typeof tag === 'string' ? tag : tag?.display_name || tag?.displayName || tag?.tag_slug)
    .filter(Boolean)
    .map((name) => safeDisplayText(name, { maxLength: 80 }))
    .filter(Boolean);
  if (!names.length) return 'No interests added yet.';
  const shown = names.slice(0, 18);
  const text = shown.join(' · ');
  const suffix = names.length > shown.length ? ` · +${names.length - shown.length} more` : '';
  return safeDisplayText(`${text}${suffix}`, { maxLength: EMBED_LIMITS.fieldValue, fallback: 'No interests added yet.' });
}

/**
 * Build the compact member card used by profile view, sharing, and discovery. Local
 * images are supplied as an attachment descriptor so they never depend on an expiring
 * Discord CDN URL.
 */
export function buildProfilePayload({
  profile = {},
  tags = [],
  theme = null,
  boundaries = null,
  member = null,
  user = null,
  displayName = null,
  avatarUrl = null,
  profileImage = undefined,
  includeStatus = true,
} = {}) {
  const name = nameFor(member, user, displayName);
  const avatar = avatarFor(member, user, avatarUrl);
  const { imageUrl, files } = imagePayload(profileImage === undefined ? profile?.profile_image : profileImage);
  const fields = [];
  const about = safeDisplayText(profile?.bio, { maxLength: EMBED_LIMITS.fieldValue });
  if (about) fields.push({ name: 'About', value: about, inline: false });
  if (profile?.pronouns) fields.push({ name: 'Pronouns', value: safeDisplayText(profile.pronouns, { maxLength: EMBED_LIMITS.fieldValue }), inline: true });
  if (profile?.open_to) fields.push({ name: 'Open to', value: safeDisplayText(profile.open_to, { maxLength: EMBED_LIMITS.fieldValue }), inline: true });
  const interestLabel = theme?.tags_emoji
    ? `${safeDisplayText(theme.tags_emoji, { maxLength: 8 })} Interests`
    : 'Interests';
  fields.push({ name: interestLabel, value: compactTags(tags), inline: false });
  if (boundaries) fields.push({ name: 'Interaction notes (optional)', value: summarizeBoundaries(boundaries), inline: false });

  const status = includeStatus
    ? `Directory: ${profile?.discoverable ? 'visible' : 'private'} · Requests: ${profile?.allow_requests ? 'open' : 'closed'}`
    : null;
  const embed = new EmbedBuilder()
    .setColor(colorFromTheme(theme))
    .setAuthor({ name: safeDisplayText(`${name}’s profile`, { maxLength: EMBED_LIMITS.title }), iconURL: avatar || undefined })
    .addFields(fields);
  if (theme?.title) embed.setTitle(safeDisplayText(theme.title, { maxLength: EMBED_LIMITS.title }));
  if (status) embed.setFooter({ text: safeDisplayText(status, { maxLength: EMBED_LIMITS.footer }) });
  if (imageUrl) embed.setImage(imageUrl);
  else if (avatar) embed.setThumbnail(avatar);

  return files.length ? { embeds: [embed], files } : { embeds: [embed] };
}

export { EMBED_LIMITS };
