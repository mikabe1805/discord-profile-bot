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
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { createConnectionService } from './connections.js';
import { canViewBoundaries, normalizeInterestSlug, parseInterests, safeDisplayText } from './domain.js';
import { createGatherService } from './gather.js';
import { buildProfilePayload } from './profile-view.js';
import { buildBoundariesEmbed } from './modules/boundaries/embed.js';
import { createBoundariesController } from './modules/boundaries/wizard.js';

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

async function profilePayload({ store, media, interaction, userId, includeStatus = true }) {
  const profile = store.getProfile(interaction.guildId, userId);
  if (!profile) throw new RangeError('That member has not made a profile yet.');
  const member = await memberFor(interaction.guild, userId);
  const user = member?.user || (interaction.user.id === userId ? interaction.user : await interaction.client.users.fetch(userId).catch(() => null));
  const tags = store.listUserTags(interaction.guildId, userId);
  const theme = store.getTheme(interaction.guildId, userId);
  const boundary = store.getBoundaries(interaction.guildId, userId);
  const viewerMember = await memberFor(interaction.guild, interaction.user.id);
  const visibleBoundary = boundary && canViewBoundaries({
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
    const payload = await profilePayload({ store, media, interaction, userId, includeStatus: true });
    return interaction.editReply(withNoMentions(payload));
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
      content: existed ? 'Profile saved.' : 'Profile saved privately. Turn on only the ways you want people to find or contact you.',
      ...payload,
      components: preferenceRows(profile, interaction.user.id),
    }));
    return tags;
  }

  async function handlePreference(interaction) {
    const [, field, rawValue, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('Those preferences belong to someone else.');
    if (!['discoverable', 'allow_requests', 'allow_group_pings'].includes(field)) throw new RangeError('That preference no longer exists.');
    const profile = store.updatePrivacy(interaction.guildId, interaction.user.id, { [field]: rawValue === '1' });
    await interaction.update(withNoMentions({ content: 'Saved. You can change these choices at any time.', components: preferenceRows(profile, ownerId), embeds: [] }));
  }

  async function handleDelete(interaction) {
    const [, action, ownerId] = interaction.customId.split(':');
    if (ownerId !== interaction.user.id) throw new RangeError('That choice belongs to someone else.');
    if (action === 'cancel') return interaction.update({ content: 'Kept your Bio data.', components: [], embeds: [] });
    await media.remove(interaction.guildId, interaction.user.id);
    store.deleteUserData(interaction.guildId, interaction.user.id);
    return interaction.update({ content: 'Your Bio data was deleted from this server.', components: [], embeds: [] });
  }

  async function handleDiscover(interaction) {
    await interaction.deferReply({ flags: PRIVATE });
    const sub = interaction.options.getSubcommand();
    if (sub === 'interests') {
      const tags = store.listTags(interaction.guildId, 100);
      if (!tags.length) return interaction.editReply(withNoMentions('This server has not added any interests yet.'));
      const lines = tags.map((tag) => `${safeDisplayText(tag.display_name, { maxLength: 80 })} · ${tag.member_count}`);
      return interaction.editReply(withNoMentions({ embeds: [new EmbedBuilder().setColor(0x786752).setTitle('Interests in this server').setDescription(lines.join('\n').slice(0, 4096))] }));
    }
    const raw = interaction.options.getString('interest');
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
    return interaction.editReply(withNoMentions(people.length
      ? { embeds: [new EmbedBuilder().setColor(0x786752).setTitle(heading ? `People into ${heading}` : 'People in this server').setDescription(people.join('\n\n').slice(0, 4096)).setFooter({ text: 'Looking here never notifies anyone.' })] }
      : 'No opted-in members matched that search.'));
  }

  async function sendConnection(interaction, target, message) {
    await interaction.deferReply({ flags: PRIVATE });
    const result = await connections.send({ guild: interaction.guild, sender: interaction.user, target, message });
    return interaction.editReply(withNoMentions(result.ok
      ? `Request sent privately to ${safeDisplayText(target.globalName || target.username, { maxLength: 80 })}.`
      : result.message || 'That request could not be sent.'));
  }

  async function connectionList(interaction, direction) {
    await interaction.deferReply({ flags: PRIVATE });
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
    const sub = interaction.options.getSubcommand();
    if (sub === 'request') return sendConnection(interaction, interaction.options.getUser('user', true), interaction.options.getString('message'));
    if (sub === 'inbox') return connectionList(interaction, 'incoming');
    if (sub === 'sent') return connectionList(interaction, 'outgoing');
    const target = interaction.options.getUser('user', true);
    if (target.id === interaction.user.id) throw new RangeError('Choose another member.');
    if (sub === 'block') {
      store.blockUser(interaction.guildId, interaction.user.id, target.id);
      return privateReply(interaction, `${safeDisplayText(target.globalName || target.username, { maxLength: 80 })} can no longer send you requests.`);
    }
    const removed = store.unblockUser(interaction.guildId, interaction.user.id, target.id);
    return privateReply(interaction, removed ? 'Unblocked. They can send a request again if your requests are open.' : 'That member was not blocked.');
  }

  async function handleConnectionComponent(interaction) {
    const [, action, rawId] = interaction.customId.split(':');
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

  async function handleGather(interaction) {
    await interaction.deferReply({ flags: PRIVATE });
    const interests = parseInterests(interaction.options.getString('interests', true), { max: 5 });
    if (!interests.length) throw new RangeError('Choose at least one interest.');
    const result = await gather.prepare({ guild: interaction.guild, senderId: interaction.user.id, interestSlugs: interests, message: interaction.options.getString('message', true) });
    if (!result.ok) return interaction.editReply(withNoMentions(result.message));
    result.commit();
    try {
      await interaction.channel.send(result.payload);
    } catch (error) {
      result.rollback();
      throw error;
    }
    return interaction.editReply(withNoMentions(`Sent the invitation to ${result.recipientIds.length} opted-in ${result.recipientIds.length === 1 ? 'member' : 'members'}.`));
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

  async function handleHelp(interaction) {
    return privateReply(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x786752)
        .setTitle('Bio')
        .setDescription('A member directory for finding shared interests and making contact by choice.')
        .addFields(
          { name: 'Start', value: '`/profile edit` writes your card. It stays out of the directory until you turn directory visibility on.' },
          { name: 'Find people', value: '`/discover people` searches quietly. Right-click a member and choose **View profile** for a direct look.' },
          { name: 'Make contact', value: '`/connect request` sends a private request they can accept, decline, or block.' },
          { name: 'Invite a group', value: '`/gather` mentions only members who opted into group calls for those interests.' },
          { name: 'Interaction notes', value: '`/boundaries edit` records what helps conversations go well, with visibility you control.' },
        )],
    });
  }

  return async function handleInteraction(interaction) {
    try {
      if (interaction.isButton?.() && interaction.customId?.startsWith('conn:')) {
        return await handleConnectionComponent(interaction);
      }
      if (!interaction.inGuild?.()) {
        if (interaction.isAutocomplete?.()) return await interaction.respond([]);
        return await privateReply(interaction, 'Bio works inside a server.');
      }
      store.ensureGuild(interaction.guildId);
      if (interaction.isAutocomplete?.()) return await handleAutocomplete(interaction);
      if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
        if (interaction.customId.startsWith('bdry:')) return await boundaries.handleComponent(interaction);
        if (interaction.customId.startsWith('pref:')) return await handlePreference(interaction);
        if (interaction.customId.startsWith('profile-delete:')) return await handleDelete(interaction);
        return;
      }
      if (interaction.isModalSubmit?.()) {
        if (interaction.customId.startsWith('bdry:')) return await boundaries.handleModal(interaction);
        if (interaction.customId.startsWith('profile:')) return await handleProfileModal(interaction);
        if (interaction.customId.startsWith('connect:request:')) {
          const targetId = interaction.customId.split(':')[2];
          const target = await interaction.client.users.fetch(targetId);
          return await sendConnection(interaction, target, interaction.fields.getTextInputValue('message'));
        }
        return;
      }
      if (interaction.isUserContextMenuCommand?.()) {
        if (interaction.commandName === 'View profile') return await showProfile(interaction, interaction.targetUser.id);
        if (interaction.commandName === 'Connect') {
          if (interaction.targetUser.id === interaction.user.id) throw new RangeError('Choose another member.');
          return await interaction.showModal(connectModal(interaction.targetUser.id));
        }
      }
      if (!interaction.isChatInputCommand?.()) return;
      if (interaction.commandName === 'profile') return await handleProfile(interaction);
      if (interaction.commandName === 'discover') return await handleDiscover(interaction);
      if (interaction.commandName === 'connect') return await handleConnect(interaction);
      if (interaction.commandName === 'gather') return await handleGather(interaction);
      if (interaction.commandName === 'boundaries') return await handleBoundaries(interaction);
      if (interaction.commandName === 'tags') return await handleTags(interaction);
      if (interaction.commandName === 'settings') return await handleSettings(interaction);
      if (interaction.commandName === 'help') return await handleHelp(interaction);
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
