// @gcu/expr — the closure compiler (the hot path). Walks the AST ONCE into a tree
// of composed closures, binding field names to ARRAY INDICES at compile time
// against a `columns` list. The per-row function then takes a POSITIONAL `fields[]`
// and runs with no switch-dispatch, no AST re-traversal, and — crucially — no
// per-row name→value object allocation. That last point is why this exists: lamina's
// scan calls the compiled closure once per record over a 500M-row file, handed the
// positional `fields[]` the cursor already produced.
//
// `compile(ast, columns, opts)` is eval-free (no `new Function`) — CSP-safe — and
// reuses runtime.js's helpers verbatim, so a compiled closure is bit-identical to
// the tree-walk evaluator (eval.js). The correctness oracle in the tests asserts it.
// `opts.decimal === ','` binds a comma-aware numeric coercion once (closed over by
// the per-row closures, no per-row decimal arg). Field binding is CASE-INSENSITIVE
// against `columns` (geo columns are AU / IJK), unlike the tree-walk's exact-case
// object lookup — the two agree on any record whose keys match the columns.

import { asAst } from './parse.js';
import { makeNum, compare, contains, inSet, matches, makeRegExp, arith, FN, isBlank } from './runtime.js';

const BLANK = () => null;

// columns: array of names (strings) or { name } objects. → lower(name) → index.
// (exported for compile-chunk.js — one binding convention across both compilers)
export function indexMap(columns) {
  const m = new Map();
  (columns || []).forEach((c, i) => {
    const name = typeof c === 'string' ? c : (c && c.name);
    if (name != null && !m.has(String(name).toLowerCase())) m.set(String(name).toLowerCase(), i);
  });
  return m;
}

function walk(n, idx, N) {
  switch (n.t) {
    case 'num': case 'str': case 'bool': { const v = n.v; return () => v; }
    case 'blank': return BLANK;                            // the blank literal
    case 'field': {
      const i = idx.get(String(n.name).toLowerCase());
      if (i === undefined) return BLANK;                       // unknown column → blank (validate() reports it)
      return (f) => { const x = f[i]; return x === undefined ? null : x; };
    }
    case 'neg': { const c = walk(n.e, idx, N); return (f) => { const a = N(c(f)); return a === null ? null : -a; }; }
    case '+': case '-': case '*': case '/': {
      const cl = walk(n.l, idx, N), cr = walk(n.r, idx, N), t = n.t;
      return (f) => arith(t, N(cl(f)), N(cr(f)));
    }
    case 'cmp': { const cl = walk(n.l, idx, N), cr = walk(n.r, idx, N), o = n.op; return (f) => compare(cl(f), cr(f), o, N); }
    case 'between': {
      const ce = walk(n.e, idx, N), clo = walk(n.lo, idx, N), chi = walk(n.hi, idx, N);
      return (f) => { const ge = compare(ce(f), clo(f), '>=', N), le = compare(ce(f), chi(f), '<=', N); return (ge === null || le === null) ? null : (ge && le); };
    }
    case 'contains': { const cl = walk(n.l, idx, N), cr = walk(n.r, idx, N); return (f) => contains(cl(f), cr(f)); }
    case 'in': { const ce = walk(n.e, idx, N), cs = n.set.map((m) => walk(m, idx, N)); return (f) => inSet(ce(f), cs.map((c) => c(f))); }
    case 'matches': { const ce = walk(n.e, idx, N), re = makeRegExp(n.re); return (f) => matches(ce(f), re); }
    case 'call': {
      if (n.fn === 'if') { const cc = walk(n.args[0], idx, N), ct = walk(n.args[1], idx, N), ce = walk(n.args[2], idx, N); return (f) => (cc(f) === true ? ct(f) : ce(f)); }
      const cargs = n.args.map((a) => walk(a, idx, N)), fn = FN[n.fn];
      return (f) => fn(cargs.map((c) => c(f)), N);
    }
    case 'isblank': { const ce = walk(n.e, idx, N); return (f) => isBlank(ce(f)); }
    case 'isfilled': { const ce = walk(n.e, idx, N); return (f) => !isBlank(ce(f)); }
    case 'not': { const ce = walk(n.e, idx, N); return (f) => ce(f) !== true; }
    case 'and': { const cl = walk(n.l, idx, N), cr = walk(n.r, idx, N); return (f) => cl(f) === true && cr(f) === true; }
    case 'or': { const cl = walk(n.l, idx, N), cr = walk(n.r, idx, N); return (f) => cl(f) === true || cr(f) === true; }
  }
  return BLANK;
}

// compile(astOrSrc, columns, opts) → (fields[]) => value. Alias compileValue.
export function compile(exprOrAst, columns, opts = {}) {
  const c = walk(asAst(exprOrAst), indexMap(columns), makeNum(opts.decimal));
  return (fields) => { const r = c(fields || []); return r === undefined ? null : r; };
}
export const compileValue = compile;

// compileBool(astOrSrc, columns, opts) → (fields[]) => bool (blank → false). For filters.
export function compileBool(exprOrAst, columns, opts) {
  const c = compile(exprOrAst, columns, opts);
  return (fields) => c(fields) === true;
}
