import { normalizeInterestSlug, safeDisplayText } from './domain.js';

const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_CANDIDATES = 30;
const MAX_RECIPIENTS = 12;

function result(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function interestList(labels) {
  return labels.map((label) => `**${label}**`).join(' · ');
}

function cleanInterests(interests) {
  if (!Array.isArray(interests)) return [];
  return [...new Set(interests
    .map((interest) => normalizeInterestSlug(interest))
    .filter(Boolean))]
    .slice(0, 10);
}

async function currentMember(guild, userId) {
  const members = guild?.members;
  if (!members) return null;

  const cached = members.cache?.get?.(userId);
  if (cached) return cached;
  if (typeof members.fetch !== 'function') return null;

  try {
    return await members.fetch(userId);
  } catch {
    return null;
  }
}

function cooldownRemaining(lastGather, now) {
  if (!lastGather?.created_at) return 0;
  const raw = lastGather.created_at;
  const normalized = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const sentAt = new Date(normalized).getTime();
  if (!Number.isFinite(sentAt)) return 0;
  return Math.max(0, COOLDOWN_MS - (now.getTime() - sentAt));
}

/**
 * Prepares a public, opt-in interest call. The caller sends the returned payload only
 * after this succeeds, so the cooldown is written only for a gather with recipients.
 */
export function createGatherService({ store, now = () => new Date() } = {}) {
  if (!store) throw new TypeError('store is required');

  return {
    async prepare({ guild, senderId, interestSlugs, message } = {}) {
      if (!guild?.id || !senderId) {
        throw new TypeError('guild and senderId are required');
      }

      const settings = await store.getGuildSettings(guild.id);
      if (!settings?.allow_gathers) {
        return result('gathers_disabled', 'Group interest calls are turned off in this server.');
      }

      const sender = await store.getProfile(guild.id, senderId);
      if (!sender) {
        return result('profile_required', 'Make a profile before inviting people to a gathering.');
      }

      const checkedAt = now();
      if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
        throw new TypeError('now must return a valid Date');
      }
      const remainingMs = cooldownRemaining(await store.getLastGather(guild.id, senderId), checkedAt);
      if (remainingMs > 0) {
        return result('cooldown', 'You can send another group invitation a little later.', {
          retryAfterMs: remainingMs,
        });
      }

      const interests = cleanInterests(interestSlugs);
      if (!interests.length) {
        return result('interests_required', 'Choose at least one interest for this gathering.');
      }

      const candidates = await store.findGatherCandidates(guild.id, interests, MAX_CANDIDATES);
      const recipientIds = [];
      const seen = new Set();
      for (const candidate of candidates || []) {
        const userId = candidate?.user_id ?? candidate?.userId;
        if (!userId || userId === senderId || seen.has(userId)) continue;
        const member = await currentMember(guild, userId);
        if (!member || member.user?.bot) continue;
        seen.add(userId);
        recipientIds.push(userId);
        if (recipientIds.length === MAX_RECIPIENTS) break;
      }

      if (!recipientIds.length) {
        return result('no_recipients', 'No current members have opted in for those interests yet.', {
          interestSlugs: interests,
        });
      }

      const invitation = safeDisplayText(message, {
        maxLength: 500,
        fallback: 'Anyone up for a small chat?'
      });
      const labels = interests.map((slug) => safeDisplayText(store.getTag?.(guild.id, slug)?.display_name || slug.replace(/-/g, ' '), { maxLength: 80 }));
      const mentions = recipientIds.map((userId) => `<@${userId}>`).join(' ');
      const payload = {
        content: `A small gathering around ${interestList(labels)} is open.\n${mentions}\n${invitation}`,
        allowedMentions: { parse: [], users: recipientIds, repliedUser: false },
      };

      let event = null;
      return {
        ok: true,
        interestSlugs: interests,
        recipientIds,
        payload,
        commit() {
          if (event) return event;
          const latest = store.getLastGather(guild.id, senderId);
          if (cooldownRemaining(latest, now()) > 0) throw new RangeError('You can send another group invitation a little later.');
          event = store.recordGather(guild.id, senderId, recipientIds.length);
          return event;
        },
        rollback() {
          if (event?.id != null) store.deleteGatherEvent(event.id, senderId);
          event = null;
        },
      };
    },
  };
}
