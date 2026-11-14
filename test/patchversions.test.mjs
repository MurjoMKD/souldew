// A newer version of a ROM hack's patch added next to the old one (player report: "it says library updated but
// nothing changed in the patch version"): the library and the new-run wizard must use the newer one, and both
// versions must stay selectable and tell-apart-able.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';

// the server modules read their data directory at import time → a scratch dir first
const DATA = mkdtempSync(join(tmpdir(), 'sls-patchver-'));
process.env.SLS_DATA_DIR = DATA;
const { scanLibrary, nameVersion, compareVersions } = await import('../server/lib/library.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const ips = Buffer.from('PATCHEOF', 'latin1'); // an empty IPS patch
const folder = (name, files) => {
  const dir = join(DATA, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, when] of Object.entries(files)) {
    writeFileSync(join(dir, f), ips);
    if (when) utimesSync(join(dir, f), when, when);
  }
  return dir;
};
const ofHack = (res, id) => res.patches.filter((p) => p.hackId === id);

test('two versions of a hack: the one with the higher version in its name comes first, whatever the file order', () => {
  // "1.07" sorts before "1.08" in a folder listing (NTFS lists alphabetically) – the old version used to win
  const dir = folder('rnb', { 'Pokemon Run&Bun 1.07.ips': new Date('2026-11-20'), 'Pokemon Run&Bun 1.08.ips': new Date('2026-01-01') });
  const list = ofHack(scanLibrary({ libraryFolders: [dir] }), 'run-and-bun');
  assert.deepEqual(list.map((p) => p.name), ['Pokemon Run&Bun 1.08.ips', 'Pokemon Run&Bun 1.07.ips']);
  assert.deepEqual(list.map((p) => p.olderVersion), [false, true]);
  // what the hack's detail view and the wizard pick: the first patch of the hack
  assert.equal(scanLibrary({ libraryFolders: [dir] }).patches.find((p) => p.hackId === 'run-and-bun').name, 'Pokemon Run&Bun 1.08.ips');
});

test('no version in the names: the file added later comes first', () => {
  const dir = folder('tmt', { 'Too Many Types A.ips': new Date('2026-03-01T10:00:00Z'), 'Too Many Types B.ips': new Date('2026-11-14T10:00:00Z') });
  const list = ofHack(scanLibrary({ libraryFolders: [dir] }), 'too-many-types');
  assert.deepEqual(list.map((p) => p.name), ['Too Many Types B.ips', 'Too Many Types A.ips']);
});

test('patches of different hacks keep their order, a single patch is not marked', () => {
  const dir = folder('mixed', { 'Pokemon Unbound 2.1.ips': null, 'Pokemon Radical Red 4.1.ips': null });
  const res = scanLibrary({ libraryFolders: [dir] });
  for (const id of ['unbound', 'radical-red']) {
    const [p, ...rest] = ofHack(res, id);
    assert.equal(rest.length, 0, id);
    assert.ok(!p.olderVersion, id);
  }
});

test('version numbers from a file name', () => {
  assert.deepEqual(nameVersion('Pokemon Run&Bun 1.07.bps'), [[1, 7]]);
  assert.deepEqual(nameVersion('Too Many Types 2 v1.5.3.ips'), [[2], [1, 5, 3]]);
  assert.deepEqual(nameVersion('RenegadePlatinumV130.xdelta'), [[130]]);
  assert.deepEqual(nameVersion('rnb.bps'), []);
  const later = (a, b) => compareVersions(nameVersion(a), nameVersion(b)) > 0;
  assert.ok(later('Pokemon Run&Bun 1.08.bps', 'Pokemon Run&Bun 1.07.bps'));
  assert.ok(later('Too Many Types 2 v1.6.ips', 'Too Many Types 2 v1.5.3.ips'));
  assert.ok(later('v1.4.10_BlazeBlack2Redux.xdelta', 'v1.4.9_BlazeBlack2Redux.xdelta'));
  assert.ok(later('RenegadePlatinumV131.xdelta', 'RenegadePlatinumV130.xdelta'));
  assert.equal(compareVersions(nameVersion('rnb.bps'), nameVersion('Pokemon Run&Bun 1.08.bps')), 0, 'no number → undecided (file time decides)');
});

test('the hack picker names each version when a hack has several', async () => {
  const ROOT = new URL('../', import.meta.url).href;
  registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
  const { patchLabel } = await import('../web/lib/data.mjs');
  const nameOf = (id) => ({ 'run-and-bun': 'Pokémon Run & Bun', unbound: 'Pokémon Unbound' })[id];
  const a = { name: 'Pokemon Run&Bun 1.08.bps', hackId: 'run-and-bun' };
  const b = { name: 'Pokemon Run&Bun 1.07.bps', hackId: 'run-and-bun' };
  const c = { name: 'Unbound.ups', hackId: 'unbound' };
  const d = { name: 'My Hack.bps', hackId: null };
  const all = [a, b, c, d];
  assert.equal(patchLabel(a, all, nameOf), 'Pokémon Run & Bun · Pokemon Run&Bun 1.08.bps');
  assert.equal(patchLabel(b, all, nameOf), 'Pokémon Run & Bun · Pokemon Run&Bun 1.07.bps');
  assert.equal(patchLabel(c, all, nameOf), 'Pokémon Unbound');
  assert.equal(patchLabel(d, all, nameOf), 'My Hack.bps');
});

test('the hack detail view lets the player pick among the versions (not just the first patch)', () => {
  const view = readFileSync(new URL('../web/views/library.mjs', import.meta.url), 'utf8');
  const detail = view.slice(view.indexOf('function HackDetail'), view.indexOf('function RomDetail'));
  assert.match(detail, /filter\(\(p\) => p\.hackId === id\)/);
  assert.match(detail, /versions\.length > 1/);
  assert.doesNotMatch(detail, /patches\?\.find\(\(p\) => p\.hackId === id\)/);
});
