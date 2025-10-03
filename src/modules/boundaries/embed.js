import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const OPTION_EMOJI = {
  yes: '✅',
  ask: '⚠️',
  no: '⛔'
};

const SECTION_LABELS = {
  dms: 'DMs & Contact',
  humor: 'Humor & Tone',
  identity: 'Identity & Background',
  emotional: 'Emotional Topics',
  debate: 'Debate & Conflict',
  feedback: 'Feedback & Criticism',
  responses: 'Boundary Responses',
  misc: 'Anything Else?'
};

function summarizeSection(sectionKey, data) {
  const s = data?.[sectionKey] || {};
  const lines = [];
  const add = (label, key) => {
    const v = s[key];
    if (!v) return;
    lines.push(`${label}: ${mapValue(v)}`);
  };
  switch (sectionKey) {
    case 'dms':
      add('Unsolicited DMs', 'unsolicited');
      add('1:1 casual chat', 'casual');
      break;
    case 'humor':
      add('Sarcasm/teasing', 'sarcasm');
      add('Edgy/dark jokes', 'edgy');
      add('“Claiming” bigotry jokes', 'claiming');
      break;
    case 'identity':
      add('Comments on identity', 'comments');
      add('Country/culture discussion', 'culture');
      break;
    case 'emotional':
      add('Light venting in public', 'light_public');
      // heavy_public fixed to no
      add('Receive heavy topics in DMs', 'heavy_dm');
      break;
    case 'debate':
      add('Casual debate in general', 'casual');
      add('Devil’s advocate on my posts', 'devils');
      if (s.tone) lines.push(`Tone: ${toneLabel(s.tone)}`);
      break;
    case 'feedback':
      add('Unsolicited critique', 'critique');
      add('Public @ for feedback', 'public_tag');
      break;
    case 'responses':
      const resp = Array.isArray(s.actions) ? s.actions : [];
      if (resp.length) lines.push(`If crossed: ${resp.map(r => responseLabel(r)).join(' • ')}`);
      break;
    case 'misc':
      if (s.text) lines.push(s.text);
      break;
  }
  const note = s.notes ? ` — ${s.notes}` : '';
  return lines.length ? `${lines.join(' • ')}${note}` : (s.notes ? s.notes : '*No preferences set*');
}

function toneLabel(v) {
  if (v === 'calm') return 'Calm only';
  if (v === 'spirited') return 'Spirited is okay';
  return 'Avoid debate with me';
}

function responseLabel(v) {
  if (v === 'speak') return 'Speak to the person directly';
  if (v === 'disengage') return 'Quietly disengage';
  if (v === 'mod') return 'Contact a moderator myself';
  return v;
}

function mapValue(v) {
  if (v === 'yes') return `${OPTION_EMOJI.yes}`;
  if (v === 'ask') return `${OPTION_EMOJI.ask}`;
  if (v === 'no') return `${OPTION_EMOJI.no}`;
  return v;
}

export async function buildBoundariesEmbed({ guild, viewerId, ownerId, data, detailed = false }) {
  const color = 0x5865F2;

  // enforce rules
  if (!data?.emotional) data.emotional = {};
  data.emotional.heavy_public = 'no';

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Boundaries Card', iconURL: guild?.iconURL?.() || undefined })
    .setColor(color)
    .setFooter({ text: ownerId === viewerId ? 'You can edit this via /boundaries set' : 'Respect others’ boundaries' })
    .setTimestamp();

  // Compact fields by default
  const sections = ['dms','humor','identity','emotional','debate','feedback','responses','misc'];
  const fields = sections.map(key => ({
    name: sectionLabel(key),
    value: summarizeSection(key, data).slice(0, 1024),
    inline: false
  }));

  embed.addFields(fields.slice(0, detailed ? fields.length : Math.min(4, fields.length)));
  if (!detailed && fields.length > 4) {
    embed.addFields({ name: 'More…', value: 'Use the button below to toggle details', inline: false });
  }

  const rows = [];
  const toggle = new ButtonBuilder()
    .setCustomId(`bdry:toggle:${ownerId}:${detailed ? '1' : '0'}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(detailed ? 'Hide details' : 'Toggle details');
  rows.push(new ActionRowBuilder().addComponents(toggle));

  const reportChan = process.env.BOUNDARIES_REPORT_CHANNEL_ID;
  if (reportChan) {
    const report = new ButtonBuilder()
      .setCustomId(`bdry:report:${ownerId}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Report misuse');
    rows.push(new ActionRowBuilder().addComponents(report));
  }

  return { embeds: [embed], components: rows };
}

function sectionLabel(key) {
  return `• ${SECTION_LABELS[key] || key}`;
}


