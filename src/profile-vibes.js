/**
 * Approachable card styles that stay independent from a member's photo and
 * title. Members can switch the feeling of their card without replacing
 * either piece of personal material.
 */
const vibes = [
  {
    id: 'quiet-green',
    name: 'Quiet green',
    description: 'Leafy, grounded, and soft.',
    primaryColor: '#58704C',
    secondaryColor: '#D8DDCF',
    tagsEmoji: '🌿',
  },
  {
    id: 'warm-dusk',
    name: 'Warm dusk',
    description: 'Golden, calm, and welcoming.',
    primaryColor: '#8B6E5B',
    secondaryColor: '#E1D2C3',
    tagsEmoji: '☀️',
  },
  {
    id: 'ocean-air',
    name: 'Ocean air',
    description: 'Cool, open, and easygoing.',
    primaryColor: '#5F7582',
    secondaryColor: '#D2DCE1',
    tagsEmoji: '🌊',
  },
  {
    id: 'lantern-night',
    name: 'Lantern night',
    description: 'Dark, warm, and a little magical.',
    primaryColor: '#A8683F',
    secondaryColor: '#2A2527',
    tagsEmoji: '✨',
  },
  {
    id: 'soft-cloud',
    name: 'Soft cloud',
    description: 'Dreamy, muted, and gentle.',
    primaryColor: '#7B7180',
    secondaryColor: '#E4DDE5',
    tagsEmoji: '☁️',
  },
  {
    id: 'clear-simple',
    name: 'Clear & simple',
    description: 'Plainspoken, warm, and easy to read.',
    primaryColor: '#786752',
    secondaryColor: null,
    tagsEmoji: null,
  },
];

export const PROFILE_VIBES = Object.freeze(vibes.map((vibe) => Object.freeze({ ...vibe })));

const vibesById = new Map(PROFILE_VIBES.map((vibe) => [vibe.id, vibe]));

export function getProfileVibe(id) {
  return typeof id === 'string' ? vibesById.get(id) || null : null;
}
