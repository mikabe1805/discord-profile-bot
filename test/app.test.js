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
  assert.equal(interaction.replies.at(-1)[1].allowedMentions.parse.length, 0);
});

test('a style preset removes uploads and stores only the strict preset marker', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  store.saveProfile('200', '100', { profile_image: 'local:profile-images/200/100.png' });
  const calls = [];
  const styleMedia = { ...media, remove: async (...args) => calls.push(args) };
  const interaction = baseInteraction({
    customId: 'style:preset:100',
    values: ['windowseat'],
    isStringSelectMenu: () => true,
  });
  const handler = createInteractionHandler({ store, media: styleMedia, ...inactive, logger });
  await handler(interaction);
  assert.deepEqual(calls, [['200', '100']]);
  assert.equal(store.getProfile('200', '100').profile_image, 'preset:windowseat');
  assert.equal(store.getTheme('200', '100').theme, 'windowseat');
  assert.match(interaction.replies.at(-1)[1].content, /Still Water/);
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

test('setup can add an additive starter pack and post a permission-bound start card', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const admin = { has: () => true };
  const interaction = baseInteraction({ commandName: 'setup', isChatInputCommand: () => true, memberPermissions: admin });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);
  assert.match(interaction.replies.at(-1)[1].embeds[0].data.title, /set up/i);

  const pack = baseInteraction({ customId: 'setup:pack:100', values: ['gaming'], isStringSelectMenu: () => true, memberPermissions: admin });
  await handler(pack);
  assert.deepEqual(store.listTags('200').map((tag) => tag.tag_slug), ['board-games', 'co-op-games', 'game-nights', 'rpgs']);

  const posted = [];
  const post = baseInteraction({ customId: 'setup:post:100', isButton: () => true, memberPermissions: admin, channel: { send: async (payload) => posted.push(payload) } });
  await handler(post);
  assert.equal(posted[0].components[0].components[0].data.custom_id, 'start:bio');
  assert.equal(posted[0].allowedMentions.parse.length, 0);
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
