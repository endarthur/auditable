// gzip compress + decompress via the native Web Streams (De)CompressionStream
// API. Zero vendored bytes — gzip support is in every browser ≥ 80 and
// Node ≥ 18, which is the floor for this whole project anyway.
//
// Exposes:
//   gunzipBytes(u8) → Promise<Uint8Array>          single-shot decompress
//   gzipBytes(u8) → Promise<Uint8Array>            single-shot compress
//
// api.js wires these into:
//   - archive.list/read/extract dispatch for 'gz' (single-file) and 'tar.gz'
//     (gunzip → re-detect → tar.* dispatch)
//   - archive.gzip / archive.gunzip helpers (single-file source ↔ sink)

// Drain a stream into a Uint8Array. Response().arrayBuffer() is the
// portable path — works in Node 18+ and every modern browser.
async function _drain(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Wrap bytes as a one-chunk ReadableStream so they can be pipeThrough'd.
function _bytesToStream(bytes) {
  return new Blob([bytes]).stream();
}

export async function gunzipBytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('gunzipBytes: expected Uint8Array');
  const piped = _bytesToStream(u8).pipeThrough(new DecompressionStream('gzip'));
  return _drain(piped);
}

export async function gzipBytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('gzipBytes: expected Uint8Array');
  const piped = _bytesToStream(u8).pipeThrough(new CompressionStream('gzip'));
  return _drain(piped);
}

// Derive an inner filename for single-file gzip archives — strip '.gz' (or
// '.tgz' → '.tar', which is what most tools do when expanding a .tgz).
// Falls back to 'data' when no name is available.
export function _gzInnerName(sourceName) {
  if (!sourceName) return 'data';
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.tgz'))  return sourceName.slice(0, -4) + '.tar';
  if (lower.endsWith('.tzst')) return sourceName.slice(0, -5) + '.tar';
  if (lower.endsWith('.tbz2')) return sourceName.slice(0, -5) + '.tar';
  if (lower.endsWith('.txz'))  return sourceName.slice(0, -4) + '.tar';
  if (lower.endsWith('.gz'))   return sourceName.slice(0, -3);
  if (lower.endsWith('.zst'))  return sourceName.slice(0, -4);
  if (lower.endsWith('.xz'))   return sourceName.slice(0, -3);
  if (lower.endsWith('.bz2'))  return sourceName.slice(0, -4);
  return sourceName;
}
