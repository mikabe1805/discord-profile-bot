/**
 * Small, reviewable sets of interests that can plausibly lead to a useful
 * /find result, conversation, or group invitation. They are suggestions for
 * moderators to curate, never defaults that are inserted automatically.
 */
const packs = [
  {
    id: 'play',
    name: 'Play together',
    interests: [
      { slug: 'co-op-games', name: 'Co-op games' },
      { slug: 'tabletop-games', name: 'Tabletop games' },
      { slug: 'ttrpgs', name: 'TTRPGs' },
      { slug: 'fighting-games', name: 'Fighting games' },
    ],
  },
  {
    id: 'make',
    name: 'Make together',
    interests: [
      { slug: 'art-design', name: 'Art & design' },
      { slug: 'writing', name: 'Writing' },
      { slug: 'music-making', name: 'Music making' },
      { slug: 'photography', name: 'Photography' },
      { slug: 'game-development', name: 'Game development' },
    ],
  },
  {
    id: 'learn',
    name: 'Learn together',
    interests: [
      { slug: 'study-sessions', name: 'Study sessions' },
      { slug: 'programming', name: 'Programming' },
      { slug: 'language-exchange', name: 'Language exchange' },
      { slug: 'project-feedback', name: 'Project feedback' },
    ],
  },
  {
    id: 'common',
    name: 'Common ground',
    interests: [
      { slug: 'movies-shows', name: 'Movies & shows' },
      { slug: 'books', name: 'Books' },
      { slug: 'cooking', name: 'Cooking' },
      { slug: 'outdoors', name: 'Outdoors' },
    ],
  },
];

export const STARTER_PACKS = Object.freeze(packs.map((pack) => Object.freeze({
  ...pack,
  interests: Object.freeze(pack.interests.map((interest) => Object.freeze({ ...interest }))),
})));

const packsById = new Map(STARTER_PACKS.map((pack) => [pack.id, pack]));

export function getStarterPack(id) {
  return typeof id === 'string' ? packsById.get(id) || null : null;
}
