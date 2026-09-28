import assert from 'node:assert/strict';
import test from 'node:test';
import { createBioBoardService } from '../src/bio-board.js';
import { createStore } from '../src/database.js';

function makeChannel(id = 'board') {
  const messages = new Map();
  const sent = [];
  let nextId = 1;
  return {
    id,
    sent,
    messages: {
      async fetch(messageId) {
        const message = messages.get(messageId);
        if (!message) {
          const error = new Error('Unknown Message');
          error.code = 10_008;
          throw error;
        }
        return message;
      },
    },
    async send(payload) {
      const id = String(nextId++);
      const message = {
        id,
        edits: [],
        deleted: false,
        async edit(next) { this.edits.push(next); },
        async delete() { this.deleted = true; messages.delete(id); },
      };
      messages.set(id, message);
      sent.push({ payload, message });
      return message;
    },
  };
}

function profilePayload(label) {
  return { embeds: [{ title: label }], allowedMentions: { parse: ['users'] } };
}

test('bio board requires a separate publishing opt-in, then edits and removes a stable card', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const board = createBioBoardService({ store });
  const channel = makeChannel();

  assert.equal((await board.enable({ guildId: 'guild', channel })).code, 'enabled');
  store.saveProfile('guild', 'alice', { bio: 'directory only', discoverable: true, publish_to_board: false });
  assert.equal((await board.publish({ guildId: 'guild', userId: 'alice', channel, payload: profilePayload('Directory only') })).code, 'already_unpublished');
  assert.equal(channel.sent.length, 0);

  store.saveProfile('guild', 'alice', { publish_to_board: true });
  const first = await board.publish({ guildId: 'guild', userId: 'alice', channel, payload: profilePayload('First') });
  assert.equal(first.code, 'published');
  assert.equal(channel.sent.length, 1);
  assert.deepEqual(channel.sent[0].payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(store.getBioBoardMessage('guild', 'alice').message_id, first.messageId);

  const updated = await board.publish({ guildId: 'guild', userId: 'alice', channel, payload: profilePayload('Updated') });
  assert.equal(updated.code, 'updated');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].message.edits[0].embeds[0].title, 'Updated');
  assert.deepEqual(channel.sent[0].message.edits[0].attachments, []);

  store.saveProfile('guild', 'alice', { publish_to_board: false });
  assert.equal((await board.publish({ guildId: 'guild', userId: 'alice', channel, payload: profilePayload('Hidden') })).code, 'unpublished');
  assert.equal(channel.sent[0].message.deleted, true);
  assert.equal(store.getBioBoardMessage('guild', 'alice'), null);
});

test('reconcile removes stale cards, preserves one card per member, and configuration is persistent', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const board = createBioBoardService({ store });
  const channel = makeChannel();
  await board.enable({ guildId: 'guild', channel });
  store.saveProfile('guild', 'alice', { discoverable: true, publish_to_board: true });
  store.saveProfile('guild', 'bob', { discoverable: true, publish_to_board: true });
  await board.publish({ guildId: 'guild', userId: 'alice', channel, payload: profilePayload('Alice') });
  await board.publish({ guildId: 'guild', userId: 'bob', channel, payload: profilePayload('Bob') });

  const reconciled = await board.reconcile({
    guildId: 'guild',
    channel,
    entries: [{ userId: 'alice', payload: profilePayload('Alice, refreshed') }],
  });
  assert.equal(reconciled.ok, true);
  assert.equal(store.getBioBoardMessage('guild', 'alice').channel_id, 'board');
  assert.equal(store.getBioBoardMessage('guild', 'bob'), null);
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[1].message.deleted, true);
  assert.deepEqual(store.listBoardGuilds(), [{ guild_id: 'guild', bio_board_channel_id: 'board' }]);
  assert.deepEqual(store.listBoardEligibleProfiles('guild').map((profile) => profile.user_id).sort(), ['alice', 'bob']);
});

test('disabling removes cards and clears board consent before a later re-enable', async (t) => {
  const store = createStore({ databasePath: ':memory:' });
  t.after(() => store.close());
  const board = createBioBoardService({ store });
  const channel = makeChannel();
  store.saveProfile('guild', 'alice', { discoverable: true, publish_to_board: true });

  await board.enable({ guildId: 'guild', channel });
  await board.publish({ guildId: 'guild', userId: 'alice', channel, payload: profilePayload('Alice') });
  assert.equal(channel.sent.length, 1);

  assert.equal((await board.disable({ guildId: 'guild', channel })).code, 'disabled');
  assert.equal(channel.sent[0].message.deleted, true);
  assert.equal(store.getProfile('guild', 'alice').publish_to_board, false);
  assert.equal(store.getGuildSettings('guild').bio_board_channel_id, null);

  await board.enable({ guildId: 'guild', channel });
  const retry = await board.publish({ guildId: 'guild', userId: 'alice', channel, payload: profilePayload('Alice') });
  assert.equal(retry.code, 'already_unpublished');
  assert.equal(channel.sent.length, 1);
});
