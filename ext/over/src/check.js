// @gcu/over — `check` (the validation report — the word in the app's name).
//
//   check "from before to":  FROM < TO
//   check "fe is a percent":  assays.fe <= 100
//   GAP = FROM - prev(TO) over hole order FROM
//   check "no downhole gaps": GAP == 0 or present(GAP) == false   # first interval has no prev
//
// A `check` is OBSERVATIONAL: rows pass through unchanged, and each rule accumulates
// a pass/fail count + a few offending rows into a report returned alongside the rows.
// It rides the existing machinery — the schema pass already resolves columns before a
// row runs (so a rule naming a missing column warns statically), and the executor
// already runs a row function with a ctx (so `check` just adds `ctx.check(id, bool)`).
// The report is a plain count, so it merges trivially for the big-data path later.

const SAMPLE_K = 5;   // offending rows kept per rule (for the report)

// A readable label for an unlabeled rule — a tiny unparse of the predicate; null for
// anything exotic (the caller falls back to `check N`).
function exprText(e) {
  if (!e || typeof e !== 'object') return null;
  switch (e.type) {
    case 'Num': return String(e.value);
    case 'Str': return JSON.stringify(e.value);
    case 'Bool': return String(e.value);
    case 'Absent': return 'absent';
    case 'Field': return e.name;
    case 'Qualified': return `${e.table}.${e.col}`;
    case 'Unary': { const o = exprText(e.operand); return o == null ? null : `-${o}`; }
    case 'Binary': { const l = exprText(e.left), r = exprText(e.right); return (l == null || r == null) ? null : `${l} ${e.op} ${r}`; }
    case 'Call': { const a = (e.args || []).map(exprText); return a.some((x) => x == null) ? null : `${e.name}(${a.join(', ')})`; }
    default: return null;
  }
}

// Tag each Check node with `_checkId` (in document order, descending into branches)
// and return the rule defs (id + label). Emit reads `_checkId`; the driver keys the
// report by id.
export function collectChecks(ast) {
  const defs = [];
  function stmt(st) {
    if (st.type === 'Check') {
      const id = defs.length;
      st._checkId = id;
      defs.push({ id, label: st.label || exprText(st.test) || `check ${id + 1}` });
    } else if (st.type === 'If') {
      st.clauses.forEach((c) => c.body.forEach(stmt));
      if (st.alternate) st.alternate.forEach(stmt);
    }
  }
  ast.statements.forEach(stmt);
  return defs;
}

export function hasChecks(defs) { return !!(defs && defs.length); }

// The per-run report accumulator. `check(id, ok, row)` from the row pass; `report()`
// → [{ rule, passed, failed, sample }] (sample = up to SAMPLE_K offending rows).
export function makeCheckReport(defs) {
  const acc = defs.map((d) => ({ rule: d.label, passed: 0, failed: 0, sample: [] }));
  return {
    check(id, ok, row) {
      const a = acc[id];
      if (ok) a.passed++;
      else { a.failed++; if (a.sample.length < SAMPLE_K) a.sample.push(row); }
    },
    report() { return acc; },
  };
}
