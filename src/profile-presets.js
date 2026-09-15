/**
 * Curated, bundled photographs. These descriptors are deliberately separate
 * from a member's uploaded image: their marker is portable, and the photos are
 * shipped read-only with the bot. IDs stay stable because profiles persist them.
 */
const presets = [
  {
    id: 'moss-room',
    name: 'Canopy',
    description: 'Bright leaves and the feeling of looking deeper.',
    primaryColor: '#58704C',
    title: 'Canopy',
    tagsEmoji: '🌿',
    assetFilename: 'canopy.jpg',
  },
  {
    id: 'windowseat',
    name: 'Still Water',
    description: 'A quiet sunset reflected across the lake.',
    primaryColor: '#8B6E5B',
    title: 'Still Water',
    tagsEmoji: '🌅',
    assetFilename: 'still-water.jpg',
  },
  {
    id: 'field-notes',
    name: 'Shoreline',
    description: 'Small waves, smooth stones, and room to breathe.',
    primaryColor: '#75665F',
    title: 'Shoreline',
    tagsEmoji: '🌊',
    assetFilename: 'shoreline.jpg',
  },
  {
    id: 'arcade-glow',
    name: 'Lantern Sky',
    description: 'A dark sky filled with warm drifting lights.',
    primaryColor: '#A8683F',
    title: 'Lantern Sky',
    tagsEmoji: '✨',
    assetFilename: 'lantern-sky.jpg',
  },
  {
    id: 'night-walk',
    name: 'Olive Dusk',
    description: 'Cool trees over a soft wash of evening color.',
    primaryColor: '#66777A',
    title: 'Olive Dusk',
    tagsEmoji: '🫒',
    assetFilename: 'olive-dusk.jpg',
  },
  {
    id: 'constellation',
    name: 'Hillside Weather',
    description: 'Pastel storm light moving over distant hills.',
    primaryColor: '#7B7180',
    title: 'Hillside Weather',
    tagsEmoji: '☁️',
    assetFilename: 'hillside-weather.jpg',
  },
];

export const CARD_ART_PRESETS = Object.freeze(presets.map((preset) => Object.freeze({ ...preset })));

const presetsById = new Map(CARD_ART_PRESETS.map((preset) => [preset.id, preset]));

/** Return a preset descriptor for an exact ID, or null for an unknown preset. */
export function getCardArtPreset(id) {
  return typeof id === 'string' ? presetsById.get(id) || null : null;
}

/** Create the only persisted marker format accepted for a bundled photo. */
export function markerForCardArt(id) {
  const preset = getCardArtPreset(id);
  if (!preset) throw new RangeError('Choose a valid photo preset.');
  return `preset:${preset.id}`;
}

/** Resolve an exact persisted marker without accepting aliases or path fragments. */
export function presetForCardArtMarker(marker) {
  if (typeof marker !== 'string' || !marker.startsWith('preset:')) return null;
  const id = marker.slice('preset:'.length);
  const preset = getCardArtPreset(id);
  return preset && marker === markerForCardArt(preset.id) ? preset : null;
}
