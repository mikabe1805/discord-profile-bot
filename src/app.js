import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  FileUploadBuilder,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { createConnectionService } from './connections.js';
import { createBioBoardService } from './bio-board.js';
import { canViewBoundaries, normalizeInterestSlug, parseInterests, safeDisplayText } from './domain.js';
import { createGatherRsvpService, createGatherService } from './gather.js';
import { buildProfilePayload } from './profile-view.js';
import { buildBoundariesEmbed } from './modules/boundaries/embed.js';
import { createBoundariesController } from './modules/boundaries/wizard.js';
import { CARD_ART_PRESETS, getCardArtPreset, markerForCardArt, presetForCardArtMarker } from './profile-presets.js';
import { PROFILE_VIBES, getProfileVibe } from './profile-vibes.js';
import { STARTER_PACKS, getStarterPack } from './starter-packs.js';

const PRIVATE = MessageFlags.Ephemeral;
const NO_MENTIONS = Object.freeze({ parse: [], repliedUser: false });

function withNoMentions(payload) {
  return { ...(typeof payload === 'string' ? { content: payload } : payload), allowedMentions: NO_MENTIONS };
}

async function privateReply(interaction, payload) {
  const safe = withNoMentions(payload);
  if (interaction.deferred) return interaction.editReply(safe);
  if (interaction.replied) return interaction.followUp({ ...safe, flags: PRIVATE });
  return interaction.reply({ ...safe, flags: PRIVATE });
}

function titleFromSlug(slug) {
  return slug.split('-').filter(Boolean).map((word) => `${word[0]?.toUpperCase() || ''}${word.slice(1)}`).join(' ');
}

function preferenceRows(profile, ownerId, { hasBoard = false } = {}) {
  const toggle = (field, value, label) => new ButtonBuilder()
    .setCustomId(`pref:${field}:${value ? 0 : 1}:${ownerId}`)
    .setStyle(value ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setLabel(`${label}: ${value ? 'on' : 'off'}`);
  const rows = [new ActionRowBuilder().addComponents(
    toggle('discoverable', profile.discoverable, 'Directory'),
    toggle('allow_requests', profile.allow_requests, 'Requests'),
    toggle('allow_group_pings', profile.allow_group_pings, 'Group calls'),
  )];
  if (hasBoard) rows.push(new ActionRowBuilder().addComponents(
    toggle('publish_to_board', profile.publish_to_board, 'Show in Bio channel'),
  ));
  return rows;
}

function profileModal(profile, tags, ownerId) {
  const input = (id, label, maxLength, value, style = TextInputStyle.Short) => {
    const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(false).setMaxLength(maxLength);
    if (value) field.setValue(String(value).slice(0, maxLength));
    return new ActionRowBuilder().addComponents(field);
  };
  return new ModalBuilder()
    .setCustomId(`profile:edit:${ownerId}`)
    .setTitle('Your profile')
    .addComponents(
      input('bio', 'A little about you', 1000, profile?.bio, TextInputStyle.Paragraph),
      input('pronouns', 'Pronouns (optional)', 80, profile?.pronouns),
      input('open_to', 'What are you open to?', 200, profile?.open_to, TextInputStyle.Paragraph),
      input('interests', 'Interests, separated by commas', 2000, tags.map((tag) => tag.display_name).join(', ')),
    );
}

function quickProfileModal(ownerId) {
  const openTo = new TextInputBuilder()
    .setCustomId('open_to')
    .setLabel('What could someone talk to you about?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(200)
    .setPlaceholder('A game, project, hobby, or something you would like to do together');
  const about = new TextInputBuilder()
    .setCustomId('bio')
    .setLabel('A little about you (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500)
    .setPlaceholder('One sentence is enough. You can add more later.');
  return new ModalBuilder()
    .setCustomId(`profile:quick:${ownerId}`)
    .setTitle('Start your Bio')
    .addComponents(
      new ActionRowBuilder().addComponents(openTo),
      new ActionRowBuilder().addComponents(about),
    );
}

function homeRows(ownerId, { hasProfile = true } = {}) {
  if (!hasProfile) return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bio:write:${ownerId}`).setStyle(ButtonStyle.Primary).setLabel('Start with one line'),
      new ButtonBuilder().setCustomId(`bio:full:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Open full editor'),
    ),
  ];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bio:edit:${ownerId}`).setStyle(ButtonStyle.Primary).setLabel('Update my Bio'),
      new ButtonBuilder().setCustomId(`bio:style:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Photo, vibe & title'),
      new ButtonBuilder().setCustomId(`bio:sharing:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Sharing'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bio:more:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('More'),
      new ButtonBuilder().setCustomId(`bio:notes:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Interaction notes (optional)'),
    ),
  ];
}

function sharingRows(ownerId, { hasBoard = false } = {}) {
  const option = (preset, label, style) => new ButtonBuilder()
    .setCustomId(`share:${preset}:${ownerId}`).setStyle(style).setLabel(label);
  return [new ActionRowBuilder().addComponents(
    option('private', 'Private for now', ButtonStyle.Secondary),
    option('hellos', hasBoard ? 'Publish & open to hellos' : 'Open to hellos', ButtonStyle.Primary),
    option('groups', hasBoard ? 'Publish & open to groups' : 'Open to groups', ButtonStyle.Success),
  )];
}

function backToBioRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bio:home:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Back to Bio'),
  );
}

function styleRows(ownerId, currentTheme = null) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`style:upload:${ownerId}`).setStyle(ButtonStyle.Primary).setLabel('Upload your own photo'),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`style:vibe:${ownerId}`).setPlaceholder('Choose your general vibe')
        .addOptions(PROFILE_VIBES.map((vibe) => ({
          label: vibe.name,
          value: vibe.id,
          description: vibe.description,
          default: currentTheme?.theme === vibe.id,
        }))),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`style:title:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Choose a title'),
      new ButtonBuilder().setCustomId(`style:presets:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Preselected photos'),
      new ButtonBuilder().setCustomId(`style:remove:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Use Discord avatar'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bio:home:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Back to Bio'),
    ),
  ];
}

function preselectedPhotoRows(ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`style:preset:${ownerId}`).setPlaceholder('Choose a preselected photo')
        .addOptions(CARD_ART_PRESETS.map((preset) => ({ label: preset.name, value: preset.id, description: preset.description.slice(0, 100) }))),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`style:home:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Back to photo options'),
    ),
  ];
}

function photoUploadModal(ownerId) {
  const upload = new FileUploadBuilder()
    .setCustomId('photo')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1);
  return new ModalBuilder()
    .setCustomId(`style:upload:${ownerId}`)
    .setTitle('Upload your own photo')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Choose a photo')
        .setDescription('PNG, JPEG, GIF, or WebP · up to 5 MB')
        .setFileUploadComponent(upload),
    );
}

function titleModal(ownerId, currentTitle = '') {
  const title = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Card title (optional)')
    .setPlaceholder('e.g. always down for side quests')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80);
  if (currentTitle) title.setValue(String(currentTitle).slice(0, 80));
  return new ModalBuilder()
    .setCustomId(`style:title:${ownerId}`)
    .setTitle('Choose your title')
    .addComponents(new ActionRowBuilder().addComponents(title));
}

function setupRows(ownerId, { hasBoard = false } = {}) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup:packs:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Review starter tags'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup:add:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Add interests'),
      new ButtonBuilder().setCustomId(`setup:remove:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Remove interests'),
      new ButtonBuilder().setCustomId(`setup:limit:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Profile size'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup:tags:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Toggle member suggestions'),
      new ButtonBuilder().setCustomId(`setup:gathers:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Toggle group invites'),
      new ButtonBuilder().setCustomId(`setup:post:${ownerId}`).setStyle(ButtonStyle.Primary).setLabel('Post start card here'),
      new ButtonBuilder().setCustomId(`setup:prompt:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Post Bio prompt').setDisabled(!hasBoard),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup:board-create:${ownerId}`).setStyle(ButtonStyle.Primary).setLabel('Create Bio channel'),
      new ButtonBuilder().setCustomId(`setup:board-here:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Use this channel'),
      new ButtonBuilder().setCustomId(`setup:board-off:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Turn off Bio channel'),
    ),
  ];
}

function startCardPayload() {
  return withNoMentions({
    embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Meet the people here')
      .setDescription('A Bio can start with one line. Choose whether yours appears in this server’s Bio channel, then look for people you would enjoy talking to or doing something with.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('start:bio').setStyle(ButtonStyle.Primary).setLabel('Make or update my Bio'),
      new ButtonBuilder().setCustomId('start:find').setStyle(ButtonStyle.Secondary).setLabel('Find people'),
    )],
  });
}

function bioPromptModal(ownerId) {
  return new ModalBuilder()
    .setCustomId(`setup:prompt:${ownerId}`)
    .setTitle('Prompt the server')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('question')
      .setLabel('A question people can answer in their Bio')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(200)
      .setPlaceholder('What have you been into lately that someone here might share?')));
}

function bioPromptPayload(question) {
  return withNoMentions({
    embeds: [new EmbedBuilder().setColor(0x786752).setTitle('A question for this week')
      .setDescription(`${safeDisplayText(question, { maxLength: 200 })}\n\nAdd your answer to your Bio if you want people to find that in common. You can update your card any time.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('start:bio').setStyle(ButtonStyle.Primary).setLabel('Make or update my Bio'),
      new ButtonBuilder().setCustomId('start:find').setStyle(ButtonStyle.Secondary).setLabel('Find people'),
    )],
  });
}

function starterPackSummary(pack) {
  return pack.interests.map((interest) => interest.name).join(' · ');
}

function starterPackPickerEmbed() {
  return new EmbedBuilder()
    .setColor(0x786752)
    .setTitle('Starter tag suggestions')
    .setDescription('Open a group to review its tags. Nothing is selected or added until you choose tags and press **Add selected**.')
    .addFields(STARTER_PACKS.map((pack) => ({
      name: pack.name,
      value: starterPackSummary(pack),
      inline: false,
    })));
}

function starterPackPickerRows(ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`setup:pack:${ownerId}`)
        .setPlaceholder('Open a group of suggestions')
        .addOptions(STARTER_PACKS.map((pack) => ({
          label: pack.name,
          description: starterPackSummary(pack),
          value: pack.id,
        }))),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup:home:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Back to setup'),
    ),
  ];
}

function starterPackReviewEmbed(pack, selectedSlugs, existingSlugs) {
  const lines = pack.interests.map((interest) => {
    if (existingSlugs.has(interest.slug)) return `• ${interest.name} — already in this server`;
    if (selectedSlugs.has(interest.slug)) return `• **${interest.name} — selected**`;
    return `• ${interest.name}`;
  });
  return new EmbedBuilder()
    .setColor(0x786752)
    .setTitle(`Choose from ${pack.name}`)
    .setDescription('Select only what fits this server. Existing tags stay untouched, and nothing changes until you press **Add selected**.')
    .addFields({ name: 'Tags in this group', value: lines.join('\n') });
}

function starterPackReviewRows(ownerId, draftId, pack, selectedSlugs, existingSlugs) {
  const available = pack.interests.filter((interest) => !existingSlugs.has(interest.slug));
  const rows = [];
  if (available.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`setup:pick:${ownerId}:${draftId}`)
        .setPlaceholder('Choose the tags that fit this server')
        .setMinValues(0)
        .setMaxValues(available.length)
        .addOptions(available.map((interest) => ({
          label: interest.name,
          value: interest.slug,
          default: selectedSlugs.has(interest.slug),
        }))),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`setup:apply:${ownerId}:${draftId}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel(`Add ${selectedSlugs.size} selected`)
      .setDisabled(selectedSlugs.size === 0),
    new ButtonBuilder()
      .setCustomId(`setup:all:${ownerId}:${draftId}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Select all')
      .setDisabled(!available.length || selectedSlugs.size === available.length),
    new ButtonBuilder()
      .setCustomId(`setup:clear:${ownerId}:${draftId}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Clear')
      .setDisabled(selectedSlugs.size === 0),
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup:back:${ownerId}:${draftId}`).setStyle(ButtonStyle.Secondary).setLabel('Back to suggestions'),
    new ButtonBuilder().setCustomId(`setup:cancel:${ownerId}:${draftId}`).setStyle(ButtonStyle.Secondary).setLabel('Cancel'),
  ));
  return rows;
}

function setupInterestsModal(action, ownerId) {
  const adding = action === 'add';
  const names = new TextInputBuilder()
    .setCustomId('interests')
    .setLabel(adding ? 'Interest names, separated by commas' : 'Interest names to remove')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);
  const modal = new ModalBuilder()
    .setCustomId(`setup:${action}:${ownerId}`)
    .setTitle(adding ? 'Add server interests' : 'Remove server interests')
    .addComponents(new ActionRowBuilder().addComponents(names));
  if (adding) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('category').setLabel('Category (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(32),
    ));
  }
  return modal;
}

function setupLimitModal(ownerId, currentLimit) {
  const limit = new TextInputBuilder()
    .setCustomId('limit')
    .setLabel('Interests allowed on each profile (1–30)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2)
    .setValue(String(currentLimit));
  return new ModalBuilder().setCustomId(`setup:limit:${ownerId}`).setTitle('Profile interest limit')
    .addComponents(new ActionRowBuilder().addComponents(limit));
}

function connectModal(targetId) {
  const note = new TextInputBuilder()
    .setCustomId('message')
    .setLabel('Why would you like to connect?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);
  return new ModalBuilder()
    .setCustomId(`connect:request:${targetId}`)
    .setTitle('Send a connection request')
    .addComponents(new ActionRowBuilder().addComponents(note));
}

async function ensureProfile(store, guildId, userId) {
  return store.getProfile(guildId, userId) || store.saveProfile(guildId, userId, {
    discoverable: false,
    allow_requests: false,
    allow_group_pings: false,
  });
}

function planInterests(store, guildId, raw) {
  const settings = store.getGuildSettings(guildId);
  const slugs = parseInterests(raw, { max: 100 });
  if (slugs.length > settings.max_tags_per_user) {
    throw new RangeError(`This server allows up to ${settings.max_tags_per_user} interests per profile.`);
  }
  const unknown = slugs.filter((slug) => !store.getTag(guildId, slug));
  if (unknown.length && !settings.allow_ugc_tags) {
    throw new RangeError(`These interests are not in the server list: ${unknown.join(', ')}`);
  }
  return { slugs, unknown };
}

function applyInterestPlan(store, guildId, userId, { slugs, unknown }) {
  for (const slug of unknown) store.addTag(guildId, slug, titleFromSlug(slug), userId);
  return store.setUserTags(guildId, userId, slugs);
}

function setInterests(store, guildId, userId, raw) {
  return applyInterestPlan(store, guildId, userId, planInterests(store, guildId, raw));
}

async function addInterests(store, guildId, userId, raw) {
  const existing = store.listUserTags(guildId, userId).map((tag) => tag.tag_slug);
  const additions = parseInterests(raw, { max: 100 });
  return setInterests(store, guildId, userId, [...existing, ...additions].join(','));
}

function friendlyError(error) {
  if (error instanceof RangeError || error instanceof TypeError) return error.message;
  if (typeof error?.message === 'string' && /image|profile|request|interest|cooldown|gather|member/i.test(error.message)) return error.message;
  return 'Something went wrong while Bio handled that. Please try again.';
}

async function memberFor(guild, userId) {
  const cached = guild?.members?.cache?.get?.(userId);
  if (cached) return cached;
  if (typeof guild?.members?.fetch !== 'function') return null;
  try { return await guild.members.fetch(userId); } catch { return null; }
}

async function boardMemberFor(guild, userId) {
  const cached = guild?.members?.cache?.get?.(userId);
  if (cached) return cached;
  if (typeof guild?.members?.fetch !== 'function') throw new Error('Cannot verify Bio channel membership right now.');
  try { return await guild.members.fetch(userId); }
  catch (error) {
    if (error?.code === 10007) return null;
    throw error;
  }
}

async function channelFor(guild, channelId) {
  if (!channelId) return null;
  const cached = guild?.channels?.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild?.channels?.fetch !== 'function') return null;
  try { return await guild.channels.fetch(channelId); } catch { return null; }
}

async function profilePayload({ store, media, interaction, userId, includeStatus = true, includeBoundaries = true }) {
  const profile = store.getProfile(interaction.guildId, userId);
  if (!profile) throw new RangeError('That member has not made a profile yet.');
  const member = await memberFor(interaction.guild, userId);
  const user = member?.user || (interaction.user.id === userId ? interaction.user : await interaction.client.users.fetch(userId).catch(() => null));
  const tags = store.listUserTags(interaction.guildId, userId);
  const theme = store.getTheme(interaction.guildId, userId);
  const boundary = store.getBoundaries(interaction.guildId, userId);
  const viewerMember = await memberFor(interaction.guild, interaction.user.id);
  const visibleBoundary = includeBoundaries && boundary && canViewBoundaries({
    ownerId: userId,
    viewerId: interaction.user.id,
    privacyLevel: boundary.privacy_level,
    privacyRoleId: boundary.privacy_role_id,
    viewerRoleIds: [...(viewerMember?.roles?.cache?.keys?.() || [])],
    viewerIsMember: Boolean(viewerMember),
  }) ? boundary : null;
  const resolved = await media.resolve(profile.profile_image, interaction.guildId, userId);
  return buildProfilePayload({
    profile,
    tags,
    theme,
    boundaries: visibleBoundary,
    member,
    user,
    profileImage: resolved?.file || resolved?.url || null,
    includeStatus,
  });
}

function requireManageGuild(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new RangeError('You need Manage Server to use that command.');
  }
}

function boardCardRows(profile, userId) {
  const buttons = [];
  if (profile?.allow_requests) {
    buttons.push(new ButtonBuilder().setCustomId(`board:hello:${userId}`).setStyle(ButtonStyle.Primary).setLabel('Send a hello'));
  }
  buttons.push(new ButtonBuilder().setCustomId('board:mine').setStyle(ButtonStyle.Secondary).setLabel('Make or update my Bio'));
  return [new ActionRowBuilder().addComponents(buttons)];
}

async function publicBoardPayload({ store, media, guild, client, userId }) {
  const member = await boardMemberFor(guild, userId);
  if (!member || member.user?.bot) return null;
  const profile = store.getProfile(guild.id, userId);
  if (!profile) return null;
  const interaction = { guildId: guild.id, guild, client, user: member.user || { id: userId } };
  const card = await profilePayload({ store, media, interaction, userId, includeStatus: false, includeBoundaries: false });
  return withNoMentions({ ...card, components: boardCardRows(profile, userId) });
}

async function reconcileBoardGuild({ store, media, board, guild, client }) {
  const channelId = store.getGuildSettings(guild.id)?.bio_board_channel_id;
  if (!channelId) return { ok: true, code: 'disabled', outcomes: [] };
  const channel = await channelFor(guild, channelId);
  if (!channel) throw new RangeError('The configured Bio channel could not be found.');
  const entries = [];
  for (const profile of store.listBoardEligibleProfiles(guild.id)) {
    const payload = await publicBoardPayload({ store, media, guild, client, userId: profile.user_id });
    if (payload) entries.push({ userId: profile.user_id, payload });
  }
  return board.reconcile({ guildId: guild.id, channel, entries });
}

export function createInteractionHandler({ store, media, connections, gather, boundaries, board = null, rsvp = null, logger = console, now = () => new Date() }) {
  const invitationDrafts = new Map();
  const tagPackDrafts = new Map();
  let invitationDraftSequence = 0;

  async function boardChannel(guild) {
    const channelId = store.getGuildSettings(guild.id)?.bio_board_channel_id;
    return channelFor(guild, channelId);
  }

  async function syncBoardProfile(interaction, userId = interaction.user.id) {
    if (!board || !store.getGuildSettings(interaction.guildId)?.bio_board_channel_id) return null;
    const profile = store.getProfile(interaction.guildId, userId);
    const withdrawing = !profile?.discoverable || !profile?.publish_to_board;
    try {
      const channel = await boardChannel(interaction.guild);
      if (!channel) throw new Error('The configured Bio channel is unavailable.');
      const result = profile?.discoverable && profile?.publish_to_board
        ? await board.publish({ guildId: interaction.guildId, userId, channel,
          payload: await publicBoardPayload({ store, media, guild: interaction.guild, client: interaction.client, userId }) })
        : await board.unpublish({ guildId: interaction.guildId, userId, channel });
      if (!result.ok) throw new Error(result.message || 'The public card could not be updated.');
      return null;
    } catch (error) {
      logger.error('Could not sync public Bio card', { guildId: interaction.guildId, userId, error });
      return withdrawing
        ? 'Your sharing choice was saved, but your old public card may still be visible. Ask a server admin to remove it if it remains.'
        : 'Your Bio was saved, but its public channel card could not update. Please try again later.';
    }
  }

  async function refreshBoardCards(interaction) {
    if (!board || !store.getGuildSettings(interaction.guildId)?.bio_board_channel_id) return null;
    try {
      const result = await reconcileBoardGuild({ store, media, board, guild: interaction.guild, client: interaction.client });
      if (!result.ok) throw new Error('Some cards could not update.');
      return null;
    } catch (error) {
      logger.error('Could not refresh public Bio cards', { guildId: interaction.guildId, error });
      return 'Some public Bio cards could not update. Check the bot’s channel permissions and try again.';
    }
  }

  function currentTimeMs() {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError('The current time is unavailable.');
    return milliseconds;
  }

  function clearTagPackDrafts(ownerId, guildId) {
    const time = currentTimeMs();
    for (const [draftId, draft] of tagPackDrafts) {
      if (draft.expiresAt <= time || (draft.ownerId === ownerId && draft.guildId === guildId)) tagPackDrafts.delete(draftId);
    }
  }

  function requireTagPackDraft(interaction, ownerId, draftId) {
    const draft = draftId ? tagPackDrafts.get(draftId) : null;
    if (!draft || draft.expiresAt <= currentTimeMs()) {
      if (draftId) tagPackDrafts.delete(draftId);
      throw new RangeError('That tag review expired. Open the starter suggestions again.');
    }
    if (draft.ownerId !== ownerId || draft.guildId !== interaction.guildId) {
      throw new RangeError('That tag review belongs to a different setup panel.');
    }
    if (!getStarterPack(draft.packId)) {
      tagPackDrafts.delete(draftId);
      throw new RangeError('That group of tag suggestions is no longer available.');
    }
    return draft;
  }

  function existingStarterPackSlugs(guildId, pack) {
    return new Set(pack.interests.filter((interest) => store.getTag(guildId, interest.slug)).map((interest) => interest.slug));
  }
  async function handleAutocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const pieces = String(focused.value || '').split(',');
    const query = pieces.at(-1).trim();
    const prefix = pieces.length > 1 ? `${pieces.slice(0, -1).join(', ')}, ` : '';
    const rows = store.searchTags(interaction.guildId, query, 25);
    await interaction.respond(rows.map((tag) => ({
      name: safeDisplayText(`${prefix}${tag.display_name}`, { maxLength: 100 }),
      value: `${prefix}${tag.tag_slug}`.slice(0, 100),
    })));
  }

  async function showProfile(interaction, userId, { visible = false } = {}) {
    const stored = store.getProfile(interaction.guildId, userId);
    if (!stored) throw new RangeError('That member has not made a profile yet.');
    if (userId !== interaction.user.id && !stored.discoverable) {
      throw new RangeError('That member has kept their profile private.');
    }
    await interaction.deferReply(visible ? {} : { flags: PRIVATE });
    try {
      const payload = await profilePayload({
        store,
        media,
        interaction,
        userId,
        includeStatus: !visible,
        includeBoundaries: !visible,
      });
      const owner = userId === interaction.user.id;
      const rows = !owner && stored.allow_requests ? boardCardRows(stored, userId) : [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('board:mine').setStyle(ButtonStyle.Secondary).setLabel('Make or update my Bio'),
      )];
      const myTags = !visible && !owner ? new Set(store.listUserTags(interaction.guildId, interaction.user.id).map((tag) => tag.tag_slug)) : new Set();
      const shared = !visible && !owner ? store.listUserTags(interaction.guildId, userId)
        .filter((tag) => myTags.has(tag.tag_slug)).map((tag) => tag.display_name).slice(0, 3) : [];
      return interaction.editReply(withNoMentions({
        ...payload,
        ...(shared.length ? { content: `You both chose ${shared.join(' · ')}. Their Bio gives you a place to start if you want to say hello.` } : {}),
        components: rows,
      }));
    } catch (error) {
      if (!visible) throw error;
      logger.error('Could not build public profile card', { guildId: interaction.guildId, userId, error });
      return interaction.editReply(withNoMentions('Bio could not load that card right now. Please try again.'));
    }
  }

  async function showBioHome(interaction, { uploaded = false, forcePrivate = false, notice = '' } = {}) {
    const respond = (payload) => (!forcePrivate && (interaction.isButton?.() || interaction.isStringSelectMenu?.()))
      ? interaction.update(withNoMentions(payload))
      : privateReply(interaction, payload);
    const profile = store.getProfile(interaction.guildId, interaction.user.id);
    if (!profile) {
      return respond({
        embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Start with one line')
          .setDescription('What could someone here talk to you about? That is enough for a Bio. You can add a photo and interests later. Your card stays private until you choose to share it.')],
        components: homeRows(interaction.user.id, { hasProfile: false }),
      });
    }
    const payload = await profilePayload({ store, media, interaction, userId: interaction.user.id });
    const boardId = store.getGuildSettings(interaction.guildId)?.bio_board_channel_id;
    const staleCard = store.getBioBoardMessage?.(interaction.guildId, interaction.user.id);
    const boardStatus = staleCard && (!profile.discoverable || !profile.publish_to_board)
      ? `Your sharing choice is private, but your old public card in <#${staleCard.channel_id}> still needs removal. Ask a server admin to remove it if it remains.`
      : profile.discoverable && profile.publish_to_board && boardId
      ? `Your card is in <#${boardId}>. Updating your Bio edits that same card.`
      : profile.discoverable && boardId
        ? `People can find you in the directory. Open **Sharing** if you want your card in <#${boardId}> too.`
        : profile.discoverable ? 'People can find you in the directory.' : 'Your card is private for now.';
    return respond({
      content: `${uploaded ? 'Saved your photo. ' : ''}${boardStatus} You can update it whenever you want.${notice ? `\n${notice}` : ''}`,
      ...payload,
      components: homeRows(interaction.user.id),
    });
  }

  async function openProfileEditor(interaction) {
    const profile = store.getProfile(interaction.guildId, interaction.user.id);
    const tags = profile ? store.listUserTags(interaction.guildId, interaction.user.id) : [];
    return interaction.showModal(profileModal(profile, tags, interaction.user.id));
  }

  function styleSummary(profile, theme) {
    const selectedPhoto = presetForCardArtMarker(profile?.profile_image);
    const photo = selectedPhoto?.name || (profile?.profile_image ? 'Your photo' : 'Discord avatar');
    const vibe = getProfileVibe(theme?.theme)?.name || (theme?.primary_color || theme?.tags_emoji ? 'Custom' : 'Bio classic');
    const title = theme?.title ? 'Set' : 'None yet';
    return `Photo: **${photo}** · Vibe: **${vibe}** · Title: **${title}**`;
  }

  async function showStyleHome(interaction, content = '') {
    const profile = await ensureProfile(store, interaction.guildId, interaction.user.id);
    const theme = store.getTheme(interaction.guildId, interaction.user.id);
    const payload = await profilePayload({ store, media, interaction, userId: interaction.user.id });
    const introduction = 'Start with a photo of your own, then choose the general vibe and title around it. If you do not have an aesthetic photo ready, **Preselected photos** has six backups.';
    const response = withNoMentions({
      content: `${content ? `${content}\n\n` : ''}${introduction}\n${styleSummary(profile, theme)}`,
      ...payload,
      components: styleRows(interaction.user.id, theme),
    });
    if (interaction.deferred) return interaction.editReply(response);
    return interaction.update(response);
  }

  async function showPreselectedPhotos(interaction) {
    const payload = await profilePayload({ store, media, interaction, userId: interaction.user.id });
    return interaction.update(withNoMentions({
      content: 'No photo ready yet? These six owner-shot photos are here as backups. Choose one now, then replace it with your own whenever you want.',
      ...payload,
      components: preselectedPhotoRows(interaction.user.id),
    }));
  }

  async function handleBio(interaction) {
    const picture = interaction.options.getAttachment?.('picture');
    if (picture) {
      await interaction.deferReply({ flags: PRIVATE });
      await ensureProfile(store, interaction.guildId, interaction.user.id);
      const marker = await media.save(interaction.guildId, interaction.user.id, picture);
      store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: marker });
      const notice = await syncBoardProfile(interaction);
      return showBioHome(interaction, { uploaded: true, notice });
    }
    return showBioHome(interaction);
  }

  async function handleBioComponent(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId && ownerId !== interaction.user.id) throw new RangeError('That Bio control belongs to someone else.');
    if (action === 'write') return interaction.showModal(quickProfileModal(interaction.user.id));
    if (action === 'full' || action === 'edit') return openProfileEditor(interaction);
    if (action === 'home') return showBioHome(interaction);
    if (action === 'style') return showStyleHome(interaction);
    if (action === 'sharing') {
      const profile = await ensureProfile(store, interaction.guildId, interaction.user.id);
      const boardId = store.getGuildSettings(interaction.guildId)?.bio_board_channel_id;
      return interaction.update(withNoMentions({
        content: `Sharing is your choice. Current: directory ${profile.discoverable ? 'on' : 'off'}, requests ${profile.allow_requests ? 'on' : 'off'}, group invites ${profile.allow_group_pings ? 'on' : 'off'}${boardId ? `, public card in <#${boardId}> ${profile.discoverable && profile.publish_to_board ? 'on' : 'off'}` : ''}.${boardId ? ' Choosing **Publish** puts your card in the server’s Bio channel and keeps it updated there.' : ' A server admin can add a Bio channel later.'}`,
        components: [...sharingRows(interaction.user.id, { hasBoard: Boolean(boardId) }), ...preferenceRows(profile, interaction.user.id, { hasBoard: Boolean(boardId) }), backToBioRow(interaction.user.id)], embeds: [],
      }));
    }
    if (action === 'notes') {
      return boundaries.startEdit(interaction);
    }
    if (action === 'find') return handleFind(interaction);
    if (action === 'more') {
      return interaction.update(withNoMentions({
        content: 'Share your finished card in this channel, or remove your Bio data from this server.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`bio:share:${interaction.user.id}`).setStyle(ButtonStyle.Primary).setLabel('Share card here'),
          new ButtonBuilder().setCustomId(`profile-delete:confirm:${interaction.user.id}`).setStyle(ButtonStyle.Danger).setLabel('Delete my Bio data'),
          new ButtonBuilder().setCustomId(`bio:home:${interaction.user.id}`).setStyle(ButtonStyle.Secondary).setLabel('Back'),
        )], embeds: [],
      }));
    }
    if (action === 'share') return showProfile(interaction, interaction.user.id, { visible: true });
  }

  async function handleStyleComponent(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That style control belongs to someone else.');
    if (action === 'home') return showStyleHome(interaction);
    if (action === 'upload') return interaction.showModal(photoUploadModal(interaction.user.id));
    if (action === 'title') {
      const theme = store.getTheme(interaction.guildId, interaction.user.id);
      return interaction.showModal(titleModal(interaction.user.id, theme?.title));
    }
    if (action === 'presets') return showPreselectedPhotos(interaction);
    if (['vibe', 'preset', 'remove'].includes(action) && board && store.getGuildSettings(interaction.guildId)?.bio_board_channel_id) {
      await interaction.deferUpdate();
    }
    if (action === 'vibe') {
      const vibe = getProfileVibe(interaction.values?.[0]);
      if (!vibe) throw new RangeError('Choose a valid vibe.');
      await ensureProfile(store, interaction.guildId, interaction.user.id);
      store.updateTheme(interaction.guildId, interaction.user.id, {
        theme: vibe.id,
        primary_color: vibe.primaryColor,
        secondary_color: vibe.secondaryColor,
        tags_emoji: vibe.tagsEmoji,
      });
      const warning = await syncBoardProfile(interaction);
      return showStyleHome(interaction, `${vibe.name} is now your card’s general vibe. Your photo and title stayed the same.${warning ? `\n${warning}` : ''}`);
    }
    if (action === 'preset') {
      const preset = getCardArtPreset(interaction.values?.[0]);
      if (!preset) throw new RangeError('Choose a valid photo preset.');
      store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: markerForCardArt(preset.id) });
      try { await media.remove(interaction.guildId, interaction.user.id); } catch (error) {
        logger.warn?.('Could not clean up a replaced Bio upload', { guildId: interaction.guildId, userId: interaction.user.id, error });
      }
      const warning = await syncBoardProfile(interaction);
      return showStyleHome(interaction, `${preset.name} is now your backup photo. Your vibe and title stayed the same.${warning ? `\n${warning}` : ''}`);
    }
    if (action === 'remove') {
      store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: null });
      try { await media.remove(interaction.guildId, interaction.user.id); } catch (error) {
        logger.warn?.('Could not clean up a removed Bio upload', { guildId: interaction.guildId, userId: interaction.user.id, error });
      }
      const warning = await syncBoardProfile(interaction);
      return showStyleHome(interaction, `Your card now uses your Discord avatar. Your vibe and title stayed the same.${warning ? `\n${warning}` : ''}`);
    }
  }

  async function handleStyleModal(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That style editor belongs to someone else.');
    if (action === 'upload') {
      const uploads = interaction.fields.getUploadedFiles('photo', true);
      const picture = uploads.first?.() || uploads.values().next().value;
      if (!picture) throw new RangeError('Choose an image to upload.');
      await interaction.deferReply({ flags: PRIVATE });
      await ensureProfile(store, interaction.guildId, interaction.user.id);
      try {
        const marker = await media.save(interaction.guildId, interaction.user.id, picture);
        store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: marker });
      } catch (error) {
        return showStyleHome(interaction, friendlyError(error));
      }
      const warning = await syncBoardProfile(interaction);
      return showStyleHome(interaction, `Saved your photo. Choose a vibe and title next, or keep what you already had.${warning ? `\n${warning}` : ''}`);
    }
    if (action === 'title') {
      const title = String(interaction.fields.getTextInputValue('title') || '').trim();
      await interaction.deferReply({ flags: PRIVATE });
      await ensureProfile(store, interaction.guildId, interaction.user.id);
      store.updateTheme(interaction.guildId, interaction.user.id, { title: title || null });
      const warning = await syncBoardProfile(interaction);
      return showStyleHome(interaction, `${title ? 'Saved your title.' : 'Removed your title.'} Your photo and vibe stayed the same.${warning ? `\n${warning}` : ''}`);
    }
    throw new RangeError('That style editor is no longer available.');
  }

  async function handleSharingPreset(interaction) {
    const [, preset, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('Those sharing choices belong to someone else.');
    const boardId = store.getGuildSettings(interaction.guildId)?.bio_board_channel_id;
    const patches = {
      private: { discoverable: false, allow_requests: false, allow_group_pings: false, publish_to_board: false },
      hellos: { discoverable: true, allow_requests: true, allow_group_pings: false, publish_to_board: Boolean(boardId) },
      groups: { discoverable: true, allow_requests: true, allow_group_pings: true, publish_to_board: Boolean(boardId) },
    };
    if (!patches[preset]) throw new RangeError('That sharing choice no longer exists.');
    if (board && boardId) await interaction.deferUpdate();
    const profile = store.updatePrivacy(interaction.guildId, interaction.user.id, patches[preset]);
    const boardWarning = await syncBoardProfile(interaction);
    const status = preset === 'private' ? (boardWarning ? 'Saved your private sharing choice.' : 'Saved: your Bio is private.')
      : preset === 'hellos' ? 'Saved: people can find you and send private requests.'
        : 'Saved: people can find you, send private requests, and invite you to small groups.';
    const publication = preset !== 'private' && boardId && !boardWarning ? ` Your card is published in <#${boardId}> and future edits update it there.` : '';
    const response = withNoMentions({
      content: `${status}${publication}${boardWarning ? `\n${boardWarning}` : ''}`,
      components: [
        ...sharingRows(interaction.user.id, { hasBoard: Boolean(boardId) }),
        ...preferenceRows(profile, interaction.user.id, { hasBoard: Boolean(boardId) }),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`bio:find:${interaction.user.id}`).setStyle(ButtonStyle.Primary).setLabel('Find people'),
          new ButtonBuilder().setCustomId(`bio:home:${interaction.user.id}`).setStyle(ButtonStyle.Secondary).setLabel('Back to my Bio'),
        ),
      ], embeds: [],
    });
    return board && boardId ? interaction.editReply(response) : interaction.update(response);
  }

  async function handleProfile(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (!group && sub === 'edit') {
      const profile = store.getProfile(interaction.guildId, interaction.user.id);
      const tags = profile ? store.listUserTags(interaction.guildId, interaction.user.id) : [];
      return interaction.showModal(profileModal(profile, tags, interaction.user.id));
    }
    if (!group && sub === 'view') {
      const target = interaction.options.getUser('user') || interaction.user;
      return showProfile(interaction, target.id);
    }
    if (!group && sub === 'share') return showProfile(interaction, interaction.user.id, { visible: true });
    if (!group && sub === 'preferences') {
      await ensureProfile(store, interaction.guildId, interaction.user.id);
      const patch = {};
      const directory = interaction.options.getBoolean('directory');
      const requests = interaction.options.getBoolean('requests');
      const groupPings = interaction.options.getBoolean('group_pings');
      if (directory !== null) patch.discoverable = directory;
      if (requests !== null) patch.allow_requests = requests;
      if (groupPings !== null) patch.allow_group_pings = groupPings;
      if (!Object.keys(patch).length) throw new RangeError('Choose at least one preference to change.');
      await interaction.deferReply({ flags: PRIVATE });
      const profile = store.updatePrivacy(interaction.guildId, interaction.user.id, patch);
      const warning = await syncBoardProfile(interaction);
      return interaction.editReply(withNoMentions({
        content: `Saved. You can change these choices at any time.${warning ? `\n${warning}` : ''}`,
        components: preferenceRows(profile, interaction.user.id, { hasBoard: Boolean(store.getGuildSettings(interaction.guildId)?.bio_board_channel_id) }),
      }));
    }
    if (!group && sub === 'delete') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`profile-delete:confirm:${interaction.user.id}`).setStyle(ButtonStyle.Danger).setLabel('Delete my Bio data'),
        new ButtonBuilder().setCustomId(`profile-delete:cancel:${interaction.user.id}`).setStyle(ButtonStyle.Secondary).setLabel('Keep it'),
      );
      return privateReply(interaction, { content: 'This removes your profile, interests, image, boundaries, requests, and blocks from this server.', components: [row] });
    }
    if (group === 'interests') {
      await ensureProfile(store, interaction.guildId, interaction.user.id);
      if (sub === 'list') {
        const tags = store.listUserTags(interaction.guildId, interaction.user.id);
        return privateReply(interaction, tags.length ? tags.map((tag) => tag.display_name).join(' · ') : 'You have not added any interests yet.');
      }
      const raw = interaction.options.getString('tags', true);
      await interaction.deferReply({ flags: PRIVATE });
      const tags = sub === 'add'
        ? await addInterests(store, interaction.guildId, interaction.user.id, raw)
        : (() => {
          for (const slug of parseInterests(raw, { max: 100 })) store.removeUserTag(interaction.guildId, interaction.user.id, slug);
          return store.listUserTags(interaction.guildId, interaction.user.id);
        })();
      const warning = await syncBoardProfile(interaction);
      return interaction.editReply(withNoMentions(`${tags.length ? `Saved: ${tags.map((tag) => tag.display_name).join(' · ')}` : 'Your interest list is empty.'}${warning ? `\n${warning}` : ''}`));
    }
    if (group === 'image') {
      if (sub === 'set') {
        await interaction.deferReply({ flags: PRIVATE });
        await ensureProfile(store, interaction.guildId, interaction.user.id);
        const marker = await media.save(interaction.guildId, interaction.user.id, interaction.options.getAttachment('image', true));
        store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: marker });
        const warning = await syncBoardProfile(interaction);
        return interaction.editReply(withNoMentions(`Saved your profile image to Bio’s own storage.${warning ? `\n${warning}` : ''}`));
      }
      await interaction.deferReply({ flags: PRIVATE });
      await media.remove(interaction.guildId, interaction.user.id);
      if (store.getProfile(interaction.guildId, interaction.user.id)) store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: null });
      const warning = await syncBoardProfile(interaction);
      return interaction.editReply(withNoMentions(`Your profile now uses your Discord avatar.${warning ? `\n${warning}` : ''}`));
    }
  }

  async function handleView(interaction) {
    const target = interaction.options.getUser('member') || interaction.user;
    const visible = interaction.options.getBoolean('visible') !== false;
    return showProfile(interaction, target.id, { visible });
  }

  async function handleProfileModal(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (!['edit', 'quick'].includes(action) || ownerId !== interaction.user.id) throw new RangeError('That profile editor is not yours.');
    await interaction.deferReply({ flags: PRIVATE });
    const existed = store.getProfile(interaction.guildId, interaction.user.id);
    const quick = action === 'quick';
    const interestPlan = quick ? null : planInterests(store, interaction.guildId, interaction.fields.getTextInputValue('interests'));
    const openTo = String(interaction.fields.getTextInputValue('open_to') || '').trim();
    if (quick && !openTo) throw new RangeError('Write one thing someone could talk to you about. You can change it later.');
    const { profile, tags } = store.transaction(() => {
      const savedProfile = store.saveProfile(interaction.guildId, interaction.user.id, {
        bio: interaction.fields.getTextInputValue('bio'),
        ...(quick ? {} : { pronouns: interaction.fields.getTextInputValue('pronouns') }),
        open_to: openTo,
        ...(existed ? {} : { discoverable: false, allow_requests: false, allow_group_pings: false, publish_to_board: false }),
      });
      return { profile: savedProfile, tags: interestPlan ? applyInterestPlan(store, interaction.guildId, interaction.user.id, interestPlan) : [] };
    });
    const boardWarning = await syncBoardProfile(interaction);
    const payload = await profilePayload({ store, media, interaction, userId: interaction.user.id });
    const boardId = store.getGuildSettings(interaction.guildId)?.bio_board_channel_id;
    const description = existed
      ? 'Saved your update. Your published card updates in place when one is enabled.'
      : boardId
        ? `That is enough for a Bio. It is private until you choose **Publish** below; publishing places it in <#${boardId}>.`
        : 'That is enough for a Bio. It is private until you choose how to share it.';
    await interaction.editReply(withNoMentions({
      content: `${description}${boardWarning ? `\n${boardWarning}` : ''}`,
      ...payload,
      components: [
        ...sharingRows(interaction.user.id, { hasBoard: Boolean(boardId) }),
        ...(quick ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`bio:edit:${interaction.user.id}`).setStyle(ButtonStyle.Secondary).setLabel('Add more details'),
          new ButtonBuilder().setCustomId(`bio:style:${interaction.user.id}`).setStyle(ButtonStyle.Secondary).setLabel('Add a photo'),
          new ButtonBuilder().setCustomId(`bio:home:${interaction.user.id}`).setStyle(ButtonStyle.Secondary).setLabel('Done for now'),
        )] : homeRows(interaction.user.id)),
      ],
    }));
    return tags;
  }

  async function handlePreference(interaction) {
    const [, field, rawValue, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('Those preferences belong to someone else.');
    if (!['discoverable', 'allow_requests', 'allow_group_pings', 'publish_to_board'].includes(field)) throw new RangeError('That preference no longer exists.');
    const boardId = store.getGuildSettings(interaction.guildId)?.bio_board_channel_id;
    if (field === 'publish_to_board' && !boardId) throw new RangeError('This server has no Bio channel yet.');
    if (field === 'publish_to_board' && rawValue === '1' && !store.getProfile(interaction.guildId, interaction.user.id)?.discoverable) {
      throw new RangeError('Turn on Directory before publishing to the Bio channel.');
    }
    if (board && boardId) await interaction.deferUpdate();
    const profile = store.updatePrivacy(interaction.guildId, interaction.user.id, { [field]: rawValue === '1' });
    const boardWarning = await syncBoardProfile(interaction);
    const response = withNoMentions({
      content: `Saved. You can change these choices at any time.${boardWarning ? `\n${boardWarning}` : ''}`,
      components: [...sharingRows(ownerId, { hasBoard: Boolean(boardId) }), ...preferenceRows(profile, ownerId, { hasBoard: Boolean(boardId) }), backToBioRow(ownerId)], embeds: [],
    });
    return board && boardId ? interaction.editReply(response) : interaction.update(response);
  }

  async function handleDelete(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That choice belongs to someone else.');
    if (action === 'cancel') return interaction.update({ content: 'Kept your Bio data.', components: [], embeds: [] });
    const tracked = store.getBioBoardMessage?.(interaction.guildId, interaction.user.id);
    if (tracked && board) {
      await interaction.deferUpdate();
      const channel = await boardChannel(interaction.guild);
      if (channel) {
        const result = await board.unpublish({ guildId: interaction.guildId, userId: interaction.user.id, channel });
        if (!result.ok) throw new RangeError('Your public Bio card could not be removed yet. Please try again later.');
      } else {
        // A deleted channel no longer contains a public card.
        store.deleteBioBoardMessage(interaction.guildId, interaction.user.id);
      }
    }
    await media.remove(interaction.guildId, interaction.user.id);
    store.deleteUserData(interaction.guildId, interaction.user.id);
    const response = { content: 'Your Bio data and public card were deleted from this server.', components: [], embeds: [] };
    return interaction.deferred ? interaction.editReply(response) : interaction.update(response);
  }

  async function handleFind(interaction) {
    await interaction.deferReply({ flags: PRIVATE });
    const raw = interaction.options?.getString?.('interest') || null;
    const tag = raw ? normalizeInterestSlug(raw) : null;
    const profiles = store.discoverProfiles(interaction.guildId, { tag, limit: 25 });
    const people = [];
    const choices = [];
    const myTags = new Set(store.listUserTags(interaction.guildId, interaction.user.id).map((entry) => entry.tag_slug));
    for (const profile of profiles) {
      const member = await memberFor(interaction.guild, profile.user_id);
      if (!member || member.user?.bot) continue;
      const about = safeDisplayText(profile.bio, { maxLength: 120, fallback: 'No bio yet.' });
      const shared = store.listUserTags(interaction.guildId, profile.user_id).filter((entry) => myTags.has(entry.tag_slug));
      const reason = shared.length ? `You both chose ${shared.slice(0, 3).map((entry) => entry.display_name).join(' · ')}`
        : tag ? `Into ${store.getTag(interaction.guildId, tag)?.display_name || tag}` : 'Open to meeting people here';
      const openTo = safeDisplayText(profile.open_to, { maxLength: 130 });
      const displayName = safeDisplayText(member.displayName, { maxLength: 80 });
      people.push(`**${displayName}** · <@${profile.user_id}>\n${safeDisplayText(reason, { maxLength: 180 })}${openTo ? `\nOpen to: ${openTo}` : `\n${about}`}`);
      choices.push({ label: displayName.slice(0, 100), value: profile.user_id,
        description: safeDisplayText(openTo || reason, { maxLength: 100 }) });
      if (people.length === 10) break;
    }
    const heading = tag && store.getTag(interaction.guildId, tag)?.display_name;
    const interestRows = tag ? [] : store.listTags(interaction.guildId, 18)
      .map((entry) => `${safeDisplayText(entry.display_name, { maxLength: 70 })} · ${entry.member_count}`);
    return interaction.editReply(withNoMentions(people.length
      ? { embeds: [new EmbedBuilder().setColor(0x786752).setTitle(heading ? `People into ${heading}` : 'Browse people').setDescription(people.join('\n\n').slice(0, 4096)).addFields(interestRows.length ? [{ name: 'Interests in this server', value: interestRows.join(' · ').slice(0, 1024) }] : []).setFooter({ text: 'Looking here never notifies anyone.' })],
        components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
          .setCustomId(`find:choose:${interaction.user.id}`).setPlaceholder('Open someone’s Bio')
          .addOptions(choices))] }
      : tag ? { content: 'No opted-in members matched that interest yet.', components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('start:find').setStyle(ButtonStyle.Secondary).setLabel('Browse everyone'),
      )] } : interestRows.length ? { embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Browse Bio').setDescription('No one has opened their card to the directory yet. These are the interests people can use when they do.').addFields({ name: 'Server interests', value: interestRows.join(' · ').slice(0, 1024) })], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('start:bio').setStyle(ButtonStyle.Primary).setLabel('Make my Bio'),
      )] } : { content: 'No one has opened their card to the directory yet. Make the first one in one line.', components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('start:bio').setStyle(ButtonStyle.Primary).setLabel('Make my Bio'),
      )] }));
  }

  async function handleFindComponent(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (action !== 'choose' || ownerId !== interaction.user.id) throw new RangeError('That search result belongs to someone else.');
    const targetId = interaction.values?.[0];
    if (!targetId) throw new RangeError('Choose a member to view.');
    return showProfile(interaction, targetId);
  }

  async function handleBoardComponent(interaction) {
    const [, action, targetId] = interaction.customId.split(':');
    if (action === 'mine') {
      await interaction.deferReply({ flags: PRIVATE });
      return showBioHome(interaction, { forcePrivate: true });
    }
    if (action !== 'hello' || !targetId) throw new RangeError('That Bio action is no longer available.');
    if (targetId === interaction.user.id) return privateReply(interaction, 'That is your own Bio. Use the update button on your card to change it.');
    const target = store.getProfile(interaction.guildId, targetId);
    if (!target?.allow_requests || !target.discoverable) throw new RangeError('That member is not accepting hellos right now.');
    if (!store.getProfile(interaction.guildId, interaction.user.id)) {
      return privateReply(interaction, { content: 'Make a short Bio before you send a hello, so they know who is asking.',
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start:bio').setStyle(ButtonStyle.Primary).setLabel('Start my Bio'))] });
    }
    return interaction.showModal(connectModal(targetId));
  }

  async function sendConnection(interaction, target, message) {
    await interaction.deferReply({ flags: PRIVATE });
    const result = await connections.send({ guild: interaction.guild, sender: interaction.user, target, message });
    return interaction.editReply(withNoMentions(result.ok
      ? `Request sent privately to ${safeDisplayText(target.globalName || target.username, { maxLength: 80 })}.`
      : result.message || 'That request could not be sent.'));
  }

  async function connectionList(interaction, direction) {
    if (!interaction.deferred) await interaction.deferReply({ flags: PRIVATE });
    const requests = direction === 'incoming'
      ? connections.listIncoming({ guildId: interaction.guildId, userId: interaction.user.id })
      : connections.listOutgoing({ guildId: interaction.guildId, userId: interaction.user.id });
    if (!requests.length) return privateReply(interaction, direction === 'incoming' ? 'You have no pending requests.' : 'You have not sent any requests yet.');
    const lines = [];
    const rows = [];
    for (const request of requests.slice(0, direction === 'incoming' ? 5 : 10)) {
      const otherId = direction === 'incoming' ? request.sender_id : request.recipient_id;
      const user = await interaction.client.users.fetch(otherId).catch(() => null);
      lines.push(`**#${request.id} · ${safeDisplayText(user?.globalName || user?.username || 'Member', { maxLength: 80 })}** — ${request.status}${request.message ? `\n${safeDisplayText(request.message, { maxLength: 180 })}` : ''}`);
      if (direction === 'incoming') rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`conn:accept:${request.id}`).setStyle(ButtonStyle.Success).setLabel(`Accept #${request.id}`),
        new ButtonBuilder().setCustomId(`conn:decline:${request.id}`).setStyle(ButtonStyle.Secondary).setLabel('Decline'),
        new ButtonBuilder().setCustomId(`conn:block:${request.id}`).setStyle(ButtonStyle.Danger).setLabel('Block'),
      ));
    }
    return privateReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0x786752).setTitle(direction === 'incoming' ? 'Connection requests' : 'Sent requests').setDescription(lines.join('\n\n').slice(0, 4096))],
      components: rows,
    });
  }

  async function handleConnect(interaction) {
    let legacyAction = null;
    try { legacyAction = interaction.options.getSubcommand?.(false) || null; } catch { legacyAction = null; }
    if (legacyAction === 'inbox' || legacyAction === 'sent') return connectionList(interaction, legacyAction === 'inbox' ? 'incoming' : 'outgoing');
    if (legacyAction === 'request') {
      const legacyTarget = interaction.options.getUser('user', true);
      if (legacyTarget.id === interaction.user.id) throw new RangeError('Choose another member.');
      return sendConnection(interaction, legacyTarget, interaction.options.getString('message'));
    }
    if (legacyAction === 'block' || legacyAction === 'unblock') {
      const legacyTarget = interaction.options.getUser('user', true);
      if (legacyTarget.id === interaction.user.id) throw new RangeError('Choose another member.');
      if (legacyAction === 'block') {
        store.blockUser(interaction.guildId, interaction.user.id, legacyTarget.id);
        return privateReply(interaction, `Blocked ${safeDisplayText(legacyTarget.globalName || legacyTarget.username, { maxLength: 80 })}.`);
      }
      const removed = store.unblockUser(interaction.guildId, interaction.user.id, legacyTarget.id);
      return privateReply(interaction, removed ? `Unblocked ${safeDisplayText(legacyTarget.globalName || legacyTarget.username, { maxLength: 80 })}.` : 'That member was not blocked by you.');
    }
    const target = interaction.options.getUser('member');
    if (!target) {
      if (interaction.options.getString?.('message')) throw new RangeError('Choose a member before adding a connection message.');
      const incoming = connections.listIncoming({ guildId: interaction.guildId, userId: interaction.user.id });
      const outgoing = connections.listOutgoing({ guildId: interaction.guildId, userId: interaction.user.id });
      const buttons = [];
      if (incoming.length) buttons.push(new ButtonBuilder().setCustomId(`conn:inbox:${interaction.user.id}`).setStyle(ButtonStyle.Primary).setLabel('Incoming'));
      if (outgoing.length) buttons.push(new ButtonBuilder().setCustomId(`conn:sent:${interaction.user.id}`).setStyle(ButtonStyle.Secondary).setLabel('Sent'));
      const components = [];
      if (buttons.length) components.push(new ActionRowBuilder().addComponents(buttons));
      components.push(new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`conn:unblock:${interaction.user.id}`).setPlaceholder('Choose someone to unblock').setMinValues(1).setMaxValues(1),
      ));
      return privateReply(interaction, {
        embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Your connections').setDescription(
          `**Incoming:** ${incoming.length ? `${incoming.length} request${incoming.length === 1 ? '' : 's'} waiting` : 'none'}\n**Sent:** ${outgoing.length ? `${outgoing.length} request${outgoing.length === 1 ? '' : 's'} waiting` : 'none'}\n\nUse **Request connection** from a member’s profile or run /connect with a member. The chooser below only removes blocks you previously made.`
        )],
        components,
      });
    }
    if (target.id === interaction.user.id) throw new RangeError('Choose another member.');
    return sendConnection(interaction, target, interaction.options.getString('message'));
  }

  async function handleConnectionComponent(interaction) {
    const [, action, rawId] = interaction.customId.split(':');
    if (action === 'inbox' || action === 'sent') {
      if (rawId !== interaction.user.id) throw new RangeError('That inbox belongs to someone else.');
      await interaction.deferUpdate();
      return connectionList(interaction, action === 'inbox' ? 'incoming' : 'outgoing');
    }
    if (action === 'unblock') {
      if (!interaction.inGuild?.() || rawId !== interaction.user.id) throw new RangeError('That block control belongs to someone else.');
      const targetId = interaction.values?.[0];
      if (!targetId || targetId === interaction.user.id) throw new RangeError('Choose another member.');
      const removed = store.unblockUser(interaction.guildId, interaction.user.id, targetId);
      return interaction.update(withNoMentions({
        content: removed ? `Unblocked <@${targetId}>.` : 'That member was not blocked by you.',
        embeds: [], components: [],
      }));
    }
    const request = store.getConnectionRequest(rawId);
    if (!request || request.recipient_id !== interaction.user.id) throw new RangeError('That request is no longer available.');
    await interaction.deferUpdate();
    if (action === 'block') {
      const result = await connections.blockRequest({ requestId: request.id, actorId: interaction.user.id });
      return interaction.editReply({ content: result.ok ? 'Blocked. Any pending requests between you were closed.' : result.message, embeds: [], components: [] });
    }
    const status = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : null;
    if (!status) throw new RangeError('That connection action is no longer available.');
    const result = await connections.respond({ requestId: request.id, actorId: interaction.user.id, status });
    const content = action === 'accept'
      ? `Accepted. Bio let them know privately.${result.intro ? `\n\n${result.intro}` : ''}`
      : 'Declined. Bio did not share anything else.';
    return interaction.editReply({ content: result.ok ? content : result.message, embeds: [], components: [] });
  }

  async function handleInvite(interaction) {
    await interaction.deferReply({ flags: PRIVATE });
    const interests = parseInterests(interaction.options.getString('interests', true), { max: 5 });
    if (!interests.length) throw new RangeError('Choose at least one interest.');
    const result = await gather.prepare({ guild: interaction.guild, senderId: interaction.user.id, interestSlugs: interests, message: interaction.options.getString('message', true) });
    if (!result.ok) return interaction.editReply(withNoMentions(result.message));
    const activity = interaction.options.getString('activity') || null;
    const startsAt = interaction.options.getString('when') || null;
    const invitation = interaction.options.getString('message', true);
    const draftId = `${Date.now().toString(36)}${(++invitationDraftSequence).toString(36)}`;
    invitationDrafts.set(draftId, { ownerId: interaction.user.id, guildId: interaction.guildId, expiresAt: Date.now() + 10 * 60 * 1000, result, activity, startsAt, invitation });
    return interaction.editReply(withNoMentions({
      embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Preview your invite').setDescription(
        `This will post to this channel and notify **${result.recipientIds.length}** opted-in member${result.recipientIds.length === 1 ? '' : 's'}. It does not send until you confirm.`
      ).addFields(
        { name: 'Interests', value: result.interestSlugs.map((slug) => store.getTag?.(interaction.guildId, slug)?.display_name || slug).join(' · '), inline: false },
        ...(activity ? [{ name: 'Plan', value: safeDisplayText(activity, { maxLength: 160 }), inline: false }] : []),
        ...(startsAt ? [{ name: 'When', value: safeDisplayText(startsAt, { maxLength: 120 }), inline: false }] : []),
        { name: 'Message', value: safeDisplayText(invitation, { maxLength: 500 }), inline: false },
      )],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`invite:send:${interaction.user.id}:${draftId}`).setStyle(ButtonStyle.Success).setLabel('Send invite'),
        new ButtonBuilder().setCustomId(`invite:cancel:${interaction.user.id}:${draftId}`).setStyle(ButtonStyle.Secondary).setLabel('Cancel'),
      )],
    }));
  }

  async function handleInviteComponent(interaction) {
    const [, action, ownerId, draftId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That invite belongs to someone else.');
    const draft = invitationDrafts.get(draftId);
    if (!draft || draft.expiresAt < Date.now()) {
      invitationDrafts.delete(draftId);
      throw new RangeError('That invite preview expired. Run `/invite` again.');
    }
    if (draft.guildId !== interaction.guildId || draft.ownerId !== interaction.user.id) throw new RangeError('That invite belongs to someone else.');
    if (action === 'cancel') {
      invitationDrafts.delete(draftId);
      return interaction.update(withNoMentions({ content: 'Cancelled. Nothing was posted.', components: [], embeds: [] }));
    }
    if (action !== 'send') throw new RangeError('That invite action no longer exists.');
    await interaction.deferUpdate();
    invitationDrafts.delete(draftId);
    const { result } = draft;
    result.commit();
    let postedMessageExists = false;
    try {
      const sent = await interaction.channel.send(result.payload);
      postedMessageExists = true;
      if (rsvp) {
        let planId = null;
        try {
          const created = await rsvp.create({
            guildId: interaction.guildId, senderId: interaction.user.id,
            recipientIds: result.recipientIds, interestSlugs: result.interestSlugs,
            activity: draft.activity, startsAt: draft.startsAt, invitation: draft.invitation,
            channelId: sent.channelId || interaction.channelId, messageId: sent.id,
            expiresAt: new Date(currentTimeMs() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          });
          planId = created.plan.id;
          await sent.edit(created.payload);
        } catch (error) {
          if (planId) store.deleteGatherPlan(planId);
          if (typeof sent.delete === 'function') {
            await sent.delete();
            postedMessageExists = false;
          }
          throw error;
        }
      }
    } catch (error) {
      if (!postedMessageExists) result.rollback();
      else throw new RangeError('The invitation was posted, but its RSVP controls could not be added or removed. Ask a moderator to remove that message before trying again.');
      throw error;
    }
    return interaction.editReply(withNoMentions({ content: `Invited ${result.recipientIds.length} opted-in ${result.recipientIds.length === 1 ? 'member' : 'members'}. They can RSVP in this channel for the next seven days.`, components: [], embeds: [] }));
  }

  async function handleGatherComponent(interaction) {
    if (!rsvp) throw new RangeError('Gathering RSVPs are unavailable right now.');
    const [, action, rawPlanId, response] = interaction.customId.split(':');
    const plan = store.getGatherPlan(rawPlanId);
    if (!plan || plan.guild_id !== interaction.guildId || plan.channel_id !== interaction.channelId || plan.message_id !== interaction.message?.id) {
      throw new RangeError('That gathering is no longer available here.');
    }
    if (action === 'rsvp') {
      const saved = await rsvp.respond({ planId: plan.id, userId: interaction.user.id, response });
      if (!saved.ok) throw new RangeError(saved.message);
      return interaction.update(saved.payload);
    }
    if (action !== 'start') throw new RangeError('That gathering action is no longer available.');
    await interaction.deferReply({ flags: PRIVATE });
    const ready = await rsvp.readyToStart({ planId: plan.id, userId: interaction.user.id });
    if (!ready.ok) throw new RangeError(ready.message);
    if (typeof interaction.channel?.threads?.create !== 'function') {
      throw new RangeError('This channel cannot make a private conversation. Ask a server admin to allow private threads here.');
    }
    let thread = null;
    let opened;
    try {
      thread = await interaction.channel.threads.create({
        name: safeDisplayText(plan.activity || plan.interest_slugs.join(' · ') || 'Bio gathering', { maxLength: 90 }),
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 1440,
        invitable: false,
        reason: `Bio gathering ${plan.id} opened by its host`,
      });
      for (const userId of ready.participantIds) await thread.members.add(userId);
      await thread.send(withNoMentions({
        content: `You all chose to join this gathering.${plan.invitation ? `\n${safeDisplayText(plan.invitation, { maxLength: 500 })}` : ''}\nStart with the plan above, or make it your own together.`,
      }));
      opened = await rsvp.markConversationOpen({ planId: plan.id, threadId: thread.id });
    } catch (error) {
      if (thread) try { await thread.delete('Could not finish opening Bio gathering'); } catch (cleanupError) {
        logger.error('Could not remove incomplete Bio gathering thread', { planId: plan.id, threadId: thread.id, cleanupError });
      }
      throw error;
    }
    try { await interaction.message.edit(opened.payload); } catch (error) {
      logger.error('Could not update opened gathering invitation', { planId: plan.id, error });
    }
    return interaction.editReply(withNoMentions(`Opened a private conversation for the people who joined: <#${thread.id}>.`));
  }

  async function handleBoundaries(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'edit') return boundaries.startEdit(interaction);
    if (sub === 'remove') {
      const removed = store.deleteBoundaries(interaction.guildId, interaction.user.id);
      return privateReply(interaction, removed ? 'Removed your interaction notes.' : 'You did not have interaction notes to remove.');
    }
    if (sub === 'privacy') {
      const level = interaction.options.getString('visibility', true);
      const role = interaction.options.getRole('role');
      if (level === 'role' && !role) throw new RangeError('Choose the role that should be able to view your notes.');
      if (level !== 'role' && role) throw new RangeError('A role is only used with “A role” visibility.');
      store.updateBoundariesPrivacy(interaction.guildId, interaction.user.id, level, role?.id || null);
      return privateReply(interaction, level === 'role' ? `Only you and members of ${role.name} can view your notes.` : level === 'members' ? 'Server members can view your notes.' : 'Only you can view your notes.');
    }
    const target = interaction.options.getUser('user') || interaction.user;
    await interaction.deferReply({ flags: PRIVATE });
    const entry = store.getBoundaries(interaction.guildId, target.id);
    if (!entry) throw new RangeError(target.id === interaction.user.id ? 'You have not added interaction notes yet. Use `/boundaries edit`.' : 'That member has not shared interaction notes.');
    const viewer = await memberFor(interaction.guild, interaction.user.id);
    if (!canViewBoundaries({ ownerId: target.id, viewerId: interaction.user.id, privacyLevel: entry.privacy_level, privacyRoleId: entry.privacy_role_id, viewerRoleIds: [...(viewer?.roles?.cache?.keys?.() || [])], viewerIsMember: Boolean(viewer) })) {
      throw new RangeError('That member has not shared their interaction notes with you.');
    }
    const owner = await memberFor(interaction.guild, target.id) || target;
    return privateReply(interaction, buildBoundariesEmbed({ owner, entry, viewerId: interaction.user.id, ownerId: target.id }));
  }

  async function handleTags(interaction) {
    requireManageGuild(interaction);
    const sub = interaction.options.getSubcommand();
    const name = interaction.options.getString('name', true);
    const slug = normalizeInterestSlug(name);
    if (!slug) throw new RangeError('Use at least one letter or number for the interest name.');
    await interaction.deferReply({ flags: PRIVATE });
    if (sub === 'remove') {
      const removed = store.removeTag(interaction.guildId, slug);
      const warning = removed ? await refreshBoardCards(interaction) : null;
      return interaction.editReply(withNoMentions(`${removed ? 'Removed that interest from the server list and member profiles.' : 'That interest was not in the server list.'}${warning ? `\n${warning}` : ''}`));
    }
    const tag = store.addTag(interaction.guildId, slug, interaction.options.getString('display', true), interaction.user.id, interaction.options.getString('category') || 'general', { bypassUgc: true });
    const warning = await refreshBoardCards(interaction);
    return interaction.editReply(withNoMentions(`Saved ${tag.display_name}.${warning ? `\n${warning}` : ''}`));
  }

  async function handleSettings(interaction) {
    requireManageGuild(interaction);
    const sub = interaction.options.getSubcommand();
    let settings = store.getGuildSettings(interaction.guildId);
    if (sub === 'update') {
      const patch = {};
      const allowTags = interaction.options.getBoolean('allow_member_tags');
      const max = interaction.options.getInteger('max_interests');
      const allowGathers = interaction.options.getBoolean('allow_gathers');
      if (allowTags !== null) patch.allow_ugc_tags = allowTags;
      if (max !== null) patch.max_tags_per_user = max;
      if (allowGathers !== null) patch.allow_gathers = allowGathers;
      if (!Object.keys(patch).length) throw new RangeError('Choose at least one setting to change.');
      settings = store.updateGuildSettings(interaction.guildId, patch);
    }
    return privateReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Bio settings').addFields(
        { name: 'Member-created interests', value: settings.allow_ugc_tags ? 'Allowed' : 'Off', inline: true },
        { name: 'Interests per profile', value: String(settings.max_tags_per_user), inline: true },
        { name: 'Group calls', value: settings.allow_gathers ? 'Allowed' : 'Off', inline: true },
      )],
    });
  }

  function setupEmbed(settings, tags = []) {
    const shownTags = tags.slice(0, 30).map((tag) => safeDisplayText(tag.display_name, { maxLength: 70 }));
    const tagSummary = shownTags.length
      ? `${shownTags.join(' · ')}${tags.length > shownTags.length ? ` · +${tags.length - shownTags.length} more` : ''}`
      : 'None yet. Review starter suggestions or add your own names below.';
    return new EmbedBuilder().setColor(0x786752).setTitle('Set up Bio')
      .setDescription('Give people a clear, low-pressure way to make a card and find each other. These controls only affect this server.')
      .addFields(
        { name: 'Member-suggested interests', value: settings.allow_ugc_tags ? 'On' : 'Off', inline: true },
        { name: 'Group invites', value: settings.allow_gathers ? 'On' : 'Off', inline: true },
        { name: 'Interests per profile', value: String(settings.max_tags_per_user), inline: true },
        { name: 'Public Bio channel', value: settings.bio_board_channel_id
          ? `<#${settings.bio_board_channel_id}> · one card per member who chooses to publish; edits update the card`
          : 'Off · create a channel here, or use the channel where you run /setup', inline: false },
        { name: `Server interests · ${tags.length}`, value: safeDisplayText(tagSummary, { maxLength: 1024 }), inline: false },
      );
  }

  function setupPayload(interaction, content = undefined) {
    const settings = store.getGuildSettings(interaction.guildId);
    const tags = store.listTags(interaction.guildId, 500);
    return withNoMentions({
      ...(content ? { content } : {}),
      embeds: [setupEmbed(settings, tags)],
      components: setupRows(interaction.user.id, { hasBoard: Boolean(settings.bio_board_channel_id) }),
    });
  }

  function starterPackPickerPayload(ownerId) {
    return withNoMentions({
      embeds: [starterPackPickerEmbed()],
      components: starterPackPickerRows(ownerId),
    });
  }

  function starterPackReviewPayload(interaction, draftId, draft) {
    const pack = getStarterPack(draft.packId);
    const existingSlugs = existingStarterPackSlugs(interaction.guildId, pack);
    for (const slug of draft.selectedSlugs) if (existingSlugs.has(slug)) draft.selectedSlugs.delete(slug);
    return withNoMentions({
      embeds: [starterPackReviewEmbed(pack, draft.selectedSlugs, existingSlugs)],
      components: starterPackReviewRows(draft.ownerId, draftId, pack, draft.selectedSlugs, existingSlugs),
    });
  }

  async function handleSetup(interaction) {
    requireManageGuild(interaction);
    return privateReply(interaction, setupPayload(interaction));
  }

  async function handleSetupComponent(interaction) {
    const [, action, ownerId, draftId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That setup panel belongs to someone else.');
    requireManageGuild(interaction);
    if (action === 'board-create' || action === 'board-here') {
      if (!board) throw new RangeError('The Bio channel is unavailable right now.');
      const previousId = store.getGuildSettings(interaction.guildId).bio_board_channel_id;
      if (previousId && (action === 'board-create' || previousId !== interaction.channelId)) {
        throw new RangeError('Turn off the current Bio channel before choosing another one.');
      }
      if (action === 'board-here' && interaction.channel?.type !== ChannelType.GuildText) {
        throw new RangeError('Run /setup in a regular text channel to use it as the Bio channel.');
      }
      await interaction.deferUpdate();
      let channel = interaction.channel;
      if (action === 'board-create') {
        try {
          channel = await interaction.guild.channels.create({
            name: 'member-bios',
            type: ChannelType.GuildText,
            topic: 'Meet the people here. Use /bio to make or update your own card.',
            reason: `Bio channel requested by ${interaction.user.id}`,
          });
        } catch {
          throw new RangeError('I could not make a Bio channel. Give Bio Manage Channels permission, or run /setup in a channel you want to use.');
        }
      }
      const enabled = await board.enable({ guildId: interaction.guildId, channel });
      if (!enabled.ok) throw new RangeError(enabled.message || 'The Bio channel could not be enabled.');
      if (!previousId) {
        try { await channel.send(startCardPayload()); }
        catch {
          await board.disable({ guildId: interaction.guildId, channel });
          throw new RangeError('I could not post in that channel. Give Bio Send Messages and Embed Links there, then try again.');
        }
      }
      const reconciled = await reconcileBoardGuild({ store, media, board, guild: interaction.guild, client: interaction.client });
      const count = reconciled.outcomes?.filter((outcome) => outcome.ok && outcome.code === 'published').length || 0;
      const note = reconciled.ok ? '' : ' Some existing public cards could not sync; check the bot’s channel permissions.';
      return interaction.editReply(setupPayload(interaction, `Bio channel: <#${channel.id}>. New members appear after they choose Publish; their edits update the same card.${count ? ` Added ${count} previously opted-in cards.` : ''}${note}`));
    }
    if (action === 'board-off') {
      if (!board) throw new RangeError('The Bio channel is unavailable right now.');
      const previousId = store.getGuildSettings(interaction.guildId).bio_board_channel_id;
      if (!previousId) return interaction.update(setupPayload(interaction, 'The Bio channel is already off.'));
      await interaction.deferUpdate();
      const channel = await boardChannel(interaction.guild);
      if (channel) {
        const disabled = await board.disable({ guildId: interaction.guildId, channel });
        if (!disabled.ok) throw new RangeError(disabled.message || 'The public Bio cards could not be removed.');
      } else {
        for (const tracked of store.listBioBoardMessages(interaction.guildId)) {
          store.deleteBioBoardMessage(interaction.guildId, tracked.user_id);
        }
        store.clearBoardOptIns(interaction.guildId);
        store.updateGuildSettings(interaction.guildId, { bio_board_channel_id: null });
      }
      return interaction.editReply(setupPayload(interaction, 'Turned off public Bio cards. The channel itself was left for the server to use.'));
    }
    if (action === 'prompt') {
      if (!store.getGuildSettings(interaction.guildId).bio_board_channel_id) throw new RangeError('Create a Bio channel before posting a prompt.');
      return interaction.showModal(bioPromptModal(ownerId));
    }
    if (action === 'add' || action === 'remove') return interaction.showModal(setupInterestsModal(action, ownerId));
    if (action === 'limit') {
      return interaction.showModal(setupLimitModal(ownerId, store.getGuildSettings(interaction.guildId).max_tags_per_user));
    }
    if (action === 'packs') {
      clearTagPackDrafts(ownerId, interaction.guildId);
      return interaction.update(starterPackPickerPayload(ownerId));
    }
    if (action === 'home') {
      clearTagPackDrafts(ownerId, interaction.guildId);
      return interaction.update(setupPayload(interaction));
    }
    if (action === 'pack') {
      const pack = getStarterPack(interaction.values?.[0]);
      if (!pack) throw new RangeError('Choose a valid group of tag suggestions.');
      clearTagPackDrafts(ownerId, interaction.guildId);
      const id = randomUUID().replaceAll('-', '').slice(0, 12);
      const draft = {
        ownerId,
        guildId: interaction.guildId,
        packId: pack.id,
        selectedSlugs: new Set(),
        expiresAt: currentTimeMs() + (15 * 60 * 1000),
      };
      tagPackDrafts.set(id, draft);
      return interaction.update(starterPackReviewPayload(interaction, id, draft));
    }
    if (['pick', 'all', 'clear', 'back', 'cancel', 'apply'].includes(action)) {
      const draft = requireTagPackDraft(interaction, ownerId, draftId);
      const pack = getStarterPack(draft.packId);
      const offeredSlugs = new Set(pack.interests.map((interest) => interest.slug));
      const existingSlugs = existingStarterPackSlugs(interaction.guildId, pack);
      if (action === 'pick') {
        const selected = [...new Set(interaction.values || [])];
        if (selected.some((slug) => !offeredSlugs.has(slug))) throw new RangeError('Choose tags from this suggestion group only.');
        if (selected.some((slug) => existingSlugs.has(slug))) throw new RangeError('One of those tags is already in this server. Refresh the suggestions and try again.');
        draft.selectedSlugs = new Set(selected);
        return interaction.update(starterPackReviewPayload(interaction, draftId, draft));
      }
      if (action === 'all') {
        draft.selectedSlugs = new Set(pack.interests.filter((interest) => !existingSlugs.has(interest.slug)).map((interest) => interest.slug));
        return interaction.update(starterPackReviewPayload(interaction, draftId, draft));
      }
      if (action === 'clear') {
        draft.selectedSlugs.clear();
        return interaction.update(starterPackReviewPayload(interaction, draftId, draft));
      }
      if (action === 'back') {
        tagPackDrafts.delete(draftId);
        return interaction.update(starterPackPickerPayload(ownerId));
      }
      if (action === 'cancel') {
        tagPackDrafts.delete(draftId);
        return interaction.update(setupPayload(interaction, 'No starter tags were added.'));
      }
      const selected = [...draft.selectedSlugs];
      if (!selected.length) throw new RangeError('Select at least one tag before adding it.');
      if (selected.some((slug) => !offeredSlugs.has(slug))) throw new RangeError('That tag selection is no longer valid.');
      let added = 0;
      store.transaction(() => {
        for (const interest of pack.interests) {
          if (!draft.selectedSlugs.has(interest.slug) || store.getTag(interaction.guildId, interest.slug)) continue;
          store.addTag(interaction.guildId, interest.slug, interest.name, interaction.user.id, `starter:${pack.id}`, { bypassUgc: true });
          added += 1;
        }
      });
      tagPackDrafts.delete(draftId);
      const message = added
        ? `Added ${added} selected starter tag${added === 1 ? '' : 's'}. Existing server tags were left alone.`
        : 'Those tags were already in the server, so nothing new was added.';
      return interaction.update(setupPayload(interaction, message));
    }
    if (action === 'tags' || action === 'gathers') {
      const key = action === 'tags' ? 'allow_ugc_tags' : 'allow_gathers';
      const settings = store.getGuildSettings(interaction.guildId);
      const updated = store.updateGuildSettings(interaction.guildId, { [key]: !settings[key] });
      return interaction.update(setupPayload(interaction, `Saved: ${action === 'tags' ? 'member suggestions' : 'group invites'} are ${updated[key] ? 'on' : 'off'}.`));
    }
    if (action === 'post') {
      await interaction.channel.send(startCardPayload());
      return interaction.update(setupPayload(interaction, 'Posted a start card in this channel.'));
    }
  }

  function parseSetupNames(raw) {
    const names = new Map();
    for (const part of String(raw || '').split(',')) {
      const displayName = safeDisplayText(part, { maxLength: 81 });
      const slug = normalizeInterestSlug(displayName);
      if (!slug) continue;
      if (displayName.length > 80) throw new RangeError(`“${displayName.slice(0, 40)}…” is too long. Keep each interest under 80 characters.`);
      if (!names.has(slug)) names.set(slug, displayName);
    }
    if (!names.size) throw new RangeError('Add at least one interest name.');
    if (names.size > 25) throw new RangeError('Add or remove up to 25 interests at a time.');
    return names;
  }

  async function handleSetupModal(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That setup editor belongs to someone else.');
    requireManageGuild(interaction);
    if (action === 'prompt') {
      const question = String(interaction.fields.getTextInputValue('question') || '').trim();
      if (!question) throw new RangeError('Write a question for people to answer.');
      await interaction.deferReply({ flags: PRIVATE });
      const channel = await boardChannel(interaction.guild);
      if (!channel?.send) throw new RangeError('The Bio channel is unavailable right now.');
      await channel.send(bioPromptPayload(question));
      return interaction.editReply(withNoMentions(`Posted your question in <#${channel.id}>. People can update their Bio from that prompt.`));
    }
    if (action === 'limit') {
      const raw = interaction.fields.getTextInputValue('limit').trim();
      if (!/^\d{1,2}$/.test(raw)) throw new RangeError('Use a whole number from 1 to 30.');
      const limit = Number(raw);
      if (limit < 1 || limit > 30) throw new RangeError('Use a whole number from 1 to 30.');
      store.updateGuildSettings(interaction.guildId, { max_tags_per_user: limit });
      return privateReply(interaction, setupPayload(interaction, `Profiles can now use up to ${limit} interests.`));
    }
    const names = parseSetupNames(interaction.fields.getTextInputValue('interests'));
    if (action === 'add') {
      await interaction.deferReply({ flags: PRIVATE });
      const category = safeDisplayText(interaction.fields.getTextInputValue('category'), { maxLength: 32, fallback: 'general' });
      store.transaction(() => {
        for (const [slug, displayName] of names) {
          store.addTag(interaction.guildId, slug, displayName, interaction.user.id, category, { bypassUgc: true });
        }
      });
      const warning = await refreshBoardCards(interaction);
      return interaction.editReply(setupPayload(interaction, `Added ${names.size} server interest${names.size === 1 ? '' : 's'}.${warning ? ` ${warning}` : ''}`));
    }
    if (action === 'remove') {
      await interaction.deferReply({ flags: PRIVATE });
      let removed = 0;
      store.transaction(() => {
        for (const slug of names.keys()) if (store.removeTag(interaction.guildId, slug)) removed += 1;
      });
      const warning = removed ? await refreshBoardCards(interaction) : null;
      return interaction.editReply(setupPayload(interaction, `${removed ? `Removed ${removed} server interest${removed === 1 ? '' : 's'} and cleared them from member cards.` : 'None of those names were in the server interest list.'}${warning ? ` ${warning}` : ''}`));
    }
    throw new RangeError('That setup editor is no longer available.');
  }

  async function handleStartCard(interaction) {
    if (interaction.customId === 'start:bio') {
      await interaction.deferReply({ flags: PRIVATE });
      return showBioHome(interaction, { forcePrivate: true });
    }
    if (interaction.customId === 'start:find') return handleFind(interaction);
  }

  async function handleHelp(interaction) {
    return privateReply(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x786752)
        .setTitle('Bio')
        .setDescription('A member directory for finding shared interests and making contact by choice.')
        .addFields(
          { name: 'Start', value: '`/bio` starts with one line about what someone could talk to you about. Your card stays private until you choose to share it. Add interests, your own photo, a vibe, or a title whenever you want.' },
          { name: 'Bio channel', value: 'If this server has a Bio channel, choose **Publish** in your Sharing options to place your card there. Later edits update the same card, and you can remove it again.' },
          { name: 'Show a card', value: '`/view` posts your card in the channel by default. Choose a member to show their opted-in card, or set `visible:false` to keep the result to yourself.' },
          { name: 'Find people', value: '`/find` quietly shows opted-in people and server interests. Right-click a member and choose **View Bio** for a private look.' },
          { name: 'Make contact', value: '`/connect member:@someone` sends a private request they can accept, decline, or block.' },
          { name: 'Invite a group', value: '`/invite` shows a private preview before it notifies opted-in members. Invitees can RSVP, then the host can open a private conversation.' },
          { name: 'Interaction notes (optional)', value: 'The last control in `/bio` lets you share preferences only if that would help.' },
        )],
    });
  }

  return async function handleInteraction(interaction) {
    try {
      if ((interaction.isButton?.() || interaction.isUserSelectMenu?.()) && interaction.customId?.startsWith('conn:')) {
        return await handleConnectionComponent(interaction);
      }
      if (!interaction.inGuild?.()) {
        if (interaction.isAutocomplete?.()) return await interaction.respond([]);
        return await privateReply(interaction, 'Bio works inside a server.');
      }
      store.ensureGuild(interaction.guildId);
      if (interaction.isAutocomplete?.()) return await handleAutocomplete(interaction);
      if (interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isRoleSelectMenu?.() || interaction.isUserSelectMenu?.()) {
        if (interaction.customId.startsWith('bdry:')) return await boundaries.handleComponent(interaction);
        if (interaction.customId.startsWith('board:')) return await handleBoardComponent(interaction);
        if (interaction.customId.startsWith('bio:')) return await handleBioComponent(interaction);
        if (interaction.customId.startsWith('find:')) return await handleFindComponent(interaction);
        if (interaction.customId.startsWith('style:')) return await handleStyleComponent(interaction);
        if (interaction.customId.startsWith('share:')) return await handleSharingPreset(interaction);
        if (interaction.customId.startsWith('invite:')) return await handleInviteComponent(interaction);
        if (interaction.customId.startsWith('gather:')) return await handleGatherComponent(interaction);
        if (interaction.customId.startsWith('setup:')) return await handleSetupComponent(interaction);
        if (interaction.customId.startsWith('start:')) return await handleStartCard(interaction);
        if (interaction.customId.startsWith('pref:')) return await handlePreference(interaction);
        if (interaction.customId.startsWith('profile-delete:')) return await handleDelete(interaction);
        return;
      }
      if (interaction.isModalSubmit?.()) {
        if (interaction.customId.startsWith('bdry:')) return await boundaries.handleModal(interaction);
        if (interaction.customId.startsWith('profile:')) return await handleProfileModal(interaction);
        if (interaction.customId.startsWith('style:')) return await handleStyleModal(interaction);
        if (interaction.customId.startsWith('setup:')) return await handleSetupModal(interaction);
        if (interaction.customId.startsWith('connect:request:')) {
          const targetId = interaction.customId.split(':')[2];
          const target = await interaction.client.users.fetch(targetId);
          return await sendConnection(interaction, target, interaction.fields.getTextInputValue('message'));
        }
        return;
      }
      if (interaction.isUserContextMenuCommand?.()) {
        if (interaction.commandName === 'View Bio' || interaction.commandName === 'View profile') return await showProfile(interaction, interaction.targetUser.id);
        if (interaction.commandName === 'Request connection' || interaction.commandName === 'Connect') {
          if (interaction.targetUser.id === interaction.user.id) throw new RangeError('Choose another member.');
          return await interaction.showModal(connectModal(interaction.targetUser.id));
        }
      }
      if (!interaction.isChatInputCommand?.()) return;
      if (interaction.commandName === 'bio') return await handleBio(interaction);
      if (interaction.commandName === 'view') return await handleView(interaction);
      if (interaction.commandName === 'find') return await handleFind(interaction);
      if (interaction.commandName === 'connect') return await handleConnect(interaction);
      if (interaction.commandName === 'invite') return await handleInvite(interaction);
      if (interaction.commandName === 'setup') return await handleSetup(interaction);
      if (interaction.commandName === 'help') return await handleHelp(interaction);
      if (interaction.commandName === 'profile') return await handleProfile(interaction);
      if (interaction.commandName === 'discover') return await handleFind(interaction);
      if (interaction.commandName === 'gather') return await handleInvite(interaction);
      if (interaction.commandName === 'boundaries') return await handleBoundaries(interaction);
      if (interaction.commandName === 'tags') return await handleTags(interaction);
      if (interaction.commandName === 'settings') return await handleSettings(interaction);
    } catch (error) {
      logger.error('Interaction failed', { command: interaction.commandName || interaction.customId, error });
      try { await privateReply(interaction, friendlyError(error)); } catch (replyError) { logger.error('Could not report interaction failure', replyError); }
    }
  };
}

export function createBot({ store, media, logger = console, now } = {}) {
  if (!store || !media) throw new TypeError('store and media are required');
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], partials: [Partials.GuildMember] });
  const connections = createConnectionService({ store, client, now });
  const gather = createGatherService({ store, now });
  const rsvp = createGatherRsvpService({ store, now });
  const board = createBioBoardService({ store });
  const boundaries = createBoundariesController({ store });
  client.on(Events.InteractionCreate, createInteractionHandler({ store, media, connections, gather, rsvp, board, boundaries, logger, now }));
  client.on(Events.GuildCreate, (guild) => store.ensureGuild(guild.id));
  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      const tracked = store.getBioBoardMessage(member.guild.id, member.id);
      if (tracked) {
        const channel = await channelFor(member.guild, tracked.channel_id);
        if (channel) {
          const removed = await board.unpublish({ guildId: member.guild.id, userId: member.id, channel });
          if (!removed.ok) throw new Error(removed.message || 'Could not remove departing member card');
        } else store.deleteBioBoardMessage(member.guild.id, member.id);
      }
      await media.remove(member.guild.id, member.id);
      store.deleteUserData(member.guild.id, member.id);
    } catch (error) {
      logger.error('Could not remove departing member data', { guildId: member.guild.id, userId: member.id, error });
    }
  });
  client.once(Events.ClientReady, async (readyClient) => {
    for (const guild of readyClient.guilds.cache.values()) store.ensureGuild(guild.id);
    logger.log(`Bio ready as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} server(s).`);
    for (const configured of store.listBoardGuilds()) {
      const guild = readyClient.guilds.cache.get(configured.guild_id);
      if (!guild) continue;
      try {
        const synced = await reconcileBoardGuild({ store, media, board, guild, client: readyClient });
        if (!synced.ok) logger.warn?.('Some public Bio cards could not reconcile', { guildId: guild.id, outcomes: synced.outcomes });
      } catch (error) {
        logger.error('Could not reconcile public Bio channel', { guildId: guild.id, error });
      }
    }
  });
  client.on(Events.Error, (error) => logger.error('Discord client error', error));
  return client;
}
