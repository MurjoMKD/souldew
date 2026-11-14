// An already-patched ROM hack ("kaizo-emerald.gba"): its header still says Emerald and the catalog has no checksum
// for it. "This is a ROM hack…" links it to a catalog hack (or names an unknown one) by its CRC32; a file name that
// looks like a hack is suggested; runs of such ROMs are hack runs (exact ROM for joiners, no vanilla level caps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { crc32 } from 'node:zlib';
import { guessHack, nameWords } from '../shared/hackguess.mjs';
import { needsIdenticalRom, baseRomsFor } from '../shared/restart.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-romhack-'));
process.env.SLS_DATA_DIR = DATA;
const { scanLibrary, setRomHack } = await import('../server/lib/library.mjs');
const { buildRun } = await import('../server/lib/build.mjs');
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));
const ROOT = new URL('../', import.meta.url).href;
registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
const { addedToLibrary, addedMessage } = await import('../web/lib/libadded.mjs');
const catalog = JSON.parse(readFileSync(new URL('../shared/data/catalog.json', import.meta.url), 'utf8'));

const LIB = join(DATA, 'Library');
mkdirSync(LIB, { recursive: true });

/** A GBA ROM with Emerald's header (BPEE) and content no catalog dump has. */
function emeraldHack(fill = 0x5a) {
  const b = Buffer.alloc(0x10000, fill);
  b.write('POKEMON EMER', 0xa0, 'latin1');
  b.write('BPEE', 0xac, 'latin1');
  b[0xb2] = 0x96;
  return b;
}
const crcOf = (b) => crc32(b).toString(16).toUpperCase().padStart(8, '0');

test('file names that look like a catalog hack of the header’s game', () => {
  const g = (name, game) => guessHack(name, game, catalog)?.id ?? null;
  assert.equal(g('kaizo-emerald.gba', 'pokemon-emerald'), 'emerald-kaizo');
  assert.equal(g('Emerald_Kaizo_v2.gba', 'pokemon-emerald'), 'emerald-kaizo');
  assert.equal(g('Pokémon Emerald Kaizo (2.0).gba', 'pokemon-emerald'), 'emerald-kaizo');
  assert.equal(g('radicalred 4.1.gba', 'pokemon-firered'), 'radical-red');
  assert.equal(g('too many types 2 v1.3.gba', 'pokemon-emerald'), 'too-many-types-2', 'the longer name wins');
  assert.equal(g('Too Many Types.gba', 'pokemon-emerald'), 'too-many-types');
  assert.equal(g('RunAndBun 1.08.gba', 'pokemon-emerald'), 'run-and-bun');
  // not a hack, or a hack of another game
  assert.equal(g('Pokemon - Emerald Version (USA, Europe).gba', 'pokemon-emerald'), null);
  assert.equal(g('radicalred 4.1.gba', 'pokemon-emerald'), null);
  assert.equal(g('kaizo-emerald.gba', null), null);
  assert.deepEqual(nameWords('Pokémon Emerald_Kaizo v2.gba'), ['emerald', 'kaizo', 'v2']);
});

test('library: the ROM is suggested, linked by its CRC32 (also after a rename), named, dismissed, undone', () => {
  const rom = emeraldHack();
  const crc = crcOf(rom);
  writeFileSync(join(LIB, 'kaizo-emerald.gba'), rom);
  let r = scanLibrary({}).roms.find((x) => x.name === 'kaizo-emerald.gba');
  assert.deepEqual([r.gameId, r.exact, r.hackId, r.suggestedHackId], ['pokemon-emerald', false, null, 'emerald-kaizo']);

  let marks = setRomHack({}, { crc, hackId: 'emerald-kaizo' }, catalog);
  r = scanLibrary({ romHacks: marks }).roms.find((x) => x.crc === crc);
  assert.deepEqual([r.hackId, r.hackMarked, r.suggestedHackId], ['emerald-kaizo', true, undefined]);
  renameSync(join(LIB, 'kaizo-emerald.gba'), join(LIB, 'my game.gba'));
  r = scanLibrary({ romHacks: marks }).roms.find((x) => x.crc === crc);
  assert.equal(r.hackId, 'emerald-kaizo', 'kept by checksum');

  marks = setRomHack(marks, { crc: crc.toLowerCase(), name: '  My  Kaizo\u0007 Edit ' }, catalog);
  r = scanLibrary({ romHacks: marks }).roms.find((x) => x.crc === crc);
  assert.deepEqual([r.hackId, r.customHack], [null, 'My Kaizo Edit']);

  marks = setRomHack(marks, { crc, none: true }, catalog);
  renameSync(join(LIB, 'my game.gba'), join(LIB, 'kaizo-emerald.gba'));
  r = scanLibrary({ romHacks: marks }).roms.find((x) => x.crc === crc);
  assert.deepEqual([r.hackId, r.customHack, r.suggestedHackId], [null, undefined, undefined], '"no, it isn’t" – no more suggestion');

  marks = setRomHack(marks, { crc }, catalog);
  assert.deepEqual(marks, {}, 'undo forgets it');
  assert.equal(scanLibrary({ romHacks: marks }).roms.find((x) => x.crc === crc).suggestedHackId, 'emerald-kaizo');

  // refused: a bad checksum, a hack the catalog doesn't have, an empty or too long name
  for (const body of [{ crc: 'xyz', hackId: 'emerald-kaizo' }, { crc, hackId: 'no-such-hack' }, { crc, name: '   ' }, { crc, name: 'x'.repeat(81) }]) {
    assert.throws(() => setRomHack({}, body, catalog), (e) => e.status === 400 && e.code === 'badRomHack', JSON.stringify(body));
  }
  rmSync(join(LIB, 'kaizo-emerald.gba'));
});

test('the "added" message offers to link it', () => {
  const rom = emeraldHack(0x33);
  writeFileSync(join(LIB, 'Emerald_Kaizo_v2.gba'), rom);
  const after = scanLibrary({});
  const msg = addedMessage(addedToLibrary({ roms: [], patches: [] }, after, [join(LIB, 'Emerald_Kaizo_v2.gba')]), catalog);
  assert.match(msg.text, /Looks like Pokémon Emerald Kaizo – link it\?/);
  assert.deepEqual(msg.suggest, { crc: crcOf(rom), hackId: 'emerald-kaizo', hack: 'Pokémon Emerald Kaizo' });
  rmSync(join(LIB, 'Emerald_Kaizo_v2.gba'));
});

test('server: POST /api/library/romhack stores the mark, the library shows the ROM as that hack', async () => {
  const rom = emeraldHack(0x44);
  writeFileSync(join(LIB, 'kaizo.gba'), rom);
  const { server, url } = await startServer({ port: 0, background: false });
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const res = await post('/api/library/romhack', { crc: crcOf(rom), hackId: 'emerald-kaizo' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).romHacks[crcOf(rom)], { hackId: 'emerald-kaizo' });
    const lib = await (await fetch(`${url}/api/library`)).json();
    assert.equal(lib.roms.find((r) => r.crc === crcOf(rom)).hackId, 'emerald-kaizo');
    assert.equal((await post('/api/library/romhack', { crc: crcOf(rom), hackId: '../x' })).status, 400);
    assert.equal((await post('/api/library/romhack', { crc: crcOf(rom) })).status, 200); // undo
    const again = await (await fetch(`${url}/api/library`)).json();
    assert.equal(again.roms.find((r) => r.crc === crcOf(rom)).hackId, null);
  } finally {
    server.close();
    rmSync(join(LIB, 'kaizo.gba'));
  }
});

test('a run of an already-patched hack: the hack in the manifest, joiners need the exact ROM', async () => {
  const rom = emeraldHack(0x66);
  const file = join(LIB, 'Unknown Hack.gba');
  writeFileSync(file, rom);
  const m = await buildRun({ romId: file, randomize: false, config: {}, mode: 'soullink', gameId: 'pokemon-emerald', hackName: 'My \u0001Hack',
    players: { p1: { name: 'A' }, p2: { name: 'B' } } });
  assert.equal(m.game.hackName, 'My Hack');
  assert.equal(m.base.crc, crcOf(rom));
  const k = await buildRun({ romId: file, randomize: false, config: {}, mode: 'nuzlocke', gameId: 'pokemon-emerald', hackId: 'emerald-kaizo', hackName: 'ignored',
    players: { p1: { name: 'A' } } });
  assert.deepEqual([k.game.hackId, k.game.hackName], ['emerald-kaizo', undefined]);
  // joining: a plain run takes any release of the game; a hack run only the very same ROM
  assert.equal(needsIdenticalRom(m), true);
  assert.equal(needsIdenticalRom({ game: { hackId: 'emerald-kaizo' } }), true);
  assert.equal(needsIdenticalRom({ game: { id: 'pokemon-emerald' } }), false);
  const vanilla = { id: 'v', crc: '1F1C08FB', gameId: 'pokemon-emerald' };
  const mine = { id: 'h', crc: crcOf(rom), gameId: 'pokemon-emerald' };
  const rootOf = (id) => id;
  assert.deepEqual(baseRomsFor({ base: { crc: crcOf(rom) }, game: { id: 'pokemon-emerald', hackId: 'emerald-kaizo' } }, [vanilla], rootOf), []);
  assert.deepEqual(baseRomsFor({ base: { crc: crcOf(rom) }, game: { id: 'pokemon-emerald', hackId: 'emerald-kaizo' } }, [vanilla, mine], rootOf), [mine]);
  assert.deepEqual(baseRomsFor({ base: { crc: '1F1C08FB' }, game: { id: 'pokemon-emerald' } }, [mine], rootOf), [mine], 'a plain run: any release');
  rmSync(file);
});

test('every new message has a German translation (and the other languages)', () => {
  const keys = ['lib.hackSuggest', 'lib.hackLink', 'lib.hackNotIt', 'lib.isHack', 'lib.isHackHint', 'lib.hackPick', 'lib.hackOther', 'lib.hackOtherName', 'lib.hackSave',
    'lib.hackLinked', 'lib.hackLinkedText', 'lib.hackLinkedOther', 'lib.hackLinkFailed', 'lib.hackMarked', 'lib.hackMarkedOther', 'lib.hackUndo', 'lib.otherCopies', 'err.badRomHack'];
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of keys) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.doesNotMatch(d[k], /faint/i, `${lang}: ${k}`);
      assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), `${lang}: ${k}`);
    }
  }
});
