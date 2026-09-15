import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_ART_PRESETS,
  getCardArtPreset,
  markerForCardArt,
  presetForCardArtMarker,
} from '../src/profile-presets.js';

test('card art registry is complete, immutable, and carries theme-ready metadata', () => {
  assert.deepEqual(CARD_ART_PRESETS.map((preset) => preset.id), [
    'windowseat', 'field-notes', 'arcade-glow', 'moss-room', 'night-walk', 'constellation',
  ]);
  for (const preset of CARD_ART_PRESETS) {
    assert.equal(Object.isFrozen(preset), true);
    assert.match(preset.name, /\S/);
    assert.match(preset.description, /\S/);
    assert.match(preset.primaryColor, /^#[0-9a-f]{6}$/i);
    assert.match(preset.title, /\S/);
    assert.match(preset.tagsEmoji, /\S/);
    assert.match(preset.assetFilename, /^[a-z0-9-]+\.png$/);
  }
  assert.equal(Object.isFrozen(CARD_ART_PRESETS), true);
});

test('card art lookup and markers accept only exact known IDs', () => {
  const preset = getCardArtPreset('moss-room');
  assert.equal(preset.name, 'Moss Room');
  assert.equal(getCardArtPreset('Moss Room'), null);
  assert.equal(markerForCardArt('moss-room'), 'preset:moss-room');
  assert.equal(presetForCardArtMarker('preset:moss-room'), preset);
  assert.equal(presetForCardArtMarker('preset:moss-room/../night-walk'), null);
  assert.equal(presetForCardArtMarker('preset:unknown'), null);
  assert.throws(() => markerForCardArt('unknown'), /valid card art preset/);
});
