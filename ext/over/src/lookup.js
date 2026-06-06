// @gcu/over — lookup / join (SQL-y, multi-table).
//
//   DENSITY = lookup densities.density where densities.litho == LITHO
//   DOMAIN  = lookup domains.code where domains.hole == hole and domains.from <= DEPTH < domains.to
//
// `lookup TABLE.valueCol where PREDICATE`. The predicate is an `and` of comparisons,
// each between a TABLE.<col> (qualified ref) and a row value. The compiler reads the
// predicate SHAPE and picks the index — pure equality → hash; equality + a range
// pair → per-eq-key sorted intervals + binary search (the geology join). Tables are
// injected by name (run(rows, { table })); left-join (unmatched → absent). Index is
// built once per (table, eq-cols, range-cols) and shared across value columns.

import { SEP, isAbsent, numCmp, refRowsOf } from './util.js';

const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==' };

// The table a predicate joins against = the first qualified ref's table.
export function tableOfPredicate(pred) {
  let t = null;
  (function f(e) { if (!e || typeof e !== 'object' || t) return; if (e.type === 'Qualified') { t = e.table; return; } f(e.left); f(e.right); })(pred);
  return t;
}

// Decompose an `and` of comparisons (`TABLE.col <cmp> rowValue`) into equality
// terms + an optional range pair. Shared by `lookup` (point-in-interval) and the
// aggregating join (interval overlap) — the ONLY difference between the two is
// whether the two range bounds probe the same row value (`from <= DEPTH < to` →
// contains) or two different ones (`from < TO and to > FROM` → overlap). Both fall
// out of the same analysis; `loProbe`/`hiProbe` carry them for whoever needs them.
export function analyzePredicate(predicate, table) {
  const terms = [];
  (function flat(e) { if (e && e.type === 'Binary' && e.op === 'and') { flat(e.left); flat(e.right); } else terms.push(e); })(predicate);

  const eqRefCols = [], eqProbes = [], lows = [], highs = [];
  for (const t of terms) {
    if (!t || t.type !== 'Binary' || !FLIP[t.op]) throw new Error('over: a `where` must be comparisons joined by `and`');
    const lq = t.left.type === 'Qualified' && t.left.table === table;
    const rq = t.right.type === 'Qualified' && t.right.table === table;
    if (lq === rq) throw new Error(`over: each condition must compare ${table}.<col> with a row value`);
    const refCol = lq ? t.left.col : t.right.col;
    const op = lq ? t.op : FLIP[t.op];            // normalize: ref on the left
    const probe = lq ? t.right : t.left;
    if (op === '==') { eqRefCols.push(refCol); eqProbes.push(probe); }
    else if (op === '<=' || op === '<') lows.push({ refCol, op, probe });    // ref ≤ probe → ref is LO
    else highs.push({ refCol, op, probe });                                  // ref ≥ probe → ref is HI
  }

  let range = null;
  if (lows.length || highs.length) {
    if (lows.length !== 1 || highs.length !== 1)
      throw new Error('over: a range needs one lower (TABLE.from <= pos) and one upper (pos < TABLE.to) bound');
    range = { loCol: lows[0].refCol, hiCol: highs[0].refCol, loOp: lows[0].op, hiOp: highs[0].op,
      loProbe: lows[0].probe, hiProbe: highs[0].probe, posProbe: lows[0].probe };
  }
  return { eqRefCols, eqProbes, range };
}

// Analyze a Lookup node's value + predicate → equality refs/probes + an optional
// range. Throws on anything outside `and` of `TABLE.col <cmp> rowValue`.
function analyze(node) {
  if (node.value.type !== 'Qualified') throw new Error('over: lookup expects `lookup TABLE.column where …`');
  const table = node.value.table, valueCol = node.value.col;
  const { eqRefCols, eqProbes, range } = analyzePredicate(node.predicate, table);
  return { table, valueCol, eqRefCols, eqProbes, range };
}

// Collect Lookup nodes: assign each a dedup'd indexId, tag node._spec (for emit),
// return the unique index defs to build.
export function collectLookups(ast) {
  const defs = [];
  const byKey = new Map();

  function consider(node) {
    const a = analyze(node);
    const rk = a.range ? `${a.range.loCol}|${a.range.hiCol}|${a.range.loOp}|${a.range.hiOp}` : '';
    const key = a.table + SEP + a.eqRefCols.join(',') + SEP + rk;
    let indexId = byKey.get(key);
    if (indexId === undefined) {
      indexId = defs.length; byKey.set(key, indexId);
      defs.push({ table: a.table, eqRefCols: a.eqRefCols, range: a.range ? { loCol: a.range.loCol, hiCol: a.range.hiCol, loOp: a.range.loOp, hiOp: a.range.hiOp } : null });
    }
    node._spec = { indexId, valueCol: a.valueCol, eqProbes: a.eqProbes, posProbe: a.range ? a.range.posProbe : null };
  }
  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'Lookup') consider(e);
    expr(e.operand); expr(e.left); expr(e.right); expr(e.agg); expr(e.subject); expr(e.default); expr(e.predicate); expr(e.value);
    if (e.args) e.args.forEach(expr);
    if (e.arms) e.arms.forEach((arm) => { expr(arm.test); expr(arm.value); });
  }
  function stmt(st) {
    if (st.type === 'Assign') expr(st.value);
    else if (st.type === 'Check') expr(st.test);
    else if (st.type === 'If') { st.clauses.forEach((c) => { expr(c.test); c.body.forEach(stmt); }); if (st.alternate) st.alternate.forEach(stmt); }
  }
  ast.statements.forEach(stmt);
  return defs;
}

export function hasLookups(defs) { return !!(defs && defs.length); }

// Build each index once: a hash (eq-only) or per-eq-key sorted intervals (range).
export function buildLookups(defs, tables) {
  return defs.map((d) => {
    const refRows = refRowsOf(tables && tables[d.table]);
    if (!refRows) throw new Error(`over: lookup table "${d.table}" was not provided to run(rows, tables)`);
    const eqKey = (r) => d.eqRefCols.map((c) => String(r[c])).join(SEP);
    if (!d.range) {
      const m = new Map();
      for (const r of refRows) { const k = eqKey(r); if (!m.has(k)) m.set(k, r); }   // first wins
      return { range: false, m };
    }
    const groups = new Map();
    for (const r of refRows) {
      if (isAbsent(r[d.range.loCol]) || isAbsent(r[d.range.hiCol])) continue;
      const k = eqKey(r);
      let g = groups.get(k); if (!g) { g = []; groups.set(k, g); }
      g.push({ lo: r[d.range.loCol], hi: r[d.range.hiCol], row: r });
    }
    for (const g of groups.values()) g.sort((a, b) => numCmp(a.lo, b.lo));
    return { range: true, m: groups, loOp: d.range.loOp, hiOp: d.range.hiOp };
  });
}

// ctx.lookup(indexId, eqVals[], posVal, valueCol) — the row fn probes here.
export function makeLookup(indexes) {
  return (indexId, eqVals, posVal, valueCol) => {
    const idx = indexes[indexId];
    const eqKey = eqVals.map(String).join(SEP);
    if (!idx.range) {
      const row = idx.m.get(eqKey);
      if (!row) return null;
      const v = row[valueCol]; return v === undefined ? null : v;
    }
    if (isAbsent(posVal)) return null;
    const arr = idx.m.get(eqKey);
    if (!arr || !arr.length) return null;
    const loOk = idx.loOp === '<=' ? (lo) => numCmp(lo, posVal) <= 0 : (lo) => numCmp(lo, posVal) < 0;
    const hiOk = idx.hiOp === '>' ? (hi) => numCmp(posVal, hi) < 0 : (hi) => numCmp(posVal, hi) <= 0;
    let lo = 0, hi = arr.length - 1, found = -1;     // rightmost interval with lo "below" pos
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (loOk(arr[mid].lo)) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found < 0 || !hiOk(arr[found].hi)) return null;
    const v = arr[found].row[valueCol]; return v === undefined ? null : v;
  };
}
