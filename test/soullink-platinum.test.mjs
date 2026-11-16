// Ticket #18 (Discord, 2.7.4): a two-player SoulLink in vanilla Platinum, dupes clause "Per player", level caps on.
// "The board didn't register an encounter as dupe if I caught the encounter on the route but my friend killed it."
// What souldew does there, end to end on the run logic (web/lib/run.mjs) with a Platinum run:
// - the pair of that area failed: the caught Pokémon may not be used (an error while it is in the team);
// - the dupes clause counts every catch – also one of a failed or dead pair: a second Pokémon of that line is a dupe;
//   "Per player" only your own catches, "For both" the partner's too;
// - a Pokémon that got away or was knocked out isn't a catch: it never counts as a dupe (the board stores a missed
//   encounter without its species);
// - the level caps come from the game's own trainers (Platinum has no curated list) and the badges read from the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

// Platinum (USA) is a "dynamic" game: its areas are made from the places the catches were met at
const PT = { id: 'pt18', mode: 'soullink', game: { id: 'pokemon-platinum', code: 'CPUE', system: 'nds' }, players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } } };
const R201 = 'm4-16'; // Route 201 (Gen 4 met location 16)
const R202 = 'm4-17';
const R203 = 'm4-18';
// Starly 396 → Staravia 397 → Staraptor 398, Bidoof 399 → Bibarel 400
const rd = { familyRoot: (id) => ({ 397: 396, 398: 396, 400: 399 })[id] || id, types: () => [] };
function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const mon = (o = {}) => ({ key: 'k1', species: 393, nickname: 'PIPLUP', level: 5, hp: 20, maxHp: 20, metLocation: 1, metLevel: 5, ...o });
const snap = (d, slot, party, extra = {}) => R.applySnapshot(d, PT, 4, slot, { source: 'live', party, ...extra }, { rd });

/** Ana catches a Starly on Route 201, Ben knocks his encounter there out and enters it as missed on the board. */
function failedPair(rules) {
  const d = mkDoc(rules);
  const ana = [mon({ key: 'a1' }), mon({ key: 'a2', species: 396, nickname: 'STARLY', metLocation: 16 })];
  const ben = [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' })];
  snap(d, 'p1', ana);
  snap(d, 'p2', ben);
  // (what the board's encounter dialog saves for "Missed (fled / fainted)")
  R.setEncounter(d, PT, R201, 'p2', { outcome: 'missed', species: null, nickname: '', level: null, shiny: false, key: null }, { by: 'p2' });
  return { d, ana, ben };
}

test('Platinum SoulLink: caught on a route where the partner’s encounter was knocked out – the pair failed, the catch may not be used', () => {
  const { d } = failedPair({ dupes: 'player', levelCaps: true });
  assert.equal(d.get(`enc:${R201}:p1`).species, 396, 'the live tracking filed the Starly under Route 201');
  assert.equal(R.pairState(d, R201, PT).state, 'failed');
  const errs = R.checks(d, PT, rd).filter((c) => c.level === 'error');
  assert.deepEqual(errs.map((c) => c.area), [R201]);
  assert.match(errs[0].text, /may not be used \(team of Ana\)/);
  // with "a missed encounter costs the whole pair" switched off the Starly stays usable
  const off = failedPair({ dupes: 'player', failKillsPair: false });
  assert.equal(R.checks(off.d, PT, rd).filter((c) => c.level === 'error').length, 0);
});

test('Platinum SoulLink, dupes "Per player": the catch of a failed pair still counts – the same line again is a dupe for its catcher only', () => {
  const { d, ana, ben } = failedPair({ dupes: 'player' });
  // in battle (the play view's catch rules): Ana meets another Starly – a dupe; for Ben it isn't (per player)
  assert.deepEqual(R.dupeOf(d, PT, rd, 396, 'p1'), { area: R201, slot: 'p1' });
  assert.deepEqual(R.dupeOf(d, PT, rd, 398, 'p1'), { area: R201, slot: 'p1' }, 'the whole evolution line');
  assert.equal(R.dupeOf(d, PT, rd, 396, 'p2'), null);
  // Ana catches a Staravia on Route 202 anyway: not entered as the area's encounter – the inbox says why
  const res = snap(d, 'p1', [...ana, mon({ key: 'a3', species: 397, nickname: 'STARAVIA', metLocation: 17 })]);
  assert.equal(d.get(`enc:${R202}:p1`, null), null);
  assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.reason, i.dupeArea]), [['a3', 'dupe', R201]]);
  // Ben catches a Starly on Route 202: his first of that line – his encounter there
  snap(d, 'p2', [...ben, mon({ key: 'b3', species: 396, nickname: 'STARLY', metLocation: 17 })]);
  assert.equal(d.get(`enc:${R202}:p2`).species, 396);
});

test('Platinum SoulLink, dupes "For both": a line either of you caught is a dupe for both – also from a failed pair', () => {
  const { d, ben } = failedPair({ dupes: 'both' });
  assert.deepEqual(R.dupeOf(d, PT, rd, 396, 'p2'), { area: R201, slot: 'p1' });
  const res = snap(d, 'p2', [...ben, mon({ key: 'b3', species: 396, nickname: 'STARLY', metLocation: 17 })]);
  assert.equal(d.get(`enc:${R202}:p2`, null), null);
  assert.deepEqual(res.inbox.map((i) => [i.reason, i.dupeArea]), [['dupe', R201]]);
});

test('Platinum SoulLink: a dead pair still counts for the dupes clause; a Pokémon that got away never does', () => {
  const { d, ben } = failedPair({ dupes: 'player' });
  // Route 203: both caught, then Ben's Bidoof fell – the pair is dead, both Pokémon count as caught for the dupes clause
  snap(d, 'p1', [mon({ key: 'a1' }), mon({ key: 'a4', species: 403, nickname: 'SHINX', metLocation: 18 })]);
  snap(d, 'p2', [...ben, mon({ key: 'b4', species: 399, nickname: 'BIDOOF', metLocation: 18 })]);
  R.markDead(d, PT, R203, { slot: 'p2', cause: 'test' });
  assert.equal(R.pairState(d, R203, PT).state, 'dead');
  assert.deepEqual(R.dupeOf(d, PT, rd, 400, 'p2'), { area: R203, slot: 'p2' });
  // Ben's encounter on Route 201 was knocked out, not caught: no dupe – whatever it was (the board doesn't ask)
  assert.equal(d.get(`enc:${R201}:p2`).species, null);
  for (const s of [396, 399, 390]) assert.equal(R.dupeOf(mkDoc({ dupes: 'both' }), PT, rd, s, 'p2'), null);
});

test('Platinum SoulLink level caps: the gym aces read from the game, by the badges each player has – per player, warnings name them', () => {
  const d = mkDoc({ levelCaps: true });
  // what shared/live/romcaps.mjs reads from Platinum (USA): Roark 14, Gardenia 22, Fantina 26, Maylene 32, Wake 37,
  // Byron 41, Candice 44, Volkner 50, Champion Cynthia 62 (checked against the ROM for ticket #18)
  const romCaps = { caps: [14, 22, 26, 32, 37, 41, 44, 50], leaders: null, final: { name: 'Champion', cap: 62 } };
  // (a level jump is believed on the second read in a row – lib/run.mjs trustLevels)
  const reads = (slot, party, extra) => [1, 2].forEach(() => snap(d, slot, party, extra));
  const ana = (level) => [mon({ key: 'a1', level })];
  const ben = (level) => [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR', level })];
  snap(d, 'p1', ana(12), { romCaps });
  assert.equal(R.levelCap(d, PT, 'p1').cap, null, 'badges not read yet: no cap rather than a wrong one');
  snap(d, 'p1', ana(12), { romCaps, badges: 0 });
  snap(d, 'p2', ben(13), { romCaps, badges: 0 });
  assert.deepEqual([R.levelCap(d, PT, 'p1').cap, R.levelCap(d, PT, 'p2').cap], [14, 14]);
  assert.equal(R.levelCap(d, PT, 'p1').boss.name, 'Gym 1', '(Platinum names no leader per badge: "Gym n")');
  assert.equal(R.checks(d, PT, rd).filter((c) => /Level cap/.test(c.text)).length, 0);
  // Ana beats Roark and Gardenia, Ben only Roark: each has the cap of their own next gym
  reads('p1', ana(23), { romCaps, badges: 2 });
  reads('p2', ben(23), { romCaps, badges: 1 });
  assert.deepEqual([R.levelCap(d, PT, 'p1').cap, R.levelCap(d, PT, 'p2').cap], [26, 22]);
  const over = R.checks(d, PT, rd).filter((c) => /Level cap/.test(c.text));
  assert.deepEqual(over.map((c) => [c.level, c.slot]), [['warn', 'p2']]);
  assert.match(over[0].text, /Level cap 22 exceeded: Ben’s CHIMCHAR is level 23/);
  // all eight badges: the champion's ace
  reads('p1', ana(55), { romCaps, badges: 8 });
  assert.equal(R.levelCap(d, PT, 'p1').cap, 62);
  // caps off: no warnings at all
  d.set('rules', { levelCaps: false });
  assert.equal(R.checks(d, PT, rd).filter((c) => /Level cap/.test(c.text)).length, 0);
});

test('board rules: the dupes clause says what counts – whose catches, and that a failed or dead pair’s catch counts too', () => {
  const board = readFileSync(new URL('../web/views/board.mjs', import.meta.url), 'utf8');
  assert.match(board, /t\('rules\.dupesPlayerHint'/);
  assert.match(board, /t\('rules\.dupesBothHint'/);
  assert.match(board, /t\('rules\.dupesWhich'/);
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  for (const lang of ['de', 'fr', 'es', 'it']) {
    const tr = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of Object.keys(en).filter((x) => x.startsWith('rules.dupes'))) assert.ok(tr[k], `${lang}: ${k}`);
  }
});
