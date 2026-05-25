// bzip2 read via seek-bzip (vendored). Decode-only — bz2 encode is out
// of scope (modern toolchains produce .tar.gz or .tar.zst; bz2 is mostly
// for reading older Debian sources / scientific datasets). A user trying
// to .compress to bz2 gets the "decode-only build" error from api.js.
//
// At dev time the import below resolves through ESM directly. At build
// time the import is stripped and `Bunzip` is provided by an alias
// declared after the vendored IIFE (see ext/archive/build.js's "vendor
// alias bindings" section).

import { Bunzip } from '../vendor/seek-bzip.module.mjs';

// Single-shot decompress. seek-bzip is sync — same shape as fzstd /
// fflate — so we wrap in an async function to match the rest of the
// archive helpers' Promise-returning shape.
export async function unbz2Bytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('unbz2Bytes: expected Uint8Array');
  // Bunzip.decode returns a Buffer-shaped result; coerce to Uint8Array.
  const out = Bunzip.decode(u8);
  return out instanceof Uint8Array ? out : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

// Placeholder for the encoder. Throws a clear error pointing at why.
export async function bz2Bytes(/* u8 */) {
  throw new Error(
    'archive: bz2 encode not available — seek-bzip is decode-only and a ' +
    'bzip2 encoder is not vendored. Use tar.gz or zip if you need a ' +
    'writeable archive format right now.'
  );
}

// Derive an inner filename for single-file .bz2 archives — strip '.bz2'
// (or '.tbz' / '.tbz2' → '.tar'). Mirrors gz.js / zst.js / xz.js.
export function _bz2InnerName(sourceName) {
  if (!sourceName) return 'data';
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.tbz2')) return sourceName.slice(0, -5) + '.tar';
  if (lower.endsWith('.tbz'))  return sourceName.slice(0, -4) + '.tar';
  if (lower.endsWith('.bz2'))  return sourceName.slice(0, -4);
  return sourceName;
}
