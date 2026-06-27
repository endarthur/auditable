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

import { splitRecordsPos, parseFields, decoderFor } from './scan.js';

/**
 * Attach `eachRecord` + `readByLoc` to a CSV/text block source (source.js shape:
 * blockOffsets + readRange + kind/delimiter/quote/blockSize/rowCount/totalBytes).
 * Locator = (byte offset, byte length) — exactly what the byte-offset result view
 * reads a scattered row from. Returns the same source (mutated), for chaining.
 */
export function installRecordCursor(source) {
  const K = source.blockSize;
  const qByte = (source.quote || '"').charCodeAt(0);
  const delimited = source.kind === 'delimited';
  const fieldsOf = (bytes) => (delimited ? parseFields(bytes, { delimiter: source.delimiter, quote: source.quote, encoding: source.encoding }) : [decoderFor(source.encoding).decode(bytes)]);

  source.eachRecord = async ({ dataStart = 0, rows = null, onProgress, limit = Infinity } = {}, visit) => {
    const nBlocks = source.blockOffsets.length;
    let sp = 0, seen = 0;                                  // sp = cursor into `rows`; seen = visited count (for `limit`)
    for (let b = 0; b < nBlocks; b++) {
      if (rows) {                                          // subset: skip blocks that hold none of the requested rows
        if (sp >= rows.length) break;                      // (block b = source records [b*K, (b+1)*K)) → no readRange, no decode
        if (Math.floor((rows[sp] + dataStart) / K) > b) continue;
      }
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
        const rv = visit(disp, fieldsOf(bytes.subarray(pos[i].start, pos[i].end)), s + pos[i].start, pos[i].end - pos[i].start);
        if (rv && rv.then) await rv;                       // async visit (e.g. export's stream-flush); sync visits pay nothing
        if (++seen >= limit) return;                       // sample cap (gutter stats)
      }
      if (onProgress) onProgress(b + 1, nBlocks);
      if (rows && sp >= rows.length) break;                // subset exhausted → stop early
    }
  };

  source.readByLoc = async (off, len) => fieldsOf(await source.readRange(off, len));
  return source;
}
