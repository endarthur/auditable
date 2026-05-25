// ZIP read via fflate (vendored). Sync surface for v0.1; the streaming
// `Unzip` class is available for archive.stream() when it lands.
//
// Note: at runtime (after the build concatenates everything into one
// scope), fflate's `unzipSync` lives at the top of the same scope —
// these imports get stripped, references resolve directly.
//
// Entry shape we expose (matches the spec §3.2 list() shape):
//   { path, type: 'file' | 'directory', size, compressed?, mtime? }
//
// Directories in fflate's output appear as zero-byte entries whose path
// ends with '/'; we translate those into type: 'directory'.

import { unzipSync } from '../vendor/fflate.module.mjs';
import { autoRename } from './sink.js';

// listZip(bytes) → entries[]
// fflate's unzipSync decompresses everything into a `{ name: Uint8Array }`
// map. For v0.1 we accept the cost — list-only routes also discard the data
// after measuring. The streaming Unzip path will land in archive.stream()
// for huge archives.
export function listZip(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('listZip: bytes must be a Uint8Array');
  }
  const map = unzipSync(bytes);
  const out = [];
  for (const [name, data] of Object.entries(map)) {
    const isDir = name.endsWith('/');
    out.push(isDir
      ? { path: name, type: 'directory' }
      : { path: name, type: 'file', size: data.length });
  }
  return out;
}

// readZip(bytes, innerPath) → Uint8Array | null
// Extract a single entry. Returns null if the entry isn't present.
// Same caveat as listZip — fflate's sync API decompresses everything; for
// archives with many entries the streaming path is better.
export function readZip(bytes, innerPath) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('readZip: bytes must be a Uint8Array');
  }
  if (typeof innerPath !== 'string' || !innerPath) {
    throw new TypeError('readZip: innerPath must be a non-empty string');
  }
  const map = unzipSync(bytes, { filter: (file) => file.name === innerPath });
  const data = map[innerPath];
  return data || null;
}

// extractZip(bytes, sink, opts?) → { count, paths }
// Walk every entry, write through the sink. opts.overwrite controls
// collision behavior: 'error' (default) throws, 'skip' skips, 'rename'
// auto-suffixes (Finder-shape, file (2).csv), 'overwrite' clobbers.
export async function extractZip(bytes, sink, opts) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('extractZip: bytes must be a Uint8Array');
  }
  const map = unzipSync(bytes);
  const overwrite = (opts && opts.overwrite) || 'error';
  const filter = (opts && opts.filter) || null;
  const progress = (opts && opts.progress) || null;
  const paths = [];

  // Total byte count (best-effort for progress reporting).
  let total = 0;
  for (const v of Object.values(map)) if (v && v.length) total += v.length;
  let done = 0;

  for (const [name, data] of Object.entries(map)) {
    if (filter && !filter({ path: name })) continue;
    const isDir = name.endsWith('/');
    if (isDir) {
      await sink.mkdir(name);
      paths.push(name);
      continue;
    }

    let targetName = name;
    if (await sink.exists(targetName)) {
      if (overwrite === 'error')     throw new Error(`extract: destination exists — ${name}`);
      else if (overwrite === 'skip') continue;
      else if (overwrite === 'rename') targetName = await autoRename(sink, name);
      // 'overwrite' falls through and clobbers.
    }
    await sink.writeFile(targetName, data);
    paths.push(targetName);
    done += data.length;
    if (progress) progress({ path: name, bytesDone: done, bytesTotal: total });
  }
  return { count: paths.length, paths };
}

