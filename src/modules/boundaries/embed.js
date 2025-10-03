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

const ITEM_HELP = {
  // DMs
  unsolicited: 'Receiving unsolicited DMs',
  casual: 'Starting casual one-on-one chats',
  // Humor
  sarcasm: 'Sarcasm or playful teasing',
  edgy: 'Edgy/dark jokes (e.g., trauma, gore)',
  claiming: '“Claiming” bigotry as a joke (e.g., calling yourself racist/sexist ironically)',
  // Identity
  comments: 'Comments about my gender/sexuality/religion/ethnicity',
  culture: 'Critique/jokes about my country/region/culture',
  // Emotional
  light_public: 'Light venting in public spaces',
  heavy_public: 'Heavy trauma/sensitive topics in public spaces (always ⛔)',
  heavy_dm: 'Receiving heavy topics in DMs',
  // Debate
  casual_debate: 'Casual debate in general spaces',
  devils: '“Devil’s advocate” arguments on my posts',
  tone: 'Tone I’m comfortable with',
  // Feedback
  critique: 'Unsolicited critique of my work/ideas',
  public_tag: 'Publicly tagging me to ask for feedback',
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
      add(`${ITEM_HELP.unsolicited}`, 'unsolicited');
      add(`${ITEM_HELP.casual}`, 'casual');
      break;
    case 'humor':
      add(`${ITEM_HELP.sarcasm}`, 'sarcasm');
      add(`${ITEM_HELP.edgy}`, 'edgy');
      add(`${ITEM_HELP.claiming}`, 'claiming');
      break;
    case 'identity':
      add(`${ITEM_HELP.comments}`, 'comments');
      add(`${ITEM_HELP.culture}`, 'culture');
      break;
    case 'emotional':
      add(`${ITEM_HELP.light_public}`, 'light_public');
      // heavy_public fixed to no
      add(`${ITEM_HELP.heavy_dm}`, 'heavy_dm');
      break;
    case 'debate':
      add(`${ITEM_HELP.casual_debate}`, 'casual');
      add(`${ITEM_HELP.devils}`, 'devils');
      if (s.tone) lines.push(`${ITEM_HELP.tone}: ${toneLabel(s.tone)}`);
      break;
    case 'feedback':
      add(`${ITEM_HELP.critique}`, 'critique');
      add(`${ITEM_HELP.public_tag}`, 'public_tag');
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

export async function buildBoundariesEmbed({ guild, viewerId, ownerId, ownerName, ownerAvatarUrl, data, detailed = false }) {
  const color = 0x5865F2;

  // enforce rules
  if (!data?.emotional) data.emotional = {};
  data.emotional.heavy_public = 'no';

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${ownerName ? ownerName + ' — ' : ''}Boundaries Card`, iconURL: ownerAvatarUrl || guild?.iconURL?.() || undefined })
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


