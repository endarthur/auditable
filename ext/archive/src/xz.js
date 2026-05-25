// XZ read via xz-decompress (vendored). Decode-only — xz encode is out
// of scope (the LZMA2 encoder is large and not bundled). A user trying
// to .compress to xz gets the "decode-only build" error from api.js.
//
// At dev time the import below resolves through ESM directly. At build
// time the import is stripped and `XzReadableStream` is provided by an
// alias declared after the vendored IIFE (see ext/archive/build.js's
// "vendor alias bindings" section).

import { XzReadableStream } from '../vendor/xz-decompress.module.mjs';

// Single-shot decompress. xz-decompress is stream-only — wrap the input
// bytes in a one-chunk ReadableStream, drain through XzReadableStream,
// concatenate output chunks. The decoder's WebAssembly module is
// instantiated lazily on the first construct() — subsequent calls reuse
// the cached instance, so back-to-back unxz operations only pay the
// init cost once.
export async function unxzBytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('unxzBytes: expected Uint8Array');

  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(u8);
      controller.close();
    },
  });

  const decoded = new XzReadableStream(input);
  const reader = decoded.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Placeholder for the encoder. Throws a clear error pointing at why.
export async function xzBytes(/* u8 */) {
  throw new Error(
    'archive: xz encode not available — xz-decompress is decode-only and ' +
    'an LZMA2 encoder is not vendored. Use tar.gz or zip if you need a ' +
    'writeable archive format right now.'
  );
}

// Derive an inner filename for single-file .xz archives — strip '.xz' (or
// '.txz' → '.tar'). Mirrors gz.js / zst.js for consistency.
export function _xzInnerName(sourceName) {
  if (!sourceName) return 'data';
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.txz')) return sourceName.slice(0, -4) + '.tar';
  if (lower.endsWith('.xz'))  return sourceName.slice(0, -3);
  return sourceName;
}
