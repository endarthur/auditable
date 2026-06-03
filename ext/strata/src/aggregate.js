// @gcu/strata — aggregate: group-by + aggregation (strata-spec §5 aggregate cells).
//
// groupBy(table, { by, aggs }, rowIndices?) → a fresh summary StrataTable: one
// row per distinct key tuple, with aggregate columns. The result IS a table, so
// it flows through the rest of strata unchanged — view it in loom, save it as
// .strata, chart it, group it again (the §7.2 "promotable: selection → … → a new
// table" idea, here for aggregation). Operates over EFFECTIVE values (base⊕
// overlay, derived computed); pass `view.rows()` as rowIndices to aggregate the
// currently filtered set.
//
// v1 = single in-memory pass (the small-data fast path). Streaming group-by over
// @gcu/sluice accumulators (welford/t-digest) for big data is the deferred §4.3
// pipeline path — same engine, different host.
//
// Pure, zero-dep (beyond ./table). Node-testable.

import { createTable } from './table.js';

// Aggregation ops. count needs no column; the rest skip non-numeric/null values
// (so a sum over a column with gaps is the sum of what's there, not NaN).
const OPS = {
  count: { needsCol: false, init: () => 0, step: (a) => a + 1, fin: (a) => a },
  sum: { needsCol: true, init: () => ({ s: 0, any: false }),
    step: (a, v) => { if (typeof v === 'number') { a.s += v; a.any = true; } return a; },
    fin: (a) => (a.any ? a.s : null) },
  mean: { needsCol: true, init: () => ({ s: 0, n: 0 }),
    step: (a, v) => { if (typeof v === 'number') { a.s += v; a.n++; } return a; },
    fin: (a) => (a.n ? a.s / a.n : null) },
  min: { needsCol: true, init: () => ({ m: null }),
    step: (a, v) => { if (typeof v === 'number' && (a.m === null || v < a.m)) a.m = v; return a; },
    fin: (a) => a.m },
  max: { needsCol: true, init: () => ({ m: null }),
    step: (a, v) => { if (typeof v === 'number' && (a.m === null || v > a.m)) a.m = v; return a; },
    fin: (a) => a.m },
};

export const AGG_OPS = Object.keys(OPS);

/**
 * @param {object} table   a StrataTable
 * @param {object} spec     { by: name|name[], aggs: [{ op, col?, as? }] }
 * @param {number[]} [rowIndices]  rows to aggregate (default: all). Pass
 *   view.rows() to aggregate the filtered set.
 * @returns {object} a new summary StrataTable (key columns + aggregate columns)
 */
export function groupBy(table, spec, rowIndices) {
  const by = Array.isArray(spec.by) ? spec.by : [spec.by];
  const keyIdx = by.map((n) => table.schema.findIndex((s) => s.name === n));
  if (keyIdx.some((i) => i < 0)) throw new Error('groupBy: unknown key column');

  const aggs = spec.aggs.map((a) => {
    if (!OPS[a.op]) throw new Error(`groupBy: unknown op "${a.op}"`);
    if (OPS[a.op].needsCol && a.col == null) throw new Error(`groupBy: op "${a.op}" needs a column`);
    const colIdx = a.col != null ? table.schema.findIndex((s) => s.name === a.col) : -1;
    if (a.col != null && colIdx < 0) throw new Error(`groupBy: unknown column "${a.col}"`);
    return { op: a.op, colIdx, as: a.as || (a.col ? `${a.op}_${a.col}` : a.op) };
  });

  const rows = rowIndices || Array.from({ length: table.nrows }, (_, i) => i);

  // Single pass: bucket rows by key tuple (insertion-ordered), accumulate.
  const groups = new Map();
  const order = [];
  for (const r of rows) {
    const keyVals = keyIdx.map((ci) => table.getCell(r, ci).value);
    const keyStr = JSON.stringify(keyVals);
    let g = groups.get(keyStr);
    if (!g) { g = { keyVals, accs: aggs.map((a) => OPS[a.op].init()) }; groups.set(keyStr, g); order.push(keyStr); }
    for (let i = 0; i < aggs.length; i++) {
      const v = aggs[i].colIdx >= 0 ? table.getCell(r, aggs[i].colIdx).value : undefined;
      g.accs[i] = OPS[aggs[i].op].step(g.accs[i], v);
    }
  }

  // Result schema: key columns (copied, unit preserved) + aggregate columns
  // (number; sum/mean/min/max inherit the source column's unit, count is unitless).
  const schema = [];
  for (const ci of keyIdx) {
    const s = table.schema[ci];
    schema.push({ name: s.name, type: s.type, ...(s.unit ? { unit: s.unit } : {}) });
  }
  for (const a of aggs) {
    const srcUnit = a.colIdx >= 0 && a.op !== 'count' ? table.schema[a.colIdx].unit : undefined;
    schema.push({ name: a.as, type: 'number', ...(srcUnit ? { unit: srcUnit } : {}) });
  }

  const columns = schema.map(() => []);
  for (const keyStr of order) {
    const g = groups.get(keyStr);
    let c = 0;
    for (let k = 0; k < keyIdx.length; k++) columns[c++].push(g.keyVals[k]);
    for (let i = 0; i < aggs.length; i++) columns[c++].push(OPS[aggs[i].op].fin(g.accs[i]));
  }

  return createTable({ schema, columns, nrows: order.length });
}
