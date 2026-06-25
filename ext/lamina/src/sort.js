// @gcu/lamina — sort: a forward scan that extracts a key column, then sorts row
// ordinals by it. The result is a row-order array consumed by the SAME remap view
// as filter (createFilteredViewSource) — sort is just a different permutation.
//
// In-memory (capped): the (row, key) arrays are one entry per sorted row, so this
// is bounded at `max` rows (then throws — "filter first"). A true decagigabyte
// sort is external-merge-to-OPFS (deferred, the heavy path); until then, the
// composition filter→sort handles huge files: reduce with a filter, sort the rest.
// `rows` (the current filter's matches, ascending) sorts only that subset.

import { splitRecords, parseFields } from './scan.js';

const DEC = new TextDecoder();

/**
 * @param {object} source  block index + readRange (source.js)
 * @param {object} opts  { col, dir?, dataStart?, numeric?, rows?, onProgress?, max? }
 * @returns {Promise<Float64Array>}  display rows in sorted order (nulls/NaN last)
 */
export async function scanSortKeys(source, { col, dir = 'asc', dataStart = 0, numeric = true, rows = null, onProgress, max = 5 * 1024 * 1024 } = {}) {
  const K = source.blockSize;
  const nBlocks = source.blockOffsets.length;
  const qByte = (source.quote || '"').charCodeAt(0);
  const delimited = source.kind === 'delimited';
  const subset = rows;                 // ascending display rows to restrict to, or null = all
  let sp = 0;
  const outRows = [];
  const keys = [];
  for (let b = 0; b < nBlocks; b++) {
    const s = source.blockOffsets[b];
    const e = b + 1 < nBlocks ? source.blockOffsets[b + 1] : source.totalBytes;
    const recs = splitRecords(await source.readRange(s, e - s), { kind: source.kind, quote: qByte });
    for (let i = 0; i < recs.length; i++) {
      const srcRow = b * K + i;
      if (srcRow >= source.rowCount) break;
      const disp = srcRow - dataStart;
      if (disp < 0) continue;
      if (subset) {
        while (sp < subset.length && subset[sp] < disp) sp++;
        if (sp >= subset.length || subset[sp] !== disp) continue;
        sp++;
      }
      const fields = delimited ? parseFields(recs[i], { delimiter: source.delimiter, quote: source.quote }) : [DEC.decode(recs[i])];
      const raw = fields[col];
      outRows.push(disp);
      // empty/missing numeric → NaN (sorts last), NOT 0 (Number('') === 0 would sort low)
      keys.push(numeric ? (raw == null || raw === '' ? NaN : Number(raw)) : (raw == null ? '' : String(raw)));
      if (outRows.length > max) throw new Error('too many rows to sort — filter first');
    }
    if (onProgress) onProgress(b + 1, nBlocks);
    if (subset && sp >= subset.length) break;     // collected every wanted row
  }

  const n = outRows.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const mul = dir === 'desc' ? -1 : 1;
  let cmp;
  if (numeric) {
    cmp = (a, b) => {
      const ka = keys[a], kb = keys[b];
      const na = Number.isNaN(ka), nb = Number.isNaN(kb);   // non-numeric → last, both directions
      if (na && nb) return a - b;
      if (na) return 1;
      if (nb) return -1;
      return mul * (ka - kb) || (a - b);                    // stable on original order
    };
  } else {
    cmp = (a, b) => {
      const ka = keys[a], kb = keys[b];
      const ea = ka === '', eb = kb === '';                 // empty → last
      if (ea && eb) return a - b;
      if (ea) return 1;
      if (eb) return -1;
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * mul || (a - b);
    };
  }
  idx.sort(cmp);
  const order = new Float64Array(n);
  for (let k = 0; k < n; k++) order[k] = outRows[idx[k]];
  return order;
}
