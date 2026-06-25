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

/** Convenience: scan a whole Uint8Array in one shot (tests / small files). */
export function scanRecords(bytes, opts) {
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
export function splitRecords(bytes, { kind = 'delimited', quote = DQUOTE } = {}) {
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
export function parseFields(recordBytes, { delimiter = ',', quote = '"' } = {}) {
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
