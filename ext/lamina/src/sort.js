// @gcu/lamina — sort: a forward scan that extracts a key column + each row's byte
// position, then orders the rows by key. Returns the same `{ offsets, lengths,
// nums }` result shape as filter, consumed by createResultView (per-row reads, no
// base-block thrash — a sorted view is scattered in base order too).
//
// In-memory + capped. A true decagigabyte sort is external-merge-to-OPFS
// (deferred); until then filter→sort handles huge files (the `rows` subset sorts
// only the current filter's matches).

import { parseNum } from './scan.js';

/**
 * Forward-scan a source extracting a key column + each row's LOCATOR, then order
 * the rows by key. Iteration is delegated to source.eachRecord, so it works on any
 * backing. Returns the same `{ offsets, lengths, nums }` result shape as filter,
 * consumed by createResultView.
 * @param {object} source  a record cursor (cursor.js / a backing adapter)
 * @param {object} opts  { col, dir?, dataStart?, numeric?, rows?, onProgress?, max? }
 *   rows = ascending DISPLAY rows to restrict to (a filter's matches), or null = all
 * @returns {Promise<{offsets:Float64Array, lengths:Float64Array, nums:Float64Array}>}
 *          ordered by key (nulls/NaN/empty last, stable)
 */
export async function scanSortKeys(source, { col, dir = 'asc', dataStart = 0, numeric = true, decimal = '.', rows = null, onProgress, max = 5 * 1024 * 1024 } = {}) {
  const recs = [];   // { off, len, num, key }
  await source.eachRecord({ dataStart, rows, onProgress }, (disp, fields, loc0, loc1) => {
    const raw = fields[col];
    const key = numeric ? (raw == null || raw === '' ? NaN : parseNum(raw, decimal)) : (raw == null ? '' : String(raw));
    recs.push({ off: loc0, len: loc1, num: disp, key });
    if (recs.length > max) throw new Error('too many rows to sort — filter first');
  });

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
