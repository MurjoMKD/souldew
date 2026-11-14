// Unpacking downloaded tools (the external emulators) without platform tools: .zip (zip.mjs) and .7z (sevenzip.mjs)
// in plain JavaScript. Used on Windows and Linux; macOS keeps ditto / hdiutil, which preserve .app bundles exactly.
// Entry names are checked: nothing is written outside the target folder, and names are made valid for the platform.
import { mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { join, dirname, relative } from 'node:path';
import { listZip, readZipEntry } from './zip.mjs';
import { read7z } from './sevenzip.mjs';
import { crc32 } from '../../shared/checksum.mjs';
import { safeFileName, isInside } from './fsutil.mjs';

/** Where an archive entry goes inside `dest` – or null for names that would escape it (../, absolute, drive letters). */
export function entryTarget(dest, name) {
  const parts = String(name).split(/[\\/]+/).filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..') || /^[a-z]:/i.test(String(name)) || /^[\\/]/.test(String(name))) return null;
  const target = join(dest, ...parts.map((p) => safeFileName(p)));
  return isInside(target, dest) ? target : null;
}

/**
 * A folder entry: its name ends in a separator. Zips made on Windows (Azahar's official build, made with
 * PowerShell's Compress-Archive) spell folders with backslashes – "azahar-windows-msvc-2126.2\\plugins\\" – and a
 * reader that only knows "/" writes such an entry as an empty FILE, which then blocks every file inside the folder
 * (ENOTDIR on mkdir).
 */
export const isFolderEntry = (name) => /[\\/]$/.test(String(name));

/** Unpacks a .zip or .7z into `dest` (created if needed). Returns the files written. Throws on damaged archives. */
export function extractArchive(file, dest) {
  mkdirSync(dest, { recursive: true });
  const written = [];
  const empties = new Set(); // empty files this archive wrote: a folder entry stored as a file, replaced if need be
  const isDir = (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  // `dir` and its parents as folders. An empty file this archive wrote earlier where a folder must go (a folder
  // entry without its separator) becomes the folder; anything else in the way is an error with the path in it.
  const ensureDir = (dir) => {
    try {
      mkdirSync(dir, { recursive: true });
      return;
    } catch (e) {
      if (e.code !== 'ENOTDIR' && e.code !== 'EEXIST') throw e;
    }
    let p = dest;
    for (const part of relative(dest, dir).split(/[\\/]+/).filter(Boolean)) {
      p = join(p, part);
      if (isDir(p)) continue;
      if (empties.has(p)) {
        unlinkSync(p);
        empties.delete(p);
        if (written.includes(p)) written.splice(written.indexOf(p), 1);
      }
      mkdirSync(p); // throws (EEXIST / ENOTDIR) for a real file in the way – a broken archive
    }
  };
  const put = (name, data) => {
    const target = entryTarget(dest, name);
    if (!target) throw new Error(`Unsafe path in archive: ${String(name).slice(0, 200)}`);
    ensureDir(dirname(target));
    if (isDir(target)) {
      if (!data.length) return; // the folder again, as an empty "file" entry
      throw new Error(`Archive has a file and a folder named ${String(name).slice(0, 200)}`);
    }
    writeFileSync(target, data);
    if (!written.includes(target)) written.push(target); // (a duplicate entry: the last one wins)
    if (data.length) empties.delete(target);
    else empties.add(target);
  };
  const folder = (name) => {
    const target = entryTarget(dest, name);
    if (target) ensureDir(target);
  };
  if (/\.7z$/i.test(file)) {
    for (const e of read7z(readFileSync(file))) {
      if (e.dir || isFolderEntry(e.name)) folder(e.name);
      else put(e.name, e.data);
    }
  } else if (/\.zip$/i.test(file)) {
    for (const e of listZip(file)) {
      if (isFolderEntry(e.name) && !e.uncompSize) {
        folder(e.name);
        continue;
      }
      const data = readZipEntry(file, e);
      if (crc32(data) !== e.crc) throw new Error(`Damaged archive (CRC error in ${e.name})`);
      put(e.name, data);
    }
  } else {
    throw new Error(`Unsupported archive: ${file}`);
  }
  return written;
}

/**
 * extractArchive on a worker thread: unpacking a 7z (LZMA) takes seconds of CPU, and the server shares its thread
 * with the app's main process – the window must not freeze meanwhile. Resolves with the files written.
 */
export function extractArchiveAsync(file, dest) {
  return new Promise((resolvePromise, reject) => {
    // execArgv: [] – the worker must not inherit flags meant for the main script (e.g. `node --input-type=module -e`)
    const worker = new Worker(new URL(import.meta.url), { workerData: { task: 'extract', file, dest }, execArgv: [] });
    let settled = false;
    worker.once('message', (m) => {
      settled = true;
      if (m.ok) resolvePromise(m.written);
      else reject(Object.assign(new Error(m.message), { code: m.code }));
    });
    worker.once('error', (e) => {
      settled = true;
      reject(e);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Unpacking stopped unexpectedly (exit code ${code})`));
    });
  });
}

if (!isMainThread && workerData?.task === 'extract') {
  try {
    parentPort.postMessage({ ok: true, written: extractArchive(workerData.file, workerData.dest) });
  } catch (e) {
    parentPort.postMessage({ ok: false, message: e.message, code: e.code || null });
  }
}
