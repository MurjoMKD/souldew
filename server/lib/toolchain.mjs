// Java + Universal Pokemon Randomizer ZX detection, download and invocation.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, delimiter } from 'node:path';
import { listZip, readZipEntry } from './zip.mjs';
import { TOOLS_DIR, BUNDLED_TOOLS, CACHE_DIR } from './paths.mjs';
import { httpError } from './fsutil.mjs';
import { PRESETS, buildValues, toProperties } from '../../shared/randomizer-options.mjs';

export const UPR_VERSION = '4.6.1';
export const UPR_URL = 'https://github.com/Ajarmar/universal-pokemon-randomizer-zx/releases/download/v4.6.1/PokeRandoZX-v4_6_1.zip';
export const UPR_ZIP_SHA256 = '26051fe8a6665ea0582dfcd4d1c3e4889da42a2f731f5fc530fff0cb691a43fd';
const BUNDLED_JAR = join(BUNDLED_TOOLS, 'upr', 'PokeRandoZX.jar');
export const UPR_JAR = existsSync(BUNDLED_JAR) ? BUNDLED_JAR : join(TOOLS_DIR, 'upr', 'PokeRandoZX.jar');
export const BRIDGE_DIR = join(BUNDLED_TOOLS, 'upr-bridge');
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const bundledJava = (arch) => join(BUNDLED_TOOLS, 'jre', `${process.platform}-${arch}`, 'bin', JAVA_EXE);
const BUNDLED_JAVA = bundledJava(process.arch);
// An arm64 Windows PC runs the bundled x64 runtime through Windows' x64 emulation.
const BUNDLED_FALLBACK = process.platform === 'win32' && process.arch === 'arm64' ? bundledJava('x64') : null;

/**
 * JVM options for the randomizer. UTF-8 as the default charset: Java 17 on Windows would otherwise read and write
 * text in the ANSI code page (cp1252), unlike macOS – the same seed must give the same game on every computer.
 */
export const JAVA_OPTS = ['-Xmx1g', '-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'];

/**
 * A 3DS game (Gen 6/7) needs far more Java heap: UPR ZX's own launcher starts it with -Xmx4608M (Sun runs out of memory
 * below ~2 GB). Only a ceiling – Java takes what it uses.
 */
export const CTR_HEAP = '-Xmx4608m';
/** Rebuilding a 3DS game writes ~3 GB and hashes it: minutes on a slow disk. */
export const CTR_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * JVM options of one bridge call. `ctr`: a 3DS game – the larger heap. `workDir`: UPR's working folder (the patched
 * SysConstants in tools/upr-bridge reads -Dsouldew.upr.root; without it UPR writes next to its jar, inside the app).
 */
export function javaOptsFor({ ctr = false, workDir = null } = {}) {
  const root = workDir ? [`-Dsouldew.upr.root=${workDir}`] : [];
  if (!ctr) return [...JAVA_OPTS, ...root];
  return [CTR_HEAP, ...JAVA_OPTS.filter((o) => !o.startsWith('-Xmx')), ...root];
}

/**
 * The @@ lines of the bridge's output → { json, warnings, error, settingsString, done, code, step, files }.
 * Other lines (UPR's own "NCCH: …" chatter) are ignored.
 */
export function parseBridgeOutput(out) {
  const result = { json: null, warnings: [], error: null, settingsString: null, done: null, code: null, step: null, files: null };
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^@@(\w+) (.*)$/);
    if (!m) continue;
    let value;
    try {
      value = JSON.parse(m[2]);
    } catch {
      continue; // a garbled line must not throw inside an event handler (= server crash)
    }
    if (m[1] === 'JSON') result.json = value;
    else if (m[1] === 'WARN') result.warnings.push(value);
    else if (m[1] === 'ERROR') result.error = value;
    else if (m[1] === 'SETTINGS') result.settingsString = value;
    else if (m[1] === 'DONE') result.done = value;
    else if (m[1] === 'CODE') result.code = value;
    else if (m[1] === 'STEP') result.step = value;
    else if (m[1] === 'FILES') result.files = value;
  }
  return result;
}

let javaCache = null;

/** Installed JDKs / JREs in the usual Windows folders (…\Java\jdk-17\bin\java.exe, Adoptium, Microsoft, Zulu …). */
export function windowsJavaCandidates(env = process.env, list = readdirSync) {
  const found = [];
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean);
  // 'jdk-21.0.4.7-hotspot' → 21, 'jdk1.8.0_202' / 'jre1.8.0' → 8
  const major = (name) => {
    const m = /(\d+)(?:\.(\d+))?/.exec(name);
    return !m ? 0 : m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1]);
  };
  for (const root of [...new Set(roots)]) {
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
      let names = [];
      try {
        names = list(join(root, vendor));
      } catch {
        continue;
      }
      for (const name of names) found.push({ path: join(root, vendor, name, 'bin', 'java.exe'), major: major(name) });
    }
  }
  // newest first, so a current Java wins over an old Java 8 left behind
  return found.sort((a, b) => b.major - a.major).map((f) => f.path);
}

function javaCandidates() {
  // The bundled runtime comes first: both players then use the identical Java version,
  // which keeps seeded randomization byte-identical across machines.
  const list = [BUNDLED_JAVA];
  if (BUNDLED_FALLBACK) list.push(BUNDLED_FALLBACK);
  if (process.env.JAVA_HOME) list.push(join(process.env.JAVA_HOME, 'bin', JAVA_EXE));
  list.push('java');
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) list.push(join(r.stdout.trim(), 'bin', 'java'));
    list.push('/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java');
    list.push('/opt/homebrew/opt/openjdk/bin/java');
  }
  if (process.platform === 'win32') list.push(...windowsJavaCandidates());
  return list;
}

export function detectJava(force = false) {
  if (javaCache && !force) return javaCache;
  for (const bin of javaCandidates()) {
    try {
      // windowsHide: java.exe is a console program – without it every check would flash a console window
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const text = `${r.stderr || ''}${r.stdout || ''}`;
      const m = text.match(/version "([^"]+)"/);
      if (r.status === 0 && m) {
        const raw = m[1];
        const major = raw.startsWith('1.') ? Number(raw.split('.')[1]) : Number(raw.split(/[.+-]/)[0]);
        javaCache = { ok: major >= 8, bin, version: raw, major, bundled: bin === BUNDLED_JAVA || bin === BUNDLED_FALLBACK, vendor: text.split(/\r?\n/)[1]?.trim() || '' };
        return javaCache;
      }
    } catch {
      // try next candidate
    }
  }
  javaCache = { ok: false, bin: null, version: null, major: 0 };
  return javaCache;
}

export function uprStatus() {
  return {
    version: UPR_VERSION,
    installed: existsSync(UPR_JAR),
    bridge: existsSync(join(BRIDGE_DIR, 'SoulLinkBridge.class')),
    jar: UPR_JAR,
  };
}

export async function installUpr() {
  const res = await fetch(UPR_URL);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== UPR_ZIP_SHA256) throw new Error('Prüfsumme des Randomizer-Downloads stimmt nicht – abgebrochen');
  mkdirSync(join(TOOLS_DIR, 'upr'), { recursive: true });
  const tmp = join(TOOLS_DIR, 'upr', 'download.zip');
  writeFileSync(tmp, buf);
  try {
    const entry = listZip(tmp).find((e) => e.name.endsWith('PokeRandoZX.jar'));
    if (!entry) throw new Error('PokeRandoZX.jar nicht im Download gefunden');
    writeFileSync(UPR_JAR + '.part', readZipEntry(tmp, entry));
    renameSync(UPR_JAR + '.part', UPR_JAR);
  } finally {
    rmSync(tmp, { force: true });
  }
  return uprStatus();
}

/**
 * What the new-run wizard needs to know about a Gen 1–5 game (POST /api/rom/inspect): UPR ZX's `info`, with a trial
 * run of the recommended preset (`gen`: the game's generation, for that preset's values) – the whole randomization in
 * memory, nothing written (SoulLinkBridge info). A game UPR can't load → { unsupported: true, reason: 'unreadable' };
 * one it loads but can't randomize (a ROM hack or release whose data isn't where UPR expects it) → reason 'randoCrash'
 * with `what`, the exception's class: the page says so before a run is built, instead of a failed build. Java or the
 * randomizer missing → `missingTool`. Never the bridge's own output (#43). `run`: runBridge (tests pass a stand-in).
 */
export async function inspectRom(path, { gen = null, run = runBridge, dir = CACHE_DIR } = {}) {
  const props = join(dir, `trial-${randomBytes(6).toString('hex')}.properties`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(props, toProperties(buildValues(PRESETS[0].values, gen)));
    const info = (await run(['info', path, props, '1'])).json || {};
    if (typeof info.trial === 'string') return { ...info, unsupported: true, reason: 'randoCrash', what: info.trial };
    return info;
  } catch (e) {
    const missingTool = !detectJava().ok ? 'java' : !uprStatus().installed ? 'upr' : null;
    if (!missingTool) console.warn('[inspect]', e.message);
    return { unsupported: true, reason: missingTool ? null : 'unreadable', missingTool };
  } finally {
    rmSync(props, { force: true });
  }
}

/**
 * A randomizer run that failed, as the answer the page shows: in words, with a code it translates – never the
 * randomizer's own output (#43). UPR ZX stopping with a Java exception (data it doesn't expect – a ROM hack, a release
 * it doesn't know) → 422 'randoFailed', naming only the exception's class for a bug report ("Index 1286 out of bounds
 * for length 1268" and the like say nothing to a player); a timeout → 504 'randoTimeout'. Errors that are answers
 * already (Java or the randomizer missing, an invalid seed …) pass through. The bridge's output stays on the error
 * (`details`) for the server's log.
 */
export function randomizerError(e) {
  if (!e || e.status || !e.details) return e;
  if (e.code === 'timeout') return Object.assign(httpError(504, 'Der Randomizer hat zu lange gebraucht und wurde abgebrochen', 'randoTimeout'), { details: e.details });
  const cls = String(e.details.error || e.details.stderr || '').match(/\b(?:[a-z]\w*\.)+([A-Z]\w*(?:Exception|Error))\b/)?.[1] || null;
  return Object.assign(httpError(422, `Der Randomizer kommt mit diesem Spiel nicht zurecht${cls ? ` (${cls})` : ''} – spiel es ohne Randomizer`, 'randoFailed', { what: cls || `exit ${e.details.exitCode}` }),
    { details: e.details });
}

/**
 * Run the SoulLinkBridge (see tools/upr-bridge/SoulLinkBridge.java). Resolves with parsed @@ lines.
 * `ctr`: a 3DS game – bigger heap, its own working folder under the cache (removed afterwards), a longer timeout.
 * `onLine`: called with every line the bridge prints while it runs (progress of a 3DS build).
 * A failure carries `code` when the bridge named one ('encrypted', 'memory', 'timeout').
 */
export function runBridge(args, { timeoutMs, ctr = false, onLine = null } = {}) {
  const java = detectJava();
  if (!java.ok) return Promise.reject(new Error('Java 8+ wurde nicht gefunden. Bitte Java installieren (z. B. Temurin 21 von adoptium.net).'));
  if (!existsSync(UPR_JAR)) return Promise.reject(new Error('Universal Pokemon Randomizer ZX fehlt – bitte im Setup installieren.'));
  const limit = timeoutMs ?? (ctr ? CTR_TIMEOUT_MS : 180000);
  // every run's own folder for the game files UPR unpacks (a 3DS game: hundreds of MB) – never inside the app, never
  // shared: two runs on the same game (the wizard's check while a build runs) took each other's files away
  const workDir = join(CACHE_DIR, ctr ? 'upr-3ds' : 'upr-work', randomBytes(6).toString('hex'));
  mkdirSync(workDir, { recursive: true });
  return new Promise((resolve, reject) => {
    // the bridge folder first: it carries a fixed copy of UPR's Effectiveness (EnumMap instead of HashMap – the order
    // of a HashMap of enums depends on the JVM, so "sensible items" on Gen 4/5 gave different ROMs per Java version)
    // and of SysConstants (the working folder above)
    const cp = [BRIDGE_DIR, UPR_JAR].join(delimiter);
    const child = spawn(java.bin, [...javaOptsFor({ ctr, workDir }), '-cp', cp, 'SoulLinkBridge', ...args], {
      cwd: workDir,
      windowsHide: true, // no console window next to the app while the randomizer runs
    });
    let out = '';
    let err = '';
    let partial = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limit);
    child.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) {
        try {
          onLine(l);
        } catch {
          // progress only – never the build's failure
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    const cleanup = () => {
      clearTimeout(timer);
      rmSync(workDir, { recursive: true, force: true });
    };
    child.on('error', (e) => {
      cleanup();
      reject(e);
    });
    child.on('close', (code) => {
      cleanup();
      // `code`: the code the bridge named (@@CODE), `exitCode`: the process' exit code
      const result = { ...parseBridgeOutput(out), exitCode: code, stdout: out, stderr: err };
      if (code !== 0 || result.error) {
        const detail = timedOut ? `Zeitüberschreitung nach ${Math.round(limit / 1000)} s` : result.error || err.split(/\r?\n/).find((l) => l.trim())?.trim() || `Exit-Code ${code}`;
        const e = new Error(`Randomizer-Fehler: ${detail}`);
        e.details = result;
        e.code = timedOut ? 'timeout' : result.code || (/OutOfMemoryError/.test(err) ? 'memory' : null);
        reject(e);
        return;
      }
      resolve(result);
    });
  });
}
