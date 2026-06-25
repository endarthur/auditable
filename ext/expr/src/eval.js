// @gcu/expr — tree-walk evaluator. The REFERENCE path: walks the AST over a
// name-keyed record `values` (exact-case field lookup), used for interactive
// preview and as the compiler's correctness oracle. The hot per-row path is
// compile.js (positional closures); both share runtime.js so they agree.

import { asAst } from './parse.js';
import { makeNum, compare, contains, inSet, matches, makeRegExp, arith, FN, isBlank } from './runtime.js';

function ev(n, V, N) {
  switch (n.t) {
    case 'num': case 'str': case 'bool': return n.v;
    case 'field': { const x = V[n.name]; return x === undefined ? null : x; }
    case 'neg': { const a = N(ev(n.e, V, N)); return a === null ? null : -a; }
    case '+': case '-': case '*': case '/': return arith(n.t, N(ev(n.l, V, N)), N(ev(n.r, V, N)));
    case 'cmp': return compare(ev(n.l, V, N), ev(n.r, V, N), n.op, N);
    case 'between': {
      const ge = compare(ev(n.e, V, N), ev(n.lo, V, N), '>=', N), le = compare(ev(n.e, V, N), ev(n.hi, V, N), '<=', N);
      return (ge === null || le === null) ? null : (ge && le);
    }
    case 'contains': return contains(ev(n.l, V, N), ev(n.r, V, N));
    case 'in': return inSet(ev(n.e, V, N), n.set.map((m) => ev(m, V, N)));
    case 'matches': { if (n._re === undefined) n._re = makeRegExp(n.re); return matches(ev(n.e, V, N), n._re); }
    case 'call':
      if (n.fn === 'if') return ev(n.args[0], V, N) === true ? ev(n.args[1], V, N) : ev(n.args[2], V, N);   // lazy branches
      return FN[n.fn](n.args.map((a) => ev(a, V, N)), N);
    case 'isblank': return isBlank(ev(n.e, V, N));
    case 'isfilled': return !isBlank(ev(n.e, V, N));
    case 'not': return ev(n.e, V, N) !== true;
    case 'and': return ev(n.l, V, N) === true && ev(n.r, V, N) === true;
    case 'or': return ev(n.l, V, N) === true || ev(n.r, V, N) === true;
  }
  return null;
}

// Raw value: boolean, number, string, set, or `null` (blank). For a calc-column.
// opts.decimal === ',' reads comma-decimal field strings numerically.
export function evaluate(exprOrAst, values, opts = {}) {
  const r = ev(asAst(exprOrAst), values || {}, makeNum(opts.decimal));
  return r === undefined ? null : r;
}

// Boolean reading (blank → false): for a filter / predicate body.
export function evalBool(exprOrAst, values, opts) { return evaluate(exprOrAst, values, opts) === true; }

// A value is constraint-valid iff it is blank OR the constraint holds (carried
// from hopper — a useful "validation column" primitive; blank is require's job).
export function constraintValid(exprOrAst, values, target, opts) {
  if (isBlank((values || {})[target])) return true;
  return evaluate(exprOrAst, values, opts) === true;
}
