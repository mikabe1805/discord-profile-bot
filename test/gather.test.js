import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGatherRsvpPayload, createGatherRsvpService, createGatherService } from '../src/gather.js';

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

function makeRsvpStore() {
  const plans = new Map();
  const rsvps = new Map();
  let nextPlanId = 1;
  return {
    async createGatherPlan(input) {
      const plan = { id: nextPlanId++, status: 'pending', ...input, sender_id: input.senderId, recipient_ids: input.recipientIds, interest_slugs: input.interestSlugs };
      plans.set(plan.id, plan);
      return plan;
    },
    async getGatherPlan(id) { return plans.get(Number(id)) || null; },
    async recordGatherRsvp(planId, userId, response) {
      rsvps.set(`${planId}:${userId}`, { plan_id: Number(planId), user_id: userId, response });
    },
    async listGatherRsvps(planId) {
      return [...rsvps.values()].filter((rsvp) => rsvp.plan_id === Number(planId));
    },
    async setGatherConversation(planId, { threadId }) {
      const plan = plans.get(Number(planId));
      plan.thread_id = threadId;
      plan.status = 'open';
      return plan;
    },
  };
}

test('RSVP plans are durable-store backed and lead the host to a real shared room', async () => {
  const service = createGatherRsvpService({ store: makeRsvpStore(), now: () => NOW });
  const created = await service.create({
    guildId: 'guild', senderId: 'sender', recipientIds: ['one', 'two'], interestSlugs: ['board-games'],
    activity: 'Try a co-op game', startsAt: 'Friday at 8', channelId: 'channel', messageId: 'message',
  });

  assert.match(created.payload.content, /Try a co-op game · when: Friday at 8/);
  assert.deepEqual(created.payload.components[0].components.map((button) => button.custom_id), [
    'gather:rsvp:1:yes', 'gather:rsvp:1:maybe', 'gather:rsvp:1:no',
  ]);
  const response = await service.respond({ planId: 1, userId: 'one', response: 'yes' });
  assert.equal(response.ok, true);
  assert.match(response.payload.content, /1 in/);
  assert.equal(response.payload.components[0].components.at(-1).custom_id, 'gather:start:1');

  const ready = await service.readyToStart({ planId: 1, userId: 'sender' });
  assert.deepEqual(ready.participantIds, ['sender', 'one']);
  const opened = await service.markConversationOpen({ planId: 1, threadId: 'thread' });
  assert.match(opened.payload.content, /private conversation is open/);
  assert.equal(opened.payload.components[0].components[0].disabled, true);
});

test('RSVPs are limited to people invited to the pending plan', async () => {
  const service = createGatherRsvpService({ store: makeRsvpStore(), now: () => NOW });
  await service.create({
    guildId: 'guild', senderId: 'sender', recipientIds: ['one'], interestSlugs: ['games'], channelId: 'channel', messageId: 'message',
  });
  const outsider = await service.respond({ planId: 1, userId: 'outside', response: 'yes' });
  assert.deepEqual(outsider, {
    ok: false,
    code: 'not_invited',
    message: 'This RSVP is for the people invited to this gathering.',
  });
  const nonHost = await service.readyToStart({ planId: 1, userId: 'one' });
  assert.equal(nonHost.code, 'host_required');
});

test('gather RSVP payload never permits mass mentions', () => {
  const payload = buildGatherRsvpPayload({ id: 9, activity: '@everyone game', interest_slugs: ['tabletop-games'] });
  assert.equal(payload.allowedMentions.parse.length, 0);
  assert.match(payload.content, /@\u200beveryone/);
});
