import assert from 'node:assert/strict';
import test from 'node:test';
import { STARTER_PACKS, getStarterPack } from '../src/starter-packs.js';

test('starter packs stay small, unique, previewable, and free of the retired filler tags', () => {
  assert.equal(Object.isFrozen(STARTER_PACKS), true);
  assert.deepEqual(STARTER_PACKS.map((pack) => pack.id), ['play', 'make', 'learn', 'common']);

  const retired = new Set(['Introductions', 'Local events', 'Homework', 'Accountability', 'Game nights']);
  const slugs = new Set();
  for (const pack of STARTER_PACKS) {
    assert.equal(Object.isFrozen(pack), true);
    assert.equal(Object.isFrozen(pack.interests), true);
    assert.ok(pack.interests.length > 0 && pack.interests.length <= 25);
    assert.ok(pack.interests.map((interest) => interest.name).join(' · ').length <= 100);
    assert.equal(getStarterPack(pack.id), pack);
    for (const interest of pack.interests) {
      assert.equal(Object.isFrozen(interest), true);
      assert.match(interest.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.equal(slugs.has(interest.slug), false);
      assert.equal(retired.has(interest.name), false);
      slugs.add(interest.slug);
    }
  }
  assert.equal(getStarterPack('missing'), null);
});
