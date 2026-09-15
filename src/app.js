import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
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
import { canViewBoundaries, normalizeInterestSlug, parseInterests, safeDisplayText } from './domain.js';
import { createGatherService } from './gather.js';
import { buildProfilePayload } from './profile-view.js';
import { buildBoundariesEmbed } from './modules/boundaries/embed.js';
import { createBoundariesController } from './modules/boundaries/wizard.js';
import { CARD_ART_PRESETS, getCardArtPreset, markerForCardArt } from './profile-presets.js';

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

function preferenceRows(profile, ownerId) {
  const toggle = (field, value, label) => new ButtonBuilder()
    .setCustomId(`pref:${field}:${value ? 0 : 1}:${ownerId}`)
    .setStyle(value ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setLabel(`${label}: ${value ? 'on' : 'off'}`);
  return [new ActionRowBuilder().addComponents(
    toggle('discoverable', profile.discoverable, 'Directory'),
    toggle('allow_requests', profile.allow_requests, 'Requests'),
    toggle('allow_group_pings', profile.allow_group_pings, 'Group calls'),
  )];
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

const PATHS = Object.freeze({
  meet: { label: 'Meet people', description: 'Casual conversation and new friends', openTo: 'casual conversation and meeting new people' },
  play: { label: 'Find people to play with', description: 'Games, campaigns, and pickup sessions', openTo: 'co-op games, campaigns, or game nights' },
  make: { label: 'Make things together', description: 'Creative projects and useful feedback', openTo: 'creative projects, collaboration, and sharing feedback' },
  study: { label: 'Study together', description: 'Study sessions and project help', openTo: 'study sessions, project help, and accountability' },
  card: { label: 'Just make my card', description: 'Start private and decide the rest later', openTo: '' },
});

const STARTER_PACKS = Object.freeze({
  community: ['Introductions', 'Local events', 'Food', 'Music'],
  study: ['Study buddies', 'Homework', 'Project help', 'Accountability'],
  creative: ['Art', 'Writing', 'Photography', 'Music making'],
  gaming: ['Co-op games', 'Board games', 'RPGs', 'Game nights'],
});

function homeRows(ownerId, { hasProfile = true } = {}) {
  if (!hasProfile) return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bio:write:${ownerId}`).setStyle(ButtonStyle.Primary).setLabel('Write from scratch'),
    ),
  ];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bio:edit:${ownerId}`).setStyle(ButtonStyle.Primary).setLabel('Edit card'),
      new ButtonBuilder().setCustomId(`bio:style:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Picture & style'),
      new ButtonBuilder().setCustomId(`bio:sharing:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Sharing'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bio:more:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('More'),
      new ButtonBuilder().setCustomId(`bio:notes:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Interaction notes (optional)'),
    ),
  ];
}

function pathSelect(ownerId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`bio:path:${ownerId}`)
      .setPlaceholder('What are you here for?')
      .addOptions(Object.entries(PATHS).map(([value, path]) => ({ label: path.label, description: path.description, value }))),
  );
}

function sharingRows(ownerId) {
  const option = (preset, label, style) => new ButtonBuilder()
    .setCustomId(`share:${preset}:${ownerId}`).setStyle(style).setLabel(label);
  return [new ActionRowBuilder().addComponents(
    option('private', 'Private for now', ButtonStyle.Secondary),
    option('hellos', 'Open to hellos', ButtonStyle.Primary),
    option('groups', 'Open to groups', ButtonStyle.Success),
  )];
}

function backToBioRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bio:home:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Back to Bio'),
  );
}

function styleRows(ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`style:preset:${ownerId}`).setPlaceholder('Choose card art')
        .addOptions(CARD_ART_PRESETS.map((preset) => ({ label: preset.name, value: preset.id, description: preset.description.slice(0, 100) }))),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`style:remove:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Use Discord avatar'),
      new ButtonBuilder().setCustomId(`bio:home:${ownerId}`).setStyle(ButtonStyle.Secondary).setLabel('Back to Bio'),
    ),
  ];
}

function setupRows(ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`setup:pack:${ownerId}`).setPlaceholder('Add a starter interest pack')
        .addOptions(Object.keys(STARTER_PACKS).map((value) => ({ label: `${value[0].toUpperCase()}${value.slice(1)} pack`, value }))),
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
    ),
  ];
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

export function createInteractionHandler({ store, media, connections, gather, boundaries, logger = console }) {
  const invitationDrafts = new Map();
  let invitationDraftSequence = 0;
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

  async function showProfile(interaction, userId, { shared = false } = {}) {
    const stored = store.getProfile(interaction.guildId, userId);
    if (!stored) throw new RangeError('That member has not made a profile yet.');
    if (userId !== interaction.user.id && !stored.discoverable) {
      throw new RangeError('That member has kept their profile private.');
    }
    await interaction.deferReply(shared ? {} : { flags: PRIVATE });
    const payload = await profilePayload({ store, media, interaction, userId, includeStatus: true, includeBoundaries: !shared });
    return interaction.editReply(withNoMentions(payload));
  }

  async function showBioHome(interaction, { uploaded = false, forcePrivate = false } = {}) {
    const respond = (payload) => (!forcePrivate && (interaction.isButton?.() || interaction.isStringSelectMenu?.()))
      ? interaction.update(withNoMentions(payload))
      : privateReply(interaction, payload);
    const profile = store.getProfile(interaction.guildId, interaction.user.id);
    if (!profile) {
      return respond({
        embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Make a small corner of this server yours')
          .setDescription('Bio starts private. Pick a reason to begin, write a card, then choose exactly how people can find or contact you.')],
        components: [pathSelect(interaction.user.id), ...homeRows(interaction.user.id, { hasProfile: false })],
      });
    }
    const payload = await profilePayload({ store, media, interaction, userId: interaction.user.id });
    return respond({
      content: uploaded ? 'Saved your picture. Your card is still private until you change Sharing.' : 'This is your private Bio home. Interaction notes are optional and always last.',
      ...payload,
      components: homeRows(interaction.user.id),
    });
  }

  async function openProfileEditor(interaction, suggestedOpenTo = '') {
    const profile = store.getProfile(interaction.guildId, interaction.user.id);
    const tags = profile ? store.listUserTags(interaction.guildId, interaction.user.id) : [];
    return interaction.showModal(profileModal(profile ? { ...profile, open_to: profile.open_to || suggestedOpenTo } : { open_to: suggestedOpenTo }, tags, interaction.user.id));
  }

  async function handleBio(interaction) {
    const picture = interaction.options.getAttachment?.('picture');
    if (picture) {
      await interaction.deferReply({ flags: PRIVATE });
      await ensureProfile(store, interaction.guildId, interaction.user.id);
      const marker = await media.save(interaction.guildId, interaction.user.id, picture);
      store.transaction(() => {
        store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: marker });
        store.updateTheme(interaction.guildId, interaction.user.id, {
          theme: null, primary_color: null, secondary_color: null, title: null, tags_emoji: null,
        });
      });
      return showBioHome(interaction, { uploaded: true });
    }
    return showBioHome(interaction);
  }

  async function handleBioComponent(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId && ownerId !== interaction.user.id) throw new RangeError('That Bio control belongs to someone else.');
    if (action === 'path') {
      const path = interaction.values?.[0];
      const suggested = PATHS[path]?.openTo || '';
      return openProfileEditor(interaction, suggested);
    }
    if (action === 'write' || action === 'edit') return openProfileEditor(interaction);
    if (action === 'home') return showBioHome(interaction);
    if (action === 'style') {
      return interaction.update(withNoMentions({
        content: 'Choose bundled card art, use your Discord avatar, or upload your own image with `/bio picture:`. Choosing a preset removes any uploaded Bio image.',
        components: styleRows(interaction.user.id), embeds: [],
      }));
    }
    if (action === 'sharing') {
      const profile = await ensureProfile(store, interaction.guildId, interaction.user.id);
      return interaction.update(withNoMentions({
        content: `Sharing is your choice. Current: directory ${profile.discoverable ? 'on' : 'off'}, requests ${profile.allow_requests ? 'on' : 'off'}, group invites ${profile.allow_group_pings ? 'on' : 'off'}.`,
        components: [...sharingRows(interaction.user.id), ...preferenceRows(profile, interaction.user.id), backToBioRow(interaction.user.id)], embeds: [],
      }));
    }
    if (action === 'notes') {
      return boundaries.startEdit(interaction);
    }
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
    if (action === 'share') return showProfile(interaction, interaction.user.id, { shared: true });
  }

  async function handleStyleComponent(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That style control belongs to someone else.');
    if (action === 'preset') {
      const preset = getCardArtPreset(interaction.values?.[0]);
      if (!preset) throw new RangeError('Choose a valid card art preset.');
      store.transaction(() => {
        store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: markerForCardArt(preset.id) });
        store.updateTheme(interaction.guildId, interaction.user.id, {
          theme: preset.id, primary_color: preset.primaryColor, secondary_color: null, title: preset.title, tags_emoji: preset.tagsEmoji,
        });
      });
      try { await media.remove(interaction.guildId, interaction.user.id); } catch (error) {
        logger.warn?.('Could not clean up a replaced Bio upload', { guildId: interaction.guildId, userId: interaction.user.id, error });
      }
      const payload = await profilePayload({ store, media, interaction, userId: interaction.user.id });
      return interaction.update(withNoMentions({ content: `${preset.name} is now the art on your card.`, ...payload, components: styleRows(interaction.user.id) }));
    }
    if (action === 'remove') {
      store.transaction(() => {
        store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: null });
        store.updateTheme(interaction.guildId, interaction.user.id, {
          theme: null, primary_color: null, secondary_color: null, title: null, tags_emoji: null,
        });
      });
      try { await media.remove(interaction.guildId, interaction.user.id); } catch (error) {
        logger.warn?.('Could not clean up a removed Bio upload', { guildId: interaction.guildId, userId: interaction.user.id, error });
      }
      const payload = await profilePayload({ store, media, interaction, userId: interaction.user.id });
      return interaction.update(withNoMentions({ content: 'Your card now uses your Discord avatar. You can choose bundled art anytime.', ...payload, components: styleRows(interaction.user.id) }));
    }
  }

  async function handleSharingPreset(interaction) {
    const [, preset, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('Those sharing choices belong to someone else.');
    const patches = {
      private: { discoverable: false, allow_requests: false, allow_group_pings: false },
      hellos: { discoverable: true, allow_requests: true, allow_group_pings: false },
      groups: { discoverable: true, allow_requests: true, allow_group_pings: true },
    };
    if (!patches[preset]) throw new RangeError('That sharing choice no longer exists.');
    const profile = store.updatePrivacy(interaction.guildId, interaction.user.id, patches[preset]);
    return interaction.update(withNoMentions({
      content: preset === 'private' ? 'Saved: private for now.' : preset === 'hellos' ? 'Saved: people can find you and send private requests.' : 'Saved: you are open to directory, private hellos, and matching group invites.',
      components: [...sharingRows(interaction.user.id), ...preferenceRows(profile, interaction.user.id), backToBioRow(interaction.user.id)], embeds: [],
    }));
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
    if (!group && sub === 'share') return showProfile(interaction, interaction.user.id, { shared: true });
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
      const profile = store.updatePrivacy(interaction.guildId, interaction.user.id, patch);
      return privateReply(interaction, {
        content: 'Saved. You can change these choices at any time.',
        components: preferenceRows(profile, interaction.user.id),
      });
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
      const tags = sub === 'add'
        ? await addInterests(store, interaction.guildId, interaction.user.id, raw)
        : (() => {
          for (const slug of parseInterests(raw, { max: 100 })) store.removeUserTag(interaction.guildId, interaction.user.id, slug);
          return store.listUserTags(interaction.guildId, interaction.user.id);
        })();
      return privateReply(interaction, tags.length ? `Saved: ${tags.map((tag) => tag.display_name).join(' · ')}` : 'Your interest list is empty.');
    }
    if (group === 'image') {
      if (sub === 'set') {
        await interaction.deferReply({ flags: PRIVATE });
        await ensureProfile(store, interaction.guildId, interaction.user.id);
        const marker = await media.save(interaction.guildId, interaction.user.id, interaction.options.getAttachment('image', true));
        store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: marker });
        return interaction.editReply(withNoMentions('Saved your profile image to Bio’s own storage.'));
      }
      await media.remove(interaction.guildId, interaction.user.id);
      if (store.getProfile(interaction.guildId, interaction.user.id)) store.saveProfile(interaction.guildId, interaction.user.id, { profile_image: null });
      return privateReply(interaction, 'Your profile now uses your Discord avatar.');
    }
  }

  async function handleProfileModal(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (action !== 'edit' || ownerId !== interaction.user.id) throw new RangeError('That profile editor is not yours.');
    await interaction.deferReply({ flags: PRIVATE });
    const existed = store.getProfile(interaction.guildId, interaction.user.id);
    const interestPlan = planInterests(store, interaction.guildId, interaction.fields.getTextInputValue('interests'));
    const { profile, tags } = store.transaction(() => {
      const savedProfile = store.saveProfile(interaction.guildId, interaction.user.id, {
        bio: interaction.fields.getTextInputValue('bio'),
        pronouns: interaction.fields.getTextInputValue('pronouns'),
        open_to: interaction.fields.getTextInputValue('open_to'),
        ...(existed ? {} : { discoverable: false, allow_requests: false, allow_group_pings: false }),
      });
      return { profile: savedProfile, tags: applyInterestPlan(store, interaction.guildId, interaction.user.id, interestPlan) };
    });
    const payload = await profilePayload({ store, media, interaction, userId: interaction.user.id });
    await interaction.editReply(withNoMentions({
      content: existed ? 'Profile saved. Choose a quick sharing preset below, or leave your choices as they are.' : 'Profile saved privately. Choose a quick sharing preset below, or keep it private. Picture & style is ready when you want it.',
      ...payload,
      components: [...sharingRows(interaction.user.id), ...homeRows(interaction.user.id)],
    }));
    return tags;
  }

  async function handlePreference(interaction) {
    const [, field, rawValue, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('Those preferences belong to someone else.');
    if (!['discoverable', 'allow_requests', 'allow_group_pings'].includes(field)) throw new RangeError('That preference no longer exists.');
    const profile = store.updatePrivacy(interaction.guildId, interaction.user.id, { [field]: rawValue === '1' });
    await interaction.update(withNoMentions({ content: 'Saved. You can change these choices at any time.', components: [...sharingRows(ownerId), ...preferenceRows(profile, ownerId), backToBioRow(ownerId)], embeds: [] }));
  }

  async function handleDelete(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That choice belongs to someone else.');
    if (action === 'cancel') return interaction.update({ content: 'Kept your Bio data.', components: [], embeds: [] });
    await media.remove(interaction.guildId, interaction.user.id);
    store.deleteUserData(interaction.guildId, interaction.user.id);
    return interaction.update({ content: 'Your Bio data was deleted from this server.', components: [], embeds: [] });
  }

  async function handleFind(interaction) {
    await interaction.deferReply({ flags: PRIVATE });
    const raw = interaction.options?.getString?.('interest') || null;
    const tag = raw ? normalizeInterestSlug(raw) : null;
    const profiles = store.discoverProfiles(interaction.guildId, { tag, limit: 25 });
    const people = [];
    for (const profile of profiles) {
      const member = await memberFor(interaction.guild, profile.user_id);
      if (!member || member.user?.bot) continue;
      const about = safeDisplayText(profile.bio, { maxLength: 120, fallback: 'No bio yet.' });
      people.push(`**${safeDisplayText(member.displayName, { maxLength: 80 })}** · <@${profile.user_id}>\n${about}`);
      if (people.length === 10) break;
    }
    const heading = tag && store.getTag(interaction.guildId, tag)?.display_name;
    const interestRows = tag ? [] : store.listTags(interaction.guildId, 18)
      .map((entry) => `${safeDisplayText(entry.display_name, { maxLength: 70 })} · ${entry.member_count}`);
    return interaction.editReply(withNoMentions(people.length
      ? { embeds: [new EmbedBuilder().setColor(0x786752).setTitle(heading ? `People into ${heading}` : 'Browse people').setDescription(people.join('\n\n').slice(0, 4096)).addFields(interestRows.length ? [{ name: 'Interests in this server', value: interestRows.join(' · ').slice(0, 1024) }] : []).setFooter({ text: 'Looking here never notifies anyone.' })] }
      : tag ? 'No opted-in members matched that interest.' : interestRows.length ? { embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Browse Bio').setDescription('No one has opened their card to the directory yet. These are the interests people can use when they do.').addFields({ name: 'Server interests', value: interestRows.join(' · ').slice(0, 1024) })] } : 'No one has opened their card to the directory yet. Try `/bio` to make the first one.'));
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
    const content = action === 'accept' ? 'Accepted. Bio let them know privately.' : 'Declined. Bio did not share anything else.';
    return interaction.editReply({ content: result.ok ? content : result.message, embeds: [], components: [] });
  }

  async function handleInvite(interaction) {
    await interaction.deferReply({ flags: PRIVATE });
    const interests = parseInterests(interaction.options.getString('interests', true), { max: 5 });
    if (!interests.length) throw new RangeError('Choose at least one interest.');
    const result = await gather.prepare({ guild: interaction.guild, senderId: interaction.user.id, interestSlugs: interests, message: interaction.options.getString('message', true) });
    if (!result.ok) return interaction.editReply(withNoMentions(result.message));
    const draftId = `${Date.now().toString(36)}${(++invitationDraftSequence).toString(36)}`;
    invitationDrafts.set(draftId, { ownerId: interaction.user.id, guildId: interaction.guildId, expiresAt: Date.now() + 10 * 60 * 1000, result });
    return interaction.editReply(withNoMentions({
      embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Preview your invite').setDescription(
        `This will post to this channel and notify **${result.recipientIds.length}** opted-in member${result.recipientIds.length === 1 ? '' : 's'}. It does not send until you confirm.`
      ).addFields(
        { name: 'Interests', value: result.interestSlugs.map((slug) => store.getTag?.(interaction.guildId, slug)?.display_name || slug).join(' · '), inline: false },
        { name: 'Message', value: safeDisplayText(interaction.options.getString('message', true), { maxLength: 500 }), inline: false },
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
    try {
      await interaction.channel.send(result.payload);
    } catch (error) {
      result.rollback();
      throw error;
    }
    return interaction.editReply(withNoMentions({ content: `Sent the invitation to ${result.recipientIds.length} opted-in ${result.recipientIds.length === 1 ? 'member' : 'members'}.`, components: [], embeds: [] }));
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
    if (sub === 'remove') return privateReply(interaction, store.removeTag(interaction.guildId, slug) ? 'Removed that interest from the server list and member profiles.' : 'That interest was not in the server list.');
    const tag = store.addTag(interaction.guildId, slug, interaction.options.getString('display', true), interaction.user.id, interaction.options.getString('category') || 'general', { bypassUgc: true });
    return privateReply(interaction, `Saved ${tag.display_name}.`);
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
      : 'None yet. Add a starter pack or your own names below.';
    return new EmbedBuilder().setColor(0x786752).setTitle('Set up Bio')
      .setDescription('Give people a clear, low-pressure way to make a card and find each other. These controls only affect this server.')
      .addFields(
        { name: 'Member-suggested interests', value: settings.allow_ugc_tags ? 'On' : 'Off', inline: true },
        { name: 'Group invites', value: settings.allow_gathers ? 'On' : 'Off', inline: true },
        { name: 'Interests per profile', value: String(settings.max_tags_per_user), inline: true },
        { name: `Server interests · ${tags.length}`, value: safeDisplayText(tagSummary, { maxLength: 1024 }), inline: false },
      );
  }

  function setupPayload(interaction, content = undefined) {
    const settings = store.getGuildSettings(interaction.guildId);
    const tags = store.listTags(interaction.guildId, 500);
    return withNoMentions({
      ...(content ? { content } : {}),
      embeds: [setupEmbed(settings, tags)],
      components: setupRows(interaction.user.id),
    });
  }

  async function handleSetup(interaction) {
    requireManageGuild(interaction);
    return privateReply(interaction, setupPayload(interaction));
  }

  async function handleSetupComponent(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That setup panel belongs to someone else.');
    requireManageGuild(interaction);
    if (action === 'add' || action === 'remove') return interaction.showModal(setupInterestsModal(action, ownerId));
    if (action === 'limit') {
      return interaction.showModal(setupLimitModal(ownerId, store.getGuildSettings(interaction.guildId).max_tags_per_user));
    }
    if (action === 'pack') {
      const pack = interaction.values?.[0];
      const interests = STARTER_PACKS[pack];
      if (!interests) throw new RangeError('Choose a valid starter pack.');
      for (const displayName of interests) {
        const slug = normalizeInterestSlug(displayName);
        if (!store.getTag(interaction.guildId, slug)) store.addTag(interaction.guildId, slug, displayName, interaction.user.id, pack, { bypassUgc: true });
      }
      return interaction.update(setupPayload(interaction, `Added the ${pack} starter pack. Existing interests were left alone.`));
    }
    if (action === 'tags' || action === 'gathers') {
      const key = action === 'tags' ? 'allow_ugc_tags' : 'allow_gathers';
      const settings = store.getGuildSettings(interaction.guildId);
      const updated = store.updateGuildSettings(interaction.guildId, { [key]: !settings[key] });
      return interaction.update(setupPayload(interaction, `Saved: ${action === 'tags' ? 'member suggestions' : 'group invites'} are ${updated[key] ? 'on' : 'off'}.`));
    }
    if (action === 'post') {
      await interaction.channel.send(withNoMentions({
        embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Make this server feel a little smaller')
          .setDescription('Bio cards begin private. Make one when you want, then choose whether people can find you, say hello, or include you in small interest invites.')],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('start:bio').setStyle(ButtonStyle.Primary).setLabel('Open Bio'),
          new ButtonBuilder().setCustomId('start:find').setStyle(ButtonStyle.Secondary).setLabel('Find people'),
        )],
      }));
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
      const category = safeDisplayText(interaction.fields.getTextInputValue('category'), { maxLength: 32, fallback: 'general' });
      store.transaction(() => {
        for (const [slug, displayName] of names) {
          store.addTag(interaction.guildId, slug, displayName, interaction.user.id, category, { bypassUgc: true });
        }
      });
      return privateReply(interaction, setupPayload(interaction, `Added ${names.size} server interest${names.size === 1 ? '' : 's'}.`));
    }
    if (action === 'remove') {
      let removed = 0;
      store.transaction(() => {
        for (const slug of names.keys()) if (store.removeTag(interaction.guildId, slug)) removed += 1;
      });
      return privateReply(interaction, setupPayload(interaction, removed ? `Removed ${removed} server interest${removed === 1 ? '' : 's'} and cleared them from member cards.` : 'None of those names were in the server interest list.'));
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
          { name: 'Start', value: '`/bio` opens your private home. Write a card, choose card art, then decide how it is shared.' },
          { name: 'Find people', value: '`/find` quietly shows opted-in people and server interests. Right-click a member and choose **View Bio** for a direct look.' },
          { name: 'Make contact', value: '`/connect member:@someone` sends a private request they can accept, decline, or block.' },
          { name: 'Invite a group', value: '`/invite` shows a private preview before it notifies opted-in members.' },
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
        if (interaction.customId.startsWith('bio:')) return await handleBioComponent(interaction);
        if (interaction.customId.startsWith('style:')) return await handleStyleComponent(interaction);
        if (interaction.customId.startsWith('share:')) return await handleSharingPreset(interaction);
        if (interaction.customId.startsWith('invite:')) return await handleInviteComponent(interaction);
        if (interaction.customId.startsWith('setup:')) return await handleSetupComponent(interaction);
        if (interaction.customId.startsWith('start:')) return await handleStartCard(interaction);
        if (interaction.customId.startsWith('pref:')) return await handlePreference(interaction);
        if (interaction.customId.startsWith('profile-delete:')) return await handleDelete(interaction);
        return;
      }
      if (interaction.isModalSubmit?.()) {
        if (interaction.customId.startsWith('bdry:')) return await boundaries.handleModal(interaction);
        if (interaction.customId.startsWith('profile:')) return await handleProfileModal(interaction);
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
  const boundaries = createBoundariesController({ store });
  client.on(Events.InteractionCreate, createInteractionHandler({ store, media, connections, gather, boundaries, logger }));
  client.on(Events.GuildCreate, (guild) => store.ensureGuild(guild.id));
  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      await media.remove(member.guild.id, member.id);
      store.deleteUserData(member.guild.id, member.id);
    } catch (error) {
      logger.error('Could not remove departing member data', { guildId: member.guild.id, userId: member.id, error });
    }
  });
  client.once(Events.ClientReady, (readyClient) => {
    for (const guild of readyClient.guilds.cache.values()) store.ensureGuild(guild.id);
    logger.log(`Bio ready as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} server(s).`);
  });
  client.on(Events.Error, (error) => logger.error('Discord client error', error));
  return client;
}
