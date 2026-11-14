// The two titles of a classic pair (HeartGold + SoulSilver, Red + Blue, …) share one plain SoulLink (#18): the same
// maps, the same location ids (so the same run areas), the same badges and level caps – only some wild Pokémon
// differ, and a SoulLink links by area, not by species, so every player simply catches what their own game has.
// Each player's live tracking reads their own ROM (shared/live/parse.mjs findEntry by its own game code / title ID),
// and both titles of every pair below have their own entry in shared/data/addresses.json.
// Third versions (Yellow, Crystal, Emerald, Platinum) are not pairs: their maps, events and scripts differ.
// Randomized or patched runs still need byte-identical ROMs (shared/restart.mjs needsIdenticalRom).

/** Catalog ids (main games, no language variants) of the titles that may share one plain SoulLink. */
export const PAIR_TITLES = Object.freeze([
  ['pokemon-red', 'pokemon-blue'],
  ['pokemon-gold', 'pokemon-silver'],
  ['pokemon-ruby', 'pokemon-sapphire'],
  ['pokemon-firered', 'pokemon-leafgreen'],
  ['pokemon-diamond', 'pokemon-pearl'],
  ['pokemon-heartgold', 'pokemon-soulsilver'],
  ['pokemon-black', 'pokemon-white'],
  ['pokemon-black-2', 'pokemon-white-2'],
  ['pokemon-x', 'pokemon-y'],
  ['pokemon-omega-ruby', 'pokemon-alpha-sapphire'],
  ['pokemon-sun', 'pokemon-moon'],
  ['pokemon-ultra-sun', 'pokemon-ultra-moon'],
].map((p) => Object.freeze(p)));

const MATE = new Map(PAIR_TITLES.flatMap(([a, b]) => [[a, b], [b, a]]));

/** The other title of a pair for a main game's catalog id ('pokemon-heartgold' → 'pokemon-soulsilver'), else null. */
export function pairMate(gameId) {
  return MATE.get(gameId) || null;
}
