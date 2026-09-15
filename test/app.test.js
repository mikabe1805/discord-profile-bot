import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { createInteractionHandler } from '../src/app.js';
import { createStore } from '../src/database.js';

const logger = { error() {}, log() {} };
const media = { resolve: async () => null, save: async () => null, remove: async () => {} };
const inactive = {
  connections: { send() {}, respond() {}, blockRequest() {}, listIncoming: () => [], listOutgoing: () => [] },
  gather: { prepare() {} },
  boundaries: { startEdit() {}, handleComponent() {}, handleModal() {} },
};

function baseInteraction(overrides = {}) {
  const replies = [];
  return {
    replies,
    deferred: false,
    replied: false,
    guildId: '200',
    user: { id: '100', username: 'Mika', displayAvatarURL: () => 'https://example.com/avatar.png' },
    guild: {
      id: '200',
      members: {
        cache: new Map([['100', { id: '100', displayName: 'Mika', user: { id: '100', bot: false }, roles: { cache: new Map() }, displayAvatarURL: () => 'https://example.com/avatar.png' }]]),
        fetch: async () => null,
      },
    },
    client: { users: { fetch: async () => null } },
    inGuild: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isModalSubmit: () => false,
    isUserContextMenuCommand: () => false,
    isChatInputCommand: () => false,
    async deferReply(payload) { this.deferred = true; replies.push(['defer', payload]); },
    async editReply(payload) { replies.push(['edit', payload]); return payload; },
    async reply(payload) { this.replied = true; replies.push(['reply', payload]); return payload; },
    async followUp(payload) { replies.push(['followUp', payload]); return payload; },
    async update(payload) { replies.push(['update', payload]); return payload; },
    async deferUpdate() { this.deferred = true; replies.push(['deferUpdate']); },
    async showModal(payload) { replies.push(['modal', payload]); return payload; },
    ...overrides,
  };
}

test('a first profile edit is stored privately and returns explicit consent controls', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const interaction = baseInteraction({
    customId: 'profile:edit:100',
    isModalSubmit: () => true,
    fields: { getTextInputValue: (name) => ({ bio: 'hello', pronouns: 'they/them', open_to: 'board games', interests: 'Board Games, Art' })[name] },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);

  const profile = store.getProfile('200', '100');
  assert.equal(profile.bio, 'hello');
  assert.equal(profile.discoverable, false);
  assert.equal(profile.allow_requests, false);
  assert.equal(profile.allow_group_pings, false);
  assert.deepEqual(store.listUserTags('200', '100').map((tag) => tag.tag_slug), ['art', 'board-games']);
  assert.deepEqual(interaction.replies[0], ['defer', { flags: MessageFlags.Ephemeral }]);
  const response = interaction.replies.at(-1)[1];
  assert.match(response.content, /saved privately/i);
  assert.deepEqual(response.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(response.components[0].components.length, 3);
});

test('a new member gets the private Bio home with a clear first choice', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const interaction = baseInteraction({
    commandName: 'bio',
    isChatInputCommand: () => true,
    options: { getAttachment: () => null },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);

  const response = interaction.replies.at(-1)[1];
  assert.match(response.embeds[0].data.title, /small corner/i);
  assert.equal(response.components.length, 2);
  assert.equal(response.components[0].components[0].data.custom_id, 'bio:path:100');
  assert.equal(response.components[1].components[0].data.label, 'Write from scratch');
  assert.equal(response.flags, MessageFlags.Ephemeral);
});

test('invite commits only after its owner confirms the private preview', async () => {
  const order = [];
  const store = { ensureGuild() {} };
  const gather = {
    async prepare() {
      order.push('prepare');
      return { ok: true, interestSlugs: ['games'], recipientIds: ['300'], payload: { content: '<@300>', allowedMentions: { parse: [], users: ['300'] } }, commit: () => order.push('commit') };
    },
  };
  const interaction = baseInteraction({
    commandName: 'invite',
    isChatInputCommand: () => true,
    options: { getString: (name) => name === 'interests' ? 'games' : 'table tonight' },
    channel: { async send() { order.push('send'); } },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, gather, logger });
  await handler(interaction);
  assert.deepEqual(order, ['prepare']);
  assert.match(interaction.replies.at(-1)[1].embeds[0].data.title, /preview/i);
  const sendId = interaction.replies.at(-1)[1].components[0].components[0].data.custom_id;

  const confirm = baseInteraction({
    customId: sendId,
    isButton: () => true,
    channel: interaction.channel,
  });
  await handler(confirm);
  assert.deepEqual(order, ['prepare', 'commit', 'send']);
  assert.match(confirm.replies.at(-1)[1].content, /1 opted-in member/);
});

test('a failed confirmed invite releases its cooldown reservation', async () => {
  const order = [];
  const store = { ensureGuild() {} };
  const gather = {
    async prepare() {
      order.push('prepare');
      return {
        ok: true,
        interestSlugs: ['games'], recipientIds: ['300'],
        payload: { content: '<@300>', allowedMentions: { parse: [], users: ['300'] } },
        commit: () => order.push('commit'),
        rollback: () => order.push('rollback'),
      };
    },
  };
  const interaction = baseInteraction({
    commandName: 'invite',
    isChatInputCommand: () => true,
    options: { getString: (name) => name === 'interests' ? 'games' : 'table tonight' },
    channel: { async send() { order.push('send'); throw new Error('missing permission'); } },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, gather, logger });
  await handler(interaction);
  const sendId = interaction.replies.at(-1)[1].components[0].components[0].data.custom_id;
  const confirm = baseInteraction({ customId: sendId, isButton: () => true, channel: interaction.channel });
  await handler(confirm);
  assert.deepEqual(order, ['prepare', 'commit', 'send', 'rollback']);
  assert.match(confirm.replies.at(-1)[1].content, /Something went wrong/);
});

test('connection buttons map to persisted accepted and declined states', async () => {
  const calls = [];
  const store = {
    ensureGuild() {},
    getConnectionRequest: () => ({ id: 9, guild_id: '200', sender_id: '300', recipient_id: '100', status: 'pending' }),
  };
  const connections = {
    async respond(payload) { calls.push(payload); return { ok: true }; },
    async blockRequest() { return { ok: true }; },
  };
  const interaction = baseInteraction({ customId: 'conn:accept:9', isButton: () => true, inGuild: () => false, guildId: null, guild: null });
  const handler = createInteractionHandler({ store, media, ...inactive, connections, logger });
  await handler(interaction);
  assert.deepEqual(calls, [{ requestId: 9, actorId: '100', status: 'accepted' }]);
  assert.deepEqual(interaction.replies.at(-2), ['deferUpdate']);
  assert.match(interaction.replies.at(-1)[1].content, /Accepted/);
});

test('the renamed View Bio context keeps private cards private', async () => {
  const store = {
    ensureGuild() {},
    getProfile: () => ({ user_id: '300', discoverable: false }),
  };
  const interaction = baseInteraction({
    commandName: 'View Bio',
    isUserContextMenuCommand: () => true,
    targetUser: { id: '300' },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);
  assert.match(interaction.replies.at(-1)[1].content, /kept their profile private/);
  assert.equal(interaction.deferred, false);
});

test('a card can be deliberately shared from the private Bio home', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { bio: 'hello', discoverable: false });
  store.saveBoundaries('200', '100', { notes: 'this must stay private' }, { level: 'private' });
  const interaction = baseInteraction({ customId: 'bio:share:100', isButton: () => true });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);
  assert.deepEqual(interaction.replies[0], ['defer', {}]);
  assert.match(interaction.replies.at(-1)[1].embeds[0].data.fields[0].value, /hello/);
  assert.equal(interaction.replies.at(-1)[1].embeds[0].data.fields.some((field) => field.name.startsWith('Interaction notes')), false);
  assert.equal(interaction.replies.at(-1)[1].embeds[0].data.footer, undefined);
  assert.equal(interaction.replies.at(-1)[1].allowedMentions.parse.length, 0);
  assert.equal(store.getProfile('200', '100').discoverable, false);
});

test('/view defaults to a public self card without changing directory privacy', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { bio: 'hello from here', discoverable: false, allow_requests: true });
  store.saveBoundaries('200', '100', { notes: 'ask before dropping into voice' }, { level: 'private' });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  const interaction = baseInteraction({
    commandName: 'view',
    isChatInputCommand: () => true,
    options: {
      getUser: (name) => name === 'member' ? null : undefined,
      getBoolean: (name) => name === 'visible' ? null : undefined,
    },
  });

  await handler(interaction);

  assert.deepEqual(interaction.replies[0], ['defer', {}]);
  const response = interaction.replies.at(-1)[1];
  assert.match(response.embeds[0].data.fields[0].value, /hello from here/);
  assert.equal(response.embeds[0].data.fields.some((field) => field.name.startsWith('Interaction notes')), false);
  assert.equal(response.embeds[0].data.footer, undefined);
  assert.deepEqual(response.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(store.getProfile('200', '100').discoverable, false);
  assert.equal(store.getProfile('200', '100').allow_requests, true);
});

test('/view visible:false keeps the full self card private', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { bio: 'quiet card', discoverable: false });
  store.saveBoundaries('200', '100', { notes: 'please ask first' }, { level: 'private' });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  const interaction = baseInteraction({
    commandName: 'view',
    isChatInputCommand: () => true,
    options: { getUser: () => null, getBoolean: () => false },
  });

  await handler(interaction);

  assert.deepEqual(interaction.replies[0], ['defer', { flags: MessageFlags.Ephemeral }]);
  const embed = interaction.replies.at(-1)[1].embeds[0].data;
  assert.equal(embed.fields.some((field) => field.name.startsWith('Interaction notes')), true);
  assert.match(embed.footer.text, /Directory: private/);
});

test('/view can publicly show an opted-in member while keeping private views private', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '300', { bio: 'tabletop and tea', discoverable: true, allow_requests: true });
  store.saveBoundaries('200', '300', { notes: 'please ping first' }, { level: 'members' });
  const target = { id: '300', username: 'June', displayAvatarURL: () => 'https://example.com/june.png' };
  const guild = {
    id: '200',
    members: {
      cache: new Map([
        ['100', { id: '100', displayName: 'Mika', user: { id: '100', bot: false }, roles: { cache: new Map() } }],
        ['300', { id: '300', displayName: 'June', user: target, roles: { cache: new Map() }, displayAvatarURL: () => 'https://example.com/june.png' }],
      ]),
      fetch: async () => null,
    },
  };
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  const publicView = baseInteraction({
    commandName: 'view', guild, isChatInputCommand: () => true,
    options: { getUser: () => target, getBoolean: () => null },
  });
  await handler(publicView);
  assert.deepEqual(publicView.replies[0], ['defer', {}]);
  const publicEmbed = publicView.replies.at(-1)[1].embeds[0].data;
  assert.match(publicEmbed.author.name, /June/);
  assert.equal(publicEmbed.fields.some((field) => field.name.startsWith('Interaction notes')), false);
  assert.equal(publicEmbed.footer, undefined);

  const privateView = baseInteraction({
    commandName: 'view', guild, isChatInputCommand: () => true,
    options: { getUser: () => target, getBoolean: () => false },
  });
  await handler(privateView);
  assert.deepEqual(privateView.replies[0], ['defer', { flags: MessageFlags.Ephemeral }]);
  const privateEmbed = privateView.replies.at(-1)[1].embeds[0].data;
  assert.equal(privateEmbed.fields.some((field) => field.name.startsWith('Interaction notes')), true);
  assert.match(privateEmbed.footer.text, /Directory: visible/);
});

test('/view refuses another member who is not listed before choosing response visibility', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '300', { bio: 'not listed', discoverable: false });
  let mediaResolutions = 0;
  const guardedMedia = { ...media, resolve: async () => { mediaResolutions += 1; return null; } };
  const target = { id: '300', username: 'June' };
  const handler = createInteractionHandler({ store, media: guardedMedia, ...inactive, logger });

  for (const visible of [null, false]) {
    const interaction = baseInteraction({
      commandName: 'view', isChatInputCommand: () => true,
      options: { getUser: () => target, getBoolean: () => visible },
    });
    await handler(interaction);
    assert.equal(interaction.deferred, false);
    assert.equal(interaction.replies[0][0], 'reply');
    assert.equal(interaction.replies[0][1].flags, MessageFlags.Ephemeral);
    assert.match(interaction.replies[0][1].content, /kept their profile private/);
  }
  assert.equal(mediaResolutions, 0);
});

test('/view reports a generic error if a public card fails after its visibility is locked', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { bio: 'hello', profile_image: 'https://example.com/card.png' });
  const failingMedia = { ...media, resolve: async () => { throw new Error('secret storage path failed'); } };
  const handler = createInteractionHandler({ store, media: failingMedia, ...inactive, logger });
  const interaction = baseInteraction({
    commandName: 'view', isChatInputCommand: () => true,
    options: { getUser: () => null, getBoolean: () => null },
  });

  await handler(interaction);

  assert.deepEqual(interaction.replies[0], ['defer', {}]);
  assert.equal(interaction.replies.length, 2);
  assert.match(interaction.replies[1][1].content, /could not load that card/i);
  assert.doesNotMatch(interaction.replies[1][1].content, /secret storage path/);
  assert.deepEqual(interaction.replies[1][1].allowedMentions, { parse: [], repliedUser: false });
});

test('Photo & vibe leads with a working upload picker and hides fallback photos', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', {});
  const handler = createInteractionHandler({ store, media, ...inactive, logger });

  const hub = baseInteraction({ customId: 'bio:style:100', isButton: () => true });
  await handler(hub);
  const response = hub.replies.at(-1)[1];
  assert.match(response.content, /Start with a photo of your own/);
  assert.equal(response.components[0].components[0].data.custom_id, 'style:upload:100');
  assert.equal(response.components[0].components[0].data.label, 'Upload your own photo');
  assert.equal(response.components[0].components[0].data.style, 1);
  assert.equal(response.components[1].components[0].data.custom_id, 'style:vibe:100');
  assert.equal(response.components[2].components[1].data.custom_id, 'style:presets:100');
  assert.equal(response.components.flatMap((row) => row.components).some((component) => component.data.custom_id === 'style:preset:100'), false);

  const openUpload = baseInteraction({ customId: 'style:upload:100', isButton: () => true });
  await handler(openUpload);
  const modal = openUpload.replies.at(-1)[1].toJSON();
  assert.equal(modal.title, 'Upload your own photo');
  assert.equal(modal.components[0].label, 'Choose a photo');
  assert.deepEqual(modal.components[0].component, {
    type: 19,
    custom_id: 'photo',
    required: true,
    min_values: 1,
    max_values: 1,
  });

  const openPresets = baseInteraction({ customId: 'style:presets:100', isButton: () => true });
  await handler(openPresets);
  const presetPanel = openPresets.replies.at(-1)[1];
  assert.match(presetPanel.content, /owner-shot photos.*backups/i);
  assert.equal(presetPanel.components[0].components[0].data.custom_id, 'style:preset:100');
  assert.equal(presetPanel.components[0].components[0].data.placeholder, 'Choose a preselected photo');
});

test('modal and command photo uploads preserve the chosen vibe and title', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { profile_image: 'preset:moss-room' });
  store.updateTheme('200', '100', { theme: 'quiet-green', primary_color: '#58704C', secondary_color: '#D8DDCF', title: 'Mika after dark', tags_emoji: '🌿' });
  const savedAttachments = [];
  const styleMedia = {
    ...media,
    save: async (_guildId, _userId, attachment) => {
      savedAttachments.push(attachment);
      return 'local:profile-images/200/100.jpg';
    },
  };
  const handler = createInteractionHandler({ store, media: styleMedia, ...inactive, logger });
  const firstPhoto = { id: '900', url: 'https://cdn.example/first.jpg', contentType: 'image/jpeg', size: 100 };
  const modalUpload = baseInteraction({
    customId: 'style:upload:100',
    isModalSubmit: () => true,
    fields: { getUploadedFiles: () => new Map([['900', firstPhoto]]) },
  });
  await handler(modalUpload);
  assert.deepEqual(modalUpload.replies[0], ['defer', { flags: MessageFlags.Ephemeral }]);
  assert.equal(store.getProfile('200', '100').profile_image, 'local:profile-images/200/100.jpg');
  assert.equal(store.getTheme('200', '100').title, 'Mika after dark');
  assert.equal(store.getTheme('200', '100').theme, 'quiet-green');

  const secondPhoto = { id: '901', url: 'https://cdn.example/second.png', contentType: 'image/png', size: 100 };
  const commandUpload = baseInteraction({
    commandName: 'bio',
    isChatInputCommand: () => true,
    options: { getAttachment: () => secondPhoto },
  });
  await handler(commandUpload);
  assert.equal(savedAttachments.length, 2);
  assert.equal(store.getTheme('200', '100').title, 'Mika after dark');
  assert.equal(store.getTheme('200', '100').theme, 'quiet-green');
  assert.match(commandUpload.replies.at(-1)[1].content, /vibe and title stayed the same/i);
});

test('a rejected modal upload keeps the existing card and returns to the photo controls', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { profile_image: 'preset:moss-room' });
  store.updateTheme('200', '100', { theme: 'soft-cloud', title: 'Cloud room' });
  const rejectingMedia = { ...media, save: async () => { throw new Error('Use a PNG, JPEG, GIF, or WebP image.'); } };
  const handler = createInteractionHandler({ store, media: rejectingMedia, ...inactive, logger });
  const interaction = baseInteraction({
    customId: 'style:upload:100',
    isModalSubmit: () => true,
    fields: { getUploadedFiles: () => new Map([['900', { url: 'https://cdn.example/file.txt' }]]) },
  });
  await handler(interaction);
  const response = interaction.replies.at(-1)[1];
  assert.match(response.content, /Use a PNG, JPEG, GIF, or WebP image/);
  assert.equal(response.components[0].components[0].data.custom_id, 'style:upload:100');
  assert.equal(store.getProfile('200', '100').profile_image, 'preset:moss-room');
  assert.equal(store.getTheme('200', '100').title, 'Cloud room');
});

test('photos, vibes, and titles can each change without overwriting the others', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { profile_image: 'local:profile-images/200/100.png' });
  store.updateTheme('200', '100', { theme: 'quiet-green', primary_color: '#58704C', title: 'My corner', tags_emoji: '🌿' });
  const calls = [];
  const styleMedia = { ...media, remove: async (...args) => calls.push(args) };
  const handler = createInteractionHandler({ store, media: styleMedia, ...inactive, logger });

  const preselected = baseInteraction({
    customId: 'style:preset:100',
    values: ['windowseat'],
    isStringSelectMenu: () => true,
  });
  await handler(preselected);
  assert.deepEqual(calls, [['200', '100']]);
  assert.equal(store.getProfile('200', '100').profile_image, 'preset:windowseat');
  assert.equal(store.getTheme('200', '100').theme, 'quiet-green');
  assert.equal(store.getTheme('200', '100').title, 'My corner');
  assert.match(preselected.replies.at(-1)[1].content, /backup photo.*stayed the same/i);

  const vibe = baseInteraction({ customId: 'style:vibe:100', values: ['lantern-night'], isStringSelectMenu: () => true });
  await handler(vibe);
  assert.equal(store.getProfile('200', '100').profile_image, 'preset:windowseat');
  assert.equal(store.getTheme('200', '100').theme, 'lantern-night');
  assert.equal(store.getTheme('200', '100').primary_color, '#A8683F');
  assert.equal(store.getTheme('200', '100').title, 'My corner');

  const openTitle = baseInteraction({ customId: 'style:title:100', isButton: () => true });
  await handler(openTitle);
  const titleEditor = openTitle.replies.at(-1)[1].toJSON();
  assert.equal(titleEditor.title, 'Choose your title');
  assert.equal(titleEditor.components[0].components[0].custom_id, 'title');
  assert.equal(titleEditor.components[0].components[0].value, 'My corner');

  const title = baseInteraction({
    customId: 'style:title:100',
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'Tea, games, and weather' },
  });
  await handler(title);
  assert.deepEqual(title.replies[0], ['defer', { flags: MessageFlags.Ephemeral }]);
  assert.equal(store.getProfile('200', '100').profile_image, 'preset:windowseat');
  assert.equal(store.getTheme('200', '100').theme, 'lantern-night');
  assert.equal(store.getTheme('200', '100').title, 'Tea, games, and weather');

  const avatar = baseInteraction({ customId: 'style:remove:100', isButton: () => true });
  await handler(avatar);
  assert.equal(store.getProfile('200', '100').profile_image, null);
  assert.equal(store.getTheme('200', '100').theme, 'lantern-night');
  assert.equal(store.getTheme('200', '100').title, 'Tea, games, and weather');
});

test('sharing presets make every consent choice explicit', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', {});
  const interaction = baseInteraction({ customId: 'share:groups:100', isButton: () => true });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);
  const profile = store.getProfile('200', '100');
  assert.equal(profile.discoverable, true);
  assert.equal(profile.allow_requests, true);
  assert.equal(profile.allow_group_pings, true);
  assert.match(interaction.replies.at(-1)[1].content, /open to directory/i);
});

test('the connection home exposes sent requests and lets an owner undo a block', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.blockUser('200', '100', '300');
  const connections = {
    ...inactive.connections,
    listOutgoing: () => [{ id: 1 }],
  };
  const home = baseInteraction({
    commandName: 'connect', isChatInputCommand: () => true,
    options: { getSubcommand: () => null, getUser: () => null },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, connections, logger });
  await handler(home);
  const components = home.replies.at(-1)[1].components;
  assert.equal(components[0].components[0].data.custom_id, 'conn:sent:100');
  assert.equal(components[1].components[0].data.custom_id, 'conn:unblock:100');

  const unblock = baseInteraction({ customId: 'conn:unblock:100', values: ['300'], isUserSelectMenu: () => true });
  await handler(unblock);
  assert.equal(store.isBlocked('200', '100', '300'), false);
  assert.match(unblock.replies.at(-1)[1].content, /Unblocked/);
});

test('setup shows every starter tag and adds only the moderator-curated selection', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const admin = { has: () => true };
  store.addTag('200', 'film-photography', 'Film photography', '100', 'custom', { bypassUgc: true });
  store.addTag('200', 'co-op-games', 'Co-op games', '100', 'custom', { bypassUgc: true });
  const listAllTags = store.listTags;
  store.listTags = (guildId, limit) => listAllTags(guildId, limit).filter((tag) => tag.tag_slug !== 'co-op-games');
  const interaction = baseInteraction({ commandName: 'setup', isChatInputCommand: () => true, memberPermissions: admin });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);
  const setup = interaction.replies.at(-1)[1];
  assert.match(setup.embeds[0].data.title, /set up/i);
  assert.equal(setup.components[0].toJSON().components[0].custom_id, 'setup:packs:100');

  const browse = baseInteraction({ customId: 'setup:packs:100', isButton: () => true, memberPermissions: admin });
  await handler(browse);
  const suggestions = browse.replies.at(-1)[1];
  const suggestionFields = suggestions.embeds[0].toJSON().fields;
  assert.deepEqual(suggestionFields.map((field) => field.name), ['Play together', 'Make together', 'Learn together', 'Common ground']);
  assert.match(suggestionFields[0].value, /Co-op games.*Tabletop games.*TTRPGs.*Fighting games/);
  const packOptions = suggestions.components[0].toJSON().components[0].options;
  assert.match(packOptions[1].description, /Art & design.*Writing.*Music making.*Photography.*Game development/);
  assert.deepEqual(listAllTags('200').map((tag) => tag.tag_slug), ['co-op-games', 'film-photography']);

  const pack = baseInteraction({ customId: 'setup:pack:100', values: ['play'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(pack);
  const review = pack.replies.at(-1)[1];
  assert.match(review.embeds[0].data.description, /nothing changes until/i);
  assert.match(review.embeds[0].toJSON().fields[0].value, /Co-op games — already in this server/);
  const picker = review.components[0].toJSON().components[0];
  assert.equal(picker.min_values, 0);
  assert.equal(picker.max_values, 3);
  assert.equal(picker.options.some((option) => option.value === 'co-op-games'), false);
  assert.equal(picker.options.every((option) => option.default === false), true);
  assert.deepEqual(listAllTags('200').map((tag) => tag.tag_slug), ['co-op-games', 'film-photography']);

  const chooseTwo = baseInteraction({ customId: picker.custom_id, values: ['tabletop-games', 'ttrpgs'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(chooseTwo);
  assert.deepEqual(listAllTags('200').map((tag) => tag.tag_slug), ['co-op-games', 'film-photography']);
  const chosenPicker = chooseTwo.replies.at(-1)[1].components[0].toJSON().components[0];
  assert.deepEqual(chosenPicker.options.filter((option) => option.default).map((option) => option.value), ['tabletop-games', 'ttrpgs']);

  const unselectOne = baseInteraction({ customId: picker.custom_id, values: ['ttrpgs'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(unselectOne);
  assert.deepEqual(listAllTags('200').map((tag) => tag.tag_slug), ['co-op-games', 'film-photography']);
  const applyButton = unselectOne.replies.at(-1)[1].components
    .flatMap((row) => row.toJSON().components)
    .find((component) => component.custom_id?.startsWith('setup:apply:'));
  assert.equal(applyButton.label, 'Add 1 selected');

  const apply = baseInteraction({ customId: applyButton.custom_id, isButton: () => true, memberPermissions: admin });
  await handler(apply);
  assert.deepEqual(listAllTags('200').map((tag) => tag.tag_slug), ['co-op-games', 'film-photography', 'ttrpgs']);
  assert.equal(store.getTag('200', 'ttrpgs').category, 'starter:play');
  assert.match(apply.replies.at(-1)[1].content, /Added 1 selected starter tag/);

  const posted = [];
  const post = baseInteraction({ customId: 'setup:post:100', isButton: () => true, memberPermissions: admin, channel: { send: async (payload) => posted.push(payload) } });
  await handler(post);
  assert.equal(posted[0].components[0].components[0].data.custom_id, 'start:bio');
  assert.equal(posted[0].allowedMentions.parse.length, 0);
});

test('starter tag reviews can be cancelled or expire without changing server tags', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const admin = { has: () => true };
  let time = new Date('2026-09-15T12:00:00Z');
  const handler = createInteractionHandler({ store, media, ...inactive, logger, now: () => time });

  const pack = baseInteraction({ customId: 'setup:pack:100', values: ['make'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(pack);
  const picker = pack.replies.at(-1)[1].components[0].toJSON().components[0];
  const forged = baseInteraction({ customId: picker.custom_id, values: ['homework'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(forged);
  assert.deepEqual(store.listTags('200'), []);
  assert.match(forged.replies.at(-1)[1].content, /suggestion group only/i);

  const choose = baseInteraction({ customId: picker.custom_id, values: ['writing', 'photography'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(choose);
  const cancelButton = choose.replies.at(-1)[1].components
    .flatMap((row) => row.toJSON().components)
    .find((component) => component.custom_id?.startsWith('setup:cancel:'));
  const cancel = baseInteraction({ customId: cancelButton.custom_id, isButton: () => true, memberPermissions: admin });
  await handler(cancel);
  assert.deepEqual(store.listTags('200'), []);
  assert.match(cancel.replies.at(-1)[1].content, /No starter tags were added/);

  const secondPack = baseInteraction({ customId: 'setup:pack:100', values: ['learn'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(secondPack);
  const secondPicker = secondPack.replies.at(-1)[1].components[0].toJSON().components[0];
  time = new Date('2026-09-15T12:16:00Z');
  const expired = baseInteraction({ customId: secondPicker.custom_id, values: ['programming'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(expired);
  assert.deepEqual(store.listTags('200'), []);
  assert.match(expired.replies.at(-1)[1].content, /review expired/i);
});

test('setup can curate custom interests and change the profile limit without old admin commands', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const admin = { has: () => true };
  const handler = createInteractionHandler({ store, media, ...inactive, logger });

  const add = baseInteraction({
    customId: 'setup:add:100', isModalSubmit: () => true, memberPermissions: admin,
    fields: { getTextInputValue: (name) => name === 'interests' ? 'Film photography, Soup club' : 'community' },
  });
  await handler(add);
  assert.deepEqual(store.listTags('200').map((tag) => tag.tag_slug), ['film-photography', 'soup-club']);
  assert.match(add.replies.at(-1)[1].content, /Added 2/);

  const remove = baseInteraction({
    customId: 'setup:remove:100', isModalSubmit: () => true, memberPermissions: admin,
    fields: { getTextInputValue: () => 'Soup club' },
  });
  await handler(remove);
  assert.deepEqual(store.listTags('200').map((tag) => tag.tag_slug), ['film-photography']);

  const limit = baseInteraction({
    customId: 'setup:limit:100', isModalSubmit: () => true, memberPermissions: admin,
    fields: { getTextInputValue: () => '12' },
  });
  await handler(limit);
  assert.equal(store.getGuildSettings('200').max_tags_per_user, 12);
});

test('role selectors are routed into the optional interaction-note wizard', async () => {
  const calls = [];
  const store = { ensureGuild() {} };
  const boundaries = { ...inactive.boundaries, handleComponent: async (interaction) => calls.push(interaction.customId) };
  const interaction = baseInteraction({ customId: 'bdry:privacy-role:100', values: ['300'], isRoleSelectMenu: () => true });
  const handler = createInteractionHandler({ store, media, ...inactive, boundaries, logger });
  await handler(interaction);
  assert.deepEqual(calls, ['bdry:privacy-role:100']);
});

test('a public start-card Bio button opens an existing private home ephemerally', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { bio: 'private note' });
  const interaction = baseInteraction({ customId: 'start:bio', isButton: () => true });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);
  assert.deepEqual(interaction.replies[0], ['defer', { flags: MessageFlags.Ephemeral }]);
  assert.equal(interaction.replies.some(([kind]) => kind === 'update'), false);
  assert.match(interaction.replies.at(-1)[1].content, /private Bio home/i);
});

test('a rejected interest edit does not partially create or overwrite a profile', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.updateGuildSettings('200', { allow_ugc_tags: false });
  const interaction = baseInteraction({
    customId: 'profile:edit:100',
    isModalSubmit: () => true,
    fields: { getTextInputValue: (name) => ({ bio: 'should not save', pronouns: '', open_to: '', interests: 'unknown thing' })[name] },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);
  assert.equal(store.getProfile('200', '100'), null);
  assert.match(interaction.replies.at(-1)[1].content, /not in the server list/);
});
