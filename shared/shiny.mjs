// Shiny odds of a run: the original Gen 3–5 games get another shiny rate – and, in Gen 3/4, shiny Pokémon for
// trainers – by patching the game's own shiny check.
//
// Gen 3–5 call a Pokémon shiny when the XOR of the four 16-bit halves of its OT ID and personality value is below
// SHINY_ODDS = 8 (8 / 65536 = 1 in 8192; pret pokeemerald include/constants/pokemon.h, pokeheartgold
// include/constants/pokemon.h, PKHeX PKM.IsShiny). The games compile that compare into a handful of places:
//   Gen 3  pokemon.c CreateBoxMon (the OT_ID_RANDOM_NO_SHINY loop of trainer Pokémon), GetMonSpritePalFromSpeciesAnd-
//          Personality, GetMonSpritePalStructFromOtIdPersonality, IsShinyOtIdPersonality and the battle's sparkle
//          (pokeemerald battle_anim_throw.c, pokefirered/pokeruby battle_anim_special.c): `cmp rN, #7` + bls/bhi
//   Gen 4  pokemon.c CreateBoxMon's OTID_NOT_SHINY loop and CalcShininessByOtIdAndPersonality (pokeplatinum
//          Pokemon_InlineIsPersonalityShiny, pokeheartgold SHINY_CHECK): `cmp r0, #8` + blo/bhs
//   Gen 5  one function every check calls (wild Pokémon, shiny locks, the not-shiny OT of NPC Pokémon, the Shiny Charm):
//          `cmp r0, #8` + bhs
// Each place is found by its code – the XOR of the halves right before the compare – never by a fixed address, and a
// game qualifies only with exactly the places its generation has. Everything not shiny-checked by the game itself
// (Gen 1: no shinies, Gen 2: shininess comes from the DVs, the 3DS games) can't get another rate.
//
// Gen 3 also passes SHINY_ODDS itself as an OT ID that is never shiny – the starter choice, Birch's Lotad, the
// Pokédex and FireRed/LeafGreen's credits draw their pictures with `CreateMonPicSprite…(species, SHINY_ODDS, 0 …)`
// (pokeemerald main_menu.c, starter_choose.c, pokedex.c; pokefirered credits.c, pokedex_screen.c). A higher
// threshold would show those shiny, so these arguments move to 0xFF along with it – a rate needs a threshold of at
// most 255 for that (and for the 8-bit compares): the top preset is 255 / 65536, about 1 in 256.

/** "1 in N" presets – 8192 is the games' own rate. */
export const SHINY_RATES = [8192, 4096, 1024, 512, 256];
export const NORMAL_RATE = 8192;
/** The compare's threshold per preset (shiny ⇔ XOR value < threshold). 256 would need a 9-bit constant: 255. */
const THRESHOLD = { 8192: 8, 4096: 16, 1024: 64, 512: 128, 256: 255 };

/**
 * A run's shiny setting from a request, a manifest or an invite (untrusted): { rate, trainers } with a known rate, or
 * null for the games' own odds without trainer shinies (what a run without the setting is).
 */
export function cleanShiny(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const rate = SHINY_RATES.includes(Number(v.rate)) ? Number(v.rate) : NORMAL_RATE;
  const trainers = v.trainers === true;
  return rate === NORMAL_RATE && !trainers ? null : { rate, trainers };
}

/** The threshold a run's game compares with (8 = unchanged) – what the live tracker needs to call a Pokémon shiny. */
export const shinyThreshold = (shiny) => THRESHOLD[cleanShiny(shiny)?.rate ?? NORMAL_RATE];

/** Does the run change anything about shinies? */
export const shinyChanged = (shiny) => cleanShiny(shiny) !== null;

/**
 * The game family behind a GBA/DS header code, with the shiny checks its generation has: `checks` compares, `loops`
 * not-shiny loops for NPC Pokémon (what the trainer option opens), `literals` the [min, max] SHINY_ODDS arguments
 * (Gen 3 – Ruby/Sapphire draw those pictures with the normal palette, a German FireRed/LeafGreen has a seventh one
 * for its Pokédex). null: not a game this works for.
 */
export function shinyFamily(system, code) {
  const c = String(code || '').slice(0, 3).toUpperCase();
  if (system === 'gba') {
    if (c === 'AXV' || c === 'AXP') return { gen: 3, checks: 4, loops: 1, literals: [0, 0] };
    if (c === 'BPE') return { gen: 3, checks: 4, loops: 1, literals: [3, 4] };
    if (c === 'BPR' || c === 'BPG') return { gen: 3, checks: 4, loops: 1, literals: [6, 7] };
  } else if (system === 'nds') {
    if (['ADA', 'APA', 'CPU', 'IPK', 'IPG'].includes(c)) return { gen: 4, checks: 1, loops: 1, literals: [0, 0] };
    if (['IRB', 'IRA', 'IRE', 'IRD'].includes(c)) return { gen: 5, checks: 1, loops: 0, literals: [0, 0] };
  }
  return null;
}

// ---- THUMB code ------------------------------------------------------------------------------------------------
const NOP = 0x46c0; // mov r8, r8
const hw = (b, o) => b[o] | (b[o + 1] << 8);
const isEorInto = (h, n) => (h & 0xffc7) === (0x4040 | n); // eors Rn, Rm
const isShift16 = (h) => (h & 0xf000) === 0 && ((h >> 6) & 31) === 16; // lsls/lsrs Rd, Rm, #16

/** A THUMB `bl` at `o`: its target (offset into the same buffer), else null. */
function blTarget(b, o) {
  const h1 = hw(b, o);
  const h2 = hw(b, o + 2);
  if ((h1 & 0xf800) !== 0xf000 || (h2 & 0xf800) !== 0xf800) return null;
  let d = ((h1 & 0x7ff) << 12) | ((h2 & 0x7ff) << 1);
  if (d & 0x400000) d -= 0x800000;
  return o + 4 + d;
}

/**
 * Every shiny compare in `code` (THUMB): `cmp rN, #imm` + a conditional branch right after the XOR of the four
 * halves – the last instruction an `eors` into rN, three of the ten before eors into rN and two of them shifts by
 * 16. Gen 3 compares `#7` with bls/bhi, Gen 4/5 `#8` with blo/bhs. A branch taken for a shiny one that jumps back and
 * is followed by a plain `b` is the not-shiny loop. Returns [{ at, kind: 'check' | 'loop', imm }].
 */
export function findShinyCompares(code, imm) {
  const out = [];
  const shinyTaken = imm === 7 ? 0xd9 : 0xd3; // bls / blo
  const notShinyTaken = imm === 7 ? 0xd8 : 0xd2; // bhi / bhs
  for (let s = 20; s + 6 <= code.length; s += 2) {
    const h = hw(code, s);
    if ((h & 0xf8ff) !== (0x2800 | imm)) continue;
    const br = hw(code, s + 2);
    if (br >> 8 !== shinyTaken && br >> 8 !== notShinyTaken) continue;
    const n = (h >> 8) & 7;
    if (!isEorInto(hw(code, s - 2), n)) continue;
    let eors = 0;
    let shifts = 0;
    for (let k = 1; k <= 10; k++) {
      const p = hw(code, s - 2 * k);
      if (isEorInto(p, n)) eors++;
      if (isShift16(p)) shifts++;
    }
    if (eors < 3 || shifts < 2) continue;
    const back = (br & 0x80) !== 0;
    const loop = br >> 8 === shinyTaken && back && (hw(code, s + 4) & 0xf800) === 0xe000;
    out.push({ at: s, kind: loop ? 'loop' : 'check', imm });
  }
  return out;
}

/**
 * One function's extent and calls, by a linear sweep from `entry`: it ends at a return (`pop {…, pc}`, `bx rM`, an
 * unconditional `b` back) that no branch inside it jumps past – at most `limit` bytes.
 */
function sweep(code, entry, limit = 0x400) {
  const calls = [];
  let far = entry;
  let o = entry;
  for (const end = Math.min(code.length - 4, entry + limit); o < end; o += 2) {
    const h = hw(code, o);
    const t = blTarget(code, o);
    if (t !== null) {
      calls.push(t);
      o += 2;
    } else if ((h & 0xf000) === 0xd000 && (h & 0x0f00) < 0x0e00) {
      far = Math.max(far, o + 4 + 2 * ((h << 24) >> 24));
    } else if ((h & 0xf800) === 0xe000) {
      const t2 = o + 4 + 2 * ((h << 21) >> 21);
      if (t2 > o) far = Math.max(far, t2);
      else if (o >= far) break;
    } else if (((h & 0xff00) === 0xbd00 || (h & 0xff87) === 0x4700) && o >= far) break;
  }
  return { start: entry, end: o + 2, calls };
}

/** Between the OT ID and the call only the next arguments are set up: `movs r2/r3, #imm` or `adds r2/r3, rM, #0`. */
const argSetup = (h) => (h & 0xfe00) === 0x2200 || ((h & 0xffc0) === 0x1c00 && ((h & 7) === 2 || (h & 7) === 3));

/**
 * Gen 3's SHINY_ODDS arguments: `movs r1, #8` (the OT ID), then only argSetup() with `movs r3, #1`, then a `bl`
 * into a picture function – one whose calls reach a shiny check within five levels (CreateMonPicSprite_HandleDeoxys →
 * CreateMonPicSprite → CreatePicSprite → LoadPicPaletteByTagOrSlot → GetMonSpritePalFromSpeciesAndPersonality).
 */
export function findShinyLiterals(code, checks) {
  const bodies = new Map();
  const body = (t) => {
    if (!bodies.has(t)) bodies.set(t, sweep(code, t));
    return bodies.get(t);
  };
  const reaches = new Map();
  const reachable = (target) => {
    if (reaches.has(target)) return reaches.get(target);
    let level = [target];
    const seen = new Set(level);
    let hit = false;
    for (let depth = 0; depth <= 5 && level.length && !hit; depth++) {
      const next = [];
      for (const t of level) {
        if (t < 0 || t >= code.length - 4) continue;
        const f = body(t);
        if (checks.some((c) => c >= f.start && c < f.end)) {
          hit = true;
          break;
        }
        for (const c of f.calls) {
          if (seen.has(c)) continue;
          seen.add(c);
          next.push(c);
        }
      }
      level = next;
    }
    reaches.set(target, hit);
    return hit;
  };
  const out = [];
  for (let o = 0; o + 12 <= code.length; o += 2) {
    if (hw(code, o) !== 0x2108) continue; // movs r1, #8
    let r3 = false;
    for (let k = o + 2; k < o + 10; k += 2) {
      const t = blTarget(code, k);
      if (t !== null) {
        if (r3 && reachable(t)) out.push(o);
        break;
      }
      const h = hw(code, k);
      if (h === 0x2301) r3 = true; // movs r3, #1
      else if (!argSetup(h)) break;
    }
  }
  return out;
}

/**
 * The shiny code of a game: `code` is the GBA ROM or the DS game's ARM9 binary (decompressed), `family` its
 * shinyFamily(). → { gen, checks: [at], loop: at | null, literals: [at] } or { error: 'code' } when the places aren't
 * exactly the ones that generation has.
 */
export function locateShiny(code, family) {
  if (!family) return { error: 'game' };
  const imm = family.gen === 3 ? 7 : 8;
  const found = findShinyCompares(code, imm);
  const checks = found.filter((x) => x.kind === 'check').map((x) => x.at);
  const loops = found.filter((x) => x.kind === 'loop').map((x) => x.at);
  if (checks.length !== family.checks || loops.length !== family.loops) return { error: 'code' };
  const literals = family.gen === 3 ? findShinyLiterals(code, checks) : [];
  if (literals.length < family.literals[0] || literals.length > family.literals[1]) return { error: 'code' };
  return { gen: family.gen, checks, loop: loops[0] ?? null, literals };
}

/** Can the trainer option be patched into this game? (the not-shiny loop of Gen 3/4 – Gen 5 has none to open) */
export const trainerShiniesOk = (located) => !located?.error && located.loop !== null;

/**
 * The byte edits (offsets into `code`) that give a located game the shiny setting: each compare's constant becomes
 * the new threshold, the not-shiny loop runs once with `trainers` (its branch back a nop – NPC Pokémon then keep their
 * first random OT ID and are shiny at the same rate) and Gen 3's SHINY_ODDS arguments move above the threshold.
 */
export function shinyEdits(located, shiny) {
  const s = cleanShiny(shiny);
  if (!s || located?.error) return [];
  if (s.trainers && !trainerShiniesOk(located)) throw new Error('trainer shinies are not available for this game');
  const t = THRESHOLD[s.rate];
  const was = located.gen === 3 ? 7 : 8;
  const value = located.gen === 3 ? t - 1 : t; // Gen 3: `cmp #7` + bls (≤ 7), Gen 4/5: `cmp #8` + blo (< 8)
  const edits = [];
  if (value !== was) for (const at of located.checks) edits.push({ at, bytes: [value] });
  if (located.loop !== null) {
    if (s.trainers) edits.push({ at: located.loop + 2, bytes: [NOP & 0xff, NOP >> 8] });
    else if (value !== was) edits.push({ at: located.loop, bytes: [value] });
  }
  if (t > 8) for (const at of located.literals) edits.push({ at, bytes: [0xff] });
  return edits.sort((a, b) => a.at - b.at);
}
