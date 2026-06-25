// @gcu/lamina — source: a "where the bytes are" object the ViewSource reads
// through. It carries the block index (from one scan) + a `readRange(off,len)`.
//
// buildMemorySource scans a whole Uint8Array and serves ranges by subarray — for
// tests + small files. The STREAMING source (a @gcu/proc worker scans the File
// chunk-by-chunk to build the index, then `vfs.readRange` serves windows) is a
// separate builder with the SAME shape — the ViewSource doesn't care which.

import { scanRecords } from './scan.js';

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
