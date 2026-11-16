// Another shiny rate for a run (shared/shiny.mjs, server/lib/shiny.mjs): finding the games' shiny compares by their
// code, the byte edits per generation, Gen 3's SHINY_ODDS picture arguments, the DS ARM9 compressed again into its
// old space (shared/nds.mjs blzCompressTo), the setting through build → invite → the partner's build, and the live
// reader counting shinies with the run's threshold. Synthetic THUMB code only – real ROMs when present:
//   SOULDEW_TEST_ROMS=/folder/with/roms node --test test/shiny.test.mjs
// (retail Gen 3–5 dumps: each one is found, patched on a copy in a temp folder and checked; never commit ROMs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { SHINY_RATES, cleanShiny, shinyThreshold, shinyChanged, shinyFamily, findShinyCompares, findShinyLiterals, locateShiny, shinyEdits, trainerShiniesOk } from '../shared/shiny.mjs';
import { blzCompressTo, blzDecompress, ndsArm9 } from '../shared/nds.mjs';
import { LiveTables, parsePk3 } from '../shared/live/parse.mjs';
import { identifyRom } from '../shared/romid.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-shiny-'));
process.env.SLS_DATA_DIR = DATA;
const { shinySupport, applyShiny } = await import('../server/lib/shiny.mjs');
const { buildRun, readManifest, checkPack, runPack } = await import('../server/lib/build.mjs');
const { restartRequest } = await import('../shared/restart.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// ---- a small THUMB assembler: halfwords with labels, branches resolved at the end ----------------------------------
function asm() {
  const out = [];
  const labels = {};
  const fix = [];
  const a = {
    at: () => out.length * 2,
    label(name) {
      labels[name] = out.length * 2;
      return a;
    },
    h(...hs) {
      out.push(...hs);
      return a;
    },
    bcond(cond, name) {
      fix.push({ i: out.length, kind: 'bcond', cond, name });
      return a.h(0);
    },
    b(name) {
      fix.push({ i: out.length, kind: 'b', name });
      return a.h(0);
    },
    bl(name) {
      fix.push({ i: out.length, kind: 'bl', name });
      return a.h(0, 0);
    },
    pad(bytes) {
      while (out.length * 2 < bytes) out.push(0x46c0);
      return a;
    },
    bytes() {
      for (const f of fix) {
        const d = labels[f.name] - (f.i * 2 + 4);
        if (f.kind === 'bcond') out[f.i] = 0xd000 | (f.cond << 8) | ((d >> 1) & 0xff);
        else if (f.kind === 'b') out[f.i] = 0xe000 | ((d >> 1) & 0x7ff);
        else {
          out[f.i] = 0xf000 | ((d >> 12) & 0x7ff);
          out[f.i + 1] = 0xf800 | ((d >> 1) & 0x7ff);
        }
      }
      const b = new Uint8Array(out.length * 2);
      out.forEach((h, i) => {
        b[i * 2] = h & 0xff;
        b[i * 2 + 1] = h >> 8;
      });
      return b;
    },
  };
  return a;
}
const BLS = 9;
const BHI = 8;
const BLO = 3;
const BHS = 2;
// XOR of the four halves of r0 (OT ID) and r1 (personality) into rN, as the games compile it
const xorInto = (a, n) => a.h(0x0c00 | (16 << 6) | n, 0x4018, 0x4040 | n, 0x0c08, 0x4040 | n, 0x4019, 0x4040 | (1 << 3) | n);
// Gen 3: `cmp rN, #7` + bhi (IsShinyOtIdPersonality) or bls (the palettes); Gen 4/5: `cmp r0, #8` + bhs
function check(a, name, { gen = 3, cond = BHI, n = 2 } = {}) {
  a.label(name).h(0xb510, 0x2400);
  xorInto(a, n).h(0x2800 | (n << 8) | (gen === 3 ? 7 : 8)).bcond(gen === 3 ? cond : BHS, `${name}.no`);
  return a.h(0x2401).label(`${name}.no`).h(0x1c20, 0xbc10, 0xbc02, 0x4708);
}
// the not-shiny loop of NPC Pokémon: draw an OT ID, again while shiny, then on
function loop(a, name, { gen = 3, n = 1 } = {}) {
  a.label(name).h(0xb5f0).label(`${name}.top`).h(0x2000, 0x2100);
  xorInto(a, n).h(0x2800 | (n << 8) | (gen === 3 ? 7 : 8)).bcond(gen === 3 ? BLS : BLO, `${name}.top`).b(`${name}.out`);
  return a.h(0x46c0).label(`${name}.out`).h(0xbdf0);
}
/** A Gen 3 game: the loop, four checks (one a palette function) and a picture function that reaches the palette. */
function gen3Code({ literals = 1 } = {}) {
  const a = asm();
  a.pad(0x40);
  loop(a, 'loop');
  check(a, 'isShiny');
  check(a, 'pal1', { cond: BLS, n: 0 });
  check(a, 'pal2', { cond: BLS, n: 0 });
  check(a, 'sparkle', { n: 0 });
  // CreateMonPicSprite → LoadPicPalette → the palette function
  a.label('loadPal').h(0xb500).bl('pal1').h(0xbd00);
  a.label('pic').h(0xb500).bl('loadPal').h(0xbd00);
  a.label('other').h(0xb500, 0x2000).h(0xbd00); // reaches no shiny check
  for (let i = 0; i < literals; i++) a.h(0xb500, 0x2108, 0x2200, 0x2301).bl('pic').h(0xbd00); // (species, SHINY_ODDS, 0, TRUE)
  a.h(0xb500, 0x2108, 0x2301).bl('other').h(0xbd00); // r1 = 8 for something else
  a.h(0xb500, 0x2108, 0x6809, 0x2301).bl('pic').h(0xbd00); // r1 = 8, then loaded from memory: not the argument
  return { code: a.pad(0x400).bytes(), a };
}
const FAMILY3 = (literals = 1) => ({ gen: 3, checks: 4, loops: 1, literals: [literals, literals] });

test('cleanShiny: known presets only, null for the games’ own odds; thresholds per preset', () => {
  assert.deepEqual(cleanShiny({ rate: 512, trainers: true }), { rate: 512, trainers: true });
  assert.deepEqual(cleanShiny({ rate: '1024' }), { rate: 1024, trainers: false });
  assert.deepEqual(cleanShiny({ rate: 8192, trainers: true }), { rate: 8192, trainers: true });
  assert.equal(cleanShiny({ rate: 8192 }), null);
  assert.equal(cleanShiny({ rate: 100 }), null, 'not a preset: the games’ own odds');
  assert.equal(cleanShiny({ rate: 512, trainers: 'yes' }).trainers, false);
  for (const bad of [null, undefined, 3, 'x', [], { trainers: 1 }]) assert.equal(cleanShiny(bad), null);
  assert.deepEqual(SHINY_RATES.map((r) => shinyThreshold({ rate: r })), [8, 16, 64, 128, 255]);
  assert.equal(shinyThreshold(null), 8);
  assert.equal(shinyChanged({ rate: 8192 }), false);
  assert.equal(shinyChanged({ rate: 4096 }), true);
});

test('shinyFamily: Gen 3–5 GBA/DS games by their code, nothing else', () => {
  assert.equal(shinyFamily('gba', 'BPEE').literals[0], 3);
  assert.equal(shinyFamily('gba', 'AXVD').gen, 3);
  assert.equal(shinyFamily('gba', 'BPGD').literals[1], 7);
  assert.equal(shinyFamily('nds', 'IPKE').loops, 1);
  assert.equal(shinyFamily('nds', 'IREO').gen, 5);
  assert.equal(shinyFamily('nds', 'IRBO').loops, 0);
  for (const [sys, code] of [['gbc', 'BYTE'], ['gb', ''], ['gba', 'AGBJ'], ['nds', 'NTRJ'], ['3ds', 'ECRA']]) assert.equal(shinyFamily(sys, code), null);
});

test('findShinyCompares: the compares after the XOR of the halves, the loop told apart', () => {
  const { code } = gen3Code();
  const found = findShinyCompares(code, 7);
  assert.deepEqual(found.map((x) => x.kind), ['loop', 'check', 'check', 'check', 'check']);
  assert.equal(findShinyCompares(code, 8).length, 0, 'Gen 4/5 compares #8');
  // the same compare without the XOR before it is something else
  const plain = asm().pad(0x40).h(0x2000, 0x2100, 0x2207, 0x4042).h(0x2a07).bcond(BHI, 'x').label('x').h(0x4770).pad(0x80).bytes();
  assert.equal(findShinyCompares(plain, 7).length, 0);
});

test('findShinyLiterals: SHINY_ODDS passed into a picture function – not other calls, not when r1 changes', () => {
  const { code } = gen3Code({ literals: 2 });
  const checks = findShinyCompares(code, 7).filter((x) => x.kind === 'check').map((x) => x.at);
  const lits = findShinyLiterals(code, checks);
  assert.equal(lits.length, 2);
  for (const at of lits) assert.deepEqual([code[at], code[at + 1]], [0x08, 0x21]);
});

test('locateShiny + shinyEdits, Gen 3: thresholds - 1 at every check, the loop opened or tightened, pictures moved', () => {
  const { code } = gen3Code();
  const loc = locateShiny(code, FAMILY3());
  assert.equal(loc.gen, 3);
  assert.equal(loc.checks.length, 4);
  assert.equal(loc.literals.length, 1);
  assert.equal(trainerShiniesOk(loc), true);
  assert.deepEqual(locateShiny(code, FAMILY3(2)), { error: 'code' }, 'one picture argument fewer than the game has');
  assert.deepEqual(locateShiny(code, { ...FAMILY3(), checks: 5 }), { error: 'code' });
  assert.deepEqual(locateShiny(code, null), { error: 'game' });

  const apply = (shiny) => {
    const c = code.slice();
    for (const e of shinyEdits(loc, shiny)) c.set(e.bytes, e.at);
    return c;
  };
  const p = apply({ rate: 512 });
  for (const at of loc.checks) assert.equal(p[at], 127);
  assert.equal(p[loc.loop], 127, 'trainers stay never shiny at the new rate');
  assert.equal(p[loc.literals[0]], 0xff, 'the pictures’ OT ID stays above the threshold');
  const t = apply({ rate: 256, trainers: true });
  for (const at of loc.checks) assert.equal(t[at], 254);
  assert.deepEqual([t[loc.loop], t[loc.loop + 2], t[loc.loop + 3]], [7, 0xc0, 0x46], 'the branch back is a nop');
  const only = shinyEdits(loc, { rate: 8192, trainers: true });
  assert.deepEqual(only, [{ at: loc.loop + 2, bytes: [0xc0, 0x46] }], 'trainer shinies at the normal rate: just the loop');
  assert.deepEqual(shinyEdits(loc, null), []);
  // nothing else changes
  const diff = [...p].filter((b, i) => b !== code[i]).length;
  assert.equal(diff, 6);
});

test('shinyEdits, Gen 4/5: the threshold itself; Gen 5 has no loop to open', () => {
  const a = asm().pad(0x40);
  loop(a, 'loop', { gen: 4, n: 0 });
  check(a, 'calc', { gen: 4, n: 0 });
  const code4 = a.pad(0x200).bytes();
  const loc4 = locateShiny(code4, { gen: 4, checks: 1, loops: 1, literals: [0, 0] });
  assert.equal(loc4.literals.length, 0);
  const e4 = shinyEdits(loc4, { rate: 1024 });
  assert.deepEqual(e4.map((e) => e.bytes[0]), [64, 64]);
  const b = asm().pad(0x40);
  check(b, 'calc', { gen: 5, n: 0 });
  const code5 = b.pad(0x200).bytes();
  const loc5 = locateShiny(code5, { gen: 5, checks: 1, loops: 0, literals: [0, 0] });
  assert.equal(trainerShiniesOk(loc5), false);
  assert.deepEqual(shinyEdits(loc5, { rate: 256 }).map((e) => e.bytes[0]), [255]);
  assert.throws(() => shinyEdits(loc5, { rate: 256, trainers: true }), /trainer/);
});

test('blzCompressTo: exactly the given size, the start kept, decompresses back – in place', () => {
  // compressible "code": repeating runs with some noise
  const raw = new Uint8Array(0x9000);
  let x = 1;
  for (let i = 0; i < raw.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    raw[i] = i % 64 < 40 ? (i >> 3) & 0xff : (x >>> 24) & 0x0f;
  }
  for (const size of [0x6000, 0x7000, 0x8ff0]) {
    const out = blzCompressTo(raw, size, 0x1000);
    assert.ok(out, `fits into ${size.toString(16)}`);
    assert.equal(out.length, size);
    assert.deepEqual(out.subarray(0, 0x1000), raw.subarray(0, 0x1000), 'the start stays as it is');
    assert.deepEqual(blzDecompress(out), raw);
  }
  assert.equal(blzCompressTo(raw, 0x800, 0x400), null, 'too small');
});

// ---- files: a GBA game and a DS game with a compressed ARM9 --------------------------------------------------------
function gbaRom(code, gameCode = 'AXVE') {
  const rom = new Uint8Array(0x8000);
  rom.set(code.subarray(0, 0x7000), 0x1000);
  rom[0xb2] = 0x96;
  rom.set([...gameCode].map((c) => c.charCodeAt(0)), 0xac);
  return rom;
}
const put32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};
/** A Gen 5 DS game: header + an ARM9 (module params in its uncompressed start) compressed to `packed` bytes. */
function ndsRom(code) {
  const RAM = 0x02004000;
  const raw = new Uint8Array(0x6000);
  for (let i = 0; i < 0x4000; i++) raw[i] = (i * 7) & 0xff; // the start (secure area, crt0)
  const params = 0x800;
  put32(raw, params + 0x1c, 0xdec00621);
  raw.set(code.subarray(0, 0x2000), 0x4000);
  const packed = 0x5800;
  put32(raw, params + 0x14, RAM + packed); // compressed_static_end
  const image = blzCompressTo(raw, packed, 0x4000);
  assert.ok(image);
  const rom = new Uint8Array(0x4000 + packed);
  rom.set([...'POKEMON B2'].map((c) => c.charCodeAt(0)), 0);
  rom.set([...'IREO'].map((c) => c.charCodeAt(0)), 0x0c);
  put32(rom, 0x20, 0x4000);
  put32(rom, 0x28, RAM);
  put32(rom, 0x2c, packed);
  rom[0x15c] = 0x56;
  rom[0x15d] = 0xcf;
  rom.set(image, 0x4000);
  return rom;
}

test('applyShiny on a GBA file: the edits land in the file, a game without the code is refused', () => {
  const dir = mkdtempSync(join(DATA, 'gba-'));
  const { code } = gen3Code({ literals: 0 });
  const path = join(dir, 'Ruby.gba');
  writeFileSync(path, gbaRom(code));
  assert.deepEqual(shinySupport(path), { ok: true, gen: 3, trainers: true });
  assert.deepEqual(shinySupport(path, { original: false }), { ok: false, reason: 'hack', gen: 3 });
  assert.deepEqual(applyShiny(path, { rate: 1024, trainers: true }), { changed: 5 });
  const after = new Uint8Array(readFileSync(path));
  assert.deepEqual(locateShiny(after, shinyFamily('gba', 'AXVE')), { error: 'code' }, 'patched: the compares changed');
  assert.deepEqual(applyShiny(path, null), { changed: 0 });

  const gb = join(dir, 'Red.gb');
  writeFileSync(gb, new Uint8Array(0x8000));
  assert.deepEqual(shinySupport(gb), { ok: false, reason: 'game' });
  assert.throws(() => applyShiny(gb, { rate: 512 }), (e) => e.code === 'shinyUnsupported');
  const odd = join(dir, 'Emerald.gba');
  writeFileSync(odd, gbaRom(code, 'BPEE')); // Emerald has three picture arguments – this one none
  assert.equal(shinySupport(odd).reason, 'code');
});

test('applyShiny on a DS game: the compressed ARM9 is compressed again into its own space', () => {
  const dir = mkdtempSync(join(DATA, 'nds-'));
  const a = asm().pad(0x40);
  check(a, 'calc', { gen: 5, n: 0 });
  const rom = ndsRom(a.pad(0x2000).bytes());
  const path = join(dir, 'Black 2.nds');
  writeFileSync(path, rom);
  assert.deepEqual(shinySupport(path), { ok: true, gen: 5, trainers: false });
  assert.throws(() => applyShiny(path, { rate: 512, trainers: true }), (e) => e.code === 'shinyUnsupported');
  assert.deepEqual(applyShiny(path, { rate: 512 }), { changed: 1 });
  const after = new Uint8Array(readFileSync(path));
  assert.equal(after.length, rom.length, 'nothing moved');
  assert.deepEqual(after.subarray(0, 0x4000 + 0x4000), rom.subarray(0, 0x4000 + 0x4000), 'header and the ARM9’s start as they were');
  const a9 = ndsArm9(after);
  assert.equal(a9.packed, 0x5800);
  const before = ndsArm9(rom).bytes;
  const changed = [...a9.bytes].map((b, i) => (b !== before[i] ? i : -1)).filter((i) => i >= 0);
  assert.equal(changed.length, 1);
  assert.equal(a9.bytes[changed[0]], 128);
});

// ---- the setting through a run --------------------------------------------------------------------------------------
test('build → invite → partner: every player’s game patched alike, a game that can’t take it is refused', async () => {
  const LIB = join(DATA, 'Library');
  mkdirSync(LIB, { recursive: true });
  const ROM = join(LIB, 'Sapphire.gba');
  writeFileSync(ROM, gbaRom(gen3Code({ literals: 0 }).code, 'AXPE'));
  const log = [];
  const m = await buildRun({ romId: ROM, randomize: false, config: {}, shiny: { rate: 512, trainers: true }, players: { p1: { name: 'Lou' }, p2: { name: 'Kim' } } }, (l) => log.push(l));
  assert.deepEqual(m.shiny, { rate: 512, trainers: true });
  assert.ok(log.some((l) => /Shiny/.test(l)));
  const out = new Uint8Array(readFileSync(join(DATA, 'runs', m.id, m.outputs.p1.rom)));
  assert.notDeepEqual(out, new Uint8Array(readFileSync(ROM)));
  assert.equal(m.outputs.p1.sha1, m.outputs.p2.sha1);

  const pack = runPack(m);
  assert.deepEqual(pack.shiny, { rate: 512, trainers: true });
  assert.deepEqual(checkPack(pack).shiny, { rate: 512, trainers: true });
  assert.equal(checkPack({ ...pack, shiny: { rate: 3 } }).shiny, null, 'a pack with an unknown rate: the games’ own odds');
  // the partner's build (an imported run has the setting; the request doesn't repeat it)
  const again = await buildRun({ identity: { id: m.id, room: m.room, secret: m.secret }, romId: ROM, randomize: false, config: {}, players: pack.players, buildFor: ['p2'], expectedOutputs: pack.outputs });
  assert.equal(again.outputs.p2.matchesFriend, true);
  assert.deepEqual(readManifest(m.id).shiny, { rate: 512, trainers: true });
  // a new attempt keeps it
  assert.deepEqual(restartRequest(m, { library: { roms: [{ id: ROM, crc: m.base.crc }] }, runs: [] }).shiny, { rate: 512, trainers: true });
  assert.equal(restartRequest({ ...m, shiny: null }, { library: { roms: [{ id: ROM, crc: m.base.crc }] }, runs: [] }).shiny, undefined);

  const plain = await buildRun({ romId: ROM, randomize: false, config: {}, mode: 'nuzlocke', players: { p1: { name: 'Lou' } } });
  assert.equal(plain.shiny, null);
  assert.equal(runPack(plain).shiny, undefined, 'runs without the setting: the pack as before');

  const GB = join(LIB, 'Fake.gb');
  writeFileSync(GB, Buffer.alloc(0x8000, 7));
  await assert.rejects(buildRun({ romId: GB, randomize: false, config: {}, mode: 'nuzlocke', shiny: { rate: 256 }, players: { p1: { name: 'Lou' } } }), (e) => e.code === 'shinyUnsupported');
});

test('the live reader calls a Pokémon shiny with the run’s threshold', () => {
  const T = new LiveTables({ gen3Index: { map: { 1: 1 } } });
  assert.equal(T.withShinyOdds(8), T);
  assert.equal(T.withShinyOdds(undefined), T);
  const T512 = T.withShinyOdds(128);
  assert.equal(T512.shinyOdds, 128);
  // a Gen 3 party mon (unencrypted key 0: PID = OT ID ^ data key) with a shiny value of 100
  const mon = (sv) => {
    const d = new Uint8Array(100);
    const pid = 0x00010000 | sv; // high half 1, low half sv: XOR with OT ID 0x00000001 → sv
    put32(d, 0, pid);
    put32(d, 4, 0x00000001);
    const key = (pid ^ 1) >>> 0;
    const plain = new Uint8Array(48);
    plain[0] = 1; // species index 1 in the Growth block
    let sum = 0;
    const order = pid % 24; // the substructures' order (pokeemerald pokemon.c GetSubstruct)
    const at = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][order].indexOf('G');
    const block = new Uint8Array(48);
    block.set(plain.subarray(0, 12), at * 12);
    for (let i = 0; i < 48; i += 2) sum = (sum + (block[i] | (block[i + 1] << 8))) & 0xffff;
    d[0x1c] = sum & 0xff;
    d[0x1d] = sum >> 8;
    for (let i = 0; i < 48; i += 4) put32(d, 32 + i, ((block[i] | (block[i + 1] << 8) | (block[i + 2] << 16) | (block[i + 3] << 24)) ^ key) >>> 0);
    return d;
  };
  const m100 = mon(100);
  assert.equal(parsePk3(m100, T)?.shiny, false);
  assert.equal(parsePk3(m100, T512)?.shiny, true);
  assert.equal(parsePk3(mon(200), T512)?.shiny, false);
  assert.equal(parsePk3(mon(3), T)?.shiny, true);
});

// ---- real ROMs (optional) ------------------------------------------------------------------------------------------
const ROMS = process.env.SOULDEW_TEST_ROMS;
test('real Gen 3–5 ROMs: found, patched on a copy, the code reads back patched', { skip: !ROMS && 'set SOULDEW_TEST_ROMS' }, () => {
  const dir = mkdtempSync(join(DATA, 'real-'));
  const files = readdirSync(ROMS).filter((f) => ['.gba', '.nds'].includes(extname(f).toLowerCase()));
  let checked = 0;
  for (const f of files) {
    const src = join(ROMS, f);
    const s = shinySupport(src);
    if (!s.ok) continue;
    const copy = join(dir, f);
    copyFileSync(src, copy);
    const res = applyShiny(copy, { rate: 512, trainers: s.trainers });
    assert.ok(res.changed > 0, f);
    const before = new Uint8Array(readFileSync(src));
    const after = new Uint8Array(readFileSync(copy));
    assert.equal(after.length, before.length, f);
    const code = (b) => (extname(f).toLowerCase() === '.gba' ? b : ndsArm9(b).bytes);
    const was = code(before);
    const now = code(after);
    const id = identifyRom(before.subarray(0, 0x200));
    const edits = shinyEdits(locateShiny(was, shinyFamily(id.system, id.code)), { rate: 512, trainers: s.trainers });
    const diff = [...now].map((b, i) => (b !== was[i] ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(diff, edits.flatMap((e) => e.bytes.map((_, k) => e.at + k)), f);
    rmSync(copy);
    checked++;
  }
  assert.ok(checked > 0 || !existsSync(ROMS));
});
