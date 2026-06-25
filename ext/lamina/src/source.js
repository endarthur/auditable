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

// ── the "tape": a rewindable read head over a forward-only (compressed) stream ──
//
// A deflate/gzip stream can't random-seek (back-references + no skip), so this
// keeps ONE decompression reader + a cursor + a rolling tail buffer. readRange:
//  · within the buffer        → served free
//  · forward of the cursor    → pull (inflate) ahead until reached
//  · behind the buffer        → REWIND: reopen the stream from 0 and fast-forward
// Sequential / near scrolling is cheap; a far jump inflates proportional to the
// distance (the inherent cost — surfaced as PENDING). All reads are serialized on
// a single queue (one tape, one head). `openStream()` must return a FRESH
// decompressed ReadableStream from offset 0 each call (re-openable = rewindable).
function makeTape(openStream, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  let reader = null;          // current decompression reader (null until first read / after rewind)
  let cursor = 0;             // decompressed bytes pulled so far (next byte the reader yields)
  let bufStart = 0;           // decompressed offset of the buffer's first byte
  let chunks = [];            // contiguous decoded chunks covering [bufStart, cursor)
  let bufLen = 0;             // = cursor - bufStart
  let eof = false;
  let q = Promise.resolve();  // serialization queue

  function rewind() {
    if (reader) { try { reader.cancel(); } catch { /* ignore */ } }
    reader = openStream().getReader();
    cursor = 0; bufStart = 0; chunks = []; bufLen = 0; eof = false;
  }

  async function ensure(end, keepFloor) {
    while (cursor < end && !eof) {
      const { done, value } = await reader.read();
      if (done) { eof = true; break; }
      chunks.push(value); cursor += value.length; bufLen += value.length;
      // Evict whole front chunks that are entirely before keepFloor, while over budget.
      while (bufLen > maxBuffer && chunks.length && bufStart + chunks[0].length <= keepFloor) {
        const c = chunks.shift(); bufStart += c.length; bufLen -= c.length;
      }
    }
  }

  function slice(off, end) {
    const out = new Uint8Array(Math.max(0, end - off));
    let p = bufStart;
    for (const c of chunks) {
      const cs = p, ce = p + c.length;
      const s = Math.max(off, cs), e = Math.min(end, ce);
      if (s < e) out.set(c.subarray(s - cs, e - cs), s - off);
      p = ce;
      if (ce >= end) break;
    }
    return out;
  }

  function read(off, length) {
    const run = async () => {
      if (reader === null || off < bufStart) rewind();    // first read, or a jump behind the buffer → rewind
      const end = off + length;
      await ensure(end, off);                             // keepFloor = off: never evict what we're about to serve
      return slice(off, Math.min(end, cursor));           // clamp to EOF
    };
    const p = q.then(run);
    q = p.catch(() => {});                                // keep the queue alive after an error
    return p;
  }

  return { read };
}

/**
 * Window a forward-only (typically COMPRESSED) byte stream WITHOUT unpacking it to
 * RAM or disk — the third backing between resident and materialized-OPFS. One
 * forward pass builds the block index (in DECOMPRESSED byte-space); reads go
 * through the rewindable tape (see makeTape). `openStream()` returns a fresh
 * decompressed ReadableStream from 0 each call (a .gz = File→DecompressionStream;
 * a zip entry = a re-runnable fflate streaming unzip — supplied by the host).
 * Pass a cached `index` (an `indexOf(source)` value) to SKIP the decompress-scan
 * on reopen — the tape still serves reads through a fresh `openStream`.
 * @param {object} opts  { openStream, index?, kind, delimiter, quote, blockSize?, maxBuffer?, onProgress? }
 * @returns {Promise<source>}  same shape as buildMemorySource (readRange is the tape)
 */
export async function buildStreamSource({ openStream, index, kind = 'delimited', delimiter = ',', quote = '"', blockSize = 4096, maxBuffer, onProgress } = {}) {
  // The index scan reuses scanFileToIndex over a File-like whose .stream() decompresses.
  const idx = index || await scanFileToIndex({ stream: openStream, size: 0 }, { kind, quote: quote.charCodeAt(0), blockSize, onProgress });
  const tape = makeTape(openStream, maxBuffer ? { maxBuffer } : {});
  return {
    kind, delimiter, quote, blockSize,
    blockOffsets: idx.blockOffsets,
    rowCount: idx.rowCount,
    totalBytes: idx.totalBytes,                          // DECOMPRESSED size (from the scan)
    readRange(offset, length) { return tape.read(offset, length); },
  };
}
