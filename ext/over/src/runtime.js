// @gcu/over — the `_over` runtime: the helpers + function registry the emitted row
// function calls. Semantics (SPEC §6 / locked decisions):
//   • absent (null) PROPAGATES through arithmetic; comparisons with absent → false;
//     absent is falsy in a guard. (Matches @gcu/sift's null semantics — one stack.)
//   • bool ↔ number coerce both ways (Number(true)===1; truthy(0)===false).
//
// Headless + pure; the AIR lowerer (next chunk) will emit equivalent calls/inline.

function num(x) { return x == null ? null : Number(x); }

// non-null comparison: numeric when both are numbers, else lexical (like sift)
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') { const x = Number(a), y = Number(b); return x - y; }
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export const overRuntime = {
  // ── value helpers ──
  isAbsent: (x) => x == null,
  present: (x) => x != null,
  truthy: (x) => x != null && x !== false && x !== 0 && x !== '',
  coalesce: (a, b) => (a == null ? b : a),

  // ── arithmetic (absent-propagating, bool→number) ──
  neg: (a) => (a == null ? null : -Number(a)),
  add: (a, b) => (a == null || b == null ? null : Number(a) + Number(b)),
  sub: (a, b) => (a == null || b == null ? null : Number(a) - Number(b)),
  mul: (a, b) => (a == null || b == null ? null : Number(a) * Number(b)),
  div: (a, b) => (a == null || b == null ? null : Number(a) / Number(b)),

  // ── comparison (absent → false; → bool) ──
  eq: (a, b) => a != null && b != null && (a === b || cmp(a, b) === 0),
  ne: (a, b) => a != null && b != null && !(a === b || cmp(a, b) === 0),
  lt: (a, b) => a != null && b != null && cmp(a, b) < 0,
  le: (a, b) => a != null && b != null && cmp(a, b) <= 0,
  gt: (a, b) => a != null && b != null && cmp(a, b) > 0,
  ge: (a, b) => a != null && b != null && cmp(a, b) >= 0,
  // match-arm relational dispatch
  rel: (op, a, b) => overRuntime[{ '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' }[op]](a, b),

  // ── logical (→ bool) ──
  and: (a, b) => overRuntime.truthy(a) && overRuntime.truthy(b),
  or: (a, b) => overRuntime.truthy(a) || overRuntime.truthy(b),
  not: (a) => !overRuntime.truthy(a),

  // ── function registry (dialect-shared core; native adds without breaking compat) ──
  fns: {
    abs: (x) => (x == null ? null : Math.abs(Number(x))),
    sqrt: (x) => (x == null ? null : Math.sqrt(Number(x))),
    exp: (x) => (x == null ? null : Math.exp(Number(x))),
    log: (x) => (x == null ? null : Math.log(Number(x))),     // EXTRA log == natural log
    loge: (x) => (x == null ? null : Math.log(Number(x))),
    logn: (x) => (x == null ? null : Math.log(Number(x))),
    log10: (x) => (x == null ? null : Math.log10(Number(x))),
    pow: (a, b) => (a == null || b == null ? null : Math.pow(Number(a), Number(b))),
    rais: (a, b) => (a == null || b == null ? null : Math.pow(Number(a), Number(b))),
    sin: (x) => (x == null ? null : Math.sin(Number(x))),
    cos: (x) => (x == null ? null : Math.cos(Number(x))),
    tan: (x) => (x == null ? null : Math.tan(Number(x))),
    asin: (x) => (x == null ? null : Math.asin(Number(x))),
    acos: (x) => (x == null ? null : Math.acos(Number(x))),
    atan: (x) => (x == null ? null : Math.atan(Number(x))),
    atan2: (a, b) => (a == null || b == null ? null : Math.atan2(Number(a), Number(b))),
    mod: (a, b) => (a == null || b == null ? null : Number(a) % Number(b)),
    int: (x) => (x == null ? null : Math.trunc(Number(x))),
    round: (x) => (x == null ? null : Math.round(Number(x))),
    // min/max ignore nothing; minia/maxia ignore absent (the EXTRA twins)
    min: (...a) => (a.some((x) => x == null) ? null : Math.min(...a.map(Number))),
    max: (...a) => (a.some((x) => x == null) ? null : Math.max(...a.map(Number))),
    minia: (...a) => { const v = a.filter((x) => x != null).map(Number); return v.length ? Math.min(...v) : null; },
    maxia: (...a) => { const v = a.filter((x) => x != null).map(Number); return v.length ? Math.max(...v) : null; },
    // strings
    len: (x) => (x == null ? 0 : String(x).length),
    ucase: (x) => (x == null ? null : String(x).toUpperCase()),
    lcase: (x) => (x == null ? null : String(x).toLowerCase()),
    trim: (x) => (x == null ? null : String(x).trim()),
    string: (x) => (x == null ? null : String(x)),
    concat: (...a) => a.map((x) => (x == null ? '' : String(x))).join(''),
    substr: (s, i, n) => (s == null ? null : String(s).substr(Number(i), n == null ? undefined : Number(n))),
  },

  call(name, ...args) {
    const f = this.fns[name];
    if (!f) throw new Error(`over: unknown function "${name}"`);
    return f(...args);
  },
};
