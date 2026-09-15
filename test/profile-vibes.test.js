import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILE_VIBES, getProfileVibe } from '../src/profile-vibes.js';

test('vibe presets are readable, immutable, and independently addressable', () => {
  assert.equal(PROFILE_VIBES.length, 6);
  assert.equal(Object.isFrozen(PROFILE_VIBES), true);
  for (const vibe of PROFILE_VIBES) {
    assert.equal(Object.isFrozen(vibe), true);
    assert.match(vibe.id, /^[a-z0-9-]+$/);
    assert.match(vibe.name, /\S/);
    assert.match(vibe.description, /\S/);
    assert.match(vibe.primaryColor, /^#[0-9a-f]{6}$/i);
    assert.equal(getProfileVibe(vibe.id), vibe);
  }
  assert.equal(getProfileVibe('not-a-vibe'), null);
});
