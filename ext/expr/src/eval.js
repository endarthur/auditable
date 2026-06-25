// @gcu/expr — tree-walk evaluator. The REFERENCE path: walks the AST over a
// name-keyed record `values` (exact-case field lookup), used for interactive
// preview and as the compiler's correctness oracle. The hot per-row path is
// compile.js (positional closures); both share runtime.js so they agree.

import { asAst } from './parse.js';
import { num, compare, contains, matches, makeRegExp, arith, FN, isBlank } from './runtime.js';

function ev(n, V) {
  switch (n.t) {
    case 'num': case 'str': case 'bool': return n.v;
    case 'field': { const x = V[n.name]; return x === undefined ? null : x; }
    case 'neg': { const a = num(ev(n.e, V)); return a === null ? null : -a; }
    case '+': case '-': case '*': case '/': return arith(n.t, num(ev(n.l, V)), num(ev(n.r, V)));
    case 'cmp': return compare(ev(n.l, V), ev(n.r, V), n.op);
    case 'between': {
      const ge = compare(ev(n.e, V), ev(n.lo, V), '>='), le = compare(ev(n.e, V), ev(n.hi, V), '<=');
      return (ge === null || le === null) ? null : (ge && le);
    }
    case 'contains': return contains(ev(n.l, V), ev(n.r, V));
    case 'matches': { if (n._re === undefined) n._re = makeRegExp(n.re); return matches(ev(n.e, V), n._re); }
    case 'call':
      if (n.fn === 'if') return ev(n.args[0], V) === true ? ev(n.args[1], V) : ev(n.args[2], V);   // lazy branches
      return FN[n.fn](n.args.map((a) => ev(a, V)));
    case 'isblank': return isBlank(ev(n.e, V));
    case 'isfilled': return !isBlank(ev(n.e, V));
    case 'not': return ev(n.e, V) !== true;
    case 'and': return ev(n.l, V) === true && ev(n.r, V) === true;
    case 'or': return ev(n.l, V) === true || ev(n.r, V) === true;
  }
  return null;
}

// Raw value: boolean, number, string, set, or `null` (blank). For a calc-column.
export function evaluate(exprOrAst, values) {
  const r = ev(asAst(exprOrAst), values || {});
  return r === undefined ? null : r;
}

// Boolean reading (blank → false): for a filter / predicate body.
export function evalBool(exprOrAst, values) { return evaluate(exprOrAst, values) === true; }

// A value is constraint-valid iff it is blank OR the constraint holds (carried
// from hopper — a useful "validation column" primitive; blank is require's job).
export function constraintValid(exprOrAst, values, target) {
  if (isBlank((values || {})[target])) return true;
  return evaluate(exprOrAst, values) === true;
}
