// @gcu/over — lookup / join (multi-table). A row enriches itself from an injected
// reference table. Two forms, both build-once / probe-per-row (the windows pattern):
//
//   equality:  DENS = lookup(densities, "litho", LITHO, "density")
//              lookup(<table>, <refKeyCol>, <probeExpr>, <valueCol>)
//              hash per (table,key) → O(1) probe.
//
//   interval:  CODE = lookup_in(domains, "hole", HOLE, "from", "to", DEPTH, "code")
//              lookup_in(<table>, <eqCol>, <eqProbe>, <loCol>, <hiCol>, <posExpr>, <valueCol>)
//              per-eq-key sorted-interval index → O(log M) binary search; the
//              geology join (desurvey / compositing / domain-by-depth). Half-open
//              [lo, hi): lo ≤ pos < hi (the universal downhole-interval convention).
//
// Tables injected by name (run(rows, { table })); all column names are EXPLICIT
// string literals (nothing inferred); left-join (unmatched → absent). Aggregating
// one-to-many joins (compositing) are a separate, bigger feature.

const SEP = String.fromCharCode(1);
const refRowsOf = (t) => (Array.isArray(t) ? t : (t && t.rows) || null);
const isAbsent = (x) => x == null || x !== x;
const numCmp = (a, b) => Number(a) - Number(b);

// ── shape validation ──
export function lookupSpec(call) {
  const a = call.args || [];
  if (a.length !== 4) throw new Error('over: lookup(table, "keyCol", probe, "valueCol") takes 4 arguments');
  if (a[0].type !== 'Field') throw new Error('over: lookup\'s first argument must be a table name');
  if (a[1].type !== 'Str' || a[3].type !== 'Str') throw new Error('over: lookup\'s key + value columns must be string literals');
  return { table: a[0].name, keyCol: a[1].value };
}

export function lookupInSpec(call) {
  const a = call.args || [];
  if (a.length !== 7) throw new Error('over: lookup_in(table, "eqCol", eqProbe, "loCol", "hiCol", posProbe, "valueCol") takes 7 arguments');
  if (a[0].type !== 'Field') throw new Error('over: lookup_in\'s first argument must be a table name');
  for (const i of [1, 3, 4, 6]) if (a[i].type !== 'Str') throw new Error('over: lookup_in\'s column names must be string literals');
  return { table: a[0].name, eqCol: a[1].value, loCol: a[3].value, hiCol: a[4].value };
}

// Walk the AST, validate every lookup()/lookup_in() Call, and return the unique
// build specs of each kind.
export function collectLookups(ast) {
  const eq = [], interval = [];
  const seenEq = new Set(), seenIv = new Set();

  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'Call' && e.name === 'lookup') {
      const s = lookupSpec(e); const k = s.table + SEP + s.keyCol;
      if (!seenEq.has(k)) { seenEq.add(k); eq.push(s); }
    } else if (e.type === 'Call' && e.name === 'lookup_in') {
      const s = lookupInSpec(e); const k = s.table + SEP + s.eqCol + SEP + s.loCol + SEP + s.hiCol;
      if (!seenIv.has(k)) { seenIv.add(k); interval.push(s); }
    }
    expr(e.operand); expr(e.left); expr(e.right); expr(e.agg); expr(e.subject); expr(e.default);
    if (e.args) e.args.forEach(expr);
    if (e.arms) e.arms.forEach((arm) => { expr(arm.test); expr(arm.value); });
  }
  function stmt(st) {
    if (st.type === 'Assign') expr(st.value);
    else if (st.type === 'If') { st.clauses.forEach((c) => { expr(c.test); c.body.forEach(stmt); }); if (st.alternate) st.alternate.forEach(stmt); }
  }
  ast.statements.forEach(stmt);
  return { eq, interval };
}

export function hasLookups(specs) { return !!(specs && (specs.eq.length || specs.interval.length)); }

// Build the indexes once, before the row pass.
export function buildLookups(specs, tables) {
  const eqIdx = new Map();        // (table,key) → Map(keyVal → row)
  const ivIdx = new Map();        // (table,eqCol,loCol,hiCol) → Map(eqVal → sorted [{lo,hi,row}])

  for (const { table, keyCol } of specs.eq) {
    const refRows = refRowsOf(tables && tables[table]);
    if (!refRows) throw new Error(`over: lookup table "${table}" was not provided to run(rows, tables)`);
    const m = new Map();
    for (const r of refRows) if (!m.has(r[keyCol])) m.set(r[keyCol], r);   // first wins
    eqIdx.set(table + SEP + keyCol, m);
  }

  for (const { table, eqCol, loCol, hiCol } of specs.interval) {
    const refRows = refRowsOf(tables && tables[table]);
    if (!refRows) throw new Error(`over: lookup_in table "${table}" was not provided to run(rows, tables)`);
    const groups = new Map();
    for (const r of refRows) {
      if (isAbsent(r[loCol]) || isAbsent(r[hiCol])) continue;             // skip malformed intervals
      const eqVal = r[eqCol];
      let g = groups.get(eqVal); if (!g) { g = []; groups.set(eqVal, g); }
      g.push({ lo: r[loCol], hi: r[hiCol], row: r });
    }
    for (const g of groups.values()) g.sort((a, b) => numCmp(a.lo, b.lo));
    ivIdx.set(table + SEP + eqCol + SEP + loCol + SEP + hiCol, groups);
  }

  return { eqIdx, ivIdx };
}

// ctx.lookup — equality probe. Unmatched → null (absent).
export function makeLookup(indexes) {
  return (table, keyCol, keyVal, valCol) => {
    const m = indexes.eqIdx.get(table + SEP + keyCol);
    const row = m && m.get(keyVal);
    if (!row) return null;
    const v = row[valCol];
    return v === undefined ? null : v;
  };
}

// ctx.lookupIn — interval probe. Binary-search the eq-group's sorted intervals for
// the half-open [lo, hi) containing pos. Out of any interval / unmatched → null.
export function makeLookupIn(indexes) {
  return (table, eqCol, eqVal, loCol, hiCol, pos, valCol) => {
    if (isAbsent(pos)) return null;
    const groups = indexes.ivIdx.get(table + SEP + eqCol + SEP + loCol + SEP + hiCol);
    const arr = groups && groups.get(eqVal);
    if (!arr || !arr.length) return null;
    // rightmost interval with lo <= pos
    let lo = 0, hi = arr.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (numCmp(arr[mid].lo, pos) <= 0) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found < 0) return null;
    const iv = arr[found];
    if (numCmp(pos, iv.hi) >= 0) return null;        // in a gap / past the last interval
    const v = iv.row[valCol];
    return v === undefined ? null : v;
  };
}
