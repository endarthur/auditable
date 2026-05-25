// Zstandard read via fzstd (vendored). Decode-only; the encoder is a
// separate, larger package that we don't ship in v0.1 — anyone trying to
// .compress to zst gets a clear "decode-only build" error.
//
// At dev time the imports below resolve through ESM directly. At build
// time the imports are stripped and the references hit aliases declared
// after each vendored IIFE (see ext/archive/build.js's "vendor alias
// bindings" section).

import { decompress as fzstd_decompress } from '../vendor/fzstd.module.mjs';

// Single-shot decompress. fzstd's API is sync — same shape as fflate's
// unzipSync — so we wrap it in an async function to match gz.js's
// promise-returning shape and keep the API consistent.
export async function unzstdBytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('unzstdBytes: expected Uint8Array');
  // fzstd returns a Uint8Array directly; no Promise involved.
  return fzstd_decompress(u8);
}

// Placeholder for the encoder. Throws a clear error pointing at why.
export async function zstdBytes(/* u8 */) {
  throw new Error(
    'archive: zstd encode not available in this build — fzstd is decode-only ' +
    'and the encoder package (~120 KB) is not vendored yet. ' +
    'Use tar.gz or zip if you need a writeable archive format right now.'
  );
}

// Derive an inner filename for single-file .zst archives — strip '.zst' (or
// '.tzst' → '.tar'). Mirrors gz.js's _gzInnerName for consistency.
export function _zstInnerName(sourceName) {
  if (!sourceName) return 'data';
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.tzst')) return sourceName.slice(0, -5) + '.tar';
  if (lower.endsWith('.zst'))  return sourceName.slice(0, -4);
  return sourceName;
}
