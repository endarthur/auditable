// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/lamina — A windowed, read-only viewer for arbitrarily huge files — record-offset block index over @gcu/vfs streaming + @gcu/loom. The finest stratum: thin slices (windows) of a file. delimited → grid, text → lines, binary → hex.

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

/** Convenience: scan a whole Uint8Array in one shot (tests / small files). */
function scanRecords(bytes, opts) {
  const s = createRecordScanner(opts);
  s.push(bytes);
  return s.end();
}

/**
 * Split a byte range (one or more blocks' worth) into record byte-slices, using
 * the same boundary rule as the scanner. Trailing \r is trimmed (CRLF). The \n
 * is excluded. This is what the windowed read calls after readRange.
 * @returns {Uint8Array[]} record byte slices, in order
 */
function splitRecords(bytes, { kind = 'delimited', quote = DQUOTE } = {}) {
  const quoteAware = kind === 'delimited';
  const out = [];
  let start = 0, inQuote = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (quoteAware && b === quote) { inQuote = !inQuote; continue; }
    if (b === NL && !inQuote) {
      let end = i;
      if (end > start && bytes[end - 1] === CR) end--;   // trim CRLF's \r
      out.push(bytes.subarray(start, end));
      start = i + 1;
    }
  }
  if (start < bytes.length) {                              // trailing record, no \n
    let end = bytes.length;
    if (end > start && bytes[end - 1] === CR) end--;
    out.push(bytes.subarray(start, end));
  }
  return out;
}

/**
 * Split one record's bytes into decoded string fields (delimited mode). Honours
 * quoting + the doubled-"" escape. Plain (unquoted) fields are taken verbatim.
 * @returns {string[]}
 */
function parseFields(recordBytes, { delimiter = ',', quote = '"' } = {}) {
  const s = new TextDecoder().decode(recordBytes);
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
function buildMemorySource(bytes, { kind = 'delimited', delimiter = ',', quote = '"', blockSize = 4096 } = {}) {
  const idx = scanRecords(bytes, { kind, quote: quote.charCodeAt(0), blockSize });
  return {
    kind, delimiter, quote, blockSize,
    blockOffsets: idx.blockOffsets,
    rowCount: idx.rowCount,
    totalBytes: idx.totalBytes,
    async readRange(offset, length) { return bytes.subarray(offset, offset + length); },
  };
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
      ? recs.map((rb) => parseFields(rb, { delimiter: source.delimiter, quote: source.quote }))
      : recs.map((rb) => [new TextDecoder().decode(rb)]);
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

// ── src/detect.js ──

// @gcu/lamina — detect: sniff a file's KIND from a head sample, so the harness
// picks the right view (delimited→grid, text→lines, binary→hand to hex). recon's
// `sniff` is INJECTED for richer schema (types/units/roles); a solid builtin runs
// without it. Zero-dep.

const DELIMS = [',', '\t', ';', '|'];

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

function isNumeric(s) { return s !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim()); }

// Pick the delimiter with a consistent, >0 column count across the sample lines.
function sniffDelimiter(lines) {
  let best = null, bestScore = 0;
  for (const d of DELIMS) {
    const counts = lines.map((l) => l.split(d).length - 1).filter((c, i) => lines[i] !== '');
    if (!counts.length) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)]; // median count
    if (mode < 1) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = mode * consistent;                  // more columns + more consistent = better
    if (score > bestScore) { bestScore = score; best = { delimiter: d, columns: mode + 1, consistent }; }
  }
  return best && best.consistent >= 0.6 ? best : null;
}

/**
 * @param {Uint8Array} sample  the file's head (e.g. first 64 KB)
 * @param {object} opts  { sniff?: @gcu/recon sniff }
 * @returns {{ kind:'delimited'|'text'|'binary', delimiter?, quote?, schema?, hasHeader? }}
 */
function detectKind(sample, { sniff } = {}) {
  if (looksBinary(sample)) return { kind: 'binary' };

  const text = new TextDecoder().decode(sample);
  const lines = text.split('\n').slice(0, 50).map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  // recon enrichment (best-effort): if it finds a delimiter + fields, prefer it.
  if (typeof sniff === 'function') {
    try {
      const m = sniff(lines);
      if (m && m.delimiter && Array.isArray(m.fields) && m.fields.length > 1) {
        return {
          kind: 'delimited', delimiter: m.delimiter, quote: '"',
          hasHeader: m.hasHeader !== false,
          schema: m.fields.map((f) => ({ name: f.name, type: f.type || 'string', unit: f.unit, role: f.role })),
        };
      }
    } catch { /* fall through to builtin */ }
  }

  const d = sniffDelimiter(lines.filter((l) => l !== ''));
  if (!d) return { kind: 'text' };

  // Header guess: row 0 all non-numeric, and some later row has a numeric.
  const rows = lines.filter((l) => l !== '').map((l) => l.split(d.delimiter));
  const head = rows[0] || [];
  const headAllText = head.length > 0 && head.every((c) => !isNumeric(c));
  const laterHasNum = rows.slice(1, 20).some((r) => r.some(isNumeric));
  const hasHeader = headAllText && laterHasNum;

  const dataRows = rows.slice(hasHeader ? 1 : 0, hasHeader ? 21 : 20);
  const schema = [];
  for (let c = 0; c < d.columns; c++) {
    const name = hasHeader && head[c] != null ? head[c] : `col ${c + 1}`;
    const vals = dataRows.map((r) => r[c]).filter((v) => v != null && v !== '');
    const type = vals.length && vals.every(isNumeric) ? 'number' : 'string';
    schema.push({ name, type });
  }
  return { kind: 'delimited', delimiter: d.delimiter, quote: '"', hasHeader, schema };
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
    rowHeader(r) { return r + 1; },
    onReady(cb) { return vs.onReady(cb); },
  };
}

// ── src/main.js ──

// @gcu/lamina — windowed, read-only viewer for arbitrarily huge files.
// Public surface (manifest-is-truth; @gcu/build bundles from here).

export {
  createRecordScanner,
  scanRecords,
  splitRecords,
  parseFields,
  buildMemorySource,
  createRecordViewSource,
  LOADING,
  detectKind,
  createLaminaProvider,
};
