// @gcu/lamina — source: a "where the bytes are" object the ViewSource reads
// through. It carries the block index (from one scan) + a `readRange(off,len)`.
//
// buildMemorySource scans a whole Uint8Array and serves ranges by subarray — for
// tests + small files. The STREAMING source (a @gcu/proc worker scans the File
// chunk-by-chunk to build the index, then `vfs.readRange` serves windows) is a
// separate builder with the SAME shape — the ViewSource doesn't care which.

import { scanRecords, scanFileToIndex } from './scan.js';

/**
 * @param {Uint8Array} bytes  the whole file (small/medium)
 * @param {object} opts  { kind?, delimiter?, quote?, blockSize? } — quote/delimiter are CHARS
 * @returns a source: { kind, delimiter, quote, blockSize, blockOffsets, rowCount, totalBytes, readRange }
 */
export function buildMemorySource(bytes, { kind = 'delimited', delimiter = ',', quote = '"', blockSize = 4096 } = {}) {
  const idx = scanRecords(bytes, { kind, quote: quote.charCodeAt(0), blockSize });
  return {
    kind, delimiter, quote, blockSize,
    blockOffsets: idx.blockOffsets,
    rowCount: idx.rowCount,
    totalBytes: idx.totalBytes,
    async readRange(offset, length) { return bytes.subarray(offset, offset + length); },
  };
}

/**
 * Stream a File/Blob to build the block index — NEVER resident (chunks are
 * scanned then discarded; only the ~1 MB index is kept). Windows are served by
 * File.slice (lazy — reads only the slice). This is the "actually huge" source:
 * the File comes from a drop / FSAA picker / `vfs.toFile(path)`.
 *
 * The index scan is dependency-injected via `scan(file, scanOpts) → index` so the
 * heavy pass can run OFF the main thread (a @gcu/proc worker imports this bundle
 * and calls scanFileToIndex — see the harness wiring) while @gcu/lamina stays
 * zero-dependency on @gcu/proc. Default is the inline scan (with progress) — used
 * by tests, small files, and the file:// fallback where cross-blob workers are
 * blocked. `readRange` ALWAYS stays main-thread (File.slice — can't return a
 * subarray closure across a worker boundary).
 * @param {File|Blob} file
 * @param {object} opts  { kind, delimiter, quote, blockSize?, onProgress?(read,total), scan? }
 * @returns {Promise<source>}  same shape as buildMemorySource
 */
export async function buildFileSource(file, { kind = 'delimited', delimiter = ',', quote = '"', blockSize = 4096, onProgress, scan } = {}) {
  const scanOpts = { kind, quote: quote.charCodeAt(0), blockSize };
  const idx = scan
    ? await scan(file, scanOpts)                          // off-thread (worker): no onProgress (functions don't clone)
    : await scanFileToIndex(file, { ...scanOpts, onProgress });
  return fileSourceFrom(file, idx, { kind, delimiter, quote, blockSize });
}

// Build the source object (block index + a lazy File.slice readRange) — shared by
// buildFileSource (fresh scan) and buildSourceFromIndex (cached). readRange always
// stays main-thread: it captures the live File, which can't cross a realm.
function fileSourceFrom(file, idx, { kind, delimiter, quote, blockSize }) {
  return {
    kind, delimiter, quote, blockSize,
    blockOffsets: idx.blockOffsets,
    rowCount: idx.rowCount,
    totalBytes: idx.totalBytes,
    async readRange(offset, length) { return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()); },
  };
}

/**
 * The serializable part of a source — everything but the readRange closure. This
 * is what a host persists (an IDB/OPFS/VFS sidecar) to skip the scan on reopen.
 * blockOffsets is a Float64Array (structured-clone-friendly).
 */
export function indexOf(source) {
  const { kind, delimiter, quote, blockSize, blockOffsets, rowCount, totalBytes } = source;
  return { kind, delimiter, quote, blockSize, blockOffsets, rowCount, totalBytes };
}

/**
 * Rebuild a source from a previously-computed (cached) index — NO scan. The File
 * supplies the bytes via the same lazy readRange; the index supplies the offsets.
 * @param {File|Blob} file
 * @param {object} index  an `indexOf(source)` value
 */
export function buildSourceFromIndex(file, index) {
  return fileSourceFrom(file, index, index);
}

/**
 * A stable cache key for a File: name + size + mtime. Different content with the
 * same triple is essentially never a real collision for a viewer; if the file
 * changes, lastModified changes → the key misses → a fresh scan. So all hosts key
 * the index cache identically.
 */
export function fileKey(file) {
  return [file.name, file.size, file.lastModified || 0].join(':');
}
