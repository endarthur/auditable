// @gcu/over — aggregating join (the natural seam past single-match `lookup`).
//
//   N     = count() where assays.hole == hole and assays.from < TO and assays.to > FROM
//   MAXFE = max(assays.fe) where assays.hole == hole and assays.from < TO and assays.to > FROM
//   GRADE = wmean(assays.fe, overlap) where assays.hole == hole and assays.from < TO and assays.to > FROM
//
// `AGG(args) where PREDICATE` (no `over` — that's a window over THIS table; this
// aggregates ANOTHER table). Same predicate machinery as `lookup`: the compiler
// reads the shape and picks the index — equality → hash groups; an equality + a
// range pair → per-eq-key sorted intervals. The difference from `lookup` is that we
// ENUMERATE every match and fold it through an accumulator instead of taking one.
//
//   • the range pair is an interval-OVERLAP query (`assays.from < TO and assays.to >
//     FROM` → ref intervals that overlap this row's [FROM, TO)); a contains predicate
//     (`from <= DEPTH < to`, as `lookup` uses) also works (matches collapse to a point).
//   • `overlap` (a contextual word inside the aggregate args) = the overlap length
//     between this row's interval and the matched row's — so length-weighting is one
//     word. It's derived from the predicate's interval bounds; 0 for a point query.
//   • aggregate args read the matched row via qualified refs (`assays.fe`) and this
//     row via bare names (`FROM`); left-join (no matches → absent / count 0).
//
// In-memory build-once-probe, like `lookup`; the sluice mergeable path is the
// big-data upgrade. Index defs dedup by (table, eq-cols, range-cols).

import { analyzePredicate, tableOfPredicate } from './lookup.js';
import { emitExpr } from './emit.js';
import { overRuntime } from './runtime.js';
import { makeAcc } from './windows.js';

const SEP = String.fromCharCode(1);
const refRowsOf = (t) => (Array.isArray(t) ? t : (t && t.rows) || null);
const isAbsent = (x) => x == null || x !== x;
const numCmp = (a, b) => Number(a) - Number(b);
const JOIN_AGG = new Set(['count', 'sum', 'mean', 'min', 'max', 'std', 'wmean']);

// weighted mean — Σ(value·weight)/Σ(weight); absent value OR weight skips the pair.
function makeWAcc() {
  let sw = 0, swv = 0;
  return { add(v, w) { if (!isAbsent(v) && !isAbsent(w)) { const ww = Number(w); sw += ww; swv += Number(v) * ww; } }, result() { return sw ? swv / sw : NaN; } };
}

// emit context for an aggregate argument: bare name → this row (`row`), qualified
// ref → the matched row (`ref`), the word `overlap` → the per-match length (`ov`).
function joinArgEc(table) {
  return {
    ref: (name) => (name === 'overlap' ? 'ov' : `row[${JSON.stringify(name)}]`),
    qualified: (e) => {
      if (e.table !== table) throw new Error(`over: a join references two tables ("${table}" and "${e.table}") — one table per join`);
      return `ref[${JSON.stringify(e.col)}]`;
    },
    defaults: new Map(),
    onWindow: () => { throw new Error('over: a window aggregate cannot nest inside a join aggregate'); },
    hasCtx: false,                  // no lookup / join nesting inside an arg
  };
}

function compileArg(expr, table) {
  const fn = new Function('ref', 'row', 'ov', '_over', `return ${emitExpr(expr, joinArgEc(table))};`);
  return (ref, row, ov) => fn(ref, row, ov, overRuntime);
}

// Collect JoinAgg nodes: validate, compile the per-match arg/weight functions, tag
// each node with `_jaSpec` (eq/lo/hi probes — emitted against THIS row), and return
// the specs (one per node, indexed by jaId; `.indexKey` dedups the built index).
export function collectJoinAggs(ast) {
  const specs = [];

  function consider(node) {
    const agg = node.agg;
    const aggName = agg && agg.type === 'Call' ? agg.name : null;
    if (!JOIN_AGG.has(aggName))
      throw new Error(`over: a join aggregate must be ${[...JOIN_AGG].join('/')} — got ${aggName ? `"${aggName}()"` : 'a non-aggregate'} before \`where\``);
    const table = tableOfPredicate(node.predicate);
    if (!table) throw new Error('over: a join `where` must compare a table column (e.g. `assays.hole == hole`)');
    const { eqRefCols, eqProbes, range } = analyzePredicate(node.predicate, table);

    let argFn = null, weightFn = null;
    const args = agg.args || [];
    if (aggName === 'count') { if (args.length) throw new Error('over: count() takes no argument in a join'); }
    else if (aggName === 'wmean') {
      if (args.length !== 2) throw new Error('over: wmean(value, weight) needs a value and a weight');
      argFn = compileArg(args[0], table); weightFn = compileArg(args[1], table);
    } else {
      if (args.length !== 1) throw new Error(`over: ${aggName}(value) needs one argument in a join`);
      argFn = compileArg(args[0], table);
    }

    const rk = range ? `${range.loCol}|${range.hiCol}|${range.loOp}|${range.hiOp}` : '';
    const indexKey = table + SEP + eqRefCols.join(',') + SEP + rk;
    const jaId = specs.length;
    specs.push({
      jaId, indexKey, table, eqRefCols, aggName, argFn, weightFn,
      range: range ? { loCol: range.loCol, hiCol: range.hiCol, loOp: range.loOp, hiOp: range.hiOp } : null,
    });
    node._jaSpec = { jaId, eqProbes, loProbe: range ? range.loProbe : null, hiProbe: range ? range.hiProbe : null };
  }

  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'JoinAgg') consider(e);
    expr(e.operand); expr(e.left); expr(e.right); expr(e.agg); expr(e.subject); expr(e.default); expr(e.predicate); expr(e.value);
    if (e.args) e.args.forEach(expr);
    if (e.arms) e.arms.forEach((a) => { expr(a.test); expr(a.value); });
  }
  function stmt(st) {
    if (st.type === 'Assign') expr(st.value);
    else if (st.type === 'If') { st.clauses.forEach((c) => { expr(c.test); c.body.forEach(stmt); }); if (st.alternate) st.alternate.forEach(stmt); }
  }
  ast.statements.forEach(stmt);
  return specs;
}

export function hasJoinAggs(specs) { return !!(specs && specs.length); }

// Build each index once (deduped by indexKey): eq-only → hash of eq-key → [rows];
// range → per-eq-key intervals sorted ascending by lo (for the prefix scan).
export function buildJoinIndexes(specs, tables) {
  const byKey = new Map();
  for (const s of specs) {
    if (byKey.has(s.indexKey)) continue;
    const refRows = refRowsOf(tables && tables[s.table]);
    if (!refRows) throw new Error(`over: join table "${s.table}" was not provided to run(rows, tables)`);
    const eqKey = (r) => s.eqRefCols.map((c) => String(r[c])).join(SEP);
    if (!s.range) {
      const m = new Map();
      for (const r of refRows) { const k = eqKey(r); let g = m.get(k); if (!g) { g = []; m.set(k, g); } g.push(r); }
      byKey.set(s.indexKey, { range: false, m });
    } else {
      const groups = new Map();
      for (const r of refRows) {
        if (isAbsent(r[s.range.loCol]) || isAbsent(r[s.range.hiCol])) continue;
        const k = eqKey(r);
        let g = groups.get(k); if (!g) { g = []; groups.set(k, g); }
        g.push({ lo: r[s.range.loCol], hi: r[s.range.hiCol], row: r });
      }
      for (const g of groups.values()) g.sort((a, b) => numCmp(a.lo, b.lo));
      byKey.set(s.indexKey, { range: true, m: groups, loOp: s.range.loOp, hiOp: s.range.hiOp });
    }
  }
  return byKey;
}

function feed(acc, s, ref, row, ov) {
  if (s.aggName === 'count') { acc.add(1); return; }
  if (s.aggName === 'wmean') { acc.add(s.argFn(ref, row, ov), s.weightFn(ref, row, ov)); return; }
  acc.add(s.argFn ? s.argFn(ref, row, ov) : null);
}

// ctx.joinAgg(jaId, eqVals[], loVal, hiVal, row) — enumerate the matches, fold them.
export function makeJoinAgg(byKey, specs) {
  return (jaId, eqVals, loVal, hiVal, row) => {
    const s = specs[jaId];
    const idx = byKey.get(s.indexKey);
    const eqKey = eqVals.map(String).join(SEP);
    const acc = s.aggName === 'wmean' ? makeWAcc() : makeAcc(s.aggName);

    if (!idx.range) {
      const arr = idx.m.get(eqKey);
      if (arr) for (const r of arr) feed(acc, s, r, row, 0);
      return acc.result();
    }
    const arr = idx.m.get(eqKey);
    if (arr && arr.length) {
      const loOk = idx.loOp === '<' ? (lo) => numCmp(lo, loVal) < 0 : (lo) => numCmp(lo, loVal) <= 0;
      const hiOk = idx.hiOp === '>' ? (hi) => numCmp(hi, hiVal) > 0 : (hi) => numCmp(hi, hiVal) >= 0;
      // sorted asc by lo, so loOk is a true-prefix → binary-search its length.
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (loOk(arr[mid].lo)) lo = mid + 1; else hi = mid; }
      for (let k = 0; k < lo; k++) {
        const e = arr[k];
        if (!hiOk(e.hi)) continue;          // overlaps on lo, but not on hi
        const ov = Math.max(0, Math.min(Number(loVal), Number(e.hi)) - Math.max(Number(hiVal), Number(e.lo)));
        feed(acc, s, e.row, row, ov);
      }
    }
    return acc.result();
  };
}
