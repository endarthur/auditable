// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/lamina — Open any file — even a multi-gigabyte one — and scroll, filter, and sort it. A windowed, read-only viewer: a coarse record-offset block index (~1 MB at 500M rows) + @gcu/loom. delimited → grid, text → lines, binary → hex; reads inside zip/tar/gz/zst/xz/bz2, and windows huge compressed entries without unpacking. The finest stratum: thin slices (windows) of a file.

// ── src/scan.js ──

// @gcu/lamina — scan: build a coarse BLOCK index of record byte-offsets in a
// single forward pass, and split a byte range back into records at read time.
//
// The index is ONE offset per K records (the block size), not per record — so it
// stays ~1 MB even at 500M rows (decagigabyte-safe). `window(from,count)` reads
// the block(s) covering the range and forward-splits within them (splitRecords).
//
// The scanner is CHUNK-FED so it streams to any size: `push(chunk)` repeatedly
// (a @gcu/proc worker over File.stream()), then `end()`. The whole-file path is
// just one push — used by the tests. Pure, zero-dep, node-testable.
//
// Record boundary: a record ends at a newline (\n). In delimited (quote-aware)
// mode a \n INSIDE a quoted field is not a boundary — quotes toggle an in-quote
// state (a doubled "" escape toggles twice → no net change, which is correct for
// boundary-finding). Column splitting is the provider's job (parseFields), not
// the scanner's — the index records only RECORD starts.

const NL = 10;   // \n
const CR = 13;   // \r
const DQUOTE = 34; // "

/**
 * A chunk-fed record-boundary scanner that emits a coarse block index.
 * @param {object} opts
 * @param {'delimited'|'text'} [opts.kind='delimited']  quote-aware vs plain newline
 * @param {number} [opts.quote=34]       quote byte (delimited only)
 * @param {number} [opts.blockSize=4096] records per block-index entry (K). K=1 = per-record (tests).
 */
function createRecordScanner({ kind = 'delimited', quote = DQUOTE, blockSize = 4096 } = {}) {
  const quoteAware = kind === 'delimited';
  const blockOffsets = [0];   // byte offset of record 0 (block 0)
  let pos = 0;                // global byte offset of the next unconsumed byte
  let recordStart = 0;        // byte offset where the current record began
  let recordCount = 0;        // records completed (boundaries seen)
  let inQuote = false;        // delimited: inside a quoted field (persists across chunks)

  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (quoteAware && b === quote) { inQuote = !inQuote; continue; }
        if (b === NL && !inQuote) {
          recordCount++;
          recordStart = pos + i + 1;                 // next record starts after the \n
          if (recordCount % blockSize === 0) blockOffsets.push(recordStart);
        }
      }
      pos += chunk.length;
    },
    // Finish: a trailing record with no final newline still counts.
    end() {
      if (pos > recordStart) recordCount++;          // final unterminated record
      return {
        kind, quote, blockSize,
        blockOffsets: Float64Array.from(blockOffsets),
        rowCount: recordCount,
        totalBytes: pos,
      };
    },
  };
}

/**
 * Parse a numeric field honouring the decimal separator. `decimal: ','` (the
 * European/Brazilian convention, usually paired with ';' delimiters) strips
 * '.' thousands separators and treats ',' as the decimal point. Default '.' is
 * a plain Number(). Used by detect / sort / stats / filter so a comma-decimal
 * file reads as numeric everywhere.
 */
function parseNum(s, decimal) {
  return decimal === ',' ? Number(String(s).replace(/\./g, '').replace(',', '.')) : Number(s);
}

/** Convenience: scan a whole Uint8Array in one shot (tests / small files). */
function scanRecords(bytes, opts) {
  const s = createRecordScanner(opts);
  s.push(bytes);
  return s.end();
}

/**
 * Stream a File/Blob through the scanner and return the block index — NEVER
 * resident (chunks scanned then dropped). Worker-callable (a @gcu/proc
 * module-call imports this bundle and invokes it; File crosses by structured
 * clone, the ~1 MB index comes back) AND the main-thread fallback. Self-contained
 * — references only this module, so it's safe across the realm boundary.
 * `onProgress` is undefined in a worker (functions don't clone); only the inline
 * caller passes it.
 * @param {File|Blob} file
 * @param {object} opts  { kind, quote (BYTE), blockSize, onProgress?(read,total) }
 * @returns {Promise<{blockOffsets,rowCount,totalBytes,kind,quote,blockSize}>}
 */
async function scanFileToIndex(file, { kind = 'delimited', quote = DQUOTE, blockSize = 4096, onProgress } = {}) {
  const scanner = createRecordScanner({ kind, quote, blockSize });
  const reader = file.stream().getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    scanner.push(value);                 // a Uint8Array chunk — scanned, then dropped
    read += value.length;
    if (onProgress) onProgress(read, file.size);
  }
  return scanner.end();
}

/**
 * Split a byte range into record POSITIONS `{ start, end }` (relative to `bytes`,
 * \n excluded, trailing \r trimmed) — same boundary rule as the scanner. The
 * filter/sort scans use this to record each matching row's byte offset + length,
 * so the result view can read a single row directly (no coarse-block read).
 * @returns {{start:number,end:number}[]}
 */
function splitRecordsPos(bytes, { kind = 'delimited', quote = DQUOTE } = {}) {
  const quoteAware = kind === 'delimited';
  const out = [];
  let start = 0, inQuote = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (quoteAware && b === quote) { inQuote = !inQuote; continue; }
    if (b === NL && !inQuote) {
      let end = i;
      if (end > start && bytes[end - 1] === CR) end--;   // trim CRLF's \r
      out.push({ start, end });
      start = i + 1;
    }
  }
  if (start < bytes.length) {                              // trailing record, no \n
    let end = bytes.length;
    if (end > start && bytes[end - 1] === CR) end--;
    out.push({ start, end });
  }
  return out;
}

/**
 * Split a byte range into record byte-slices (the windowed read's path).
 * @returns {Uint8Array[]} record byte slices, in order
 */
function splitRecords(bytes, opts) {
  return splitRecordsPos(bytes, opts).map((p) => bytes.subarray(p.start, p.end));
}

/**
 * Split one record's bytes into decoded string fields (delimited mode). Honours
 * quoting + the doubled-"" escape. Plain (unquoted) fields are taken verbatim.
 * @returns {string[]}
 */
// Cached TextDecoders by label — structure (delimiter/quote/newline) is ASCII and so
// encoding-invariant; only field CONTENT decodes per the chosen encoding. Default utf-8.
const _decoders = {};
function decoderFor(encoding) { const k = encoding || 'utf-8'; return _decoders[k] || (_decoders[k] = new TextDecoder(k)); }

function parseFields(recordBytes, { delimiter = ',', quote = '"', encoding } = {}) {
  const s = decoderFor(encoding).decode(recordBytes);
  if (delimiter === ' ') {                          // whitespace mode: split on runs (GSLIB / scientific dumps)
    const t = s.trim();
    return t === '' ? [''] : t.split(/\s+/);
  }
  const fields = [];
  let i = 0, field = '', inQ = false;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === quote) {
        if (s[i + 1] === quote) { field += quote; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === quote) { inQ = true; i++; continue; }
    if (c === delimiter) { fields.push(field); field = ''; i++; continue; }
    field += c; i++;
  }
  fields.push(field);
  return fields;
}

// ── src/cursor.js ──

// @gcu/lamina — record cursor: the backing-AGNOSTIC iteration that the scans
// (filter / sort / stats) and result views run on. A CSV/text block source gets a
// cursor via installRecordCursor (byte locator); any other backing — e.g. a binary
// table like Datamine .dm — implements the SAME two methods directly, and then the
// whole pipeline (filter / sort / stats / result-view) works on it unchanged.
//
//   eachRecord({ dataStart, rows, onProgress }, visit) -> Promise
//       Forward-iterate, calling visit(disp, fields, loc0, loc1) for every record
//       with display row `disp` >= 0, in order. `rows` (ascending display rows)
//       restricts to a subset (the filter→sort / filter→stats composition); pass
//       null for all. `fields` is the parsed/decoded value array. (loc0, loc1) is
//       the record's LOCATOR — opaque to the scans; they only store and replay it.
//
//   readByLoc(loc0, loc1) -> Promise<fields[]>
//       Re-read one record by its locator, for a result view's scattered per-row
//       reads (no base-block thrash).
//
// The locator lets a result set stay compact (two Float64Arrays) and read each
// matching row directly. For CSV it's (byte offset, byte length); for .dm it's the
// record index. The scans never interpret it — that's the whole point.


/**
 * Attach `eachRecord` + `readByLoc` to a CSV/text block source (source.js shape:
 * blockOffsets + readRange + kind/delimiter/quote/blockSize/rowCount/totalBytes).
 * Locator = (byte offset, byte length) — exactly what the byte-offset result view
 * reads a scattered row from. Returns the same source (mutated), for chaining.
 */
function installRecordCursor(source) {
  const K = source.blockSize;
  const qByte = (source.quote || '"').charCodeAt(0);
  const delimited = source.kind === 'delimited';
  const fieldsOf = (bytes) => (delimited ? parseFields(bytes, { delimiter: source.delimiter, quote: source.quote, encoding: source.encoding }) : [decoderFor(source.encoding).decode(bytes)]);

  source.eachRecord = async ({ dataStart = 0, rows = null, onProgress, limit = Infinity } = {}, visit) => {
    const nBlocks = source.blockOffsets.length;
    let sp = 0, seen = 0;                                  // sp = cursor into `rows`; seen = visited count (for `limit`)
    for (let b = 0; b < nBlocks; b++) {
      const s = source.blockOffsets[b];
      const e = b + 1 < nBlocks ? source.blockOffsets[b + 1] : source.totalBytes;
      const bytes = await source.readRange(s, e - s);
      const pos = splitRecordsPos(bytes, { kind: source.kind, quote: qByte });
      for (let i = 0; i < pos.length; i++) {
        const srcRow = b * K + i;
        if (srcRow >= source.rowCount) break;
        const disp = srcRow - dataStart;
        if (disp < 0) continue;                            // header / preamble
        if (rows) {                                        // restrict to the subset (ascending)
          while (sp < rows.length && rows[sp] < disp) sp++;
          if (sp >= rows.length || rows[sp] !== disp) continue;
          sp++;
        }
        visit(disp, fieldsOf(bytes.subarray(pos[i].start, pos[i].end)), s + pos[i].start, pos[i].end - pos[i].start);
        if (++seen >= limit) return;                       // sample cap (gutter stats)
      }
      if (onProgress) onProgress(b + 1, nBlocks);
      if (rows && sp >= rows.length) break;                // subset exhausted → stop early
    }
  };

  source.readByLoc = async (off, len) => fieldsOf(await source.readRange(off, len));
  return source;
}

// ── src/source.js ──

// @gcu/lamina — source: a "where the bytes are" object the ViewSource reads
// through. It carries the block index (from one scan) + a `readRange(off,len)`.
//
// buildMemorySource scans a whole Uint8Array and serves ranges by subarray — for
// tests + small files. The STREAMING source (a @gcu/proc worker scans the File
// chunk-by-chunk to build the index, then `vfs.readRange` serves windows) is a
// separate builder with the SAME shape — the ViewSource doesn't care which.


/**
 * @param {Uint8Array} bytes  the whole file (small/medium)
 * @param {object} opts  { kind?, delimiter?, quote?, blockSize? } — quote/delimiter are CHARS
 * @returns a source: { kind, delimiter, quote, blockSize, blockOffsets, rowCount, totalBytes, readRange }
 */
function buildMemorySource(bytes, { kind = 'delimited', delimiter = ',', quote = '"', blockSize = 4096, encoding } = {}) {
  const idx = scanRecords(bytes, { kind, quote: quote.charCodeAt(0), blockSize });
  return installRecordCursor({
    kind, delimiter, quote, blockSize, encoding,
    blockOffsets: idx.blockOffsets,
    rowCount: idx.rowCount,
    totalBytes: idx.totalBytes,
    async readRange(offset, length) { return bytes.subarray(offset, offset + length); },
  });
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
async function buildFileSource(file, { kind = 'delimited', delimiter = ',', quote = '"', blockSize = 4096, encoding, onProgress, scan } = {}) {
  const scanOpts = { kind, quote: quote.charCodeAt(0), blockSize };
  const idx = scan
    ? await scan(file, scanOpts)                          // off-thread (worker): no onProgress (functions don't clone)
    : await scanFileToIndex(file, { ...scanOpts, onProgress });
  return fileSourceFrom(file, idx, { kind, delimiter, quote, blockSize, encoding });
}

// Build the source object (block index + a lazy File.slice readRange) — shared by
// buildFileSource (fresh scan) and buildSourceFromIndex (cached). readRange always
// stays main-thread: it captures the live File, which can't cross a realm.
function fileSourceFrom(file, idx, { kind, delimiter, quote, blockSize, encoding }) {
  return installRecordCursor({
    kind, delimiter, quote, blockSize, encoding,
    blockOffsets: idx.blockOffsets,
    rowCount: idx.rowCount,
    totalBytes: idx.totalBytes,
    async readRange(offset, length) { return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()); },
  });
}

/**
 * The serializable part of a source — everything but the readRange closure. This
 * is what a host persists (an IDB/OPFS/VFS sidecar) to skip the scan on reopen.
 * blockOffsets is a Float64Array (structured-clone-friendly).
 */
function indexOf(source) {
  const { kind, delimiter, quote, blockSize, blockOffsets, rowCount, totalBytes } = source;
  return { kind, delimiter, quote, blockSize, blockOffsets, rowCount, totalBytes };
}

/**
 * Rebuild a source from a previously-computed (cached) index — NO scan. The File
 * supplies the bytes via the same lazy readRange; the index supplies the offsets.
 * @param {File|Blob} file
 * @param {object} index  an `indexOf(source)` value
 */
function buildSourceFromIndex(file, index) {
  return fileSourceFrom(file, index, index);
}

/**
 * A stable cache key for a File: name + size + mtime. Different content with the
 * same triple is essentially never a real collision for a viewer; if the file
 * changes, lastModified changes → the key misses → a fresh scan. So all hosts key
 * the index cache identically.
 */
function fileKey(file) {
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
async function buildStreamSource({ openStream, index, kind = 'delimited', delimiter = ',', quote = '"', blockSize = 4096, maxBuffer, onProgress } = {}) {
  // The index scan reuses scanFileToIndex over a File-like whose .stream() decompresses.
  const idx = index || await scanFileToIndex({ stream: openStream, size: 0 }, { kind, quote: quote.charCodeAt(0), blockSize, onProgress });
  const tape = makeTape(openStream, maxBuffer ? { maxBuffer } : {});
  return installRecordCursor({
    kind, delimiter, quote, blockSize,
    blockOffsets: idx.blockOffsets,
    rowCount: idx.rowCount,
    totalBytes: idx.totalBytes,                          // DECOMPRESSED size (from the scan)
    readRange(offset, length) { return tape.read(offset, length); },
  });
}

// ── src/viewsource.js ──

// @gcu/lamina — viewsource: the read-only windowed data layer over a source.
//
// `rowAt(r)` is SYNC: the parsed fields if the row's block is cached, the LOADING
// sentinel if a `readRange` was kicked (the loom provider maps it → loom's
// PENDING and repaints on `onReady`), or null if out of range. Blocks are
// fetched + decoded + split on demand and held in a small LRU — only a few
// screenfuls are ever resident, never the file. This is the read-only
// indexed-original ViewSource (strata-windowing §3b); windowed strata reuses it.


const LOADING = Symbol('lamina.loading');   // a row whose block isn't loaded yet

/**
 * @param {object} source  see source.js (block index + readRange)
 * @param {object} opts  { schema?: [{name,type}], cacheBlocks?: number }
 */
function createRecordViewSource(source, { schema = null, cacheBlocks = 16, dataStart = 0 } = {}) {
  // dataStart = source records to skip (e.g. a header row). Display row r → source
  // record r + dataStart; the schema (from detect) supplies the header, not a row.
  const K = source.blockSize;
  const qByte = (source.quote || '"').charCodeAt(0);
  const cache = new Map();        // blockIndex → fields[][]  (Map = insertion-order LRU)
  const inflight = new Map();     // blockIndex → Promise
  const readyCbs = [];
  const cols = schema ? schema.length : 1;

  const notify = () => { for (const cb of readyCbs) { try { cb(); } catch (e) { console.error('[lamina] onReady threw', e); } } };

  function parseBlock(bytes) {
    const recs = splitRecords(bytes, { kind: source.kind, quote: qByte });
    return source.kind === 'delimited'
      ? recs.map((rb) => parseFields(rb, { delimiter: source.delimiter, quote: source.quote, encoding: source.encoding }))
      : recs.map((rb) => [decoderFor(source.encoding).decode(rb)]);
  }

  function loadBlock(b) {
    if (cache.has(b)) return Promise.resolve();
    if (inflight.has(b)) return inflight.get(b);
    const s = source.blockOffsets[b];
    const e = b + 1 < source.blockOffsets.length ? source.blockOffsets[b + 1] : source.totalBytes;
    const p = Promise.resolve(source.readRange(s, e - s)).then((bytes) => {
      cache.set(b, parseBlock(bytes));
      while (cache.size > cacheBlocks) cache.delete(cache.keys().next().value);  // evict oldest
      inflight.delete(b);
      notify();
    }, (err) => { inflight.delete(b); console.error('[lamina] loadBlock failed', err); });
    inflight.set(b, p);
    return p;
  }

  return {
    kind: source.kind,
    cols,
    schema,
    rowCount() { return Math.max(0, source.rowCount - dataStart); },

    // Sync: fields[] (cached) | LOADING (load kicked) | null (out of range).
    rowAt(r) {
      const u = r + dataStart;                               // display row → source record
      if (r < 0 || u >= source.rowCount) return null;
      const b = Math.floor(u / K);
      if (cache.has(b)) {
        const rows = cache.get(b);
        cache.delete(b); cache.set(b, rows);                 // LRU touch
        return rows[u - b * K] || null;
      }
      loadBlock(b);
      return LOADING;
    },

    // Await a row's block (prefetch / tests).
    async ensureRow(r) { const u = r + dataStart; if (r >= 0 && u < source.rowCount) await loadBlock(Math.floor(u / K)); return this.rowAt(r); },

    header(c) { return { label: schema && schema[c] ? schema[c].name : `col ${c + 1}`, type: this.colType(c) }; },
    colType(c) { return (schema && schema[c] && schema[c].type) || 'string'; },

    onReady(cb) { readyCbs.push(cb); return () => { const i = readyCbs.indexOf(cb); if (i >= 0) readyCbs.splice(i, 1); }; },
  };
}

// ── src/calc.js ──

// @gcu/lamina — calculated columns: read-time derived columns appended to a record
// source. NEVER materialized, never written — exactly the strata derived-column
// precedent, but over lamina's windowed/never-resident scan. Two decorators mirror
// the two consumers: the CURSOR (filter/sort/stats + result views) and the BROWSE
// VIEW (the unfiltered grid).
//
// `calcs`: [{ name, type, fn }] where `fn(fieldsSoFar) => value` is precompiled by
// the caller (e.g. @gcu/expr's compile against [...baseColumns, ...calcNames]) — so
// @gcu/lamina stays expression-engine-agnostic. The fn indexes into the FULL
// extended field array, so a calc may reference base columns AND earlier calc
// columns; they're computed left-to-right (a forward reference reads undefined →
// the engine's blank). `baseCount` = the number of base columns.


// Append RAW calc values (numbers stay numbers) — for the scan path, where
// filter/sort/stats want exact values.
function extendRaw(base, calcs) {
  const out = base.slice();
  for (const c of calcs) out.push(c.fn(out));
  return out;
}
// Append STRINGIFIED calc values — for the display path (the loom provider writes
// row[c] straight into the cell text, like every other lamina field).
function extendDisp(base, calcs) {
  const out = base.slice();
  for (const c of calcs) { const v = c.fn(out); out.push(v == null ? '' : String(v)); }
  return out;
}

// Decorate a record cursor (cursor.js / a backing adapter): eachRecord yields the
// extended raw fields; readByLoc yields the extended display fields. Everything
// else passes through. Empty calcs → the source unchanged.
function withCalcCursor(source, baseCount, calcs) {
  if (!calcs || !calcs.length) return source;
  return {
    ...source,
    eachRecord: (opts, visit) => source.eachRecord(opts, (disp, fields, l0, l1) => visit(disp, extendRaw(fields, calcs), l0, l1)),
    readByLoc: async (l0, l1) => extendDisp(await source.readByLoc(l0, l1), calcs),
  };
}

// Decorate a browse ViewSource (createRecordViewSource / createDmViewSource):
// rowAt appends the calc fields (display), cols/header/colType extend. LOADING /
// null pass through untouched so windowing still works.
function withCalcView(vs, baseCount, calcs) {
  if (!calcs || !calcs.length) return vs;
  const cols = baseCount + calcs.length;
  const dec = {
    kind: vs.kind, cols, schema: vs.schema,
    rowCount() { return vs.rowCount(); },
    rowAt(r) { const row = vs.rowAt(r); return (row === LOADING || row == null) ? row : extendDisp(row, calcs); },
    async ensureRow(r) { await vs.ensureRow(r); return dec.rowAt(r); },
    header(c) { return c < baseCount ? vs.header(c) : { label: calcs[c - baseCount].name, type: calcs[c - baseCount].type || 'string', calc: true }; },
    colType(c) { return c < baseCount ? vs.colType(c) : (calcs[c - baseCount].type || 'string'); },
    onReady(cb) { return vs.onReady(cb); },
  };
  if (vs.rowHeaderAt) dec.rowHeaderAt = (r) => vs.rowHeaderAt(r);   // a result view reports the original row #
  return dec;
}

// ── src/filter.js ──

// @gcu/lamina — filter: a forward scan that records the matching rows, and a
// RESULT VIEW that reads each matching row directly by byte offset.
//
// Why per-row, not a remap onto the base view: a selective filter scatters its
// matches across the file, so a screenful of results would touch ~one base block
// (4096 rows) PER VISIBLE ROW — blowing the base LRU and thrashing (load→evict→
// reload forever). Recording each match's (offset, length) lets the result view
// read exactly the visible rows — small reads, a generous row LRU, no thrash.
//
// Decagigabyte note: the result is 3 × Float64 per matching row (offset, length,
// original row #), so it tracks SELECTIVITY not file size; capped (then "refine
// the filter") rather than OOM.


const CMP = {
  '==': (a, b) => a === b, '!=': (a, b) => a !== b,
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
};

/**
 * Compile a filter string into a predicate over a parsed field array. Grammar:
 * one or more `col OP value` terms joined by `&&`. OP: == != > >= < <= ~ !~.
 * Numeric compare when the value parses as a number (else string). Throws on a
 * bad term / unknown column.
 * @returns {(fields:string[])=>boolean | null}  null for an empty filter
 */
function parseFilter(str, columns, decimal = '.') {
  const names = (columns || []).map((c) => (typeof c === 'string' ? c : c.name));
  const lower = names.map((n) => n.toLowerCase());
  const terms = String(str || '').split('&&').map((s) => s.trim()).filter(Boolean);
  if (!terms.length) return null;
  const fns = terms.map((t) => compileTerm(t, names, lower, decimal));
  return (fields) => { for (const f of fns) if (!f(fields)) return false; return true; };
}

function colIndex(name, names, lower) {
  let i = names.indexOf(name);
  if (i < 0) i = lower.indexOf(name.toLowerCase());
  if (i < 0) throw new Error(`unknown column: "${name}"`);
  return i;
}

function unquote(v) {
  v = v.trim();
  return (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) ? v.slice(1, -1) : v;
}

function compileTerm(term, names, lower, decimal) {
  // `col in a, b, c` — set membership (the natural OR for multiple categorical values)
  const im = term.match(/^(.+?)\s+in\s+(.+)$/i);
  if (im) {
    const i = colIndex(im[1].trim(), names, lower);
    const set = new Set(im[2].split(',').map(unquote).filter((s) => s !== ''));
    return (f) => set.has(String(f[i] ?? ''));
  }
  const m = term.match(/^(.+?)\s*(!~|~|>=|<=|==|!=|>|<)\s*(.*)$/);
  if (!m) throw new Error(`bad filter term: "${term}"`);
  const i = colIndex(m[1].trim(), names, lower);
  const op = m[2];
  const val = unquote(m[3]);
  if (op === '~') { const v = val.toLowerCase(); return (f) => String(f[i] ?? '').toLowerCase().includes(v); }
  if (op === '!~') { const v = val.toLowerCase(); return (f) => !String(f[i] ?? '').toLowerCase().includes(v); }
  // The expression's literal stays dot-decimal (Number); the cell value parses
  // by the file's decimal separator (so a comma-decimal file compares correctly).
  const num = Number(val);
  const cmp = CMP[op];
  if (val !== '' && !Number.isNaN(num)) return (f) => { const x = parseNum(f[i], decimal); return !Number.isNaN(x) && cmp(x, num); };
  return (f) => cmp(String(f[i] ?? ''), val);
}

// A growable Float64Array (the result columns: offset / length / row#).
function grower() {
  let buf = new Float64Array(1024), n = 0;
  return {
    push(v) { if (n === buf.length) { const a = new Float64Array(buf.length * 2); a.set(buf); buf = a; } buf[n++] = v; },
    get n() { return n; },
    done() { return buf.slice(0, n); },
  };
}

/**
 * Forward-scan a source applying a predicate; return the matching rows as
 * `{ offsets, lengths, nums }` (Float64Arrays — the record LOCATOR loc0/loc1 and
 * the original DISPLAY row #). Iteration is delegated to source.eachRecord, so this
 * works on any backing (CSV byte-blocks, a windowed .dm, …) unchanged.
 * @param {object} opts  { predicate, dataStart?, onProgress?, max? }
 */
async function scanFilter(source, { predicate, dataStart = 0, onProgress, max = 16 * 1024 * 1024 } = {}) {
  const offsets = grower(), lengths = grower(), nums = grower();
  await source.eachRecord({ dataStart, onProgress }, (disp, fields, loc0, loc1) => {
    if (predicate(fields)) {
      offsets.push(loc0); lengths.push(loc1); nums.push(disp);
      if (offsets.n > max) throw new Error('too many matches — refine the filter');
    }
  });
  return { offsets: offsets.done(), lengths: lengths.done(), nums: nums.done() };
}

/**
 * A view over a RESULT SET (filter or sort): `{ offsets, lengths, nums }` rows
 * read directly from the source by byte offset, with a generous row LRU — so a
 * scattered result scrolls without touching the base blocks (no thrash). Same
 * provider contract as the windowed view.
 * @param {object} source  block index + readRange (source.js)
 * @param {object} result  { offsets, lengths, nums } (Float64Arrays)
 * @param {Array} schema   column descriptors (for header / colType)
 * @param {object} opts     { cacheRows? }
 */
function createResultView(source, result, schema, { cacheRows = 1024 } = {}) {
  const { offsets, lengths, nums } = result;
  const cache = new Map();          // r → fields[]  (insertion-order LRU)
  const inflight = new Map();
  const readyCbs = [];
  const cols = schema ? schema.length : 1;
  const notify = () => { for (const cb of readyCbs) { try { cb(); } catch (e) { console.error('[lamina] onReady threw', e); } } };

  function loadRow(r) {
    if (cache.has(r)) return Promise.resolve();
    if (inflight.has(r)) return inflight.get(r);
    const p = Promise.resolve(source.readByLoc(offsets[r], lengths[r])).then((fields) => {
      cache.set(r, fields);
      while (cache.size > cacheRows) cache.delete(cache.keys().next().value);
      inflight.delete(r); notify();
    }, (err) => { inflight.delete(r); console.error('[lamina] loadRow failed', err); });
    inflight.set(r, p);
    return p;
  }

  return {
    kind: source.kind,
    cols,
    schema,
    rowCount() { return offsets.length; },
    rowAt(r) {
      if (r < 0 || r >= offsets.length) return null;
      if (cache.has(r)) { const v = cache.get(r); cache.delete(r); cache.set(r, v); return v; }   // LRU touch
      loadRow(r);
      return LOADING;
    },
    async ensureRow(r) { if (r < 0 || r >= offsets.length) return null; await loadRow(r); return this.rowAt(r); },
    rowHeaderAt(r) { return (r < 0 || r >= nums.length) ? r + 1 : nums[r] + 1; },   // original (1-based) row
    header(c) { return { label: schema && schema[c] ? schema[c].name : `col ${c + 1}`, type: this.colType(c), calc: !!(schema && schema[c] && schema[c].calc) }; },
    colType(c) { return (schema && schema[c] && schema[c].type) || 'string'; },
    onReady(cb) { readyCbs.push(cb); return () => { const i = readyCbs.indexOf(cb); if (i >= 0) readyCbs.splice(i, 1); }; },
  };
}

// ── src/sort.js ──

// @gcu/lamina — sort: a forward scan that extracts the key column(s) + each row's
// locator, then orders the rows. Returns the same `{ offsets, lengths, nums }`
// result shape as filter, consumed by createResultView (per-row reads, no
// base-block thrash — a sorted view is scattered in base order too).
//
// MULTI-KEY: pass `keys: [{col, dir, numeric}]` to sort by several columns (ties
// broken left-to-right). The single-key form ({col, dir, numeric}) still works.
//
// In-memory + capped. A true decagigabyte sort is external-merge-to-OPFS
// (deferred); until then filter→sort handles huge files (the `rows` subset sorts
// only the current filter's matches).


// Compare one key (nulls/NaN/empty last, in BOTH directions). dir: 1 asc, -1 desc.
function keyCmp(ka, kb, dir, numeric) {
  if (numeric) {
    const na = Number.isNaN(ka), nb = Number.isNaN(kb);
    if (na && nb) return 0; if (na) return 1; if (nb) return -1;
    return dir * (ka < kb ? -1 : ka > kb ? 1 : 0);
  }
  const ea = ka === '', eb = kb === '';
  if (ea && eb) return 0; if (ea) return 1; if (eb) return -1;
  return dir * (ka < kb ? -1 : ka > kb ? 1 : 0);
}

/**
 * @param {object} source  a record cursor (cursor.js / a backing adapter)
 * @param {object} opts  { keys?: [{col,dir,numeric}], col?, dir?, numeric?, dataStart?, decimal?, rows?, onProgress?, max? }
 *   rows = ascending DISPLAY rows to restrict to (a filter's matches), or null = all
 * @returns {Promise<{offsets,lengths,nums}>}  ordered by the keys (nulls/empty last, stable)
 */
async function scanSortKeys(source, { keys, col, dir = 'asc', numeric = true, dataStart = 0, decimal = '.', rows = null, onProgress, max = 5 * 1024 * 1024 } = {}) {
  const K = (keys && keys.length ? keys : [{ col, dir, numeric }]).map((k) => ({ col: k.col, dir: k.dir === 'desc' ? -1 : 1, numeric: k.numeric !== false }));
  const recs = [];   // { off, len, num, keys: [...] }
  await source.eachRecord({ dataStart, rows, onProgress }, (disp, fields, loc0, loc1) => {
    const ks = K.map((k) => { const raw = fields[k.col]; return k.numeric ? (raw == null || raw === '' ? NaN : parseNum(raw, decimal)) : (raw == null ? '' : String(raw)); });
    recs.push({ off: loc0, len: loc1, num: disp, keys: ks });
    if (recs.length > max) throw new Error('too many rows to sort — filter first');
  });

  const n = recs.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => {
    for (let i = 0; i < K.length; i++) { const r = keyCmp(recs[a].keys[i], recs[b].keys[i], K[i].dir, K[i].numeric); if (r) return r; }
    return a - b;                                          // stable on original order
  });
  const offsets = new Float64Array(n), lengths = new Float64Array(n), nums = new Float64Array(n);
  for (let k = 0; k < n; k++) { const r = recs[idx[k]]; offsets[k] = r.off; lengths[k] = r.len; nums[k] = r.num; }
  return { offsets, lengths, nums };
}

// ── src/stats.js ──

// @gcu/lamina — column statistics: one forward scan over a column (optionally
// restricted to the current filter's `rows`), accumulating a summary. Numeric →
// count / nulls / min / max / mean / std (Welford, streaming) / sum + quantiles
// (collected + sorted, capped); categorical → count / nulls / distinct + top-N.
// Same scan shape as filter/sort — no new dependency.


const HIST_BINS = 40;
// Bin nv values from `vals` into a {bins, min, max, log} histogram (linear, or log
// over [min,max] with min>0). Counts only; the renderer scales them.
function histify(vals, nv, lo, hi, nbins, log) {
  const bins = new Array(nbins).fill(0);
  const l0 = log ? Math.log(lo) : lo, span = (log ? Math.log(hi) : hi) - l0 || 1;
  for (let i = 0; i < nv; i++) {
    const v = vals[i];
    if (log && v <= 0) continue;
    let k = Math.floor(((log ? Math.log(v) : v) - l0) / span * nbins);
    if (k >= nbins) k = nbins - 1; if (k < 0) k = 0;
    bins[k]++;
  }
  return { bins, min: lo, max: hi, log: !!log };
}

/**
 * One forward scan over a column (optionally restricted to a filter's `rows`),
 * accumulating a summary. Iteration is delegated to source.eachRecord, so it works
 * on any backing. Numeric → count / nulls / min / max / mean / std (Welford) / sum
 * + quantiles (capped); categorical → count / nulls / distinct + top-N.
 * @param {object} source  a record cursor (cursor.js / a backing adapter)
 * @param {object} opts  { col, dataStart?, numeric?, rows?, max?, topN?, maxDistinct?, onProgress? }
 *   rows = ascending DISPLAY rows to restrict to (a filter's matches), or null = all
 * @returns {Promise<object>}  numeric or categorical summary (see fields below)
 */
async function scanColumnStats(source, { col, dataStart = 0, numeric = true, decimal = '.', rows = null, max = 5 * 1024 * 1024, topN = 12, maxDistinct = 100000, onProgress } = {}) {
  let count = 0, nulls = 0, bad = 0;   // nulls = empty/missing; bad = present but not a number
  // numeric (Welford) + a capped value buffer for quantiles
  let min = Infinity, max_ = -Infinity, sum = 0, mean = 0, m2 = 0, nNum = 0;
  let vals = numeric ? new Float64Array(1024) : null, nv = 0, collecting = numeric;
  // categorical
  const freq = numeric ? null : new Map();
  let cappedDistinct = false;

  await source.eachRecord({ dataStart, rows, onProgress }, (disp, fields) => {
    const raw = fields[col];
    count++;
    if (numeric) {
      if (raw == null || raw === '') { nulls++; return; }
      const x = parseNum(raw, decimal);
      if (Number.isNaN(x)) { bad++; return; }       // present but not a number → "non-numeric"
      nNum++;
      if (x < min) min = x;
      if (x > max_) max_ = x;
      sum += x;
      const d = x - mean; mean += d / nNum; m2 += d * (x - mean);   // Welford
      if (collecting) {
        if (nv === vals.length) {
          if (nv >= max) collecting = false;
          else { const a = new Float64Array(vals.length * 2); a.set(vals); vals = a; }
        }
        if (collecting) vals[nv++] = x;
      }
    } else {
      if (raw == null || raw === '') { nulls++; return; }
      const cur = freq.get(raw);
      if (cur !== undefined) freq.set(raw, cur + 1);
      else if (freq.size < maxDistinct) freq.set(raw, 1);
      else cappedDistinct = true;
    }
  });

  if (numeric) {
    const std = nNum > 1 ? Math.sqrt(m2 / (nNum - 1)) : 0;
    let quantiles = null, histogram = null, logHistogram = null;
    if (collecting && nv > 0) {
      const sl = vals.slice(0, nv).sort((a, b) => a - b);
      const q = (p) => sl[Math.min(nv - 1, Math.round(p * (nv - 1)))];
      quantiles = { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
      // full-resolution histograms for the column-profile popup (from the collected
      // value buffer, same basis as the quantiles → consistent; capped flag carries).
      histogram = histify(vals, nv, min, max_, HIST_BINS, false);
      const posMin = sl.find((v) => v > 0);
      if (posMin != null && max_ > posMin) logHistogram = histify(vals, nv, posMin, max_, HIST_BINS, true);
    }
    return { kind: 'number', count, nulls, bad, n: nNum, min: nNum ? min : null, max: nNum ? max_ : null, mean: nNum ? mean : null, std, sum, quantiles, histogram, logHistogram, quantilesCapped: !collecting };
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([value, n]) => ({ value, n }));
  return { kind: 'string', count, nulls, distinct: freq.size, cappedDistinct, top };
}

// ── src/detect.js ──

// @gcu/lamina — detect: sniff a file's KIND from a head sample, so the harness
// picks the right view (delimited→grid, text→lines, binary→hand to hex). recon's
// `sniff` is INJECTED for richer schema (types/units/roles); a solid builtin runs
// without it. Zero-dep.

const DELIMS = [',', '\t', ';', '|', ' '];   // ' ' = whitespace-run mode (GSLIB / scientific dumps)

// Split a line by a delimiter; ' ' means split on whitespace runs (trimmed).
function splitBy(line, delim) {
  if (delim === ' ') { const t = line.trim(); return t === '' ? [] : t.split(/\s+/); }
  return line.split(delim);
}

// Binary = a NUL byte (text files don't have them) or a high ratio of control
// bytes (excluding \t \n \r). Cheap + reliable on a head sample.
function looksBinary(sample) {
  const n = Math.min(sample.length, 8192);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = sample[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.3;
}

function isNumeric(s, decimal) {
  let t = String(s).trim();
  if (t === '') return false;
  if (decimal === ',') t = t.replace(/\./g, '').replace(',', '.');   // 1.234,56 → 1234.56
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t);
}

// Pick the delimiter with a consistent, >0 column count across the sample lines.
function sniffDelimiter(lines) {
  let best = null, bestScore = 0;
  for (const d of DELIMS) {
    const counts = lines.map((l) => splitBy(l, d).length - 1).filter((c, i) => lines[i] !== '');
    if (!counts.length) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)]; // median count
    if (mode < 1) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    // Whitespace is the fallback delimiter and would also "split" prose, so gate
    // it on the data being NUMERIC (geology/scientific whitespace dumps are) — and
    // discount it so a real punctuation delimiter on the same data wins.
    if (d === ' ') {
      const toks = lines.flatMap((l) => splitBy(l, d));
      const numFrac = toks.length ? toks.filter(isNumeric).length / toks.length : 0;
      if (numFrac < 0.5) continue;                    // prose / non-numeric → not whitespace-delimited
    }
    const score = mode * consistent * (d === ' ' ? 0.9 : 1);
    if (score > bestScore) { bestScore = score; best = { delimiter: d, columns: mode + 1, consistent }; }
  }
  return best;   // best candidate (may be low-consistency); the caller gates it
}

// Build a delimited result (schema + header guess) for a known delimiter. Header:
// forced (true/false) or guessed (row 0 all-text + a later numeric). Column count
// = the median row length (robust to a stray ragged row). Shared by auto + forced.
function buildDelimited(lines, delimiter, forceHeader, decimal) {
  const rows = lines.filter((l) => l !== '').map((l) => splitBy(l, delimiter));
  const lens = rows.map((r) => r.length).sort((a, b) => a - b);
  const columns = Math.max(1, lens[Math.floor(lens.length / 2)] || 1);
  const head = rows[0] || [];
  let hasHeader;
  if (forceHeader === true || forceHeader === false) hasHeader = forceHeader;
  else hasHeader = head.length > 0 && head.every((c) => !isNumeric(c, decimal)) && rows.slice(1, 20).some((r) => r.some((v) => isNumeric(v, decimal)));
  const dataRows = rows.slice(hasHeader ? 1 : 0, hasHeader ? 21 : 20);
  const schema = [];
  for (let c = 0; c < columns; c++) {
    const name = hasHeader && head[c] != null && head[c] !== '' ? head[c] : `col ${c + 1}`;
    const vals = dataRows.map((r) => r[c]).filter((v) => v != null && v !== '');
    schema.push({ name, type: vals.length && vals.every((v) => isNumeric(v, decimal)) ? 'number' : 'string' });
  }
  return { kind: 'delimited', delimiter, quote: '"', hasHeader, schema };
}

// How many leading lines to skip as a comment/preamble (the geology-export norm:
// a block of `# …` metadata before the real header). Auto: a `comment` prefix
// (forced, or `#` when line 0 starts with it) → skip leading lines that match.
function leadingSkip(lines, f) {
  if (f.skip != null) return { skip: f.skip | 0, comment: f.comment || null };
  const comment = f.comment != null ? f.comment : (lines[0] && lines[0].startsWith('#') ? '#' : null);
  if (!comment) return { skip: 0, comment: null };
  let skip = 0;
  while (skip < lines.length && lines[skip].startsWith(comment)) skip++;
  return { skip, comment };
}

// GSLIB / Geo-EAS: line 0 = title, line 1 = an integer N (column count), lines
// 2..N+1 = one column NAME per line, then N-column (usually whitespace) data.
// Column names come from the preamble, not a header row → schema + dataStart=N+2.
function detectGeoEAS(lines, decimal) {
  if (lines.length < 4) return null;
  const n = Number((lines[1] || '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 1000 || lines.length < n + 3) return null;
  const names = lines.slice(2, 2 + n).map((l) => l.trim());
  if (names.some((nm) => nm === '')) return null;
  const first = lines[2 + n] || '';
  for (const delim of [' ', ',', '\t']) {              // data delimiter (whitespace is the norm)
    if (delim === ',' && decimal === ',') continue;     // can't be both delimiter and decimal
    const tok = splitBy(first, delim);
    if (tok.length === n && tok.some((v) => isNumeric(v, decimal))) {
      const dataRows = lines.slice(2 + n, 2 + n + 20).map((l) => splitBy(l, delim));
      const schema = names.map((nm, c) => {
        const vals = dataRows.map((r) => r[c]).filter((v) => v != null && v !== '');
        return { name: nm, type: vals.length && vals.every((v) => isNumeric(v, decimal)) ? 'number' : 'string' };
      });
      return { kind: 'delimited', delimiter: delim, quote: '"', hasHeader: false, schema, dataStart: 2 + n, geoeas: true, skip: 0, comment: null, decimal };
    }
  }
  return null;
}

/**
 * @param {Uint8Array} sample  the file's head (e.g. first 64 KB)
 * @param {object} opts  { sniff?, force? }
 *   force overrides auto-detection (when the user corrects a wrong guess):
 *   { kind?: 'delimited'|'text'|'binary', delimiter?, hasHeader?, skip?, comment? }
 *   name = the filename (a .csv/.tsv/.tab extension biases an ambiguous file to a table).
 * @returns {{ kind, delimiter?, quote?, schema?, hasHeader?, skip?, comment?, dataStart? }}
 *   dataStart = records to skip before the first DATA row (preamble + header).
 */
function detectKind(sample, { sniff, force, name } = {}) {
  const f = force || {};
  if (f.kind === 'binary') return { kind: 'binary' };
  if (!f.kind && !f.delimiter && looksBinary(sample)) return { kind: 'binary' };

  const decimal = f.decimal === ',' ? ',' : '.';   // decimal separator (',' = European/Brazilian)
  let text; try { text = new TextDecoder(f.encoding || 'utf-8').decode(sample); } catch { text = new TextDecoder().decode(sample); }   // forced encoding → correct header names
  const all = text.split('\n').slice(0, 200).map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  // GSLIB / Geo-EAS structured preamble (only when nothing is forced).
  if (!f.kind && !f.delimiter && f.skip == null) { const g = detectGeoEAS(all, decimal); if (g) return g; }

  const { skip, comment } = leadingSkip(all, f);
  const lines = all.slice(skip);                    // the body, past the preamble

  if (f.kind === 'text') return { kind: 'text', skip, comment, dataStart: skip };

  const finish = (r) => ({ ...r, skip, comment, decimal, dataStart: skip + (r.hasHeader ? 1 : 0) });
  if (f.delimiter) return finish(buildDelimited(lines, f.delimiter, f.hasHeader, decimal));

  // recon enrichment (best-effort): if it finds a delimiter + fields, prefer it.
  if (typeof sniff === 'function') {
    try {
      const m = sniff(lines);
      if (m && m.delimiter && Array.isArray(m.fields) && m.fields.length > 1) {
        return finish({
          kind: 'delimited', delimiter: m.delimiter, quote: '"',
          hasHeader: f.hasHeader != null ? f.hasHeader : m.hasHeader !== false,
          schema: m.fields.map((fl) => ({ name: fl.name, type: fl.type || 'string', unit: fl.unit, role: fl.role })),
        });
      }
    } catch { /* fall through to builtin */ }
  }

  const d = sniffDelimiter(lines.filter((l) => l !== ''));
  // A .csv/.tsv/.tab extension is a strong "this is a table" signal — accept the
  // best delimiter even when column counts are inconsistent (ragged/quoted rows),
  // where a generic sniff would bail to text. Otherwise require ≥0.6 consistency.
  const csvHint = /\.(csv|tsv|tab|lam|lamina)$/i.test(name || '');   // .lam/.lamina = lamina's marker ext (delimited data)
  if (d && (d.consistent >= 0.6 || (csvHint && d.columns >= 2))) return finish(buildDelimited(lines, d.delimiter, f.hasHeader, decimal));
  return { kind: 'text', skip, comment, dataStart: skip };
}

// ── src/provider.js ──

// @gcu/lamina — provider: adapt a RecordViewSource to the @gcu/loom cell-provider
// contract (read-only). loom's PENDING sentinel is INJECTED (the consumer imports
// it from @gcu/loom and passes it in) so this stays decoupled from loom's bundle —
// the strata-provider trick, extended to the windowed/PENDING case.


/**
 * @param {object} vs  a RecordViewSource (viewsource.js)
 * @param {object} opts  { PENDING }  — loom's PENDING sentinel (required for windowing)
 * @returns a loom provider: dims / cellAt / header / rowHeader / onReady
 */
function createLaminaProvider(vs, { PENDING } = {}) {
  return {
    dims() { return { rows: vs.rowCount(), cols: vs.cols }; },
    cellAt(r, c) {
      const row = vs.rowAt(r);
      if (row === LOADING) return PENDING;          // block not loaded → loom draws a placeholder
      if (row == null) return null;                  // out of range → blank
      const v = row[c];
      if (v == null || v === '') return null;        // empty cell → blank
      return { value: v, state: 'raw', type: vs.colType(c), style: { text: v } };
    },
    header(c) { return vs.header(c); },
    rowHeader(r) { return vs.rowHeaderAt ? vs.rowHeaderAt(r) : r + 1; },   // filtered view reports the original row #
    onReady(cb) { return vs.onReady(cb); },
  };
}

// ── src/main.js ──

// @gcu/lamina — windowed, read-only viewer for arbitrarily huge files.
// Public surface (manifest-is-truth; @gcu/build bundles from here).

export {
  createRecordScanner,
  scanRecords,
  scanFileToIndex,
  splitRecords,
  splitRecordsPos,
  parseFields,
  parseNum,
  buildMemorySource,
  buildFileSource,
  buildStreamSource,
  buildSourceFromIndex,
  indexOf,
  fileKey,
  installRecordCursor,
  createRecordViewSource,
  LOADING,
  withCalcCursor,
  withCalcView,
  parseFilter,
  scanFilter,
  createResultView,
  scanSortKeys,
  scanColumnStats,
  detectKind,
  createLaminaProvider,
};
