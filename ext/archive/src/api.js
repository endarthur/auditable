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
import { listTar, readTar, extractTar } from './tar.js';
import { gunzipBytes, gzipBytes, _gzInnerName } from './gz.js';
import { unzstdBytes, zstdBytes, _zstInnerName } from './zst.js';

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

// Resolve a source to bytes + format, peeling off any outer gz/zst wrapper
// so the caller can dispatch on the inner archive format uniformly.
async function _peelCompression(src) {
  const resolved = await _resolveSourceFormat(src);
  if (resolved.format === 'gz' || resolved.format === 'tar.gz') {
    return _unwrapGz(resolved.bytes, resolved.name);
  }
  if (resolved.format === 'zst' || resolved.format === 'tar.zst') {
    return _unwrapZst(resolved.bytes, resolved.name);
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
  switch (format) {
    case 'tar.xz':
    case 'tar.bz2':
    case 'xz':
    case 'bz2':
      return `archive: ${format} requires a lazy-loaded Wasm decoder (not yet wired)`;
    default:
      return `archive: unsupported format '${format}'`;
  }
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
    if (format === 'gz-single' || format === 'zst-single') {
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
    if (format === 'gz-single' || format === 'zst-single') {
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
    else if (format === 'gz-single' || format === 'zst-single') {
      result = await _extractSingle(dst, resolved.innerName, bytes, opts);
    }
    else throw new Error(_explainUnsupported(format));
    if (dst.kind === 'memory') return dst.result();
    return result;
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

