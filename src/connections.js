import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { safeDisplayText } from './domain.js';

const HOUR_MS = 60 * 60 * 1000;
const PAIR_COOLDOWN_MS = 7 * 24 * HOUR_MS;

function idOf(value) {
  return typeof value === 'string' ? value : value?.id;
}

function asDate(value) {
  if (!value) return null;
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function controls(requestId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`conn:accept:${requestId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`conn:decline:${requestId}`).setLabel('Decline').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`conn:block:${requestId}`).setLabel('Block').setStyle(ButtonStyle.Danger),
  )];
}

function requestEmbed({ sender, message }) {
  const name = safeDisplayText(sender?.displayName || sender?.username || 'Someone', { maxLength: 80 });
  const note = safeDisplayText(message || '', { maxLength: 1000, fallback: 'No note included.' });
  return new EmbedBuilder()
    .setColor(0x6f8060)
    .setTitle('A quiet hello')
    .setDescription(`${name} would like to connect with you.`)
    .addFields({ name: 'Their note', value: note })
    .setFooter({ text: 'Accept, decline, or block. Nothing is posted publicly.' });
}

function statusEmbed({ status, recipient }) {
  const name = safeDisplayText(recipient?.displayName || recipient?.username || 'the recipient', { maxLength: 80 });
  const accepted = status === 'accepted';
  return new EmbedBuilder()
    .setColor(accepted ? 0x6f8060 : 0x756c62)
    .setTitle(accepted ? 'Connection accepted' : 'Connection declined')
    .setDescription(accepted ? `${name} accepted your request. You can reach out when it feels right.` : `${name} declined your request.`);
}

/**
 * Coordinates private, opt-in connection requests. The service deliberately returns
 * user-safe result objects so the interaction layer can choose the wording and visibility.
 */
export function createConnectionService({ store, client, now = () => new Date() } = {}) {
  if (!store || !client) throw new TypeError('store and client are required');

  async function memberFor(guild, target) {
    const targetId = idOf(target);
    if (!targetId) return null;
    try {
      return await guild.members.fetch(targetId);
    } catch {
      return null;
    }
  }

  async function send({ guild, sender, target, message = null }) {
    const guildId = idOf(guild);
    const senderId = idOf(sender);
    const targetId = idOf(target);
    if (!guildId || !senderId || !targetId) return failure('invalid_request', 'Choose a member to connect with.');
    if (senderId === targetId) return failure('self', 'You cannot send a request to yourself.');
    if (!store.getProfile(guildId, senderId)) return failure('profile_required', 'Make a profile before sending a connection request.');

    const targetMember = await memberFor(guild, target);
    if (!targetMember || targetMember.user?.bot) return failure('target_unavailable', 'That member is no longer available in this server.');

    const targetProfile = store.getProfile(guildId, targetId);
    if (!targetProfile?.allow_requests) return failure('requests_closed', 'That member is not accepting connection requests.');

    const current = now();
    const hourAgo = new Date(current.getTime() - HOUR_MS).toISOString();
    if (store.countConnectionRequests(guildId, senderId, { since: hourAgo, status: null }) >= 3) {
      return failure('rate_limited', 'You can send up to three connection requests per hour.');
    }

    const previous = store.getRequestCooldown(guildId, senderId, targetId);
    if (previous?.status === 'accepted') {
      return failure('already_connected', 'That member has already accepted a request from you.');
    }
    if (previous?.status === 'declined') {
      const resolvedAt = asDate(previous.responded_at || previous.created_at);
      const retryAt = resolvedAt && new Date(resolvedAt.getTime() + PAIR_COOLDOWN_MS);
      if (retryAt && retryAt > current) {
        return failure('pair_cooldown', 'Give this connection some space before trying again.', { retryAt });
      }
    }

    let request;
    try {
      request = store.createConnectionRequest(guildId, senderId, targetId, message);
    } catch (error) {
      const text = String(error?.message || '');
      if (/pending/i.test(text)) return failure('already_pending', 'You already have a pending request with that member.');
      if (/blocked/i.test(text)) return failure('blocked', 'This connection is unavailable.');
      if (/accept requests/i.test(text)) return failure('requests_closed', 'That member is not accepting connection requests.');
      return failure('could_not_create', 'That request could not be created.');
    }

    try {
      await targetMember.send({
        embeds: [requestEmbed({ sender, message })],
        components: controls(request.id),
        allowedMentions: { parse: [] },
      });
    } catch {
      // A request without a delivered notice would be misleading, so remove it from the inbox.
      store.setConnectionRequestStatus(request.id, 'cancelled', { actorId: senderId });
      return failure('delivery_failed', 'I could not deliver that request. They may have direct messages closed.');
    }
    return { ok: true, code: 'sent', request };
  }

  async function dmUser(userId, payload) {
    try {
      const user = client.users?.cache?.get(userId) || await client.users?.fetch(userId);
      if (user?.send) await user.send({ ...payload, allowedMentions: { parse: [] } });
      return true;
    } catch {
      return false;
    }
  }

  async function respond({ requestId, actorId, status }) {
    if (!['accepted', 'declined'].includes(status)) return failure('invalid_status', 'Choose accept or decline.');
    const request = store.getConnectionRequest(requestId);
    if (!request) return failure('not_found', 'That connection request no longer exists.');
    if (request.recipient_id !== actorId) return failure('not_recipient', 'Only the recipient can respond to this request.');
    let updated;
    try {
      updated = store.setConnectionRequestStatus(requestId, status, { actorId });
    } catch (error) {
      if (/already resolved/i.test(String(error?.message))) return failure('already_resolved', 'That request has already been handled.');
      return failure('could_not_respond', 'That response could not be saved.');
    }

    await dmUser(updated.sender_id, { embeds: [statusEmbed({ status, recipient: { username: 'They' } })] });
    return { ok: true, code: status, request: updated };
  }

  async function blockRequest({ requestId, actorId }) {
    const request = store.getConnectionRequest(requestId);
    if (!request) return failure('not_found', 'That connection request no longer exists.');
    const guildId = request.guild_id;
    if (request.recipient_id !== actorId) return failure('not_recipient', 'Only the recipient can block this request.');
    try {
      store.blockUser(guildId, actorId, request.sender_id);
    } catch {
      return failure('could_not_block', 'That member could not be blocked.');
    }
    return { ok: true, code: 'blocked', blockedId: request.sender_id, request };
  }

  function listIncoming({ guildId, userId, status = 'pending', limit = 25, offset = 0 }) {
    return store.listConnectionRequests(guildId, userId, { direction: 'incoming', status, limit, offset });
  }

  function listOutgoing({ guildId, userId, status = null, limit = 25, offset = 0 }) {
    return store.listConnectionRequests(guildId, userId, { direction: 'outgoing', status, limit, offset });
  }

  return { send, respond, blockRequest, listIncoming, listOutgoing };
}
