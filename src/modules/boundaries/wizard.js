import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { upsertBoundaries, getBoundaries } from '../../db_sqlite.js';
import { buildBoundariesEmbed } from './embed.js';

const PRESETS = {
  chill: {
    dms: { unsolicited: 'yes', casual: 'yes' },
    humor: { sarcasm: 'yes', edgy: 'ask', claiming: 'no' },
    identity: { comments: 'ask', culture: 'ask' },
    emotional: { light_public: 'yes', heavy_public: 'no', heavy_dm: 'ask' },
    debate: { casual: 'yes', devils: 'ask', tone: 'spirited' },
    feedback: { critique: 'ask', public_tag: 'ask' }
  },
  ask: {
    dms: { unsolicited: 'ask', casual: 'ask' },
    humor: { sarcasm: 'ask', edgy: 'ask', claiming: 'no' },
    identity: { comments: 'ask', culture: 'ask' },
    emotional: { light_public: 'ask', heavy_public: 'no', heavy_dm: 'ask' },
    debate: { casual: 'ask', devils: 'ask', tone: 'calm' },
    feedback: { critique: 'ask', public_tag: 'ask' }
  },
  conservative: {
    dms: { unsolicited: 'no', casual: 'ask' },
    humor: { sarcasm: 'ask', edgy: 'no', claiming: 'no' },
    identity: { comments: 'no', culture: 'no' },
    emotional: { light_public: 'ask', heavy_public: 'no', heavy_dm: 'no' },
    debate: { casual: 'ask', devils: 'no', tone: 'calm' },
    feedback: { critique: 'ask', public_tag: 'no' }
  }
};

const VALUE_CHOICES = [
  { label: '✅ Comfortable', value: 'yes' },
  { label: '⚠️ Ask First', value: 'ask' },
  { label: '⛔ Not Comfortable', value: 'no' }
];

export async function startBoundariesWizard(interaction, { preset }) {
  const existing = await getBoundaries(interaction.guildId, interaction.user.id);
  const base = preset ? (PRESETS[preset] || {}) : (existing?.data || {});
  // enforce fixed rule on base
  if (!base.emotional) base.emotional = {};
  base.emotional.heavy_public = 'no';
  await upsertBoundaries(interaction.guildId, interaction.user.id, base);
  await interaction.reply({ content: 'Boundaries setup', flags: 64, components: [templateRow(preset), sectionPickerRow()], embeds: [], ephemeral: true });
}

function templateRow(selected) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('bdry:template')
    .setPlaceholder('Choose a template (optional)')
    .addOptions(
      { label: 'Start blank', value: 'blank', default: !selected },
      { label: '🧊 Chill', value: 'chill', default: selected === 'chill' },
      { label: '❓ Ask-First', value: 'ask', default: selected === 'ask' },
      { label: '🛡️ Conservative', value: 'conservative', default: selected === 'conservative' }
    );
  return new ActionRowBuilder().addComponents(menu);
}

function sectionPickerRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('bdry:section')
    .setPlaceholder('Pick a section to edit')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      { label: '1) DMs & Contact', value: 'dms' },
      { label: '2) Humor & Tone', value: 'humor' },
      { label: '3) Identity & Background', value: 'identity' },
      { label: '4) Emotional Topics', value: 'emotional' },
      { label: '5) Debate & Conflict', value: 'debate' },
      { label: '6) Feedback & Criticism', value: 'feedback' },
      { label: '7) Boundary Responses', value: 'responses' },
      { label: '8) Anything Else?', value: 'misc' }
    );
  const save = new ButtonBuilder().setCustomId('bdry:preview').setStyle(ButtonStyle.Primary).setLabel('Preview + Save');
  return new ActionRowBuilder().addComponents(menu, save);
}

export async function handleBoundariesComponent(interaction) {
  const [prefix, action, ...rest] = interaction.customId.split(':');
  if (action === 'template') {
    const choice = interaction.values?.[0];
    if (choice && choice !== 'blank') {
      const base = PRESETS[choice] || {};
      if (!base.emotional) base.emotional = {};
      base.emotional.heavy_public = 'no';
      await upsertBoundaries(interaction.guildId, interaction.user.id, base);
    } else {
      await upsertBoundaries(interaction.guildId, interaction.user.id, {});
    }
    await interaction.update({ content: choice === 'blank' ? 'Starting blank.' : `Preset applied: ${choice}`, components: [templateRow(choice), sectionPickerRow()] });
    return;
  }
  if (action === 'section') {
    const section = interaction.values?.[0];
    await showSection(interaction, section);
    return;
  }
  if (action === 'preview') {
    await previewAndSave(interaction);
    return;
  }
  if (action === 'toggle') {
    const ownerId = rest[0];
    const cur = rest[1] === '1';
    const entry = await getBoundaries(interaction.guildId, ownerId);
    const payload = await buildBoundariesEmbed({ guild: interaction.guild, viewerId: interaction.user.id, ownerId, data: entry?.data || {}, detailed: !cur });
    await interaction.update(payload);
    return;
  }
  if (action === 'report') {
    const ownerId = rest[0];
    const chanId = process.env.BOUNDARIES_REPORT_CHANNEL_ID;
    if (chanId) {
      const chan = interaction.guild.channels.cache.get(chanId) || await interaction.guild.channels.fetch(chanId).catch(() => null);
      if (chan) await chan.send(`Report: <@${interaction.user.id}> reported misuse on <@${ownerId}>'s Boundaries Card.`);
    }
    await interaction.reply({ content: '📨 Report submitted to moderators.', flags: 64 });
    return;
  }
}

async function showSection(interaction, section) {
  // Build section UI with selects/buttons and a notes button
  const rows = [];
  const askNotes = new ButtonBuilder().setCustomId(`bdry:notes:${section}`).setStyle(ButtonStyle.Secondary).setLabel('Add/Edit notes');
  if (section === 'dms') {
    rows.push(optionRow('bdry:set:dms:unsolicited', 'Receiving unsolicited DMs'));
    rows.push(optionRow('bdry:set:dms:casual', 'Starting casual 1-on-1'));
  } else if (section === 'humor') {
    rows.push(optionRow('bdry:set:humor:sarcasm', 'Sarcasm or teasing'));
    rows.push(optionRow('bdry:set:humor:edgy', 'Edgy/dark jokes'));
    rows.push(optionRowRestricted('bdry:set:humor:claiming', '“Claiming” bigotry jokes', [
      { label: '⚠️ Ask First', value: 'ask' },
      { label: '⛔ Not Comfortable', value: 'no' }
    ]));
  } else if (section === 'identity') {
    rows.push(optionRow('bdry:set:identity:comments', 'Comments on gender/sexuality/religion/ethnicity'));
    rows.push(optionRow('bdry:set:identity:culture', 'Country/region/culture discussion'));
  } else if (section === 'emotional') {
    rows.push(optionRow('bdry:set:emotional:light_public', 'Light venting in public'));
    // heavy_public fixed as no; do not render control
    rows.push(optionRow('bdry:set:emotional:heavy_dm', 'Receiving heavy topics in DMs'));
  } else if (section === 'debate') {
    rows.push(optionRow('bdry:set:debate:casual', 'Casual debate in general'));
    rows.push(optionRow('bdry:set:debate:devils', '“Devil’s advocate” on my posts'));
    rows.push(toneRow('bdry:set:debate:tone', 'Tone I’m comfortable with'));
  } else if (section === 'feedback') {
    rows.push(optionRow('bdry:set:feedback:critique', 'Unsolicited critique'));
    rows.push(optionRow('bdry:set:feedback:public_tag', 'Publicly @ me for feedback'));
  } else if (section === 'responses') {
    rows.push(responsesRow('bdry:set:responses:actions', 'If my boundaries are crossed, I usually…'));
  } else if (section === 'misc') {
    // Only notes
  }
  rows.push(new ActionRowBuilder().addComponents(askNotes));
  await interaction.update({ content: `Editing section: ${section}`, components: rows });
}

function optionRow(customId, label) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(label)
    .addOptions(VALUE_CHOICES);
  return new ActionRowBuilder().addComponents(menu);
}

function optionRowRestricted(customId, label, options) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(label)
    .addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}

function toneRow(customId, label) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(label)
    .addOptions(
      { label: 'Calm only', value: 'calm' },
      { label: 'Spirited is okay', value: 'spirited' },
      { label: 'Avoid debate with me', value: 'avoid' }
    );
  return new ActionRowBuilder().addComponents(menu);
}

function responsesRow(customId, label) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(label)
    .setMinValues(1)
    .setMaxValues(3)
    .addOptions(
      { label: 'Speak to the person directly', value: 'speak' },
      { label: 'Quietly disengage', value: 'disengage' },
      { label: 'Contact a moderator myself', value: 'mod' }
    );
  return new ActionRowBuilder().addComponents(menu);
}

export async function handleBoundariesModal(interaction) {
  const [_, action, section] = interaction.customId.split(':');
  if (action !== 'notes') return;
  const text = interaction.fields.getTextInputValue('bdry:notes:text')?.slice(0, 140) || '';
  const existing = (await getBoundaries(interaction.guildId, interaction.user.id))?.data || {};
  existing[section] = Object.assign({}, existing[section], { notes: text });
  await upsertBoundaries(interaction.guildId, interaction.user.id, existing);
  await interaction.reply({ content: 'Notes saved.', flags: 64 });
}

async function previewAndSave(interaction) {
  // Just show current stored data
  const entry = await getBoundaries(interaction.guildId, interaction.user.id);
  const payload = await buildBoundariesEmbed({ guild: interaction.guild, viewerId: interaction.user.id, ownerId: interaction.user.id, data: entry?.data || {}, detailed: true });
  // Add a save button
  await interaction.update(payload);
}

// Handle menu selections that set values or open notes modal
export async function handleBoundariesValue(interaction) {
  const parts = interaction.customId.split(':');
  // bdry:set:section:key OR bdry:set:responses:actions
  if (parts[1] !== 'set') return;
  const section = parts[2];
  const key = parts[3];
  const existing = (await getBoundaries(interaction.guildId, interaction.user.id))?.data || {};
  if (section === 'responses' && key === 'actions') {
    existing.responses = Object.assign({}, existing.responses, { actions: interaction.values });
  } else if (section === 'debate' && key === 'tone') {
    existing.debate = Object.assign({}, existing.debate, { tone: interaction.values?.[0] });
  } else {
    const v = interaction.values?.[0];
    if (section === 'humor' && key === 'claiming' && v === 'yes') {
      // Disallow opting into hate speech/slurs
      await interaction.deferUpdate();
      return;
    }
    // non-editable rule: hate speech opt-in not allowed → already enforced by absence
    if (section === 'emotional' && key === 'heavy_public') {
      // ignore attempts
    } else {
      existing[section] = Object.assign({}, existing[section], { [key]: v });
    }
  }
  // enforce fixed rule
  if (!existing.emotional) existing.emotional = {};
  existing.emotional.heavy_public = 'no';
  await upsertBoundaries(interaction.guildId, interaction.user.id, existing);
  await interaction.deferUpdate();
}

// Entry for all component interactions (selects/buttons)
export async function handleBoundariesComponentRouter(interaction) {
  const id = interaction.customId;
  if (id.startsWith('bdry:set:')) return handleBoundariesValue(interaction);
  if (id.startsWith('bdry:notes:')) return openNotesModal(interaction, id.split(':')[2]);
  return handleBoundariesComponent(interaction);
}

async function openNotesModal(interaction, section) {
  const modal = new ModalBuilder()
    .setCustomId(`bdry:notes:${section}`)
    .setTitle('Section notes (140 chars max)');
  const input = new TextInputBuilder()
    .setCustomId('bdry:notes:text')
    .setLabel('Notes')
    .setRequired(false)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(140);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}


