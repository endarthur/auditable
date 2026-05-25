// Format detection by magic bytes, with an extension-based fallback for
// callers who only have a filename (no buffer access). The byte path is
// authoritative — extension is best-effort.
//
// Magic-byte references (per the archive spec §3.3):
//   ZIP     PK (0x50 0x4B) at offset 0
//   tar     "ustar" (0x75 0x73 0x74 0x61 0x72) at offset 257
//   gzip    1f 8b at offset 0
//   zstd    28 b5 2f fd at offset 0
//   xz      fd 37 7a 58 5a 00 at offset 0
//   bz2     BZh (0x42 0x5a 0x68) at offset 0

const FORMATS = ['zip', 'tar', 'tar.gz', 'tar.zst', 'tar.xz', 'tar.bz2',
                 'gz', 'zst', 'xz', 'bz2'];

// Probe `bytes` (Uint8Array | ArrayBuffer | Buffer-like) and return one of
// 'zip' | 'tar' | 'gz' | 'zst' | 'xz' | 'bz2' | null. Tar wins over gz/zst/xz/bz2
// only when its ustar header is intact at offset 257; otherwise we report the
// outer container (`gz` for a gzipped tar — the caller decompresses then re-detects).
export function detectFormat(bytes) {
  if (!bytes) return null;
  const u = bytes instanceof Uint8Array ? bytes :
            (bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength) :
             new Uint8Array(bytes));
  if (u.length < 2) return null;

  // ZIP — 'PK' at offset 0. (Empty ZIPs start with PK\x05\x06, regular ones with PK\x03\x04.)
  if (u[0] === 0x50 && u[1] === 0x4B) return 'zip';

  // gzip — 1f 8b. Could be a gzip-of-tar, but the caller decompresses first.
  if (u[0] === 0x1f && u[1] === 0x8b) return 'gz';

  // zstd — 28 b5 2f fd (little-endian magic, RFC 8478 §3.1.1.1.1).
  if (u.length >= 4 && u[0] === 0x28 && u[1] === 0xb5 && u[2] === 0x2f && u[3] === 0xfd) return 'zst';

  // xz — fd 37 7a 58 5a 00.
  if (u.length >= 6 && u[0] === 0xfd && u[1] === 0x37 && u[2] === 0x7a
      && u[3] === 0x58 && u[4] === 0x5a && u[5] === 0x00) return 'xz';

  // bz2 — 'BZh'.
  if (u.length >= 3 && u[0] === 0x42 && u[1] === 0x5a && u[2] === 0x68) return 'bz2';

  // tar — 'ustar' at offset 257 (POSIX ustar header). Tar's magic is far
  // into the file because tar is offset-based; we check it last.
  if (u.length >= 263
      && u[257] === 0x75 && u[258] === 0x73 && u[259] === 0x74
      && u[260] === 0x61 && u[261] === 0x72) return 'tar';

  return null;
}

// Map a filename extension to a format. Best-effort; the magic-byte sniff is
// authoritative when bytes are available. The compound forms ('.tar.gz') are
// recognized too so callers can route to a tar-on-top-of-gz pipeline directly.
export function magicForFormat(filename) {
  if (typeof filename !== 'string') return null;
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.gz')  || lower.endsWith('.tgz'))  return 'tar.gz';
  if (lower.endsWith('.tar.zst') || lower.endsWith('.tzst')) return 'tar.zst';
  if (lower.endsWith('.tar.xz')  || lower.endsWith('.txz'))  return 'tar.xz';
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return 'tar.bz2';
  if (lower.endsWith('.zip'))                                return 'zip';
  if (lower.endsWith('.tar'))                                return 'tar';
  if (lower.endsWith('.gz'))                                 return 'gz';
  if (lower.endsWith('.zst'))                                return 'zst';
  if (lower.endsWith('.xz'))                                 return 'xz';
  if (lower.endsWith('.bz2'))                                return 'bz2';
  return null;
}

export { FORMATS };
