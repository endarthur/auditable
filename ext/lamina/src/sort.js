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

import { parseNum } from './scan.js';

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
export async function scanSortKeys(source, { keys, col, dir = 'asc', numeric = true, dataStart = 0, decimal = '.', rows = null, onProgress, max = 5 * 1024 * 1024 } = {}) {
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
