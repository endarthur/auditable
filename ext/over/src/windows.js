// @gcu/over — window aggregates (SPEC §7, the `over` feature, the name).
// `agg(expr) over GROUP [order EXPR] [where EXPR]` — an aggregate over a group,
// used per row. Two-pass: pass 1 computes each window, pass 2 (the row body, via
// ctx.win) reads it.
//   • unordered (no `order`) → one value per group key (mean/sum/count/min/max/std).
//   • ordered (`order EXPR`) → a RUNNING value per row, accumulated in order within
//     the group (RUNLEN = sum(LENGTH) over BHID order DEPTH). Absorbs EXTRA's
//     first/prev/next accumulation idiom.
//   • `where EXPR` filters which rows participate in the accumulation.
// In-memory accumulators here; the sluice mergeable/parallel path is the big-data
// upgrade (the workbench pattern). Explicit prev/next/first/last lag-lead: next.

import { compileExpr } from './emit.js';
import { overRuntime } from './runtime.js';

const AGG = new Set(['count', 'sum', 'mean', 'min', 'max', 'std']);
const POSITIONAL = new Set(['prev', 'next', 'first', 'last']);   // lag/lead/edge — need `order`
const SEP = String.fromCharCode(1);   // group-key field separator

// missing = null (string absent) OR NaN (numeric absent) — aggregates skip it.
const isAbsent = (x) => x == null || x !== x;

// order comparator: numeric when both numbers else lexical; absent sorts last.
function cmpOrder(a, b) {
  const aa = isAbsent(a), bb = isAbsent(b);
  if (aa || bb) return aa && bb ? 0 : aa ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const keyOf = (group, get) => (group === 'all' ? '' : group.map((c) => String(get(c))).join(SEP));

// Walk every expression in the AST, tag each Window node with `_winId`, and
// return the window definitions (id, aggregate, arg, group, order, where).
export function collectWindows(ast) {
  const defs = [];

  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'Window') {
      const name = e.agg && e.agg.type === 'Call' ? e.agg.name : null;
      const isAgg = AGG.has(name), isPos = POSITIONAL.has(name);
      if (!isAgg && !isPos)
        throw new Error(`over: "${name}" is not a window function (aggregates: ${[...AGG].join('/')}; positional: ${[...POSITIONAL].join('/')})`);
      if (isPos && !e.order) throw new Error(`over: ${name}() needs an \`order\` — e.g. ${name}(FE) over BHID order DEPTH`);
      if (isPos && !(e.agg.args && e.agg.args[0])) throw new Error(`over: ${name}() needs a column argument`);
      e._winId = defs.length;
      defs.push({
        id: e._winId, aggName: e.agg.name, argExpr: e.agg.args[0] || null, group: e.group,
        orderExpr: e.order || null, whereExpr: e.where || null, ordered: !!e.order,
      });
    }
    expr(e.operand); expr(e.left); expr(e.right); expr(e.agg); expr(e.subject); expr(e.default);
    if (e.args) e.args.forEach(expr);
    if (e.arms) e.arms.forEach((a) => { expr(a.test); expr(a.value); });
  }
  function stmt(st) {
    if (st.type === 'Assign') expr(st.value);
    else if (st.type === 'If') { st.clauses.forEach((c) => { expr(c.test); c.body.forEach(stmt); }); if (st.alternate) st.alternate.forEach(stmt); }
  }
  ast.statements.forEach(stmt);
  return defs;
}

// A streaming accumulator per aggregate (absent ignored; count() counts rows). std
// is population std (Welford). For ordered windows the same accumulator is fed in
// sorted order, reading result() after each row → the running value.
function makeAcc(aggName) {
  switch (aggName) {
    case 'count': { let n = 0; return { add() { n++; }, result() { return n; } }; }
    case 'sum': { let s = 0, any = false; return { add(v) { if (!isAbsent(v)) { s += Number(v); any = true; } }, result() { return any ? s : NaN; } }; }
    case 'mean': { let s = 0, n = 0; return { add(v) { if (!isAbsent(v)) { s += Number(v); n++; } }, result() { return n ? s / n : NaN; } }; }
    case 'min': { let m = null; return { add(v) { if (!isAbsent(v)) { const x = Number(v); if (m == null || x < m) m = x; } }, result() { return m == null ? NaN : m; } }; }
    case 'max': { let m = null; return { add(v) { if (!isAbsent(v)) { const x = Number(v); if (m == null || x > m) m = x; } }, result() { return m == null ? NaN : m; } }; }
    case 'std': {
      let n = 0, mean = 0, m2 = 0;
      return { add(v) { if (!isAbsent(v)) { const x = Number(v); n++; const d = x - mean; mean += d / n; m2 += d * (x - mean); } }, result() { return n > 1 ? Math.sqrt(m2 / n) : 0; } };
    }
    default: throw new Error(`over: unknown aggregate "${aggName}"`);
  }
}

// Pass 1: compute each window — unordered (one value per group) or ordered (a
// running value per row). `where` filters which rows participate.
export function computeWindows(defs, rows) {
  return defs.map((d) => (d.ordered ? computeOrdered(d, rows) : computeUnordered(d, rows)));
}

function computeUnordered(d, rows) {
  const argFn = d.argExpr ? compileExpr(d.argExpr) : () => null;
  const whereFn = d.whereExpr ? compileExpr(d.whereExpr) : null;
  const accs = new Map();
  for (const row of rows) {
    if (whereFn && !overRuntime.truthy(whereFn(row))) continue;
    const key = keyOf(d.group, (c) => row[c]);
    let acc = accs.get(key);
    if (!acc) { acc = makeAcc(d.aggName); accs.set(key, acc); }
    acc.add(argFn(row));
  }
  const byKey = new Map();
  for (const [k, a] of accs) byKey.set(k, a.result());
  return { ordered: false, byKey };       // every group row sees byKey[its group]
}

function computeOrdered(d, rows) {
  const argFn = d.argExpr ? compileExpr(d.argExpr) : () => null;
  const orderFn = compileExpr(d.orderExpr);
  const whereFn = d.whereExpr ? compileExpr(d.whereExpr) : null;
  const byRow = new Array(rows.length).fill(NaN);   // rows not in the window stay NaN
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (whereFn && !overRuntime.truthy(whereFn(rows[i]))) continue;
    const key = keyOf(d.group, (c) => rows[i][c]);
    let g = groups.get(key); if (!g) { g = []; groups.set(key, g); }
    g.push(i);
  }
  const positional = POSITIONAL.has(d.aggName);
  for (const g of groups.values()) {
    g.sort((a, b) => cmpOrder(orderFn(rows[a]), orderFn(rows[b])));
    if (positional) {
      const last = g.length - 1;
      for (let k = 0; k <= last; k++) {
        let v;
        switch (d.aggName) {
          case 'first': v = argFn(rows[g[0]]); break;
          case 'last': v = argFn(rows[g[last]]); break;
          case 'prev': v = k > 0 ? argFn(rows[g[k - 1]]) : null; break;       // lag — absent at the edge
          case 'next': v = k < last ? argFn(rows[g[k + 1]]) : null; break;    // lead
        }
        byRow[g[k]] = v;
      }
    } else {
      const acc = makeAcc(d.aggName);
      for (const idx of g) { acc.add(argFn(rows[idx])); byRow[idx] = acc.result(); }   // running through this row
    }
  }
  return { ordered: true, byRow };
}

// Pass 2 lookup (called as ctx.win): unordered → keyParts (the working row's
// group-column values); ordered → rowIndex (the running value at that row).
export function winLookup(results, id, keyParts, rowIndex) {
  const r = results[id];
  if (!r) return null;
  if (r.ordered) return rowIndex == null ? null : (r.byRow[rowIndex] ?? null);
  const key = keyParts == null ? '' : keyParts.map(String).join(SEP);
  return r.byKey.has(key) ? r.byKey.get(key) : null;
}
