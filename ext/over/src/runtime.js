// @gcu/over — the `_over` runtime: the helpers + function registry the emitted row
// function calls. Semantics (SPEC §6 / locked decisions):
//   • absent PROPAGATES through arithmetic; comparisons with absent → false; absent
//     is falsy in a guard. (Matches @gcu/sift's null semantics — one stack.)
//   • bool ↔ number coerce both ways (Number(true)===1; truthy(0)===false).
//
// REPRESENTATION (the keystone, spec_inbox/lang/air-strategy-by-shape.md): numeric
// absent is **NaN**, string/category absent is **null** — the type-polymorphic split.
// `isAbsent` recognizes both. Numeric computation produces NaN; columnar numeric
// storage (Float64Array) forces it. This is what lets the hot path fold to raw JS
// ops (NaN propagates through + and makes comparisons false, *natively*) and lets
// numeric columns be unboxed typed arrays — the door to vectorized / AIR-specialized
// / streaming emission. The handful of helpers below are the v0 (direct-emit) path;
// for proven-numeric operands they become raw ops once AIR lowers them.

// absent → NaN, anything else → its Number (NaN propagates; null does NOT become 0)
function n(x) { return x == null ? NaN : Number(x); }

// non-null/non-NaN comparison: numeric when both are numbers, else lexical (like sift)
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// missing = null (string/category absent) OR NaN (numeric absent). x !== x is the
// branch-free NaN test.
const isAbsent = (x) => x == null || x !== x;

export const overRuntime = {
  // ── value helpers ──
  isAbsent,
  present: (x) => !isAbsent(x),
  truthy: (x) => !isAbsent(x) && x !== false && x !== 0 && x !== '',
  coalesce: (a, b) => (isAbsent(a) ? b : a),

  // ── arithmetic (absent → NaN, propagates; bool → number) ──
  neg: (a) => -n(a),
  add: (a, b) => n(a) + n(b),
  sub: (a, b) => n(a) - n(b),
  mul: (a, b) => n(a) * n(b),
  div: (a, b) => n(a) / n(b),

  // ── comparison (absent → false; → bool) ──
  eq: (a, b) => !isAbsent(a) && !isAbsent(b) && (a === b || cmp(a, b) === 0),
  ne: (a, b) => !isAbsent(a) && !isAbsent(b) && !(a === b || cmp(a, b) === 0),
  lt: (a, b) => !isAbsent(a) && !isAbsent(b) && cmp(a, b) < 0,
  le: (a, b) => !isAbsent(a) && !isAbsent(b) && cmp(a, b) <= 0,
  gt: (a, b) => !isAbsent(a) && !isAbsent(b) && cmp(a, b) > 0,
  ge: (a, b) => !isAbsent(a) && !isAbsent(b) && cmp(a, b) >= 0,
  rel: (op, a, b) => overRuntime[{ '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' }[op]](a, b),

  // ── logical (→ bool) ──
  and: (a, b) => overRuntime.truthy(a) && overRuntime.truthy(b),
  or: (a, b) => overRuntime.truthy(a) || overRuntime.truthy(b),
  not: (a) => !overRuntime.truthy(a),

  // ── function registry (dialect-shared core; native adds without breaking compat) ──
  // Numeric fns propagate absent as NaN (n(x)); string fns keep null for absent.
  fns: {
    abs: (x) => Math.abs(n(x)),
    sqrt: (x) => Math.sqrt(n(x)),
    exp: (x) => Math.exp(n(x)),
    log: (x) => Math.log(n(x)),                         // EXTRA log == natural log
    loge: (x) => Math.log(n(x)),
    logn: (x) => Math.log(n(x)),
    log10: (x) => Math.log10(n(x)),
    pow: (a, b) => Math.pow(n(a), n(b)),
    rais: (a, b) => Math.pow(n(a), n(b)),
    sin: (x) => Math.sin(n(x)),
    cos: (x) => Math.cos(n(x)),
    tan: (x) => Math.tan(n(x)),
    asin: (x) => Math.asin(n(x)),
    acos: (x) => Math.acos(n(x)),
    atan: (x) => Math.atan(n(x)),
    atan2: (a, b) => Math.atan2(n(a), n(b)),
    mod: (a, b) => n(a) % n(b),
    int: (x) => Math.trunc(n(x)),                       // NaN propagates
    round: (x) => Math.round(n(x)),
    // min/max propagate absent (NaN); minia/maxia ignore it (the EXTRA twins)
    min: (...a) => Math.min(...a.map(n)),
    max: (...a) => Math.max(...a.map(n)),
    minia: (...a) => { const v = a.filter((x) => !isAbsent(x)).map(Number); return v.length ? Math.min(...v) : NaN; },
    maxia: (...a) => { const v = a.filter((x) => !isAbsent(x)).map(Number); return v.length ? Math.max(...v) : NaN; },
    // strings — absent stays null (non-numeric)
    len: (x) => (isAbsent(x) ? 0 : String(x).length),
    ucase: (x) => (isAbsent(x) ? null : String(x).toUpperCase()),
    lcase: (x) => (isAbsent(x) ? null : String(x).toLowerCase()),
    trim: (x) => (isAbsent(x) ? null : String(x).trim()),
    string: (x) => (isAbsent(x) ? null : String(x)),
    concat: (...a) => a.map((x) => (isAbsent(x) ? '' : String(x))).join(''),
    substr: (s, i, k) => (isAbsent(s) ? null : String(s).substr(Number(i), k == null ? undefined : Number(k))),
  },

  call(name, ...args) {
    const f = this.fns[name];
    if (!f) throw new Error(`over: unknown function "${name}"`);
    return f(...args);
  },
};
