// The lives rule (shared/lives.mjs, web/lib/run.mjs): every death costs one life from the right pool (shared or per
// player, 1–4 players), the count is derived from the deaths that stand (undo gives the life back), the death that
// takes the last life ends the run like any other run end, runs without the rule are untouched, and the stream API
// shows what is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { livesRule, livesLeft, livesOf, deathsIn, clampLives, LIVES_DEFAULT, LIVES_MAX } from '../shared/lives.mjs';
import { buildState } from '../shared/streamapi.mjs';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const HG = { id: 'run1', game: { code: 'IPKE', system: 'nds' } };
const SOLO = { ...HG, mode: 'nuzlocke', name: 'Lou – Nuzlocke', players: { p1: { name: 'Lou' } } };
const PAIR = { ...HG, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } } };
const TRIO = { ...HG, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' }, p3: { name: 'Kai' } } };
const FOUR = { ...HG, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' }, p3: { name: 'Kai' }, p4: { name: 'Mo' } } };

function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const status = (d) => d.get('run:status', null);
const feedTexts = (d) => R.feedList(d).map((f) => f.text);
// every death a little later than the one before (diedAt orders them)
let clock = Date.now();
const at = (fn) => {
  const real = Date.now;
  clock += 1000;
  Date.now = () => clock;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
};
const die = (d, m, area, slot) => at(() => R.markDead(d, m, area, { slot }));

test('rule: off unless lives > 0, clamped, one pool for a solo run', () => {
  assert.equal(livesRule({}, ['p1', 'p2']), null, 'a run from before the rule');
  assert.equal(livesRule({ lives: 0, livesPool: 'player' }, ['p1', 'p2']), null);
  assert.equal(livesRule({ lives: 'x' }, ['p1']), null);
  assert.deepEqual(livesRule({ lives: 20 }, ['p1', 'p2']), { total: 20, pool: 'shared' });
  assert.deepEqual(livesRule({ lives: 7, livesPool: 'player' }, ['p1', 'p2', 'p3']), { total: 7, pool: 'player' });
  assert.deepEqual(livesRule({ lives: 5, livesPool: 'player' }, ['p1']), { total: 5, pool: 'shared' }, 'solo: one pool');
  assert.equal(livesRule({ lives: 500 }, ['p1']).total, LIVES_MAX);
  assert.equal(clampLives('abc'), LIVES_DEFAULT);
  assert.equal(clampLives(0.4), LIVES_DEFAULT);
  assert.equal(clampLives(-3), 1);
  assert.equal(clampLives('12'), 12);
  // the defaults carry the rule switched off – for both modes
  assert.equal(R.rules(mkDoc(), SOLO).lives, 0);
  assert.equal(R.rules(mkDoc(), PAIR).livesPool, 'shared');
});

test('count: from the deaths that stand – groups by who fell, bonus Pokémon by their owner', () => {
  const pairs = {
    a: { state: 'dead', by: 'p1', diedAt: 3 }, b: { state: 'dead', by: 'p2', diedAt: 1 }, c: { state: 'alive', by: 'p1' },
    d: { state: 'dead', diedAt: 2 }, // no `by` (an old death): counts for the host
  };
  const extras = { 'p2:k9': { dead: true, diedAt: 4 }, 'p1:k3': { dead: false } };
  const deaths = deathsIn(pairs, extras);
  assert.deepEqual(deaths.map((x) => x.area || x.extra), ['b', 'd', 'a', 'p2:k9'], 'oldest first, revived ones left out');
  const slots = ['p1', 'p2'];
  const shared = livesLeft({ lives: 5 }, slots, deaths);
  assert.deepEqual([shared.pools.all.used, shared.pools.all.left, shared.pools.all.out], [4, 1, false]);
  assert.equal(livesOf(shared, 'p2', slots), shared.pools.all, 'everyone spends from the shared pool');
  const own = livesLeft({ lives: 2, livesPool: 'player' }, slots, deaths);
  assert.deepEqual(Object.keys(own.pools), ['p1', 'p2']);
  assert.deepEqual([own.pools.p1.used, own.pools.p1.left, own.pools.p1.out], [2, 0, true]);
  assert.deepEqual([own.pools.p2.used, own.pools.p2.left], [2, 0]);
  assert.equal(livesOf(own, 'p9', slots), own.pools.p1, 'an unknown slot: the host');
  assert.equal(livesLeft({ lives: 3 }, slots, [{ slot: 'p1' }, { slot: 'p1' }, { slot: 'p1' }, { slot: 'p2' }]).pools.all.left, 0, 'never below 0');
  // "low" (the warning): few left after a death – not a run that starts with few, not one that is out
  const low = (total, used) => livesLeft({ lives: total }, slots, Array.from({ length: used }, () => ({ slot: 'p1' }))).pools.all.low;
  assert.deepEqual([low(20, 16), low(20, 17), low(20, 19), low(20, 20), low(3, 0), low(3, 1), low(1, 0)], [false, true, true, false, false, true, false]);
  assert.equal(livesLeft({}, slots, deaths), null);
});

test('SoulLink, shared: a dying pair costs one life, the last one ends the run for everyone; undo gives it back', () => {
  const d = mkDoc({ lives: 3 });
  assert.equal(R.lives(d, PAIR).pools.all.left, 3);
  die(d, PAIR, 'route-29', 'p1');
  assert.equal(R.lives(d, PAIR).pools.all.left, 2, 'the partner’s linked Pokémon going with it costs nothing more');
  die(d, PAIR, 'route-30', 'p2');
  assert.equal(R.livesFor(d, PAIR, 'p1').left, 1);
  assert.equal(status(d), null);
  // the same group can't die twice
  assert.equal(at(() => R.markDead(d, PAIR, 'route-30', { slot: 'p1' })), false);
  assert.equal(R.lives(d, PAIR).pools.all.used, 2);
  die(d, PAIR, 'cherrygrove', 'p2');
  assert.deepEqual([status(d).state, status(d).reason, status(d).by, status(d).area, status(d).auto], ['failed', 'lives', 'p2', 'cherrygrove', true]);
  assert.ok(feedTexts(d).some((x) => x.includes('The last life is gone')));
  // a death marked by mistake: undone, the life is back and the run goes on
  R.revive(d, 'route-29', PAIR);
  assert.equal(R.lives(d, PAIR).pools.all.left, 1);
  assert.equal(status(d), null);
  assert.ok(feedTexts(d).some((x) => x.includes('reopened the run')));
});

test('SoulLink, per player (2–4 players): only the player whose Pokémon fell pays; any empty pool ends the run', () => {
  for (const m of [PAIR, TRIO, FOUR]) {
    const slots = R.slotsOf(m);
    const d = mkDoc({ lives: 2, livesPool: 'player' });
    die(d, m, 'a1', 'p2');
    const l = R.lives(d, m);
    assert.deepEqual(Object.keys(l.pools), slots);
    assert.equal(l.pools.p2.left, 1);
    for (const s of slots.filter((x) => x !== 'p2')) assert.equal(l.pools[s].left, 2, `${slots.length} players: ${s} keeps all`);
    die(d, m, 'a2', slots.at(-1) === 'p2' ? 'p1' : slots.at(-1));
    assert.equal(status(d), null, 'one death each – nobody is out');
    die(d, m, 'a3', 'p2');
    assert.deepEqual([status(d)?.reason, status(d)?.by], ['lives', 'p2'], `${slots.length} players: p2 is out – the run is over`);
    assert.ok(feedTexts(d).some((x) => x.includes('Robin has no lives left')));
    // undoing another player's death doesn't help p2
    R.revive(d, 'a2', m);
    assert.equal(status(d)?.reason, 'lives');
    R.revive(d, 'a1', m);
    assert.equal(status(d), null, 'p2 has a life again');
  }
});

test('Nuzlocke: bonus Pokémon count, undoing one reopens, deathless still ends on the first death', () => {
  const d = mkDoc({ lives: 2, blackout: 'off' });
  d.set('extra:p1:k7', { species: 25, shiny: true });
  die(d, SOLO, 'route-29', 'p1');
  assert.equal(R.lives(d, SOLO).pools.all.left, 1);
  at(() => R.markExtraDead(d, SOLO, 'p1', 'k7'));
  assert.deepEqual([status(d)?.reason, status(d)?.extra], ['lives', 'p1:k7']);
  assert.ok(feedTexts(d).some((x) => x.includes('Lou has no lives left – the Nuzlocke has failed')));
  assert.equal(R.markExtraDead(d, SOLO, 'p1', 'k7', false), true);
  assert.equal(status(d), null);
  assert.equal(R.lives(d, SOLO).pools.all.left, 1);
  // deathless wins: it ends the run on the first death, whatever lives are left
  const g = mkDoc({ lives: 10, deathless: true });
  die(g, SOLO, 'route-29', 'p1');
  assert.equal(status(g).reason, 'deathless');
});

test('more deaths than lives: undoing one keeps the run over; "play on" ends it again at the next death', () => {
  const d = mkDoc({ lives: 1 });
  // two partners' deaths arrive at once (synced from two computers): both stand
  d.set('pair:r1', { state: 'dead', by: 'p1', diedAt: 1 });
  die(d, PAIR, 'r2', 'p2');
  assert.equal(status(d).reason, 'lives');
  assert.equal(R.lives(d, PAIR).pools.all.used, 2);
  R.revive(d, 'r2', PAIR);
  assert.equal(status(d).reason, 'lives', 'still no life left');
  R.revive(d, 'r1', PAIR);
  assert.equal(status(d), null);
  // out of lives, played on anyway: the next death takes a life that isn't there
  die(d, PAIR, 'r3', 'p1');
  assert.equal(status(d).reason, 'lives');
  at(() => R.resumeRun(d, 'p1'));
  assert.equal(status(d), null);
  die(d, PAIR, 'r4', 'p2');
  assert.equal(status(d).reason, 'lives');
});

test('changing the rule never ends the run by itself; a run without the rule never ends by lives', () => {
  const d = mkDoc({ lives: 5 });
  die(d, PAIR, 'r1', 'p1');
  die(d, PAIR, 'r2', 'p1');
  d.set('rules', { lives: 2 });
  assert.equal(R.lives(d, PAIR).pools.all.left, 0);
  assert.equal(status(d), null, 'lowering the lives is no death');
  die(d, PAIR, 'r3', 'p2');
  assert.equal(status(d).reason, 'lives');
  // old runs: no `lives` in the rules – deaths are just deaths
  for (const m of [SOLO, PAIR, FOUR]) {
    const o = mkDoc(m === SOLO ? { blackout: 'off' } : undefined);
    for (let i = 0; i < 30; i++) die(o, m, `x${i}`, 'p1');
    assert.equal(R.lives(o, m), null);
    assert.equal(status(o), null, `${R.slotsOf(m).length} player(s)`);
  }
});

test('auto-death from a live snapshot takes the last life: failed = "lives"', () => {
  const d = mkDoc({ lives: 1, blackout: 'off' });
  const mon = (o = {}) => ({ key: 'k1', species: 152, nickname: 'CHIKO', level: 5, hp: 20, maxHp: 20, metLocation: 126, metLevel: 5, ...o });
  const pidgey = (o = {}) => mon({ key: 'k2', species: 16, nickname: 'PIDGE', metLocation: 177, level: 3, metLevel: 3, ...o });
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon(), pidgey()] });
  const res = R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon(), pidgey({ hp: 0 })] });
  assert.deepEqual(res.deaths, ['route-29']);
  assert.equal(res.failed, 'lives');
  assert.equal(status(d).reason, 'lives');
});

test('changing the rule on the board is logged for everyone', () => {
  const d = mkDoc();
  R.logLivesRule(d, PAIR, 'p1', { lives: 20, livesPool: 'shared' });
  R.logLivesRule(d, PAIR, 'p2', { lives: 5, livesPool: 'player' });
  R.logLivesRule(d, SOLO, 'p1', { lives: 1 });
  R.logLivesRule(d, PAIR, 'p1', { lives: 0 });
  const texts = feedTexts(d);
  for (const x of ['set 20 shared lives for the run', 'set the lives to 5 per player', '1 life for this run', 'turned the lives off']) assert.ok(texts.includes(x), x);
});

test('stream API: lives left for the run and each player – null without the rule', () => {
  const e = (v) => ({ v, t: 1, by: 'dev' });
  const manifest = { id: 'r', mode: 'soullink', players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, game: { id: 'pokemon-heartgold', system: 'nds', code: 'IPKE' } };
  const raw = (rules) => ({ rules: e(rules), 'pair:a': e({ state: 'dead', by: 'p2', diedAt: 5 }), 'pair:b': e({ state: 'alive' }), 'extra:p1:k': e({ dead: true, diedAt: 6 }) });
  const off = buildState(manifest, raw({}), { now: 10 });
  assert.equal(off.run.lives, null);
  assert.equal(off.run.rules.lives, 0);
  assert.equal(off.players[0].lives, null);
  const shared = buildState(manifest, raw({ lives: 10 }), { now: 10 });
  assert.deepEqual(shared.run.lives, { total: 10, pool: 'shared', left: 8, used: 2 });
  assert.deepEqual(shared.players.map((p) => p.lives), [{ left: 8, used: 2 }, { left: 8, used: 2 }]);
  const own = buildState(manifest, raw({ lives: 3, livesPool: 'player' }), { now: 10 });
  assert.deepEqual(own.run.lives, { total: 3, pool: 'player', left: null, used: null });
  assert.deepEqual(own.players.map((p) => p.lives), [{ left: 2, used: 1 }, { left: 2, used: 1 }]);
});
