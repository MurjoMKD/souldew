// The randomizer stopping on a game (Discord: "Randomizer-Fehler: java.lang.ArrayIndexOutOfBoundsException: Index
// 1286 out of bounds for length 1268 – every time I try to make a nuzlocke"): the wizard learns before a build that UPR
// ZX can't randomize a game (a trial run with the recommended preset, nothing written), a build that fails anyway
// says so in words the page translates – never Java's own text or the randomizer's output (#43).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-randoerr-'));
process.env.SLS_DATA_DIR = DATA;
const { randomizerError, inspectRom, javaOptsFor, JAVA_OPTS } = await import('../server/lib/toolchain.mjs');
const { ctrRandoError } = await import('../server/lib/ctrrando.mjs');
const { buildRun } = await import('../server/lib/build.mjs');
const { errorBody } = await import('../server/app.mjs');
const { PRESETS, buildValues, toProperties } = await import('../shared/randomizer-options.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const AIOOBE = 'java.lang.ArrayIndexOutOfBoundsException: Index 1286 out of bounds for length 1268';
/** What runBridge rejects with when UPR throws (server/lib/toolchain.mjs): the @@ERROR text and the stack trace. */
const bridgeFailure = (error = AIOOBE, more = {}) => Object.assign(new Error(`Randomizer-Fehler: ${error}`), {
  details: { error, exitCode: 1, stdout: `@@ERROR "${error}"`, stderr: `${error}\n\tat com.dabomstew.pkrandom.romhandlers.Gen5RomHandler.setStarters(Gen5RomHandler.java:1)\n/Users/someone/Games/White.nds` },
  ...more,
});

test('a randomizer crash becomes a translated answer naming only the exception\'s class', () => {
  const e = randomizerError(bridgeFailure());
  assert.equal(e.status, 422);
  assert.equal(e.code, 'randoFailed');
  assert.deepEqual(e.vars, { what: 'ArrayIndexOutOfBoundsException' });
  assert.ok(e.details, 'the output stays on the error for the server log');
  const body = JSON.stringify(errorBody(e));
  for (const raw of ['1286', '1268', 'java.lang', 'Gen5RomHandler', '/Users/someone']) assert.ok(!body.includes(raw), raw);
  // a wrapped one (UPR's RandomizerIOException) and one without an @@ERROR line
  assert.equal(randomizerError(bridgeFailure('com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.FileNotFoundException: /x/a002')).vars.what, 'RandomizerIOException');
  const bare = randomizerError(Object.assign(new Error('Randomizer-Fehler: Exit-Code 137'), { details: { error: null, exitCode: 137, stdout: '', stderr: '' } }));
  assert.deepEqual([bare.code, bare.vars.what], ['randoFailed', 'exit 137']);
  assert.equal(randomizerError(bridgeFailure('x', { code: 'timeout' })).code, 'randoTimeout');
  // answers already: Java or the randomizer missing (no bridge output), an HTTP error
  const noJava = new Error('Java 8+ wurde nicht gefunden.');
  assert.equal(randomizerError(noJava), noJava);
  const known = Object.assign(new Error('x'), { status: 400, code: 'badRun' });
  assert.equal(randomizerError(known), known);
  // 3DS: its own codes first, everything else the same way
  assert.equal(ctrRandoError(bridgeFailure()).code, 'randoFailed');
  assert.equal(ctrRandoError(bridgeFailure('x', { code: 'memory' })).code, 'ctrMemory');
});

test('a build the randomizer stops: the readable error, no half-built run left behind', async () => {
  const lib = join(DATA, 'Library');
  mkdirSync(lib, { recursive: true });
  const rom = join(lib, 'White.gba');
  const bytes = Buffer.alloc(0x400);
  bytes[0xb2] = 0x96; // a GBA header
  writeFileSync(rom, bytes);
  const before = existsSync(join(DATA, 'runs')) ? readdirSync(join(DATA, 'runs')) : [];
  const calls = [];
  await assert.rejects(buildRun({ romId: rom, gameId: 'pokemon-emerald', randomize: true, values: buildValues(PRESETS[0].values, 3), seeds: { p1: '1' }, mode: 'nuzlocke',
    players: { p1: { name: 'Ash' } }, config: {} }, () => {}, () => {}, { bridge: async (args) => { calls.push(args); throw bridgeFailure(); } }),
  (e) => e.status === 422 && e.code === 'randoFailed' && !/1286|java\.lang/.test(e.message));
  assert.equal(calls[0][0], 'randomize');
  assert.deepEqual(readdirSync(join(DATA, 'runs')).filter((d) => !d.startsWith('.')), before.filter((d) => !d.startsWith('.')));
});

test('inspect: a trial run with the recommended preset; a game UPR can\'t randomize is known before the build', async () => {
  const calls = [];
  const fake = (json, fail = null) => async (args) => {
    calls.push({ args, props: readFileSync(args[2], 'utf8') });
    if (fail) throw fail;
    return { json };
  };
  const ok = await inspectRom('/g.nds', { gen: 5, run: fake({ generation: 5, pokemonCount: 649, trial: null }) });
  assert.equal(ok.unsupported, undefined);
  assert.equal(ok.pokemonCount, 649);
  assert.deepEqual(calls[0].args.slice(0, 2), ['info', '/g.nds']);
  assert.equal(calls[0].args[3], '1', 'a fixed seed: the same answer every time');
  assert.equal(calls[0].props, toProperties(buildValues(PRESETS[0].values, 5)), 'the wizard\'s default preset, for this generation');
  assert.ok(!existsSync(calls[0].args[2]), 'the settings file is removed');
  const crash = await inspectRom('/g.nds', { gen: 5, run: fake({ generation: 5, pokemonCount: 649, trial: 'ArrayIndexOutOfBoundsException' }) });
  assert.deepEqual([crash.unsupported, crash.reason, crash.what, crash.generation], [true, 'randoCrash', 'ArrayIndexOutOfBoundsException', 5]);
  // UPR can't load it at all: unsupported – without the bridge's text in the answer
  const warn = console.warn;
  console.warn = () => {};
  try {
    const bad = await inspectRom('/g.nds', { run: fake(null, bridgeFailure()) });
    assert.equal(bad.unsupported, true);
    assert.ok(!JSON.stringify(bad).includes('1286'));
  } finally {
    console.warn = warn;
  }
});

test('every bridge run gets its own working folder (two runs on one game don\'t share UPR\'s unpacked files)', () => {
  assert.deepEqual(javaOptsFor({ workDir: '/tmp/w' }), [...JAVA_OPTS, '-Dsouldew.upr.root=/tmp/w']);
  const src = readFileSync(new URL('../server/lib/toolchain.mjs', import.meta.url), 'utf8');
  assert.match(src, /const workDir = join\(CACHE_DIR, ctr \? 'upr-3ds' : 'upr-work', randomBytes\(6\)\.toString\('hex'\)\);/);
  assert.match(src, /cwd: workDir,/);
});

test('the wizard says why the randomizer is off; the new messages are translated', () => {
  const wizard = readFileSync(new URL('../web/views/soullink.mjs', import.meta.url), 'utf8');
  assert.match(wizard, /inspect\.info\?\.reason === 'randoCrash' \? \(solo \? t\('new\.randoCrashSolo'/);
  const app = readFileSync(new URL('../server/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /info = await inspectRom\(patched\.path, \{ gen: /);
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of ['err.randoFailed', 'err.randoTimeout', 'new.randoCrash', 'new.randoCrashSolo']) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.doesNotMatch(d[k], /faint/i, `${lang}: ${k}`);
      assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), `${lang}: ${k}`);
    }
  }
});
