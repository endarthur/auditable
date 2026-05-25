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
import { normalizeSink } from './sink.js';
import { listZip, readZip, extractZip } from './zip.js';
import { listTar, readTar, extractTar } from './tar.js';

async function _resolveSourceFormat(src) {
  const bytes = await src.bytes();
  const detected = detectFormat(bytes);
  if (detected) return { bytes, format: detected };
  if (src.name) {
    const hinted = magicForFormat(src.name);
    if (hinted) return { bytes, format: hinted };
  }
  throw new Error('archive: could not detect format (no magic bytes match, no extension hint)');
}

function _explainUnsupported(format) {
  switch (format) {
    case 'tar.gz':
    case 'tar.zst':
      return `archive: ${format} requires the gz/zst decompression layer (not yet wired — coming with gz.js + zst.js)`;
    case 'tar.xz':
    case 'tar.bz2':
      return `archive: ${format} requires a lazy-loaded Wasm decoder (not yet wired)`;
    case 'gz':
    case 'zst':
      return `archive: single-file ${format} helpers not yet wired (gz/zst handlers coming next)`;
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
    const { bytes, format } = await _resolveSourceFormat(src);
    if (format === 'zip') return listZip(bytes);
    if (format === 'tar') return listTar(bytes);
    throw new Error(_explainUnsupported(format));
  },

  async read(source, innerPath) {
    if (typeof innerPath !== 'string' || !innerPath) {
      throw new TypeError('archive.read: innerPath must be a non-empty string');
    }
    const src = normalizeSource(source);
    const { bytes, format } = await _resolveSourceFormat(src);
    if (format === 'zip') return readZip(bytes, innerPath);
    if (format === 'tar') return readTar(bytes, innerPath);
    throw new Error(_explainUnsupported(format));
  },

  async extract(source, sink, opts) {
    const src = normalizeSource(source);
    const dst = normalizeSink(sink);
    const { bytes, format } = await _resolveSourceFormat(src);
    let result;
    if (format === 'zip')      result = await extractZip(bytes, dst, opts);
    else if (format === 'tar') result = await extractTar(bytes, dst, opts);
    else throw new Error(_explainUnsupported(format));
    // For memory sinks, surface the result map directly — caller convenience.
    if (dst.kind === 'memory') return dst.result();
    return result;
  },
};
