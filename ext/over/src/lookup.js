// @gcu/over — lookup / equality join (multi-table). A row enriches itself from an
// injected reference table by an explicit key:
//
//   DENS = lookup(densities, "litho", LITHO, "density")
//          lookup(<table>,   <refKeyCol>, <probeExpr>, <valueCol>)
//
// table is an injected table (by name, via run(rows, { densities })); the ref key
// + value columns are explicit string literals (nothing inferred); the probe is any
// expression. Left-join: an unmatched key → absent. Build-once / probe-per-row, like
// windows: collectLookups → buildLookups (a hash per (table,key), cached) → the row
// fn probes via ctx.lookup. Interval/range joins add a second index shape next.

const SEP = String.fromCharCode(1);
const refRowsOf = (t) => (Array.isArray(t) ? t : (t && t.rows) || null);

// Validate a lookup Call's shape; returns { table, keyCol } | throws.
export function lookupSpec(call) {
  const a = call.args || [];
  if (a.length !== 4)
    throw new Error('over: lookup(table, "keyCol", probe, "valueCol") takes 4 arguments');
  if (a[0].type !== 'Field')
    throw new Error('over: lookup\'s first argument must be a table name');
  if (a[1].type !== 'Str' || a[3].type !== 'Str')
    throw new Error('over: lookup\'s key + value columns must be string literals');
  return { table: a[0].name, keyCol: a[1].value, valueCol: a[3].value, probe: a[2] };
}

// Walk the AST, find every lookup() Call, validate it, and return the unique
// (table, key) build specs.
export function collectLookups(ast) {
  const specs = [];
  const seen = new Set();

  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'Call' && e.name === 'lookup') {
      const s = lookupSpec(e);
      const k = s.table + SEP + s.keyCol;
      if (!seen.has(k)) { seen.add(k); specs.push({ table: s.table, keyCol: s.keyCol }); }
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
  return specs;
}

// Build one hash per (table, key): Map(keyValue → reference row). First row wins
// on a duplicate key. Throws if a referenced table wasn't provided.
export function buildLookups(specs, tables) {
  const indexes = new Map();
  for (const { table, keyCol } of specs) {
    const refRows = refRowsOf(tables && tables[table]);
    if (!refRows) throw new Error(`over: lookup table "${table}" was not provided to run(rows, tables)`);
    const m = new Map();
    for (const r of refRows) if (!m.has(r[keyCol])) m.set(r[keyCol], r);
    indexes.set(table + SEP + keyCol, m);
  }
  return indexes;
}

// The ctx.lookup probe (closes over the built indexes). Unmatched → null (absent).
export function makeLookup(indexes) {
  return (table, keyCol, keyVal, valCol) => {
    const m = indexes.get(table + SEP + keyCol);
    if (!m) return null;
    const row = m.get(keyVal);
    if (!row) return null;
    const v = row[valCol];
    return v === undefined ? null : v;
  };
}
