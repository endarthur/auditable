// @gcu/over — window aggregates (SPEC §7, the `over` feature, the name).
// `agg(expr) over GROUP` = an aggregate over a group, used per row. Runs as a
// two-pass: pass 1 accumulates each window's aggregate per group key; pass 2 (the
// row body, via ctx.win) reads the per-group result. v0: unordered group
// aggregates {count, sum, mean, min, max, std} over `all` (whole table) or one/
// more columns; ordered windows (`order …`, running/lag) + `where` + `bin` later.
// In-memory accumulators here; the sluice mergeable/parallel path is the big-data
// upgrade (the workbench pattern).

import { compileExpr } from './emit.js';

const AGG = new Set(['count', 'sum', 'mean', 'min', 'max', 'std']);

// missing = null (string absent) OR NaN (numeric absent) — aggregates skip it.
const isAbsent = (x) => x == null || x !== x;

// Walk every expression in the AST, tag each Window node with `_winId`, and
// return the window definitions (id, aggregate, arg expression, group).
export function collectWindows(ast) {
  const defs = [];

  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'Window') {
      if (!e.agg || e.agg.type !== 'Call' || !AGG.has(e.agg.name))
        throw new Error(`over: "${e.agg && e.agg.name}" is not a window aggregate (${[...AGG].join('/')})`);
      e._winId = defs.length;
      defs.push({ id: e._winId, aggName: e.agg.name, argExpr: e.agg.args[0] || null, group: e.group });
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

// A streaming accumulator per aggregate (absent values are ignored — the natural
// behaviour; count() counts rows in the group). std is population std (Welford).
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

const keyOf = (group, get) => (group === 'all' ? '' : group.map((c) => String(get(c))).join(''));

// Pass 1: accumulate each window's aggregate per group → results[id] = Map(key→value).
export function computeWindows(defs, rows) {
  const argFns = defs.map((d) => (d.argExpr ? compileExpr(d.argExpr) : () => null));
  const accs = defs.map(() => new Map());
  for (const row of rows) {
    defs.forEach((d, i) => {
      const key = keyOf(d.group, (c) => row[c]);
      let acc = accs[i].get(key);
      if (!acc) { acc = makeAcc(d.aggName); accs[i].set(key, acc); }
      acc.add(argFns[i](row));
    });
  }
  return accs.map((m) => { const out = new Map(); for (const [k, a] of m) out.set(k, a.result()); return out; });
}

// Pass 2 lookup (called as ctx.win): keyParts is the working row's group-column
// values (or null for a whole-table window).
export function winLookup(results, id, keyParts) {
  const key = keyParts == null ? '' : keyParts.map(String).join('');
  const m = results[id];
  return m && m.has(key) ? m.get(key) : null;
}
