// @gcu/expr — runtime helpers shared by the tree-walk evaluator (eval.js) and the
// closure compiler (compile.js). Keeping the value semantics in ONE place is what
// makes the two paths bit-identical (the compiler's correctness oracle asserts it).
//
// The model: blank ≡ `null`. A single `absent` notion folds null/undefined/''/
// empty-array AND NaN together (the `x !== x` keystone), so a missing grade and a
// NaN behave identically — and NEVER auto-cast to 0 (that silently corrupts means
// / estimates; the ifnum/coalesce casts are the *explicit* opt-out). Every helper
// is total: bad input → blank, never a throw.

export function isBlank(v) {
  return v === null || v === undefined || v === '' || v !== v || (Array.isArray(v) && v.length === 0);
}
// Coerce to a finite number or null. Booleans/arrays/blank → null. (NaN folds into
// blank via isBlank's `v !== v`.)
export function num(v) {
  if (isBlank(v) || typeof v === 'boolean' || Array.isArray(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function ord(a, b, o) { return o === '<' ? a < b : o === '>' ? a > b : o === '<=' ? a <= b : a >= b; }
export function eq(a, b) {
  if (isBlank(a) && isBlank(b)) return true;       // blank = blank → true
  if (isBlank(a) || isBlank(b)) return false;      // x = blank → false
  const na = num(a), nb = num(b);
  return (na !== null && nb !== null) ? na === nb : String(a) === String(b);
}
export function compare(a, b, o) {
  if (o === '=') return eq(a, b);
  if (o === '!=') return !eq(a, b);
  if (isBlank(a) || isBlank(b)) return null;       // ordering on blank → blank
  const na = num(a), nb = num(b);
  return (na !== null && nb !== null) ? ord(na, nb, o) : ord(String(a), String(b), o);
}

// Finite-or-null guard for the math functions (keeps totality: ±Inf / NaN → blank).
const fin = (x) => (Number.isFinite(x) ? x : null);

// Eager pure functions: name → (args[]) => value. Args are already-evaluated
// values. `if` is NOT here (its branches are lazy — handled in each path). Every
// fn returns blank on bad/blank input unless it's an explicit cast.
export const FN = {
  round: (a) => { const x = num(a[0]); if (x === null) return null; const d = a.length > 1 ? Math.trunc(num(a[1]) || 0) : 0; const f = Math.pow(10, d); return Math.round(x * f) / f; },
  int: (a) => { const x = num(a[0]); return x === null ? null : Math.trunc(x); },
  abs: (a) => { const x = num(a[0]); return x === null ? null : Math.abs(x); },
  log: (a) => { const x = num(a[0]); return x === null ? null : fin(Math.log(x)); },
  exp: (a) => { const x = num(a[0]); return x === null ? null : fin(Math.exp(x)); },
  sqrt: (a) => { const x = num(a[0]); return x === null ? null : fin(Math.sqrt(x)); },
  pow: (a) => { const x = num(a[0]), y = num(a[1]); return (x === null || y === null) ? null : fin(Math.pow(x, y)); },
  min: (a) => { const ns = a.map(num).filter((x) => x !== null); return ns.length ? Math.min(...ns) : null; },
  max: (a) => { const ns = a.map(num).filter((x) => x !== null); return ns.length ? Math.max(...ns) : null; },
  clamp: (a) => { const x = num(a[0]), lo = num(a[1]), hi = num(a[2]); return (x === null || lo === null || hi === null) ? null : Math.min(Math.max(x, lo), hi); },
  // date parts: read YYYY-MM-DD off an ISO date/datetime string (regex, no Date dep)
  year: (a) => datePart(a[0], 1),
  month: (a) => datePart(a[0], 2),
  day: (a) => datePart(a[0], 3),
  // explicit absent-handling — the ONLY way a blank/NaN becomes a number:
  ifnum: (a) => { const x = num(a[0]); return x === null ? a[1] : x; },          // x if numeric, else the default
  coalesce: (a) => { for (const v of a) if (!isBlank(v)) return v; return null; }, // first non-blank
  isnum: (a) => num(a[0]) !== null,
  isnan: (a) => !isBlank(a[0]) && num(a[0]) === null,    // present but not a number (junk cell)
  isblank: (a) => isBlank(a[0]),
  isfilled: (a) => !isBlank(a[0]),
};

function datePart(v, g) {
  const m = isBlank(v) ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? Number(m[g]) : null;
}

// Shared non-function node ops (used by both paths so semantics can't drift).
export function arith(t, a, b) {
  if (a === null || b === null) return null;
  if (t === '+') return a + b;
  if (t === '-') return a - b;
  if (t === '*') return a * b;
  return b === 0 ? null : a / b;                  // ÷0 → blank, never throws
}
export function contains(a, b) {
  if (isBlank(a)) return false;
  const s = String(b);
  return Array.isArray(a) ? a.map(String).includes(s) : String(a).includes(s);
}
export function matches(a, re) {       // re = a precompiled RegExp or null (invalid pattern)
  if (isBlank(a) || !re) return false;
  return re.test(String(a));
}
export function makeRegExp(src) { try { return new RegExp(src); } catch { return null; } }
