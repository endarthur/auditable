// Public surface for @gcu/archive.
//
// Shipped this commit (foundation — ZIP read only):
//   archive.list(source)              → entries[]
//   archive.read(source, innerPath)   → Uint8Array | null
//   archive.extract(source, sink, opts?) → { count, paths }
//   archive.detect(source)            → 'zip' | 'tar' | ... | null
//
// Forthcoming:
//   archive.compress(source, sink, opts)     — write ZIP/tar/tar.gz/tar.zst
//   archive.stream(source)                   — async iterable of entries
//   archive.gzip / gunzip / zstd / unzstd    — single-file helpers
//   tar / tar.gz / tar.zst dispatch          — tar.js + gz.js + zst.js wiring
//
// Format dispatch: detectFormat(bytes) is authoritative; falls back to
// magicForFormat(name) when the source had a filename hint. Compound formats
// like `.tar.gz` won't be handled here — tar.js will own the pipeline once
// it lands; today's ZIP-only impl returns a clear error for unsupported types.

import { detectFormat, magicForFormat } from './detect.js';
import { normalizeSource } from './source.js';
import { normalizeSink, autoRename } from './sink.js';
import { listZip, readZip, extractZip } from './zip.js';
import { listTar, readTar, extractTar, writeTar } from './tar.js';
import { gunzipBytes, gzipBytes, _gzInnerName } from './gz.js';
import { unzstdBytes, zstdBytes, _zstInnerName } from './zst.js';
import { unxzBytes, xzBytes, _xzInnerName } from './xz.js';
import { unbz2Bytes, bz2Bytes, _bz2InnerName } from './bz2.js';
import { walkVfsTree } from './walk.js';
import { createWriter } from './writer.js';
import { zipSync } from '../vendor/fflate.module.mjs';

async function _resolveSourceFormat(src) {
  const bytes = await src.bytes();
  const detected = detectFormat(bytes);
  if (detected) return { bytes, format: detected, name: src.name };
  if (src.name) {
    const hinted = magicForFormat(src.name);
    if (hinted) return { bytes, format: hinted, name: src.name };
  }
  throw new Error('archive: could not detect format (no magic bytes match, no extension hint)');
}

// Peel off one gzip wrapper and re-detect the inner payload. Returns the
// same { bytes, format, name } shape as _resolveSourceFormat. For tar.gz
// the inner is 'tar'; for a single-file gzip of a CSV the inner is null
// (no archive format) and we report 'gz' as a single-entry container.
async function _unwrapGz(bytes, name) {
  const inner = await gunzipBytes(bytes);
  const innerFormat = detectFormat(inner);
  const innerName = _gzInnerName(name);
  if (innerFormat) return { bytes: inner, format: innerFormat, name: innerName };
  return { bytes: inner, format: 'gz-single', name: innerName, innerName };
}

// Same shape as _unwrapGz but for zstd. Single-file .zst payloads land
// as `zst-single`; .tar.zst unwraps to tar.
async function _unwrapZst(bytes, name) {
  const inner = await unzstdBytes(bytes);
  const innerFormat = detectFormat(inner);
  const innerName = _zstInnerName(name);
  if (innerFormat) return { bytes: inner, format: innerFormat, name: innerName };
  return { bytes: inner, format: 'zst-single', name: innerName, innerName };
}

// Same shape as _unwrapGz but for xz.
async function _unwrapXz(bytes, name) {
  const inner = await unxzBytes(bytes);
  const innerFormat = detectFormat(inner);
  const innerName = _xzInnerName(name);
  if (innerFormat) return { bytes: inner, format: innerFormat, name: innerName };
  return { bytes: inner, format: 'xz-single', name: innerName, innerName };
}

// Same shape as _unwrapGz but for bzip2.
async function _unwrapBz2(bytes, name) {
  const inner = await unbz2Bytes(bytes);
  const innerFormat = detectFormat(inner);
  const innerName = _bz2InnerName(name);
  if (innerFormat) return { bytes: inner, format: innerFormat, name: innerName };
  return { bytes: inner, format: 'bz2-single', name: innerName, innerName };
}

// Resolve a source to bytes + format, peeling off any outer gz/zst/xz/bz2
// wrapper so the caller can dispatch on the inner archive format uniformly.
async function _peelCompression(src) {
  const resolved = await _resolveSourceFormat(src);
  if (resolved.format === 'gz' || resolved.format === 'tar.gz') {
    return _unwrapGz(resolved.bytes, resolved.name);
  }
  if (resolved.format === 'zst' || resolved.format === 'tar.zst') {
    return _unwrapZst(resolved.bytes, resolved.name);
  }
  if (resolved.format === 'xz' || resolved.format === 'tar.xz') {
    return _unwrapXz(resolved.bytes, resolved.name);
  }
  if (resolved.format === 'bz2' || resolved.format === 'tar.bz2') {
    return _unwrapBz2(resolved.bytes, resolved.name);
  }
  return resolved;
}

// Write a single decompressed payload into a directory-shaped sink, applying
// the overwrite policy. Shared by gz-single and zst-single extract paths.
async function _extractSingle(dst, innerName, bytes, opts) {
  const overwrite = (opts && opts.overwrite) || 'error';
  let target = innerName;
  if (await dst.exists(target)) {
    if (overwrite === 'error') throw new Error(`extract: destination exists — ${target}`);
    if (overwrite === 'skip')  return { count: 0, paths: [] };
    if (overwrite === 'rename') target = await autoRename(dst, target);
  }
  await dst.writeFile(target, bytes);
  return { count: 1, paths: [target] };
}

function _explainUnsupported(format) {
  return `archive: unsupported format '${format}'`;
}

export const archive = {
  // detect — peek at a source without reading the whole thing into memory
  // unnecessarily. For a small archive (or any in-memory bytes) it's cheap;
  // for a large stream it still has to drain to inspect the magic bytes.
  async detect(source) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    return detectFormat(bytes) || (src.name && magicForFormat(src.name)) || null;
  },

  async list(source) {
    const src = normalizeSource(source);
    const resolved = await _peelCompression(src);
    const { bytes, format } = resolved;
    if (format === 'zip') return listZip(bytes);
    if (format === 'tar') return listTar(bytes);
    if (format === 'gz-single' || format === 'zst-single' || format === 'xz-single' || format === 'bz2-single') {
      return [{ path: resolved.innerName, type: 'file', size: bytes.length }];
    }
    throw new Error(_explainUnsupported(format));
  },

  async read(source, innerPath) {
    if (typeof innerPath !== 'string' || !innerPath) {
      throw new TypeError('archive.read: innerPath must be a non-empty string');
    }
    const src = normalizeSource(source);
    const resolved = await _peelCompression(src);
    const { bytes, format } = resolved;
    if (format === 'zip') return readZip(bytes, innerPath);
    if (format === 'tar') return readTar(bytes, innerPath);
    if (format === 'gz-single' || format === 'zst-single' || format === 'xz-single' || format === 'bz2-single') {
      return innerPath === resolved.innerName ? bytes : null;
    }
    throw new Error(_explainUnsupported(format));
  },

  async extract(source, sink, opts) {
    const src = normalizeSource(source);
    const dst = normalizeSink(sink);
    const resolved = await _peelCompression(src);
    const { bytes, format } = resolved;
    let result;
    if (format === 'zip')      result = await extractZip(bytes, dst, opts);
    else if (format === 'tar') result = await extractTar(bytes, dst, opts);
    else if (format === 'gz-single' || format === 'zst-single' || format === 'xz-single' || format === 'bz2-single') {
      result = await _extractSingle(dst, resolved.innerName, bytes, opts);
    }
    else throw new Error(_explainUnsupported(format));
    if (dst.kind === 'memory') return dst.result();
    return result;
  },

  // Write side. Builds a ZIP / tar / tar.gz from a VFS directory (walked
  // recursively) or a flat `{ name: bytes }` entry map. Single-file gz /
  // zst formats route through archive.gzip / archive.zstd respectively.
  //
  // source:
  //   - { vfs, path: '/dir' }        — walk recursively, archive entries
  //     are paths relative to that dir
  //   - { vfs, path: '/file' }       — single file, archive contains the
  //     file under its basename
  //   - { name: bytes, ... }         — entries provided directly (advanced)
  //   - Uint8Array                   — only valid with format 'gz' (single
  //     stream compress)
  //
  // sink:
  //   - { vfs, path: '/out.zip' }    — file path; bytes written there
  //   - 'memory'                     — returns the raw archive bytes
  //     wrapped in a 1-key Map keyed by the sink-derived name
  //
  // opts.format: explicit format override; otherwise inferred from sink path.
  // opts.filter: predicate(entry) excluding paths during walk.
  // opts.level: deflate level for ZIP (0-9). tar / gz / zst pick their own.
  async compress(source, sink, opts = {}) {
    const format = opts.format || _formatFromSinkPath(sink);
    if (!format) {
      throw new Error(
        'archive.compress: format required — pass opts.format or use a sink path ' +
        'with a recognized extension (.zip, .tar, .tar.gz, .gz, …)');
    }

    // Single-stream gz / zst paths: read source as bytes, compress one shot.
    if (format === 'gz') return this.gzip(source, sink);
    if (format === 'zst') return this.zstd(source, sink);

    // tar.zst / tar.xz / tar.bz2 / single-stream variants are decode-only
    // by design (out-of-scope encode — modern toolchains produce tar.gz or
    // tar.zst and zstd encoding is the only one we'd vendor if any). Be
    // explicit so users don't think it silently no-op'd.
    if (format === 'tar.zst') {
      throw new Error('archive.compress: tar.zst encode not available (fzstd is decode-only)');
    }
    if (format === 'tar.xz' || format === 'xz') {
      throw new Error('archive.compress: xz encode not available (xz-decompress is decode-only)');
    }
    if (format === 'tar.bz2' || format === 'bz2') {
      throw new Error('archive.compress: bz2 encode not available (seek-bzip is decode-only)');
    }

    // Multi-entry formats. Gather entries, build the archive, write it out.
    const filter = opts.filter || null;
    const entryMap = await _gatherEntries(source, filter);
    let archiveBytes;
    if (format === 'zip')         archiveBytes = zipSync(entryMap, _zipOptsFor(opts));
    else if (format === 'tar')    archiveBytes = writeTar(entryMap);
    else if (format === 'tar.gz') archiveBytes = await gzipBytes(writeTar(entryMap));
    else throw new Error(_explainUnsupported(format));

    const fallbackName = _sinkBasename(sink) || ('archive.' + format);
    return _writeSingle(sink, archiveBytes, fallbackName);
  },

  // Single-file gzip helpers. Sink semantics differ from extract's: the
  // sink's `path` (when vfs) is the OUTPUT FILE, not a destination directory
  // — gunzip writes one byte stream, not many entries. memory sink returns
  // a one-key Map keyed by the derived inner name.
  async gzip(source, sink) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    const compressed = await gzipBytes(bytes);
    return _writeSingle(sink, compressed, (src.name || 'data') + '.gz');
  },

  async gunzip(source, sink) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    const inner = await gunzipBytes(bytes);
    return _writeSingle(sink, inner, _gzInnerName(src.name));
  },

  // Single-file zstd helpers. Encode path throws — fzstd is decode-only.
  // (When the encoder gets vendored, zstdBytes lights up and this works.)
  async zstd(source, sink) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    const compressed = await zstdBytes(bytes);
    return _writeSingle(sink, compressed, (src.name || 'data') + '.zst');
  },

  async unzstd(source, sink) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    const inner = await unzstdBytes(bytes);
    return _writeSingle(sink, inner, _zstInnerName(src.name));
  },

  // Streaming writer — call addFile / addDirectory / close incrementally
  // instead of materialising the whole entry map in memory before encoding.
  // See src/writer.js for the per-format details.
  createWriter,
};

// Write a single byte stream to whatever shape of sink the caller passed.
// Used by archive.gzip and archive.gunzip; bypasses normalizeSink because
// the directory-shaped semantics there don't fit single-file destinations.
async function _writeSingle(sink, bytes, defaultName) {
  if (sink === 'memory') {
    const m = new Map();
    m.set(defaultName, bytes);
    return m;
  }
  if (sink && typeof sink === 'object' && sink.vfs && typeof sink.path === 'string') {
    const r = sink.vfs.writeFile(sink.path, bytes);
    if (r && typeof r.then === 'function') await r;
    return { count: 1, paths: [sink.path] };
  }
  throw new TypeError('sink: single-file helpers expect { vfs, path: <file> } or "memory"');
}

// Infer the output format from the sink's file path extension. Used as the
// fallback when opts.format isn't specified — matches the spec's promise
// that `archive.compress({vfs,path:'a'}, {vfs,path:'a.tar.gz'})` Just Works.
function _formatFromSinkPath(sink) {
  if (sink && typeof sink === 'object' && typeof sink.path === 'string') {
    return magicForFormat(sink.path);
  }
  return null;
}

function _sinkBasename(sink) {
  if (sink && typeof sink === 'object' && typeof sink.path === 'string') {
    return sink.path.split('/').pop();
  }
  return null;
}

// Map opts.level (0..9 or undefined) onto fflate's zipSync options shape.
function _zipOptsFor(opts) {
  const o = {};
  if (typeof opts.level === 'number') o.level = Math.max(0, Math.min(9, opts.level | 0));
  return o;
}

// Build a `{ path: bytes }` entry map from one of the supported compress
// source shapes. VFS-backed sources walk via walkVfsTree; plain objects
// pass through after byte-coercing values; Uint8Array isn't accepted here
// (single-file gz/zst takes a different path in compress() above).
async function _gatherEntries(source, filter) {
  // VFS source — directory or single file.
  if (source && typeof source === 'object' && source.vfs && typeof source.path === 'string') {
    const entries = await walkVfsTree(source.vfs, source.path, filter ? { filter } : {});
    const map = {};
    for (const e of entries) map[e.path] = e.bytes;
    return map;
  }
  // Plain entry object — { 'a/b.txt': bytes-or-string, ... }
  if (source && typeof source === 'object' && !(source instanceof Uint8Array)) {
    const map = {};
    for (const [k, v] of Object.entries(source)) {
      if (filter && !filter({ path: k, type: k.endsWith('/') ? 'directory' : 'file' })) continue;
      if (v instanceof Uint8Array) map[k] = v;
      else if (typeof v === 'string') map[k] = new TextEncoder().encode(v);
      else if (v && v.buffer) map[k] = new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
      else map[k] = new Uint8Array(0);
    }
    return map;
  }
  throw new TypeError(
    'archive.compress: source must be { vfs, path } or a flat { path: bytes } object ' +
    '(single-stream compress goes through archive.gzip / archive.zstd)');
}

