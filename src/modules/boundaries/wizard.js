import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

const TTL = 20 * 60 * 1000;
const SECTIONS = {
  contact: ['new_dms', 'heavy_topics'], humor: ['teasing', 'dark_jokes'],
  personal: ['identity_comments', 'emotional_topics'], conversation: ['debate', 'unsolicited_advice'],
  feedback: ['critique', 'public_tags'], responses: ['response_preference'], other: ['notes']
};
const LABEL = { contact: 'Contact', humor: 'Humor', personal: 'Personal topics', conversation: 'Conversation', feedback: 'Feedback', responses: 'Response preferences', other: 'Other notes', new_dms: 'New DMs', heavy_topics: 'Heavy topics', teasing: 'Teasing or sarcasm', dark_jokes: 'Dark jokes', identity_comments: 'Identity or background comments', emotional_topics: 'Emotional topics', debate: 'Debate', unsolicited_advice: 'Unsolicited advice', critique: 'Critique', public_tags: 'Public tags', response_preference: 'When something misses the mark' };
const FIELDS = Object.values(SECTIONS).flat().filter(k => !['notes', 'response_preference'].includes(k));
const PRESETS = { open: Object.fromEntries(FIELDS.map(k => [k, 'comfortable'])), ask: Object.fromEntries(FIELDS.map(k => [k, 'ask_first'])), lowkey: Object.fromEntries(FIELDS.map(k => [k, 'not_comfortable'])) };
const clone = value => JSON.parse(JSON.stringify(value || {}));
const id = i => `${i.guildId}:${i.user.id}`;
const values = [{ label: 'Comfortable', value: 'comfortable', emoji: '🙂' }, { label: 'Ask first', value: 'ask_first', emoji: '💬' }, { label: 'Not comfortable', value: 'not_comfortable', emoji: '⛔' }];

function normalize(data) {
  const source = clone(data); const out = {};
  const old = { 'dms.unsolicited': 'new_dms', 'dms.casual': 'new_dms', 'humor.sarcasm': 'teasing', 'humor.edgy': 'dark_jokes', 'identity.comments': 'identity_comments', 'identity.culture': 'identity_comments', 'emotional.heavy_dm': 'heavy_topics', 'emotional.light_public': 'emotional_topics', 'debate.casual': 'debate', 'debate.devils': 'debate', 'feedback.critique': 'critique', 'feedback.public_tag': 'public_tags' };
  for (const [path, field] of Object.entries(old)) { const [section, key] = path.split('.'); if (source?.[section]?.[key] !== undefined && out[field] === undefined) out[field] = oldValue(source[section][key]); }
  for (const field of [...FIELDS, 'response_preference', 'notes']) if (source[field] !== undefined) out[field] = oldValue(source[field]);
  if (!out.notes) out.notes = Object.values(source).find(v => v && typeof v === 'object' && (v.notes || v.text))?.notes || Object.values(source).find(v => v && typeof v === 'object' && v.text)?.text;
  return out;
}
function oldValue(value) { return value === 'yes' ? 'comfortable' : value === 'ask' ? 'ask_first' : value === 'no' ? 'not_comfortable' : value; }
function sectionFor(field) { return Object.entries(SECTIONS).find(([, fields]) => fields.includes(field))?.[0] || 'other'; }
async function reply(i, content) { return (i.replied || i.deferred) ? i.followUp({ content, flags: 64 }) : i.reply({ content, flags: 64 }); }

export function createBoundariesController({ store, now = () => Date.now() }) {
  const drafts = new Map();
  const current = interaction => {
    const draft = drafts.get(id(interaction));
    if (!draft || now() - draft.startedAt > TTL) { drafts.delete(id(interaction)); return null; }
    return draft;
  };
  const controls = owner => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bdry:save:${owner}`).setStyle(ButtonStyle.Success).setLabel('Save'), new ButtonBuilder().setCustomId(`bdry:cancel:${owner}`).setStyle(ButtonStyle.Secondary).setLabel('Cancel'));
  const hub = owner => [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('bdry:preset').setPlaceholder('Optional starting point').addOptions([{ label: 'Open', value: 'open' }, { label: 'Ask first', value: 'ask' }, { label: 'Low-key', value: 'lowkey' }])),
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('bdry:section').setPlaceholder('Choose a section').addOptions(Object.keys(SECTIONS).map(value => ({ label: LABEL[value], value })))),
    controls(owner)
  ];
  async function startEdit(interaction, { preset } = {}) {
    const saved = await store.getBoundaries(interaction.guildId, interaction.user.id);
    const draft = {
      ownerId: interaction.user.id,
      startedAt: now(),
      data: preset ? clone(PRESETS[preset] || {}) : normalize(saved?.data || saved || {}),
      privacy: saved ? { level: saved.privacy_level, roleId: saved.privacy_role_id } : undefined,
    };
    drafts.set(id(interaction), draft);
    await interaction.reply({ content: 'Your interaction notes stay private until you press Save. Choose only what helps people treat you well; blanks are okay.', components: hub(draft.ownerId), flags: 64 });
  }
  async function handleComponent(interaction) {
    const draft = current(interaction);
    const [, action, ownerId, field] = interaction.customId.split(':');
    if (!draft) return reply(interaction, 'This editing session expired. Run `/boundaries edit` to start again.');
    if (ownerId && ownerId !== interaction.user.id) return reply(interaction, 'That control belongs to someone else’s draft.');
    if (action === 'preset') { draft.data = clone(PRESETS[interaction.values?.[0]] || {}); return interaction.update({ content: 'Preset added to your unsaved draft. You can change anything below.', components: hub(draft.ownerId) }); }
    if (action === 'section') return showSection(interaction, draft, interaction.values?.[0]);
    if (action === 'value') { draft.data[field] = interaction.values?.[0]; return showSection(interaction, draft, sectionFor(field)); }
    if (action === 'notes') return notes(interaction, draft);
    if (action === 'save') { await store.saveBoundaries(interaction.guildId, interaction.user.id, clone(draft.data), draft.privacy); drafts.delete(id(interaction)); return interaction.update({ content: 'Saved. Thanks for making the kind of interaction you want clearer.', components: [], embeds: [] }); }
    if (action === 'cancel') { drafts.delete(id(interaction)); return interaction.update({ content: 'Discarded your unsaved changes.', components: [], embeds: [] }); }
  }
  async function handleModal(interaction) {
    const draft = current(interaction); const [, action, ownerId] = interaction.customId.split(':');
    if (action !== 'notes' || !draft || ownerId !== interaction.user.id) return reply(interaction, 'This editing session is no longer active.');
    draft.data.notes = (interaction.fields.getTextInputValue('bdry:notes:text') || '').slice(0, 200);
    await interaction.reply({ content: 'Added to your unsaved draft. Choose Save when you are ready.', flags: 64 });
  }
  async function showSection(interaction, draft, section) {
    const rows = (SECTIONS[section] || []).filter(k => k !== 'notes').map(field => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`bdry:value:${draft.ownerId}:${field}`).setPlaceholder(LABEL[field]).addOptions(values)));
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bdry:notes:${draft.ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Add a note')));
    rows.push(controls(draft.ownerId));
    await interaction.update({ content: `${LABEL[section] || 'Notes'} — blanks mean no preference was shared.`, components: rows, embeds: [] });
  }
  async function notes(interaction, draft) {
    const input = new TextInputBuilder().setCustomId('bdry:notes:text').setLabel('Anything else people should know?').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200);
    if (draft.data.notes) input.setValue(draft.data.notes);
    await interaction.showModal(new ModalBuilder().setCustomId(`bdry:notes:${draft.ownerId}`).setTitle('Other notes').addComponents(new ActionRowBuilder().addComponents(input)));
  }
  return { startEdit, handleComponent, handleModal, hasActiveDraft: interaction => Boolean(current(interaction)) };
}
