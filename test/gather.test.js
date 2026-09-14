import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatherService } from '../src/gather.js';

const NOW = new Date('2026-09-14T16:00:00.000Z');

function makeStore(overrides = {}) {
  const calls = { record: 0, candidates: 0 };
  return {
    calls,
    getGuildSettings: () => ({ allow_gathers: true }),
    getProfile: () => ({ user_id: 'sender' }),
    getLastGather: () => null,
    findGatherCandidates: () => {
      calls.candidates += 1;
      return [{ user_id: 'one' }, { user_id: 'bot' }, { user_id: 'gone' }, { user_id: 'two' }];
    },
    recordGather: (guildId, senderId, recipientCount) => {
      calls.record += 1;
      calls.recorded = { guildId, senderId, recipientCount };
      return { id: 7, guild_id: guildId, sender_id: senderId, recipient_count: recipientCount };
    },
    deleteGatherEvent: () => true,
    ...overrides,
  };
}

function makeGuild() {
  const members = new Map([
    ['one', { user: { bot: false } }],
    ['bot', { user: { bot: true } }],
    ['sender', { user: { bot: false } }],
  ]);
  return {
    id: 'guild',
    members: {
      cache: members,
      fetch: async (id) => {
        if (id === 'two') return { user: { bot: false } };
        throw new Error('Member left');
      },
    },
  };
}

test('prepares an opt-in gather with explicit allowed mentions and inert mass mentions', async () => {
  const store = makeStore();
  const service = createGatherService({ store, now: () => NOW });

  const prepared = await service.prepare({
    guild: makeGuild(),
    senderId: 'sender',
    interestSlugs: ['Board Games', 'board-games', 'art & design'],
    message: 'table time @everyone',
  });

  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.interestSlugs, ['board-games', 'art-and-design']);
  assert.deepEqual(prepared.recipientIds, ['one', 'two']);
  assert.deepEqual(prepared.payload.allowedMentions, { parse: [], users: ['one', 'two'], repliedUser: false });
  assert.match(prepared.payload.content, /\*\*board games\*\*/);
  assert.match(prepared.payload.content, /<@one> <@two>/);
  assert.match(prepared.payload.content, /@\u200beveryone/);
  assert.equal(store.calls.record, 0);
  prepared.commit();
  prepared.commit();
  assert.equal(store.calls.record, 1);
  assert.deepEqual(store.calls.recorded, { guildId: 'guild', senderId: 'sender', recipientCount: 2 });
});

test('does not record an empty gather and gives a structured result', async () => {
  const store = makeStore({ findGatherCandidates: () => [{ user_id: 'gone' }] });
  const service = createGatherService({ store, now: () => NOW });

  const prepared = await service.prepare({
    guild: makeGuild(), senderId: 'sender', interestSlugs: ['games'], message: 'hello',
  });

  assert.deepEqual(prepared, {
    ok: false,
    code: 'no_recipients',
    message: 'No current members have opted in for those interests yet.',
    interestSlugs: ['games'],
  });
  assert.equal(store.calls.record, 0);
});

test('enforces server setting, profile requirement, and the durable cooldown', async () => {
  const guild = makeGuild();
  let prepared = await createGatherService({
    store: makeStore({ getGuildSettings: () => ({ allow_gathers: false }) }), now: () => NOW,
  }).prepare({ guild, senderId: 'sender', interestSlugs: ['games'], message: 'hi' });
  assert.equal(prepared.code, 'gathers_disabled');

  prepared = await createGatherService({
    store: makeStore({ getProfile: () => null }), now: () => NOW,
  }).prepare({ guild, senderId: 'sender', interestSlugs: ['games'], message: 'hi' });
  assert.equal(prepared.code, 'profile_required');

  const store = makeStore({ getLastGather: () => ({ created_at: '2026-09-14T15:45:00.000Z' }) });
  prepared = await createGatherService({ store, now: () => NOW }).prepare({
    guild, senderId: 'sender', interestSlugs: ['games'], message: 'hi',
  });
  assert.equal(prepared.code, 'cooldown');
  assert.equal(prepared.retryAfterMs, 15 * 60 * 1000);
  assert.equal(store.calls.record, 0);
});
