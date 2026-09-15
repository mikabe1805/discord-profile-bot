/**
 * Curated, bundled card art. These descriptors are deliberately separate from
 * a member's uploaded image: their marker is portable, and the artwork is
 * shipped read-only with the bot.
 */
const presets = [
  {
    id: 'windowseat',
    name: 'Windowseat',
    description: 'A warm rainy corner for slow conversations.',
    primaryColor: '#786752',
    title: 'Windowseat',
    tagsEmoji: '☕',
    assetFilename: 'windowseat.png',
  },
  {
    id: 'field-notes',
    name: 'Field Notes',
    description: 'Paper, ink, and room for a new obsession.',
    primaryColor: '#6F8060',
    title: 'Field Notes',
    tagsEmoji: '✎',
    assetFilename: 'field-notes.png',
  },
  {
    id: 'arcade-glow',
    name: 'Arcade Glow',
    description: 'A bright little signal for game nights and side quests.',
    primaryColor: '#A85C8B',
    title: 'Arcade Glow',
    tagsEmoji: '🕹️',
    assetFilename: 'arcade-glow.png',
  },
  {
    id: 'moss-room',
    name: 'Moss Room',
    description: 'Soft green, low stakes, and comfortable silences.',
    primaryColor: '#56715A',
    title: 'Moss Room',
    tagsEmoji: '🌿',
    assetFilename: 'moss-room.png',
  },
  {
    id: 'night-walk',
    name: 'Night Walk',
    description: 'Cool air, city lights, and a good tangent.',
    primaryColor: '#2F425E',
    title: 'Night Walk',
    tagsEmoji: '🌙',
    assetFilename: 'night-walk.png',
  },
  {
    id: 'constellation',
    name: 'Constellation',
    description: 'A quiet sky for people who find each other over time.',
    primaryColor: '#7663A6',
    title: 'Constellation',
    tagsEmoji: '✦',
    assetFilename: 'constellation.png',
  },
];

export const CARD_ART_PRESETS = Object.freeze(presets.map((preset) => Object.freeze({ ...preset })));

const presetsById = new Map(CARD_ART_PRESETS.map((preset) => [preset.id, preset]));

/** Return a preset descriptor for an exact ID, or null for an unknown preset. */
export function getCardArtPreset(id) {
  return typeof id === 'string' ? presetsById.get(id) || null : null;
}

/** Create the only persisted marker format accepted for bundled card art. */
export function markerForCardArt(id) {
  const preset = getCardArtPreset(id);
  if (!preset) throw new RangeError('Choose a valid card art preset.');
  return `preset:${preset.id}`;
}

/** Resolve an exact persisted marker without accepting aliases or path fragments. */
export function presetForCardArtMarker(marker) {
  if (typeof marker !== 'string' || !marker.startsWith('preset:')) return null;
  const id = marker.slice('preset:'.length);
  const preset = getCardArtPreset(id);
  return preset && marker === markerForCardArt(preset.id) ? preset : null;
}
