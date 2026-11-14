// What a patch file's name says: a readable title, the version and the "family" (the same hack in another version).
// Used by the library scan (server/lib/library.mjs) and the library view (patches of hacks the catalog doesn't know).

const EXT = /\.(xdelta3?|vcdiff|bps|ups|ips)$/i;
// a version: "v2", "V1.3.1", "ver 1.2", "1.07" (plain numbers only with a dot – "Black 2" is a name, not a version),
// standing on its own (start / end or between separators)
const VERSION = /(^|[\s._(-])(v(?:er(?:sion)?)?[.\s_]?(\d+(?:[._]\d+)*)|(\d+(?:\.\d+)+))(?=$|[\s._)-])/gi;

/**
 * "Pokémon_Light_Platinum (U) 1.0.ips" → { title: 'Pokémon Light Platinum (U)', version: '1.0' },
 * "v1.4.1_BlazeBlack2Redux.xdelta" → { title: 'BlazeBlack2Redux', version: '1.4.1' }, "Hack.bps" → { title: 'Hack', version: null }.
 */
export function patchTitle(name) {
  const stem = String(name || '').replace(EXT, '');
  let version = null;
  let cut = null;
  for (const m of stem.matchAll(VERSION)) {
    version = (m[3] || m[4]).replace(/_/g, '.');
    cut = { at: m.index + m[1].length, len: m[2].length };
  }
  const glued = !cut && stem.match(/[a-z](V(\d+(?:\.\d+)*))$/); // "RenegadePlatinumV130"
  if (glued) {
    version = glued[2];
    cut = { at: stem.length - glued[1].length, len: glued[1].length };
  }
  let title = cut ? stem.slice(0, cut.at) + stem.slice(cut.at + cut.len) : stem;
  title = title.replace(/_+/g, ' ');
  if (!/\s/.test(title.trim())) title = title.replace(/\.+/g, ' '); // "Pokemon.Crystal.Legacy.Patches"
  title = title.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '').trim();
  return { title: title || stem, version };
}

/** Patches of one hack in different versions share this: the title without version, lower case, letters and digits only. */
export function patchFamily(name) {
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/pokemon/g, '').replace(/[^a-z0-9]+/g, '');
  return norm(patchTitle(name).title) || norm(name);
}

/**
 * The version numbers in a patch's file name, as number lists: "Pokemon Run&Bun 1.08.bps" → [[1, 8]],
 * "Too Many Types 2 v1.5.3.ips" → [[2], [1, 5, 3]], "RenegadePlatinumV130" → [[130]].
 */
export function nameVersion(name) {
  const stem = String(name || '').replace(EXT, '');
  return (stem.match(/\d+(?:\.\d+)*/g) || []).map((v) => v.split('.').map(Number));
}

/** > 0 when version a is the later one (number lists from nameVersion), 0 when they can't be told apart. */
export function compareVersions(a, b) {
  if (!a.length || !b.length) return 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || [];
    const y = b[i] || [];
    for (let j = 0; j < Math.max(x.length, y.length); j++) {
      const d = (x[j] ?? -1) - (y[j] ?? -1);
      if (d) return d;
    }
  }
  return 0;
}
