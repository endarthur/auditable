// @gcu/lamina — sort: a forward scan that extracts a key column + each row's byte
// position, then orders the rows by key. Returns the same `{ offsets, lengths,
// nums }` result shape as filter, consumed by createResultView (per-row reads, no
// base-block thrash — a sorted view is scattered in base order too).
//
// In-memory + capped. A true decagigabyte sort is external-merge-to-OPFS
// (deferred); until then filter→sort handles huge files (the `rows` subset sorts
// only the current filter's matches).

import { splitRecordsPos, parseFields, parseNum } from './scan.js';

const DEC = new TextDecoder();

/**
 * @param {object} source  block index + readRange (source.js)
 * @param {object} opts  { col, dir?, dataStart?, numeric?, rows?, onProgress?, max? }
 *   rows = ascending DISPLAY rows to restrict to (a filter's matches), or null = all
 * @returns {Promise<{offsets:Float64Array, lengths:Float64Array, nums:Float64Array}>}
 *          ordered by key (nulls/NaN/empty last, stable)
 */
export async function scanSortKeys(source, { col, dir = 'asc', dataStart = 0, numeric = true, decimal = '.', rows = null, onProgress, max = 5 * 1024 * 1024 } = {}) {
  const K = source.blockSize;
  const nBlocks = source.blockOffsets.length;
  const qByte = (source.quote || '"').charCodeAt(0);
  const delimited = source.kind === 'delimited';
  const subset = rows;
  let sp = 0;
  const recs = [];   // { off, len, num, key }
  for (let b = 0; b < nBlocks; b++) {
    const s = source.blockOffsets[b];
    const e = b + 1 < nBlocks ? source.blockOffsets[b + 1] : source.totalBytes;
    const bytes = await source.readRange(s, e - s);
    const pos = splitRecordsPos(bytes, { kind: source.kind, quote: qByte });
    for (let i = 0; i < pos.length; i++) {
      const srcRow = b * K + i;
      if (srcRow >= source.rowCount) break;
      const disp = srcRow - dataStart;
      if (disp < 0) continue;
      if (subset) {
        while (sp < subset.length && subset[sp] < disp) sp++;
        if (sp >= subset.length || subset[sp] !== disp) continue;
        sp++;
      }
      const rec = bytes.subarray(pos[i].start, pos[i].end);
      const fields = delimited ? parseFields(rec, { delimiter: source.delimiter, quote: source.quote }) : [DEC.decode(rec)];
      const raw = fields[col];
      const key = numeric ? (raw == null || raw === '' ? NaN : parseNum(raw, decimal)) : (raw == null ? '' : String(raw));
      recs.push({ off: s + pos[i].start, len: pos[i].end - pos[i].start, num: disp, key });
      if (recs.length > max) throw new Error('too many rows to sort — filter first');
    }
    if (onProgress) onProgress(b + 1, nBlocks);
    if (subset && sp >= subset.length) break;
  }

  const n = recs.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const mul = dir === 'desc' ? -1 : 1;
  let cmp;
  if (numeric) {
    cmp = (a, b) => {
      const ka = recs[a].key, kb = recs[b].key;
      const na = Number.isNaN(ka), nb = Number.isNaN(kb);    // non-numeric → last, both directions
      if (na && nb) return a - b;
      if (na) return 1; if (nb) return -1;
      return mul * (ka - kb) || (a - b);                     // stable on original order
    };
  } else {
    cmp = (a, b) => {
      const ka = recs[a].key, kb = recs[b].key;
      const ea = ka === '', eb = kb === '';                  // empty → last
      if (ea && eb) return a - b;
      if (ea) return 1; if (eb) return -1;
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * mul || (a - b);
    };
  }
  idx.sort(cmp);
  const offsets = new Float64Array(n), lengths = new Float64Array(n), nums = new Float64Array(n);
  for (let k = 0; k < n; k++) { const r = recs[idx[k]]; offsets[k] = r.off; lengths[k] = r.len; nums[k] = r.num; }
  return { offsets, lengths, nums };
}
