function idOf(value) {
  return typeof value === 'string' ? value : value?.id;
}

function result(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function isMissingMessage(error) {
  return error?.code === 10_008 || error?.status === 404;
}

function boardPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('A Discord profile payload is required.');
  }
  return { ...payload, allowedMentions: { parse: [], repliedUser: false } };
}

async function fetchMessage(channel, messageId) {
  if (typeof channel?.messages?.fetch === 'function') return channel.messages.fetch(messageId);
  const cached = channel?.messages?.cache?.get?.(messageId);
  if (cached) return cached;
  throw new TypeError('The board channel cannot fetch messages.');
}

/**
 * Maintains one public profile card per member who separately opted into the board
 * in an administrator-chosen channel. Rendering stays in the interaction layer:
 * this service accepts the same public payload it already builds for `/view`, then
 * owns only message lifecycle.
 */
export function createBioBoardService({ store } = {}) {
  if (!store) throw new TypeError('store is required');

  function configuredChannel(guildId) {
    return store.getGuildSettings(guildId)?.bio_board_channel_id || null;
  }

  function validateChannel(guildId, channel) {
    const channelId = idOf(channel);
    if (!guildId || !channelId || typeof channel?.send !== 'function') {
      throw new TypeError('guildId and a sendable board channel are required');
    }
    return channelId;
  }

  async function removeTrackedMessage(guildId, userId, channel, tracked) {
    if (!tracked) return { ok: true, code: 'already_unpublished' };
    const channelId = idOf(channel);
    if (tracked.channel_id !== channelId) {
      return result('channel_mismatch', 'The stored profile card belongs to a different channel.', { tracked });
    }
    try {
      const message = await fetchMessage(channel, tracked.message_id);
      await message.delete();
    } catch (error) {
      if (!isMissingMessage(error)) {
        return result('delete_failed', 'I could not remove that public profile card yet.', { error });
      }
    }
    store.deleteBioBoardMessage(guildId, userId);
    return { ok: true, code: 'unpublished' };
  }

  async function enable({ guildId, channel } = {}) {
    const channelId = validateChannel(guildId, channel);
    const oldChannelId = configuredChannel(guildId);
    if (oldChannelId && oldChannelId !== channelId && store.listBioBoardMessages(guildId, { channelId: oldChannelId }).length) {
      return result('old_channel_has_cards', 'Remove the existing public cards before moving the bio board.', { oldChannelId });
    }
    store.updateGuildSettings(guildId, { bio_board_channel_id: channelId });
    return { ok: true, code: 'enabled', channelId };
  }

  async function publish({ guildId, userId, channel, payload } = {}) {
    const channelId = validateChannel(guildId, channel);
    if (configuredChannel(guildId) !== channelId) {
      return result('disabled', 'This channel is not configured as the bio board.');
    }
    const profile = store.getProfile(guildId, userId);
    if (!profile?.discoverable || !profile.publish_to_board) return unpublish({ guildId, userId, channel });

    const outgoing = boardPayload(payload);
    const tracked = store.getBioBoardMessage(guildId, userId);
    if (tracked && tracked.channel_id !== channelId) {
      return result('channel_mismatch', 'The stored profile card belongs to a different channel.', { tracked });
    }
    if (tracked) {
      try {
        const message = await fetchMessage(channel, tracked.message_id);
        await message.edit({ ...outgoing, attachments: [] });
        return { ok: true, code: 'updated', messageId: tracked.message_id };
      } catch (error) {
        if (!isMissingMessage(error)) return result('update_failed', 'I could not update that public profile card yet.', { error });
        store.deleteBioBoardMessage(guildId, userId);
      }
    }
    try {
      const message = await channel.send(outgoing);
      if (!message?.id) return result('create_failed', 'The board channel did not return a profile card message.');
      const saved = store.saveBioBoardMessage(guildId, userId, channelId, message.id);
      return { ok: true, code: 'published', messageId: saved.message_id };
    } catch (error) {
      return result('create_failed', 'I could not post that public profile card yet.', { error });
    }
  }

  async function unpublish({ guildId, userId, channel } = {}) {
    const channelId = validateChannel(guildId, channel);
    const tracked = store.getBioBoardMessage(guildId, userId);
    if (!tracked) return { ok: true, code: 'already_unpublished' };
    if (tracked.channel_id !== channelId) {
      return result('channel_mismatch', 'The stored profile card belongs to a different channel.', { tracked });
    }
    return removeTrackedMessage(guildId, userId, channel, tracked);
  }

  async function disable({ guildId, channel } = {}) {
    const channelId = validateChannel(guildId, channel);
    if (configuredChannel(guildId) !== channelId) return result('disabled', 'This channel is not configured as the bio board.');
    const failures = [];
    for (const tracked of store.listBioBoardMessages(guildId, { channelId })) {
      const removed = await removeTrackedMessage(guildId, tracked.user_id, channel, tracked);
      if (!removed.ok) failures.push({ userId: tracked.user_id, code: removed.code });
    }
    if (failures.length) return result('disable_incomplete', 'Some public profile cards could not be removed yet.', { failures });
    store.clearBoardOptIns(guildId);
    store.updateGuildSettings(guildId, { bio_board_channel_id: null });
    return { ok: true, code: 'disabled' };
  }

  async function reconcile({ guildId, channel, entries } = {}) {
    const channelId = validateChannel(guildId, channel);
    if (configuredChannel(guildId) !== channelId) return result('disabled', 'This channel is not configured as the bio board.');
    if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
    const wanted = new Set();
    const outcomes = [];
    for (const entry of entries) {
      const userId = idOf(entry?.userId) || entry?.userId;
      if (typeof userId !== 'string' || wanted.has(userId)) throw new TypeError('entries must contain unique user ids');
      wanted.add(userId);
      outcomes.push({ userId, ...(await publish({ guildId, userId, channel, payload: entry?.payload })) });
    }
    for (const tracked of store.listBioBoardMessages(guildId, { channelId })) {
      if (!wanted.has(tracked.user_id)) outcomes.push({ userId: tracked.user_id, ...(await unpublish({ guildId, userId: tracked.user_id, channel })) });
    }
    return { ok: outcomes.every((outcome) => outcome.ok), code: 'reconciled', outcomes };
  }

  return { enable, disable, publish, unpublish, reconcile };
}
