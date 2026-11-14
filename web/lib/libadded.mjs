// What adding files to the library actually changed – for the message after an import or upload (web/views/library.mjs).
// Compares the library before and after: an entry from one of the added files is new, or was there already (the same
// ROM or patch, by checksum, under this or another name). A file that gave no entry holds nothing souldew can use.
import { t, currentLang } from './i18n.mjs';
import { catalog, gameTitle } from './data.mjs';
import { patchTitle } from '/shared/patchname.mjs';

/** The content of a library entry: CRC32 of a ROM (3DS: title + size, no CRC), SHA-1 of a patch. */
const sig = (kind, e) => (kind === 'patch' ? `p:${e.sha1 || e.id}` : `r:${e.crc || `${e.system}|${e.titleId || e.code || ''}|${e.size}`}`);

/**
 * before / after: scanLibrary() results; paths: the library files the server reported as added ({ added } of
 * /api/library/import and /upload), or null for a whole folder (then every entry new since `before` counts).
 * → { added: [{ kind: 'rom'|'patch', entry }], already: [...], unusable: number of files with nothing usable }
 */
export function addedToLibrary(before, after, paths) {
  const had = new Set();
  for (const r of before?.roms || []) had.add(sig('rom', r));
  for (const p of before?.patches || []) had.add(sig('patch', p));
  const entries = [...(after?.roms || []).map((entry) => ({ kind: 'rom', entry })), ...(after?.patches || []).map((entry) => ({ kind: 'patch', entry }))];
  const added = [];
  const already = [];
  let unusable = 0;
  const sort = (list) => {
    for (const x of list) (had.has(sig(x.kind, x.entry)) ? already : added).push(x);
  };
  if (!paths) {
    sort(entries.filter((x) => !had.has(sig(x.kind, x.entry))));
  } else {
    for (const path of new Set(paths)) {
      const mine = entries.filter((x) => x.entry.file === path);
      if (!mine.length) unusable++;
      sort(mine);
    }
  }
  return { added, already, unusable };
}

const gbText = (n) => {
  const gb = Math.max(0, Number(n) || 0) / 1024 ** 3;
  let num = gb.toFixed(1);
  try {
    num = gb.toLocaleString(currentLang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  } catch {
    // unknown locale – "4.0"
  }
  return `${num} GB`;
};

/**
 * The progress toast while a zipped 3DS game is unpacked (the server's "unpack" events: { state, name, gameId, size,
 * done }): "Unpacking Pokémon Sun … 40 % of 4.0 GB", replaced as it goes (key) and taken away when it's over – the
 * page that added it then says what was added, or why it failed.
 */
export function unpackToast(p, cat = catalog()) {
  if (!p || (p.state !== 'start' && p.state !== 'progress')) return { key: 'unpack', remove: true };
  const g = p.gameId ? (cat.games || []).find((x) => x.id === p.gameId) : null;
  const pct = p.size > 0 ? Math.min(100, Math.floor((100 * (p.done || 0)) / p.size)) : 0;
  return {
    key: 'unpack', kind: 'warn', ttl: 30 * 60 * 1000,
    title: t('lib.unpacking', 'Unpacking {name} …', { name: g ? gameTitle(g) : p.name }),
    text: t('lib.unpackingText', '{pct} % of {size} – souldew unpacks 3DS games into your library once', { pct, size: gbText(p.size) }),
  };
}

/** A name for an entry in the "added" message: the game or hack it is (with the patch's version), else its file name. */
function addedName({ kind, entry }, cat) {
  if (kind === 'patch') {
    const h = entry.hackId ? (cat.hacks || []).find((x) => x.id === entry.hackId) : null;
    const { title, version } = patchTitle(entry.name);
    return t('lib.addedPatchName', '{name} (patch)', { name: [h ? h.name : title, version].filter(Boolean).join(' ') });
  }
  const h = entry.hackId ? (cat.hacks || []).find((x) => x.id === entry.hackId) : null;
  const g = entry.gameId ? (cat.games || []).find((x) => x.id === entry.gameId) : null;
  return h ? h.name : g ? gameTitle(g) : entry.title || entry.name;
}

/** The toast (kind, title, text) for addedToLibrary()'s result: "Added: …", "2 games and 1 patch added", "Already in your library" … */
export function addedMessage({ added, already, unusable }, cat = catalog()) {
  const name = (x) => addedName(x, cat);
  const names = (list) => {
    const all = [...new Set(list.map(name))];
    return all.length > 5 ? `${all.slice(0, 5).join(', ')} …` : all.join(', ');
  };
  const extra = [];
  if (added.length && already.length) extra.push(t('lib.addedAlready', 'Already in your library: {names}', { names: names(already) }));
  if (unusable) extra.push(t('lib.addedUnusable', '{count} file has no game or patch souldew can use.|{count} files have no game or patch souldew can use.', { count: unusable }));
  if (added.length === 1) {
    const hint = added[0].kind === 'patch' ? t('lib.addedPatchHint', 'You’ll find it under ROM hacks.') : t('lib.addedGameHint', 'It’s on the shelf now.');
    return { kind: 'ok', title: t('lib.addedOne', 'Added: {name}', { name: name(added[0]) }), text: [hint, ...extra].join('\n') };
  }
  if (added.length) {
    const games = added.filter((x) => x.kind === 'rom').length;
    const patches = added.length - games;
    const parts = [games && t('lib.addedGames', '{count} game|{count} games', { count: games }), patches && t('lib.addedPatches', '{count} patch|{count} patches', { count: patches })].filter(Boolean);
    const what = parts.length === 2 ? t('lib.addedAnd', '{a} and {b}', { a: parts[0], b: parts[1] }) : parts[0];
    return { kind: 'ok', title: t('lib.addedMany', '{what} added', { what }), text: [names(added), ...extra].join('\n') };
  }
  if (already.length) return { kind: 'ok', title: t('lib.alreadyIn', 'Already in your library'), text: [names(already), ...extra].join('\n') };
  return { kind: 'warn', title: t('lib.nothingAdded', 'Nothing added'), text: extra.join('\n') || t('lib.nothingAddedText', 'No new game or patch was found in these files.') };
}
