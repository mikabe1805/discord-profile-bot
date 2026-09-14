import assert from 'node:assert/strict';
import test from 'node:test';
import { canViewBoundaries, normalizeInterestSlug, parseInterests, safeDisplayText } from '../src/domain.js';

test('normalizes and parses human interest text into stable unique slugs', () => {
  assert.equal(normalizeInterestSlug('  Café & Board Games!  '), 'cafe-and-board-games');
  assert.deepEqual(parseInterests('Games, Art & Design, games, , Café', { max: 3 }), ['games', 'art-and-design', 'cafe']);
  assert.deepEqual(parseInterests(null), []);
});

test('makes member text safe to place in a Discord payload', () => {
  assert.equal(safeDisplayText('hello\u0000 @everyone\nplease'), 'hello @\u200beveryone please');
  assert.equal(safeDisplayText('@HERE', { maxLength: 4 }), '@\u200bH…');
  assert.equal(safeDisplayText('   ', { fallback: 'Nothing shared.' }), 'Nothing shared.');
});

test('boundary access follows the selected audience without a moderator bypass', () => {
  assert.equal(canViewBoundaries({ ownerId: 'a', viewerId: 'a', privacyLevel: 'private' }), true);
  assert.equal(canViewBoundaries({ ownerId: 'a', viewerId: 'b', privacyLevel: 'members', viewerIsMember: true }), true);
  assert.equal(canViewBoundaries({ ownerId: 'a', viewerId: 'b', privacyLevel: 'members', viewerIsMember: false }), false);
  assert.equal(canViewBoundaries({ ownerId: 'a', viewerId: 'b', privacyLevel: 'role', privacyRoleId: 'r', viewerRoleIds: ['r'] }), true);
  assert.equal(canViewBoundaries({ ownerId: 'a', viewerId: 'b', privacyLevel: 'role', privacyRoleId: 'r', viewerRoleIds: [], isModerator: true }), false);
  assert.equal(canViewBoundaries({ ownerId: 'a', viewerId: 'b', privacyLevel: 'private' }), false);
});
