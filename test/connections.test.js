import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectionService } from '../src/connections.js';

function profile({ allow_requests = true } = {}) { return { allow_requests }; }

function makeStore({ senderProfile = profile(), targetProfile = profile(), count = 0, previous = null } = {}) {
  let request = null;
  let id = 0;
  const calls = [];
  return {
    calls,
    getProfile(guildId, userId) { return userId === 'sender' ? senderProfile : targetProfile; },
    countConnectionRequests() { return count; },
    getRequestCooldown() { return previous; },
    createConnectionRequest(guildId, senderId, recipientId, message) {
      request = { id: ++id, guild_id: guildId, sender_id: senderId, recipient_id: recipientId, message, status: 'pending', created_at: '2026-01-01T00:00:00.000Z' };
      return request;
    },
    getConnectionRequest(requestId) { return request?.id === Number(requestId) ? request : null; },
    setConnectionRequestStatus(requestId, status, { actorId }) {
      assert.equal(request.id, Number(requestId));
      calls.push(['status', status, actorId]);
      request = { ...request, status, responded_at: '2026-01-01T00:01:00.000Z' };
      return request;
    },
    blockUser(guildId, blockerId, blockedId) { calls.push(['block', guildId, blockerId, blockedId]); },
    listConnectionRequests(...args) { return args; },
  };
}

function makeClient() {
  const dms = [];
  return {
    dms,
    users: { cache: new Map(), async fetch(id) { return { id, async send(payload) { dms.push([id, payload]); } }; } },
  };
}

function makeGuild(member) {
  return { id: 'guild', members: { async fetch(id) { if (id !== 'target') throw new Error('missing'); return member; } } };
}

test('sends a private, explicitly actionable request only after consent checks', async () => {
  const store = makeStore();
  const client = makeClient();
  const delivered = [];
  const target = { id: 'target', user: { bot: false }, async send(payload) { delivered.push(payload); } };
  const service = createConnectionService({ store, client, now: () => new Date('2026-01-01T01:00:00Z') });
  const result = await service.send({ guild: makeGuild(target), sender: { id: 'sender', displayName: 'Mika @everyone' }, target: 'target', message: 'hi @here' });
  assert.equal(result.code, 'sent');
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].allowedMentions, { parse: [] });
  assert.equal(delivered[0].components[0].components[0].data.custom_id, 'conn:accept:1');
  assert.match(delivered[0].embeds[0].data.fields[0].value, /@\u200bhere/);
});

test('rejects missing profiles, closed requests, rate limits, and recently resolved pairs before persistence', async () => {
  const target = { id: 'target', user: { bot: false }, async send() {} };
  const guild = makeGuild(target);
  const client = makeClient();
  const now = () => new Date('2026-01-05T00:00:00Z');
  let service = createConnectionService({ store: makeStore({ senderProfile: null }), client, now });
  assert.equal((await service.send({ guild, sender: { id: 'sender' }, target: 'target' })).code, 'profile_required');
  service = createConnectionService({ store: makeStore({ targetProfile: profile({ allow_requests: false }) }), client, now });
  assert.equal((await service.send({ guild, sender: { id: 'sender' }, target: 'target' })).code, 'requests_closed');
  service = createConnectionService({ store: makeStore({ count: 3 }), client, now });
  assert.equal((await service.send({ guild, sender: { id: 'sender' }, target: 'target' })).code, 'rate_limited');
  service = createConnectionService({ store: makeStore({ previous: { status: 'declined', responded_at: '2026-01-01T00:00:00Z' } }), client, now });
  assert.equal((await service.send({ guild, sender: { id: 'sender' }, target: 'target' })).code, 'pair_cooldown');
  service = createConnectionService({ store: makeStore({ previous: { status: 'declined', responded_at: '2026-01-01 00:00:00' } }), client, now });
  assert.equal((await service.send({ guild, sender: { id: 'sender' }, target: 'target' })).code, 'pair_cooldown');
  service = createConnectionService({ store: makeStore({ previous: { status: 'accepted', responded_at: '2025-12-01 00:00:00' } }), client, now });
  assert.equal((await service.send({ guild, sender: { id: 'sender' }, target: 'target' })).code, 'already_connected');
});

test('cancels an undeliverable request and verifies the recipient for responses and blocks', async () => {
  const store = makeStore();
  const client = makeClient();
  const target = { id: 'target', user: { bot: false }, async send() { throw new Error('DMs closed'); } };
  const service = createConnectionService({ store, client });
  const failed = await service.send({ guild: makeGuild(target), sender: { id: 'sender' }, target: 'target' });
  assert.equal(failed.code, 'delivery_failed');
  assert.deepEqual(store.calls, [['status', 'cancelled', 'sender']]);
  const wrong = await service.respond({ requestId: 1, actorId: 'other', status: 'accepted' });
  assert.equal(wrong.code, 'not_recipient');
  const accepted = await service.respond({ requestId: 1, actorId: 'target', status: 'accepted' });
  assert.equal(accepted.code, 'accepted');
  const blocked = await service.blockRequest({ requestId: 1, actorId: 'target' });
  assert.equal(blocked.code, 'blocked');
  assert.deepEqual(store.calls.at(-1), ['block', 'guild', 'target', 'sender']);
});
