import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CARD_ART_PRESETS,
  getCardArtPreset,
  markerForCardArt,
  presetForCardArtMarker,
} from '../src/profile-presets.js';

test('photo registry is complete, immutable, and carries theme-ready metadata', async () => {
  assert.deepEqual(CARD_ART_PRESETS.map((preset) => preset.id), [
    'moss-room', 'windowseat', 'field-notes', 'arcade-glow', 'night-walk', 'constellation',
  ]);
  const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'profile-presets');
  for (const preset of CARD_ART_PRESETS) {
    assert.equal(Object.isFrozen(preset), true);
    assert.match(preset.name, /\S/);
    assert.match(preset.description, /\S/);
    assert.match(preset.primaryColor, /^#[0-9a-f]{6}$/i);
    assert.match(preset.title, /\S/);
    assert.match(preset.tagsEmoji, /\S/);
    assert.match(preset.assetFilename, /^[a-z0-9-]+\.jpg$/);
    const bytes = await fs.readFile(path.join(assets, preset.assetFilename));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.ok(bytes.length < 5 * 1024 * 1024);
  }
  assert.equal(Object.isFrozen(CARD_ART_PRESETS), true);
});

test('photo lookup and markers accept only exact known IDs', () => {
  const preset = getCardArtPreset('moss-room');
  assert.equal(preset.name, 'Canopy');
  assert.equal(getCardArtPreset('Moss Room'), null);
  assert.equal(markerForCardArt('moss-room'), 'preset:moss-room');
  assert.equal(presetForCardArtMarker('preset:moss-room'), preset);
  assert.equal(presetForCardArtMarker('preset:moss-room/../night-walk'), null);
  assert.equal(presetForCardArtMarker('preset:unknown'), null);
  assert.throws(() => markerForCardArt('unknown'), /valid photo preset/);
});
