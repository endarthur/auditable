// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/expr — A small, total, CSP-safe expression calculus over one record's fields — arithmetic, comparisons, boolean (and/or/not), between/contains/matches, is blank/filled, and a pure function set (if/round/int/abs, dates, geo math log/exp/sqrt/pow/min/max/clamp, casts ifnum/coalesce, tests isnum/isnan/isblank/isfilled). Two faces (value + boolean), two paths (tree-walk reference + compiled positional closures, no eval/new Function), analyzable (deps + validate). The shared small tier of the GCU expression stack; powers lamina calc-columns + filters. Carried from hopper's rule engine.

// ── src/parse.js ──

// @gcu/expr — parser. A small, *total*, pure expression calculus over the fields
// of one record. Totality is the security boundary: no loops, recursion, I/O, or
// unbounded ops; every expression terminates and (post-parse) never throws at eval
// time. Carried from hopper's rule engine (SPEC-hopper-rules §3), then adapted for
// the GCU data stack: repeat-aggregates dropped (v1 non-goal), min/max repurposed
// as scalar functions, a geo math + cast/test function set added, identifiers made
// case-insensitive (geo columns are AU / IJK / OK-Indic), and the field escape
// switched from `${id}` to a `["any column name"]` bracket.
//
// Pipeline: tokenize → parse to an analyzable AST. `evaluate` (tree-walk, the
// reference path) and `compile` (positional closures, the hot path) consume the
// AST; `deps`/`validate` analyze it. Blank is represented as `null`.
//
// Precedence ladder (low→high): or < and < not < comparison < additive <
// multiplicative < unary < primary — so `(` is an unambiguous full sub-expression.

// Keyword operators + the words after `is` — matched case-insensitively. A column
// literally named one of these must use the ["…"] bracket escape.
const RESERVED = new Set(['and', 'or', 'not', 'between', 'contains', 'in', 'matches', 'is', 'blank', 'filled', 'true', 'false']);

// Pure total functions: name → [minArgs, maxArgs]. Carried (if/round/int/abs +
// date parts) + geo math (log/exp/sqrt/pow/min/max/clamp) + explicit absent
// handling (casts ifnum/coalesce, tests isnum/isnan/isblank/isfilled). `if` is
// special (lazy branches) but listed here for arity + call-syntax recognition.
const CALLFNS = {
  if: [3, 3], round: [1, 2], int: [1, 1], abs: [1, 1],
  year: [1, 1], month: [1, 1], day: [1, 1],
  log: [1, 1], exp: [1, 1], sqrt: [1, 1], pow: [2, 2], min: [1, Infinity], max: [1, Infinity], clamp: [3, 3],
  ifnum: [2, 2], coalesce: [1, Infinity], isnum: [1, 1], isnan: [1, 1], isblank: [1, 1], isfilled: [1, 1],
};

class ExprParseError extends Error {
  constructor(msg) { super('expr parse error: ' + msg); this.name = 'ExprParseError'; }
}
function fail(msg) { throw new ExprParseError(msg); }

// ── lexer ──────────────────────────────────────────────────────────────────
// Bare field refs are case-insensitive idents. Because `-` is a valid ident char
// (so hyphenated column names like OK-Indic lex as one token), SUBTRACTION needs
// surrounding space (`a - 5`); `a-5` lexes as the single ident "a-5". A `["…"]`
// bracket escapes any column name (spaces, punctuation, leading digit, keyword).
function tokenize(src) {
  // Multi-char ops first (longest match): && || == <= >= != !~ , then single < > = ~.
  const re = /(\s+)|(\[\s*"[^"]*"\s*\])|("[^"]*")|(&&|\|\||==|<=|>=|!=|!~|<|>|=|~)|([-+*/().,])|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_-]*)/y;
  const toks = [];
  let last = 0;
  while (last < src.length) {
    re.lastIndex = last;
    const m = re.exec(src);
    if (!m) fail(`unexpected character at ${last}: "${src.slice(last, last + 8)}"`);
    last = re.lastIndex;
    if (m[1] !== undefined) continue;                                       // whitespace
    else if (m[2] !== undefined) toks.push({ k: 'field', v: m[2].replace(/^\[\s*"/, '').replace(/"\s*\]$/, '') });
    else if (m[3] !== undefined) toks.push({ k: 'str', v: m[3].slice(1, -1) });
    else if (m[4] !== undefined) toks.push({ k: 'op', v: m[4] });
    else if (m[5] !== undefined) toks.push({ k: 'op', v: m[5] });
    else if (m[6] !== undefined) toks.push({ k: 'num', v: parseFloat(m[6]) });
    else toks.push({ k: 'word', v: m[7] });
  }
  return toks;
}

// ── parser ───────────────────────────────────────────────────────────────────
function parse(src) {
  const toks = tokenize(src);
  let i = 0;
  const op = (v) => toks[i] && toks[i].k === 'op' && toks[i].v === v;
  const word = (v) => toks[i] && toks[i].k === 'word' && toks[i].v.toLowerCase() === v;   // keywords are case-insensitive
  const eatOp = (v) => { if (!op(v)) fail(`expected '${v}'`); i++; };

  function primary() {
    const t = toks[i];
    if (!t) fail('unexpected end of expression');
    if (t.k === 'op' && t.v === '(') { i++; const e = expr(); eatOp(')'); return e; }
    if (t.k === 'num') { i++; return { t: 'num', v: t.v }; }
    if (t.k === 'str') { i++; return { t: 'str', v: t.v }; }
    if (t.k === 'field') { i++; return { t: 'field', name: t.v }; }     // ["…"] bracket escape
    if (t.k === 'word') {
      const lw = t.v.toLowerCase();
      // pure function call: fn ( expr [, expr]* ) — args are full expressions
      if (CALLFNS[lw] && toks[i + 1] && toks[i + 1].k === 'op' && toks[i + 1].v === '(') {
        i += 2;
        const args = [];
        if (!op(')')) { args.push(expr()); while (op(',')) { i++; args.push(expr()); } }
        eatOp(')');
        const [lo, hi] = CALLFNS[lw];
        if (args.length < lo || args.length > hi) fail(`${lw}() expects ${lo === hi ? lo : (hi === Infinity ? `${lo}+` : `${lo}–${hi}`)} argument(s), got ${args.length}`);
        return { t: 'call', fn: lw, args };
      }
      i++;
      if (lw === 'true') return { t: 'bool', v: true };
      if (lw === 'false') return { t: 'bool', v: false };
      if (RESERVED.has(lw)) fail(`unexpected keyword '${t.v}'`);
      return { t: 'field', name: t.v };                                 // bare ident → field (original case kept)
    }
    fail(`unexpected '${t.v}'`);
  }
  function unary() {
    if (op('-') || op('+')) { const neg = op('-'); i++; const e = unary(); return neg ? { t: 'neg', e } : e; }
    return primary();
  }
  function mul() {
    let l = unary();
    while (op('*') || op('/')) { const o = toks[i].v; i++; l = { t: o, l, r: unary() }; }
    return l;
  }
  function add() {
    let l = mul();
    while (op('+') || op('-')) { const o = toks[i].v; i++; l = { t: o, l, r: mul() }; }
    return l;
  }
  function comparison() {
    const l = add();
    if (op('<') || op('>') || op('<=') || op('>=') || op('=') || op('==') || op('!=')) {
      let o = toks[i].v; i++; if (o === '==') o = '=';                  // == is an alias for =
      return { t: 'cmp', op: o, l, r: add() };
    }
    if (op('~')) { i++; return { t: 'contains', l, r: add() }; }        // a ~ b  (substring / membership)
    if (op('!~')) { i++; return { t: 'not', e: { t: 'contains', l, r: add() } }; }
    if (word('between')) { i++; const lo = add(); if (!(word('and') || op('&&'))) fail("expected 'and' in between"); i++; return { t: 'between', e: l, lo, hi: add() }; }
    if (word('contains')) { i++; return { t: 'contains', l, r: add() }; }
    if (word('in')) { i++; const set = [add()]; while (op(',')) { i++; set.push(add()); } return { t: 'in', e: l, set }; }
    if (word('matches')) { i++; if (!toks[i] || toks[i].k !== 'str') fail("'matches' needs a string literal"); const re = toks[i].v; i++; return { t: 'matches', e: l, re }; }
    if (word('is')) { i++; if (word('blank')) { i++; return { t: 'isblank', e: l }; } if (word('filled')) { i++; return { t: 'isfilled', e: l }; } fail("'is' must be followed by 'blank' or 'filled'"); }
    return l;
  }
  function notE() { if (word('not')) { i++; return { t: 'not', e: comparison() }; } return comparison(); }
  function andE() { let l = notE(); while (word('and') || op('&&')) { i++; l = { t: 'and', l, r: notE() }; } return l; }
  function orE() { let l = andE(); while (word('or') || op('||')) { i++; l = { t: 'or', l, r: andE() }; } return l; }
  function expr() { return orE(); }

  const ast = expr();
  if (i < toks.length) fail(`trailing input near '${toks[i].v}'`);
  return ast;
}

const asAst = (x) => (typeof x === 'string' ? parse(x) : x);

// ── src/runtime.js ──

// @gcu/expr — runtime helpers shared by the tree-walk evaluator (eval.js) and the
// closure compiler (compile.js). Keeping the value semantics in ONE place is what
// makes the two paths bit-identical (the compiler's correctness oracle asserts it).
//
// The model: blank ≡ `null`, and a single `absent` notion folds null/undefined/''/
// empty-array AND NaN together (the `x !== x` keystone), so a missing grade and a
// NaN behave identically — and NEVER auto-cast to 0 (that silently corrupts means /
// estimates; the ifnum/coalesce casts are the *explicit* opt-out). Every helper is
// total: bad input → blank, never a throw.
//
// `num` is the single numeric-coercion point; eval/compile pass a decimal-bound
// `N` (= makeNum(decimal)) into the helpers so a comma-decimal file (BR/EU) reads
// numerically. The default is dot-decimal — existing callers are unaffected.

function isBlank(v) {
  return v === null || v === undefined || v === '' || v !== v || (Array.isArray(v) && v.length === 0);
}
// Coerce to a finite number or null. Booleans/arrays/blank → null. A comma-decimal
// string is honoured only when decimal === ',' (and only for STRING values — an
// actual number is used directly, so 3.5 never becomes 35).
function num(v, decimal) {
  if (isBlank(v) || typeof v === 'boolean' || Array.isArray(v)) return null;
  if (decimal === ',' && typeof v === 'string') { const n = Number(v.replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// A decimal-bound num for the hot path (compile binds it once; the per-row closures
// close over it, no per-call decimal arg).
function makeNum(decimal) { return decimal === ',' ? (v) => num(v, ',') : num; }

function ord(a, b, o) { return o === '<' ? a < b : o === '>' ? a > b : o === '<=' ? a <= b : a >= b; }
function eq(a, b, N = num) {
  if (isBlank(a) && isBlank(b)) return true;       // blank = blank → true
  if (isBlank(a) || isBlank(b)) return false;      // x = blank → false
  const na = N(a), nb = N(b);
  return (na !== null && nb !== null) ? na === nb : String(a) === String(b);
}
function compare(a, b, o, N = num) {
  if (o === '=') return eq(a, b, N);
  if (o === '!=') return !eq(a, b, N);
  if (isBlank(a) || isBlank(b)) return null;       // ordering on blank → blank
  const na = N(a), nb = N(b);
  return (na !== null && nb !== null) ? ord(na, nb, o) : ord(String(a), String(b), o);
}

const fin = (x) => (Number.isFinite(x) ? x : null);   // ±Inf / NaN → blank (totality)

// Eager pure functions: name → (args[], N) => value. Args are already-evaluated
// values; N is the decimal-bound num. `if` is NOT here (lazy branches — handled in
// each path). Every fn returns blank on bad/blank input unless it's an explicit cast.
const FN = {
  round: (a, N) => { const x = N(a[0]); if (x === null) return null; const d = a.length > 1 ? Math.trunc(N(a[1]) || 0) : 0; const f = Math.pow(10, d); return Math.round(x * f) / f; },
  int: (a, N) => { const x = N(a[0]); return x === null ? null : Math.trunc(x); },
  abs: (a, N) => { const x = N(a[0]); return x === null ? null : Math.abs(x); },
  log: (a, N) => { const x = N(a[0]); return x === null ? null : fin(Math.log(x)); },
  exp: (a, N) => { const x = N(a[0]); return x === null ? null : fin(Math.exp(x)); },
  sqrt: (a, N) => { const x = N(a[0]); return x === null ? null : fin(Math.sqrt(x)); },
  pow: (a, N) => { const x = N(a[0]), y = N(a[1]); return (x === null || y === null) ? null : fin(Math.pow(x, y)); },
  min: (a, N) => { const ns = a.map((v) => N(v)).filter((x) => x !== null); return ns.length ? Math.min(...ns) : null; },
  max: (a, N) => { const ns = a.map((v) => N(v)).filter((x) => x !== null); return ns.length ? Math.max(...ns) : null; },
  clamp: (a, N) => { const x = N(a[0]), lo = N(a[1]), hi = N(a[2]); return (x === null || lo === null || hi === null) ? null : Math.min(Math.max(x, lo), hi); },
  year: (a) => datePart(a[0], 1),
  month: (a) => datePart(a[0], 2),
  day: (a) => datePart(a[0], 3),
  ifnum: (a, N) => { const x = N(a[0]); return x === null ? a[1] : x; },          // x if numeric, else the default
  coalesce: (a) => { for (const v of a) if (!isBlank(v)) return v; return null; }, // first non-blank
  isnum: (a, N) => N(a[0]) !== null,
  isnan: (a, N) => !isBlank(a[0]) && N(a[0]) === null,    // present but not a number (junk cell)
  isblank: (a) => isBlank(a[0]),
  isfilled: (a) => !isBlank(a[0]),
};

function datePart(v, g) {
  const m = isBlank(v) ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? Number(m[g]) : null;
}

// Shared non-function node ops (used by both paths so semantics can't drift).
function arith(t, a, b) {
  if (a === null || b === null) return null;
  if (t === '+') return a + b;
  if (t === '-') return a - b;
  if (t === '*') return a * b;
  return b === 0 ? null : a / b;                  // ÷0 → blank, never throws
}
function contains(a, b) {
  if (isBlank(a)) return false;
  const s = String(b);
  return Array.isArray(a) ? a.map(String).includes(s) : String(a).includes(s);
}
// Set membership: the value (stringified) is one of the listed members (stringified).
function inSet(a, members) {
  if (isBlank(a)) return false;
  const s = String(a);
  return members.some((m) => !isBlank(m) && String(m) === s);
}
function matches(a, re) {       // re = a precompiled RegExp or null (invalid pattern)
  if (isBlank(a) || !re) return false;
  return re.test(String(a));
}
function makeRegExp(src) { try { return new RegExp(src); } catch { return null; } }

// ── src/eval.js ──

// @gcu/expr — tree-walk evaluator. The REFERENCE path: walks the AST over a
// name-keyed record `values` (exact-case field lookup), used for interactive
// preview and as the compiler's correctness oracle. The hot per-row path is
// compile.js (positional closures); both share runtime.js so they agree.


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
function evaluate(exprOrAst, values, opts = {}) {
  const r = ev(asAst(exprOrAst), values || {}, makeNum(opts.decimal));
  return r === undefined ? null : r;
}

// Boolean reading (blank → false): for a filter / predicate body.
function evalBool(exprOrAst, values, opts) { return evaluate(exprOrAst, values, opts) === true; }

// A value is constraint-valid iff it is blank OR the constraint holds (carried
// from hopper — a useful "validation column" primitive; blank is require's job).
function constraintValid(exprOrAst, values, target, opts) {
  if (isBlank((values || {})[target])) return true;
  return evaluate(exprOrAst, values, opts) === true;
}

// ── src/compile.js ──

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


const BLANK = () => null;

// columns: array of names (strings) or { name } objects. → lower(name) → index.
function indexMap(columns) {
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
function compile(exprOrAst, columns, opts = {}) {
  const c = walk(asAst(exprOrAst), indexMap(columns), makeNum(opts.decimal));
  return (fields) => { const r = c(fields || []); return r === undefined ? null : r; };
}
const compileValue = compile;

// compileBool(astOrSrc, columns, opts) → (fields[]) => bool (blank → false). For filters.
function compileBool(exprOrAst, columns, opts) {
  const c = compile(exprOrAst, columns, opts);
  return (fields) => c(fields) === true;
}

// ── src/analyze.js ──

// @gcu/expr — static analysis over the AST: `deps` (the free column references, for
// reactive wiring + lamina's parseFields column-pushdown) and `validate` (parse +
// unknown-column check, for the filter box / calc-column editor's live feedback).


// Free field references — the expression's source columns (original case, deduped).
function deps(exprOrAst) {
  const out = new Set();
  (function descend(n) {
    if (!n || typeof n !== 'object') return;
    if (n.t === 'field') { out.add(n.name); return; }
    if (Array.isArray(n.args)) for (const a of n.args) descend(a);   // function-call args
    if (Array.isArray(n.set)) for (const a of n.set) descend(a);     // `in` set members
    for (const k of ['e', 'l', 'r', 'lo', 'hi']) if (n[k]) descend(n[k]);
  })(asAst(exprOrAst));
  return [...out];
}

// Parse + (when `columns` is given) check every field ref resolves, case-insensitively.
// → { ok, errors: [{ kind, message, name? }] }. Never throws.
function validate(exprOrAst, columns) {
  let ast;
  try { ast = asAst(exprOrAst); }
  catch (e) { return { ok: false, errors: [{ kind: 'parse', message: (e instanceof ExprParseError ? e.message : String(e && e.message || e)) }] }; }
  const errors = [];
  if (columns) {
    const known = new Set((columns || []).map((c) => String(typeof c === 'string' ? c : (c && c.name)).toLowerCase()));
    const seen = new Set();
    for (const name of deps(ast)) {
      const key = name.toLowerCase();
      if (!known.has(key) && !seen.has(key)) { seen.add(key); errors.push({ kind: 'column', name, message: `unknown column: ${name}` }); }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── src/main.js ──

// @gcu/expr — a small, total, CSP-safe expression calculus over one record's
// fields. Two faces (value + boolean), two paths (tree-walk reference + compiled
// positional closures), analyzable (deps + validate). The shared "small tier" of
// the GCU expression stack; @gcu/over is the heavy cross-record DSL.
// Public surface (manifest-is-truth; @gcu/build bundles from here).

export {
  parse,
  asAst,
  CALLFNS,
  ExprParseError,
  evaluate,
  evalBool,
  constraintValid,
  compile,
  compileValue,
  compileBool,
  deps,
  validate,
  isBlank,
  num,
  FN,
};
