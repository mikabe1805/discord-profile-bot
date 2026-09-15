import { EmbedBuilder } from 'discord.js';
import { safeDisplayText } from '../../domain.js';

const labels = { new_dms: 'New DMs', heavy_topics: 'Heavy topics', teasing: 'Teasing or sarcasm', dark_jokes: 'Dark jokes', identity_comments: 'Identity or background comments', emotional_topics: 'Emotional topics', debate: 'Debate', unsolicited_advice: 'Unsolicited advice', critique: 'Critique', public_tags: 'Public tags', response_preference: 'Response preference' };
const groups = [['Contact', ['new_dms', 'heavy_topics']], ['Humor', ['teasing', 'dark_jokes']], ['Personal topics', ['identity_comments', 'emotional_topics']], ['Conversation', ['debate', 'unsolicited_advice']], ['Feedback', ['critique', 'public_tags']], ['Response preferences', ['response_preference']]];
const legacy = { 'dms.unsolicited': 'new_dms', 'dms.casual': 'new_dms', 'humor.sarcasm': 'teasing', 'humor.edgy': 'dark_jokes', 'identity.comments': 'identity_comments', 'identity.culture': 'identity_comments', 'emotional.heavy_dm': 'heavy_topics', 'emotional.light_public': 'emotional_topics', 'debate.casual': 'debate', 'debate.devils': 'debate', 'feedback.critique': 'critique', 'feedback.public_tag': 'public_tags' };
const map = v => v === 'yes' ? 'comfortable' : v === 'ask' ? 'ask_first' : v === 'no' ? 'not_comfortable' : v;
function normalize(data) { const out = {}; for (const [path, field] of Object.entries(legacy)) { const [s, k] = path.split('.'); if (data?.[s]?.[k] !== undefined && out[field] === undefined) out[field] = map(data[s][k]); } for (const key of Object.keys(labels)) if (data?.[key] !== undefined) out[key] = map(data[key]); out.notes = data?.notes || Object.values(data || {}).find(v => v && typeof v === 'object' && (v.notes || v.text))?.notes || Object.values(data || {}).find(v => v && typeof v === 'object' && v.text)?.text; return out; }
const display = v => v === 'comfortable' ? '🙂 Comfortable' : v === 'ask_first' ? '💬 Ask first' : v === 'not_comfortable' ? '⛔ Not comfortable' : String(v);

export function summarizeBoundaries(entry, { maxLength = 1024 } = {}) {
  const info = normalize(entry?.data || entry || {});
  const lines = [];
  for (const [groupName, keys] of groups) {
    const shared = keys
      .filter(key => info[key] !== undefined)
      .map(key => `${labels[key]}: ${display(info[key])}`);
    if (shared.length) lines.push(`**${groupName}** · ${shared.join(' · ')}`);
  }
  if (info.notes) lines.push(`**Other notes** · ${safeDisplayText(info.notes, { maxLength: 300 })}`);
  return safeDisplayText(lines.join('\n'), {
    maxLength,
    fallback: 'They have not filled in any optional interaction notes yet.',
  });
}

export function buildBoundariesEmbed({ owner, entry, compact = false, guild, viewerId, ownerId, ownerName, ownerAvatarUrl, data, detailed }) {
  const info = normalize(entry?.data || data || entry || {});
  const name = owner?.displayName || owner?.username || ownerName || 'Member';
  const iconURL = owner?.displayAvatarURL?.() || ownerAvatarUrl || guild?.iconURL?.();
  const fields = groups.map(([name, keys]) => ({ name, value: keys.filter(k => info[k] !== undefined).map(k => `${labels[k]}: ${display(info[k])}`).join('\n') || 'No preference shared', inline: false }));
  if (info.notes) fields.push({ name: 'Other notes', value: String(info.notes).slice(0, 1024), inline: false });
  const shown = compact || detailed === false ? fields.slice(0, 3) : fields;
  const embed = new EmbedBuilder().setColor(0x6f8060).setAuthor({ name: `${name}’s interaction notes`, iconURL: iconURL || undefined }).setDescription('An optional personal guide for kinder conversations. Please read it in good faith.').addFields(shown).setFooter({ text: ownerId === viewerId ? 'Edit from your /bio home.' : 'Preferences are not a debate.' });
  return { embeds: [embed], components: [] };
}
