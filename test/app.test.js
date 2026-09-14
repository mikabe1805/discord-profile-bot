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

test('gather reserves its durable cooldown immediately before the public send', async () => {
  const order = [];
  const store = { ensureGuild() {} };
  const gather = {
    async prepare() {
      order.push('prepare');
      return { ok: true, recipientIds: ['300'], payload: { content: '<@300>', allowedMentions: { parse: [], users: ['300'] } }, commit: () => order.push('commit') };
    },
  };
  const interaction = baseInteraction({
    commandName: 'gather',
    isChatInputCommand: () => true,
    options: { getString: (name) => name === 'interests' ? 'games' : 'table tonight' },
    channel: { async send() { order.push('send'); } },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, gather, logger });
  await handler(interaction);
  assert.deepEqual(order, ['prepare', 'commit', 'send']);
  assert.match(interaction.replies.at(-1)[1].content, /1 opted-in member/);
});

test('gather releases its cooldown reservation when the public send fails', async () => {
  const order = [];
  const store = { ensureGuild() {} };
  const gather = {
    async prepare() {
      order.push('prepare');
      return {
        ok: true,
        recipientIds: ['300'],
        payload: { content: '<@300>', allowedMentions: { parse: [], users: ['300'] } },
        commit: () => order.push('commit'),
        rollback: () => order.push('rollback'),
      };
    },
  };
  const interaction = baseInteraction({
    commandName: 'gather',
    isChatInputCommand: () => true,
    options: { getString: (name) => name === 'interests' ? 'games' : 'table tonight' },
    channel: { async send() { order.push('send'); throw new Error('missing permission'); } },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, gather, logger });
  await handler(interaction);
  assert.deepEqual(order, ['prepare', 'commit', 'send', 'rollback']);
  assert.match(interaction.replies.at(-1)[1].content, /Something went wrong/);
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

test('a private profile cannot be opened through the view command', async () => {
  const store = {
    ensureGuild() {},
    getProfile: () => ({ user_id: '300', discoverable: false }),
  };
  const interaction = baseInteraction({
    commandName: 'profile',
    isChatInputCommand: () => true,
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => 'view',
      getUser: () => ({ id: '300' }),
    },
  });
  const handler = createInteractionHandler({ store, media, ...inactive, logger });
  await handler(interaction);
  assert.match(interaction.replies.at(-1)[1].content, /kept their profile private/);
  assert.equal(interaction.deferred, false);
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
