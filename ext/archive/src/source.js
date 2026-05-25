// Source adapter — normalize whatever the caller hands us into a thin
// `{ bytes(): Promise<Uint8Array>, name: string|null }` shape that the
// per-format handlers can consume without caring where the bytes came from.
//
// Accepted source shapes:
//   - Uint8Array | ArrayBuffer                    in-memory bytes (sync)
//   - Blob                                        browser Blob (async .arrayBuffer)
//   - { vfs, path }                               VFS adapter (uses vfs.readFile)
//   - { fetch: '<url>' [, fetchFn] }              lazy fetch from URL
//   - ReadableStream<Uint8Array>                  drained on first .bytes() call
//
// `name` is preserved when known — used as an extension hint when magic-byte
// detection is ambiguous.

const basename = (p) => String(p).split(/[\\/]/).pop();

export function normalizeSource(input) {
  if (!input) throw new TypeError('source: required');

  // Uint8Array / ArrayBuffer / Buffer-like — wrap as-is.
  if (input instanceof Uint8Array) {
    const b = input;
    return { bytes: async () => b, name: null };
  }
  if (input instanceof ArrayBuffer) {
    const b = new Uint8Array(input);
    return { bytes: async () => b, name: null };
  }

  // Blob — has .arrayBuffer().
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return {
      bytes: async () => new Uint8Array(await input.arrayBuffer()),
      name: input.name || null,
    };
  }

  // ReadableStream — drain into a single Uint8Array on first call. (For
  // larger archives the format handlers can opt into the streaming `Unzip`
  // path via archive.stream(); this adapter is the "small archive, eager"
  // path.)
  if (typeof ReadableStream !== 'undefined' && input instanceof ReadableStream) {
    return {
      bytes: async () => new Uint8Array(await new Response(input).arrayBuffer()),
      name: null,
    };
  }

  // Object descriptors.
  if (typeof input === 'object') {
    // { vfs, path }
    if (input.vfs && typeof input.path === 'string') {
      return {
        bytes: async () => {
          // Request 'bytes' encoding explicitly — without it, the
          // MemoryBackend returns TextDecoder().decode(bytes), which
          // substitutes U+FFFD for any byte outside a valid UTF-8 sequence
          // and corrupts binary. CommentBackend / IDBBackend behave
          // similarly. Backends that don't recognize 'bytes' fall through
          // to the same code path; the resulting string is encoded back to
          // utf8, which round-trips for text but not for binary — same
          // behaviour as before for those backends.
          const r = input.vfs.readFile(input.path, 'bytes');
          const v = (r && typeof r.then === 'function') ? await r : r;
          if (v instanceof Uint8Array) return v;
          if (typeof v === 'string') return new TextEncoder().encode(v);
          if (v && v.buffer) return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
          throw new TypeError('vfs.readFile returned unsupported shape');
        },
        name: basename(input.path),
      };
    }
    // { fetch: url, fetchFn? }
    if (typeof input.fetch === 'string') {
      const fetchFn = input.fetchFn || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
      if (!fetchFn) throw new TypeError('source: { fetch } requires a fetch implementation in the environment');
      return {
        bytes: async () => {
          const r = await fetchFn(input.fetch);
          if (!r || !r.ok) throw new Error(`fetch ${input.fetch}: HTTP ${r ? r.status : 'no-response'}`);
          return new Uint8Array(await r.arrayBuffer());
        },
        name: basename(input.fetch.split('?')[0]),
      };
    }
  }

  throw new TypeError('source: unrecognized shape — expected Uint8Array | ArrayBuffer | Blob | ReadableStream | { vfs, path } | { fetch }');
}
