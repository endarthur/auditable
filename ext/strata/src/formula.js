// @gcu/strata — formula: compile a derived-column expression to a per-row fn.
//
// strata-spec §5: formulas are JS/adder expressions over columns, not a bespoke
// spreadsheet language. v1 compiles a JS expression to a function via `new
// Function` — a controlled emission site (emit JS string + new Function, no AIR
// routing; AIR is a later perf swap). The formula's column DEPS are the schema
// column names it references; the row's values for those columns are bound as
// arguments, so `grade * tonnes` becomes `(grade, tonnes) => grade * tonnes`.
//
// SECURITY NOTE: a formula runs when its .strata opens — the same trust model as
// a notebook cell (your own document). Sandboxing formulas from UNTRUSTED .strata
// files is a deferred concern, flagged here so it isn't forgotten.
//
// Pure (new Function is available in any JS env; no DOM). Node-testable.

// A derived cell whose formula threw for that row. Carried as the cell value;
// the provider renders it as state:error. Not serialized (derived columns
// recompute on load), so a Symbol is fine.
export const FORMULA_ERROR = Symbol('strata.formulaError');

// Identifiers in `formula` that match a known column name = the deps. Over-
// inclusion is harmless (an unused extra arg): a name appearing inside a string
// literal or as a property key may be picked up, but it only adds a bound arg.
export function extractDeps(formula, columnNames) {
  const names = new Set(columnNames);
  const ids = String(formula).match(/[A-Za-z_$][\w$]*/g) || [];
  const deps = [];
  const seen = new Set();
  for (const id of ids) {
    if (names.has(id) && !seen.has(id)) { seen.add(id); deps.push(id); }
  }
  return deps;
}

// Compile a formula → { formula, deps, fn }. `fn(...depValues)` evaluates one
// row. Throws (with a clear message) on a syntax error; per-row runtime errors
// are caught by the caller and surfaced as FORMULA_ERROR.
export function compileFormula(formula, columnNames) {
  const deps = extractDeps(formula, columnNames);
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(...deps, `"use strict"; return (${formula});`);
  } catch (e) {
    throw new Error(`strata formula compile error in "${formula}": ${e.message}`);
  }
  return { formula, deps, fn };
}
