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
export function createRecordScanner({ kind = 'delimited', quote = DQUOTE, blockSize = 4096 } = {}) {
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
export function parseNum(s, decimal) {
  return decimal === ',' ? Number(String(s).replace(/\./g, '').replace(',', '.')) : Number(s);
}

/** Convenience: scan a whole Uint8Array in one shot (tests / small files). */
export function scanRecords(bytes, opts) {
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
export async function scanFileToIndex(file, { kind = 'delimited', quote = DQUOTE, blockSize = 4096, onProgress } = {}) {
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
export function splitRecordsPos(bytes, { kind = 'delimited', quote = DQUOTE } = {}) {
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
export function splitRecords(bytes, opts) {
  return splitRecordsPos(bytes, opts).map((p) => bytes.subarray(p.start, p.end));
}

/**
 * Split one record's bytes into decoded string fields (delimited mode). Honours
 * quoting + the doubled-"" escape. Plain (unquoted) fields are taken verbatim.
 * @returns {string[]}
 */
export function parseFields(recordBytes, { delimiter = ',', quote = '"' } = {}) {
  const s = new TextDecoder().decode(recordBytes);
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
