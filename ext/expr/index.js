// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/expr — A small, total, CSP-safe expression calculus over one record's fields — arithmetic, comparisons, boolean (and/or/not), between/contains/matches, is blank/filled, and a pure function set (if/round/int/abs, dates, geo math log/exp/sqrt/pow/min/max/clamp, casts ifnum/coalesce, tests isnum/isnan/isblank/isfilled). Two faces (value + boolean), two paths (tree-walk reference + compiled positional closures, no eval/new Function), analyzable (deps + validate). The shared small tier of the GCU expression stack; powers lamina calc-columns + filters. Carried from hopper's rule engine.

// ── src/parse.js ──

// @gcu/expr — parser. A small, *total*, pure expression calculus over the fields
// of one record. Totality is the security boundary: no loops, recursion, I/O, or
// unbounded ops; every expression terminates and (post-parse) never throws at eval
// time. The canonical surface is SQL-WHERE-flavored — the dialect this audience
// already reads ("filter rows") — with a terse `if()` for the value face, and the
// blank model deliberately friendlier than SQL's NULL (blank = blank → true; no
// `= NULL` trap). C-style spellings (&&, ==, ~, <>, single-quoted strings, parenless
// `in`) still parse, silently tolerated, but the documented/highlighted form is one.
//
// Pipeline: lex → parse to an analyzable AST. `evaluate` (tree-walk reference) and
// `compile` (positional closures, hot path) consume the AST; `deps`/`validate`/
// `tokenize` analyze it. Blank is `null`.
//
// Precedence ladder (low→high): or < and < not < comparison < additive <
// multiplicative < unary < power < primary. Power (`^` / `**`) is right-associative
// and binds looser than unary on the left, tighter on the right — Python/pandas
// semantics: -2^2 = -4, 2^-3 = 0.125, 2^3^2 = 512. (Excel disagrees on -2^2; the
// Python convention wins because pandas.query is this audience's muscle memory.)

// Keyword operators / words — matched case-insensitively. A column literally named
// one of these needs the `…` backtick escape.
const RESERVED = new Set(['and', 'or', 'not', 'between', 'contains', 'in', 'like', 'matches', 'is', 'blank', 'filled', 'true', 'false']);

// Pure total functions: name → [minArgs, maxArgs]. `if` is special (lazy branches)
// but listed for arity + call-syntax recognition.
const CALLFNS = {
  if: [3, 3], round: [1, 2], int: [1, 1], abs: [1, 1], floor: [1, 1], ceil: [1, 1], mod: [2, 2],
  year: [1, 1], month: [1, 1], day: [1, 1],
  log: [1, 1], log10: [1, 1], exp: [1, 1], sqrt: [1, 1], pow: [2, 2], min: [1, Infinity], max: [1, Infinity], clamp: [3, 3], bin: [2, 3],
  ifnum: [2, 2], coalesce: [1, Infinity], nullif: [2, 2], isnum: [1, 1], isnan: [1, 1], isblank: [1, 1], isfilled: [1, 1],
  upper: [1, 1], lower: [1, 1], trim: [1, 1], len: [1, 1], left: [2, 2], right: [2, 2], substr: [2, 3], replace: [3, 3], concat: [1, Infinity],
};

// Is `name` writable as a bare identifier? (Used by quoteIdent + complete.)
const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Quote a column name for use in an expression: plain idents pass through, anything
// else (spaces, hyphens, reserved words) gets the backtick escape with \` / \\.
// Consumers that treat a column NAME as an expression (stats pickers, materialize)
// MUST route through this — `OK-Indic` bare is subtraction now.
function quoteIdent(name) {
  const s = String(name);
  return PLAIN_IDENT.test(s) && !RESERVED.has(s.toLowerCase()) ? s : '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

class ExprParseError extends Error {
  constructor(msg) { super('expr parse error: ' + msg); this.name = 'ExprParseError'; }
}
function fail(msg) { throw new ExprParseError(msg); }

// ── lexer ──────────────────────────────────────────────────────────────────
// Bare field refs are case-insensitive idents of [A-Za-z_][A-Za-z0-9_]* — `-` is
// ALWAYS subtraction (v0.2; `AU-CU` is arithmetic, as pandas/SQL fingers expect).
// Any other column name takes the BACKTICK escape — `Assay Au ppm` — the pandas
// df.query() convention; \` escapes a literal backtick, \\ a backslash. The legacy
// `["…"]` bracket form still parses (shipped lenses) but is undocumented.
// Strings: "double" (canonical) or 'single' (tolerated). Numbers: ints, decimals,
// leading-dot (.5) and scientific (1e4, 2.5e-3). `^` and `**` are power.
const TOKEN_RE = /(\s+)|(#[^\n]*)|(\[\s*"[^"]*"\s*\]|`(?:[^`\\]|\\.)*`)|("[^"]*"|'[^']*')|(&&|\|\||\*\*|==|<>|<=|>=|!=|!~|<|>|=|~)|([-+*/(),^])|((?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)/y;

// Lex into tokens carrying source positions. `tolerant` (for highlighting) emits a
// 1-char 'err' token on an unexpected character instead of throwing.
function lexAll(src, tolerant) {
  const toks = [];
  let last = 0;
  while (last < src.length) {
    TOKEN_RE.lastIndex = last;
    const m = TOKEN_RE.exec(src);
    if (!m) {
      if (tolerant) { toks.push({ k: 'err', v: src[last], start: last, end: last + 1 }); last++; continue; }
      fail(`unexpected character at ${last}: "${src.slice(last, last + 8)}"`);
    }
    const start = last; last = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) continue;                                        // whitespace
    if (m[2] !== undefined) {                                                // # comment → end of line (pandas-style;
      if (tolerant) toks.push({ k: 'comment', v: m[2], start, end: last }); //  '#' was an illegal char pre-v0.2, so
      continue;                                                              //  this is purely additive). parse skips;
    }                                                                        //  tokenize keeps them for highlighting.
    let k, v;
    if (m[3] !== undefined) {
      k = 'field';
      v = m[3][0] === '`'
        ? m[3].slice(1, -1).replace(/\\([`\\])/g, '$1')                    // `…` backtick escape (canonical)
        : m[3].replace(/^\[\s*"/, '').replace(/"\s*\]$/, '');              // ["…"] legacy bracket form
    }
    else if (m[4] !== undefined) { k = 'str'; v = m[4].slice(1, -1); }       // "double" or 'single'
    else if (m[5] !== undefined) { k = 'op'; v = m[5]; }
    else if (m[6] !== undefined) { k = 'op'; v = m[6]; }
    else if (m[7] !== undefined) { k = 'num'; v = parseFloat(m[7]); }
    else { k = 'word'; v = m[8]; }
    toks.push({ k, v, start, end: last });
  }
  return toks;
}

// SQL LIKE pattern → an anchored RegExp source (% = any run, _ = one char).
function likeToRegex(pat) {
  const esc = String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');   // escape regex specials (NOT % or _)
  return '^' + esc.replace(/%/g, '.*').replace(/_/g, '.') + '$';
}

// ── parser ───────────────────────────────────────────────────────────────────
function parse(src) {
  const toks = lexAll(src, false);
  let i = 0;
  const op = (v) => toks[i] && toks[i].k === 'op' && toks[i].v === v;
  const word = (v) => toks[i] && toks[i].k === 'word' && toks[i].v.toLowerCase() === v;       // keywords are case-insensitive
  const peekWord = (v) => toks[i + 1] && toks[i + 1].k === 'word' && toks[i + 1].v.toLowerCase() === v;
  const eatOp = (v) => { if (!op(v)) fail(`expected '${v}'`); i++; };
  const eatStr = () => { if (!toks[i] || toks[i].k !== 'str') fail('expected a quoted string'); const v = toks[i].v; i++; return v; };
  // `in (a, b, …)` — parens optional (SQL canonical with; tolerated without).
  const inList = () => { const paren = op('('); if (paren) i++; const set = [add()]; while (op(',')) { i++; set.push(add()); } if (paren) eatOp(')'); return set; };

  function primary() {
    const t = toks[i];
    if (!t) fail('unexpected end of expression');
    if (t.k === 'op' && t.v === '(') { i++; const e = expr(); eatOp(')'); if (e && typeof e === 'object') { e.gStart = t.start; e.gEnd = toks[i - 1].end; } return e; }   // paren-group extent → grouping UIs
    if (t.k === 'num') { i++; return { t: 'num', v: t.v, start: t.start, end: t.end }; }   // literals carry SOURCE SPANS
    if (t.k === 'str') { i++; return { t: 'str', v: t.v, start: t.start, end: t.end }; }   // (widget UIs rewrite them surgically)
    if (t.k === 'field') { i++; return { t: 'field', name: t.v }; }     // ["…"] bracket escape
    if (t.k === 'word') {
      const lw = t.v.toLowerCase();
      if (CALLFNS[lw] && toks[i + 1] && toks[i + 1].k === 'op' && toks[i + 1].v === '(') {
        i += 2;
        const args = [];
        if (!op(')')) { args.push(expr()); while (op(',')) { i++; args.push(expr()); } }
        eatOp(')');
        const [lo, hi] = CALLFNS[lw];
        if (args.length < lo || args.length > hi) fail(`${lw}() expects ${lo === hi ? lo : (hi === Infinity ? `${lo}+` : `${lo}–${hi}`)} argument(s), got ${args.length}`);
        return { t: 'call', fn: lw, args, start: t.start, end: toks[i - 1].end };   // full call extent
      }
      i++;
      if (lw === 'true') return { t: 'bool', v: true };
      if (lw === 'false') return { t: 'bool', v: false };
      if (lw === 'blank') return { t: 'blank' };                        // the blank LITERAL: if(AU = -99, blank, AU)
      if (RESERVED.has(lw)) fail(`unexpected keyword '${t.v}'`);
      return { t: 'field', name: t.v };                                 // bare ident → column (original case kept)
    }
    fail(`unexpected '${t.v}'`);
  }
  // power: right-assoc, desugars to the existing pow() call (zero new eval code).
  // The exponent re-enters unary so 2^-3 works; -2^2 = -(2^2) (Python/pandas).
  function power() {
    const l = primary();
    if (op('^') || op('**')) { i++; return { t: 'call', fn: 'pow', args: [l, unary()] }; }
    return l;
  }
  function unary() {
    if (op('-') || op('+')) {
      const neg = op('-'), at = toks[i].start; i++; const e = unary();
      if (!neg) return e;
      const n2 = { t: 'neg', e };
      if (e.end != null) { n2.start = at; n2.end = e.end; }              // span covers the sign (surgical rewrites)
      return n2;
    }
    return power();
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
    const st = toks[i] ? toks[i].start : 0;                               // clause EXTENT: widget UIs rewrite whole
    const fin = (n) => { if (n && n.start == null) { n.start = st; n.end = toks[i - 1] ? toks[i - 1].end : st; } return n; };   // leaves (op conversions, grouping)
    const l = add();
    if (op('<') || op('>') || op('<=') || op('>=') || op('=') || op('==') || op('!=') || op('<>')) {
      const ot = toks[i]; let o = ot.v; i++; if (o === '==') o = '='; if (o === '<>') o = '!=';     // tolerate C / SQL not-equal
      return fin({ t: 'cmp', op: o, l, r: add(), opStart: ot.start, opEnd: ot.end });   // op token span → op dropdowns
    }
    if (op('~')) { i++; return fin({ t: 'contains', l, r: add() }); }
    if (op('!~')) { i++; return fin({ t: 'not', e: { t: 'contains', l, r: add() } }); }
    if (word('between')) { i++; const lo = add(); if (!(word('and') || op('&&'))) fail("expected 'and' in between"); i++; return fin({ t: 'between', e: l, lo, hi: add() }); }
    if (word('contains')) { i++; return fin({ t: 'contains', l, r: add() }); }
    if (word('in')) { i++; return fin({ t: 'in', e: l, set: inList() }); }
    if (word('like')) { i++; return fin({ t: 'matches', e: l, re: likeToRegex(eatStr()) }); }
    if (word('matches')) { i++; return fin({ t: 'matches', e: l, re: eatStr() }); }
    if (word('not')) {                                                    // postfix negation: `x not in/contains/like …`
      if (peekWord('in')) { i += 2; return fin({ t: 'not', e: { t: 'in', e: l, set: inList() } }); }
      if (peekWord('contains')) { i += 2; return fin({ t: 'not', e: { t: 'contains', l, r: add() } }); }
      if (peekWord('like')) { i += 2; return fin({ t: 'not', e: { t: 'matches', e: l, re: likeToRegex(eatStr()) } }); }
    }
    if (word('is')) {
      i++;
      let neg = false; if (word('not')) { neg = true; i++; }              // `is not blank` / `is not filled`
      if (word('blank')) { i++; return fin(neg ? { t: 'isfilled', e: l } : { t: 'isblank', e: l }); }
      if (word('filled')) { i++; return fin(neg ? { t: 'isblank', e: l } : { t: 'isfilled', e: l }); }
      fail("'is' must be followed by 'blank' or 'filled'");
    }
    return l;
  }
  function notE() { if (word('not')) { i++; return { t: 'not', e: comparison() }; } return comparison(); }
  function andE() { let l = notE(); while (word('and') || op('&&')) { const jt = toks[i]; i++; l = { t: 'and', l, r: notE(), jStart: jt.start, jEnd: jt.end }; } return l; }
  function orE() { let l = andE(); while (word('or') || op('||')) { const jt = toks[i]; i++; l = { t: 'or', l, r: andE(), jStart: jt.start, jEnd: jt.end }; } return l; }
  function expr() { const st = toks[i] ? toks[i].start : 0; const n = orE(); if (n && typeof n === 'object' && n.start == null) { n.start = st; n.end = toks[i - 1] ? toks[i - 1].end : st; } return n; }   // extent on anything span-less (args, and/or)

  const ast = expr();
  if (i < toks.length) fail(`trailing input near '${toks[i].v}'`);
  return ast;
}

const asAst = (x) => (typeof x === 'string' ? parse(x) : x);

// ── tokenize: classified, positioned tokens for syntax highlighting + completion.
// Best-effort (tolerant lexer) so it works on a half-typed expression. kinds:
// column · string · number · operator · punct · keyword · function · boolean · error.
function tokenize(src) {
  const raw = lexAll(String(src == null ? '' : src), true);
  // one-token lookaround (skipping comments) so classification matches the PARSER:
  // a CALLFNS word is a 'function' only when a '(' follows (else it's a column,
  // e.g. a column literally named `round`); `blank` is a 'keyword' only inside
  // `is [not] blank` — elsewhere it's the value LITERAL (painted like true/false).
  const prevAt = (j) => { for (let q = j - 1; q >= 0; q--) if (raw[q].k !== 'comment') return q; return -1; };
  const nextAt = (j) => { for (let q = j + 1; q < raw.length; q++) if (raw[q].k !== 'comment') return q; return -1; };
  const wordAt = (q) => (q >= 0 && raw[q].k === 'word' ? String(raw[q].v).toLowerCase() : null);
  return raw.map((t, i) => {
    let kind;
    if (t.k === 'err') kind = 'error';
    else if (t.k === 'comment') kind = 'comment';
    else if (t.k === 'str') kind = 'string';
    else if (t.k === 'num') kind = 'number';
    else if (t.k === 'field') kind = 'column';
    else if (t.k === 'op') kind = (t.v === '(' || t.v === ')' || t.v === ',') ? 'punct' : 'operator';
    else {
      const lw = String(t.v).toLowerCase();
      if (lw === 'true' || lw === 'false') kind = 'boolean';
      else if (lw === 'blank') {
        const p1 = prevAt(i), w1 = wordAt(p1);
        kind = (w1 === 'is' || (w1 === 'not' && wordAt(prevAt(p1)) === 'is')) ? 'keyword' : 'boolean';
      }
      else if (CALLFNS[lw]) { const n = nextAt(i); kind = (n >= 0 && raw[n].k === 'op' && raw[n].v === '(') ? 'function' : 'column'; }
      else kind = RESERVED.has(lw) ? 'keyword' : 'column';
    }
    return { kind, value: src.slice(t.start, t.end), start: t.start, end: t.end };
  });
}

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
// String coercion: blank/boolean/object → blank; numbers stringify. The single
// string-coercion point (the S to num's N). NB '' folds to blank in this model, so
// string results that come out empty are returned as blank (|| null below).
const S = (v) => (isBlank(v) || typeof v === 'boolean' || typeof v === 'object' ? null : String(v));

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
  bin: (a, N) => { const x = N(a[0]), w = N(a[1]); if (x === null || w === null || w <= 0) return null; const o = a.length > 2 ? (N(a[2]) || 0) : 0; return Math.floor((x - o) / w) * w + o; },   // lower edge of x's bin (width w, optional origin)
  year: (a) => datePart(a[0], 1),
  month: (a) => datePart(a[0], 2),
  day: (a) => datePart(a[0], 3),
  floor: (a, N) => { const x = N(a[0]); return x === null ? null : Math.floor(x); },   // int() truncates — differs on negatives
  ceil: (a, N) => { const x = N(a[0]); return x === null ? null : Math.ceil(x); },
  mod: (a, N) => { const x = N(a[0]), y = N(a[1]); return (x === null || y === null || y === 0) ? null : ((x % y) + y) % y; },   // FLOORED (Excel MOD): mod(-7,3)=2
  log10: (a, N) => { const x = N(a[0]); return x === null ? null : fin(Math.log10(x)); },   // log() is ln; grades are lognormal — log10 is the geochem transform
  ifnum: (a, N) => { const x = N(a[0]); return x === null ? a[1] : x; },          // x if numeric, else the default
  coalesce: (a) => { for (const v of a) if (!isBlank(v)) return v; return null; }, // first non-blank
  nullif: (a, N) => (eq(a[0], a[1], N) ? null : a[0]),    // sentinel scrub: nullif(AU, -99)
  isnum: (a, N) => N(a[0]) !== null,
  isnan: (a, N) => !isBlank(a[0]) && N(a[0]) === null,    // present but not a number (junk cell)
  isblank: (a) => isBlank(a[0]),
  isfilled: (a) => !isBlank(a[0]),
  // ── strings (hole-ID munging, join-key cleanup). Blank in → blank out, except
  // where noted; empty results fold to blank ('' ≡ blank in this model).
  upper: (a) => { const s = S(a[0]); return s === null ? null : s.toUpperCase(); },
  lower: (a) => { const s = S(a[0]); return s === null ? null : s.toLowerCase(); },
  trim: (a) => { const s = S(a[0]); return s === null ? null : (s.trim() || null); },
  len: (a) => { const s = S(a[0]); return s === null ? null : s.length; },        // len(blank) = blank, not 0
  left: (a, N) => { const s = S(a[0]), n = N(a[1]); return (s === null || n === null) ? null : (s.slice(0, Math.max(0, Math.trunc(n))) || null); },
  right: (a, N) => { const s = S(a[0]), n = N(a[1]); return (s === null || n === null || n <= 0) ? null : (s.slice(-Math.trunc(n)) || null); },
  substr: (a, N) => {                                     // 1-BASED start (SQL/Excel MID), optional length
    const s = S(a[0]), st = N(a[1]); if (s === null || st === null) return null;
    const b = Math.max(0, Math.trunc(st) - 1); const ln = a.length > 2 ? N(a[2]) : null;
    return (ln === null ? s.slice(b) : s.slice(b, b + Math.max(0, Math.trunc(ln)))) || null;
  },
  replace: (a) => {                                       // literal replace-ALL. find blank → unchanged; repl blank → delete
    const s = S(a[0]); if (s === null) return null;
    const f = S(a[1]); if (f === null) return s;
    return s.split(f).join(S(a[2]) ?? '') || null;
  },
  concat: (a) => a.map((v) => S(v) ?? '').join('') || null,   // blanks skipped (join-key building); all-blank → blank
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
    case 'blank': return null;                            // the blank literal
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
// (exported for compile-chunk.js — one binding convention across both compilers)
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
// reactive wiring + column-pushdown projection), `validate` (parse + unknown-column
// check with did-you-mean, for the filter box / calc editor's live feedback), and
// `canMatch` (conservative interval analysis for chunk/row-group push-down — "could
// any row in a chunk with these per-column stats match this predicate?").


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

// Small bounded Levenshtein for did-you-mean (early-out above `cap`).
function editDist(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Parse + (when `columns` is given) check every field ref resolves, case-insensitively.
// → { ok, errors: [{ kind, message, name?, suggestion? }] }. Never throws. Unknown
// columns get a did-you-mean: nearest known name by edit distance, or — the hyphen
// migration case — a known name that *starts with* the unknown + '-' (`OK` typed
// bare where `OK-Indic` exists → suggest the backticked form; `-` is subtraction).
function validate(exprOrAst, columns) {
  let ast;
  try { ast = asAst(exprOrAst); }
  catch (e) { return { ok: false, errors: [{ kind: 'parse', message: (e instanceof ExprParseError ? e.message : String(e && e.message || e)) }] }; }
  const errors = [];
  if (columns) {
    const names = (columns || []).map((c) => String(typeof c === 'string' ? c : (c && c.name)));
    const known = new Set(names.map((n) => n.toLowerCase()));
    const seen = new Set();
    for (const name of deps(ast)) {
      const key = name.toLowerCase();
      if (known.has(key) || seen.has(key)) continue;
      seen.add(key);
      let best = null, bestD = 3;                                     // fuzzy: nearest known within distance 2
      for (const k of names) {
        if (k.toLowerCase().startsWith(key + '-')) { best = k; break; }   // the hyphen case wins outright
        const d = editDist(key, k.toLowerCase(), 2);
        if (d < bestD) { bestD = d; best = k; }
      }
      const suggestion = best ? quoteIdent(best) : undefined;
      errors.push({ kind: 'column', name, suggestion, message: `unknown column: ${name}${suggestion ? ` — did you mean ${suggestion}?` : ''}` });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── canMatch: chunk push-down ────────────────────────────────────────────────
// canMatch(expr, ranges) → false ONLY when provably no row in the chunk can match;
// true means "must scan". `ranges` = { columnName → { min, max, hasBlank? } } from
// chunk/row-group stats (Parquet footers, .dm band sidecars); lookup is
// case-insensitive (the language is). Conservative by construction: unknown node
// shapes, non-constant compare sides, parse errors, missing stats → true.
//
// Soundness note (`!=`): a BLANK row matches `AU != 5` (eq(blank,5) is false), and
// min/max stats don't describe blanks — so `!=` prunes only when the stats assert
// `hasBlank: false`. (Hand-rolled pushdowns typically miss this.)
const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!=' };
function canMatch(exprOrAst, ranges) {
  let ast;
  try { ast = asAst(exprOrAst); } catch { return true; }
  const R = new Map(Object.entries(ranges || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  const rangeOf = (n) => (n && n.t === 'field' ? (R.get(n.name.toLowerCase()) || null) : null);
  const cnum = (n) => {                                               // constant-fold a field-free subtree to a finite number
    if (deps(n).length) return null;
    const v = evaluate(n, {});
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  };
  const usable = (fr) => fr && Number.isFinite(fr.min) && Number.isFinite(fr.max);
  function m(n) {
    switch (n.t) {
      case 'and': return m(n.l) && m(n.r);                            // either side impossible → the conjunction is
      case 'or': return m(n.l) || m(n.r);
      case 'cmp': {
        let fr = rangeOf(n.l), k = cnum(n.r), o = n.op;
        if (!usable(fr) || k === null) {
          const fr2 = rangeOf(n.r), k2 = cnum(n.l);
          if (usable(fr2) && k2 !== null) { fr = fr2; k = k2; o = FLIP[o]; }
          else return true;
        }
        switch (o) {
          case '>': return fr.max > k;
          case '>=': return fr.max >= k;
          case '<': return fr.min < k;
          case '<=': return fr.min <= k;
          case '=': return fr.min <= k && k <= fr.max;
          case '!=': return fr.hasBlank === false ? !(fr.min === k && fr.max === k) : true;
          default: return true;
        }
      }
      case 'between': {
        const fr = rangeOf(n.e), lo = cnum(n.lo), hi = cnum(n.hi);
        return (usable(fr) && lo !== null && hi !== null) ? (fr.max >= lo && fr.min <= hi) : true;
      }
      case 'in': {
        const fr = rangeOf(n.e); if (!usable(fr)) return true;
        return n.set.some((s) => { const k = cnum(s); return k === null ? true : (fr.min <= k && k <= fr.max); });
      }
      default: return true;                                           // not / contains / matches / calls / is blank — no pruning
    }
  }
  return m(ast);
}

// ── src/compile-chunk.js ──

// @gcu/expr — the COLUMNAR chunk compiler (the substrate resolver's hot path).
// compileChunk(ast, columns) → (cols, n) => { t, buf }: each AST node compiles to a
// vector closure that evaluates the WHOLE chunk in a loop — dispatch amortized
// per-chunk, where the per-row closure tree pays 1–3 calls per node per row.
//
// Value representation by type:
//   num  — Float64Array, NaN ≡ blank (typed source columns pass through ZERO-COPY)
//   bool — Uint8Array TRI-STATE: 0 false · 1 true · 2 blank (cmp/between can yield
//          blank, so `(x > 5) is blank` stays correct; and/or/not emit 0/1 only)
//   raw  — plain Array, null ≡ blank (strings, mixed, function results)
//
// Two layers: a GENERIC spine covering every node via the shared runtime helpers
// (bit-identical semantics — the oracle asserts chunk ≡ row ≡ tree-walk), plus
// FAST f64 loops for the hot filter/calc shapes (field coercion, arithmetic,
// compare-vs-numeric-scalar, and/or/not, blank tests). Deps-free subtrees fold to
// scalars at compile time. Buffers are owned by the closures and reused across
// chunks — a returned buffer is only valid until the next call (pipeline contract).


const isNumArr = (a) => a instanceof Float64Array;
const CMP_INV = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!=' };

// read one value out of a plan's buffer, back in blank≡null row-space
function bget(t, buf, i) {
  const v = buf[i];
  if (t === 'num') return v !== v ? null : v;
  if (t === 'bool') return v === 2 ? null : v === 1;
  return v === undefined ? null : v;
}

function compileChunk(exprOrAst, columns, opts = {}) {
  const ast = asAst(exprOrAst);
  const N = makeNum(opts.decimal);
  const idx = indexMap(columns);

  const f64 = () => { let b = null; return (n) => (b = b && b.length >= n ? b : new Float64Array(n)); };
  const u8 = () => { let b = null; return (n) => (b = b && b.length >= n ? b : new Uint8Array(n)); };
  const arr = () => { let b = null; return (n) => { if (!b || b.length < n) b = new Array(n); return b; }; };

  // wrap a plan into a guaranteed-Float64Array producer (zero-copy when possible)
  function numVec(p) {
    if (p.s !== undefined) return null;                    // scalars handled by callers
    if (p.t === 'num') return p.run;
    const S = f64(), run = p.run, t = p.t;
    return (ctx) => {
      const src = run(ctx), n = ctx.n;
      if (isNumArr(src)) return src;
      const out = S(n);
      if (ArrayBuffer.isView(src)) { for (let i = 0; i < n; i++) out[i] = src[i]; }
      else if (t === 'bool') { out.fill(NaN, 0, n); }   // N(boolean) is null in the row path — booleans are numerically blank
      else for (let i = 0; i < n; i++) { const v = N(src[i]); out[i] = v === null ? NaN : v; }
      return out;
    };
  }

  function build(node) {
    if (!node || typeof node !== 'object') return { s: null };
    if (node.t !== 'field' && deps(node).length === 0) {   // constant fold (totality makes this safe)
      const v = evaluate(node, {}, opts);
      return { s: v === undefined ? null : v };
    }
    switch (node.t) {
      case 'field': {
        const i = idx.get(String(node.name).toLowerCase());
        if (i === undefined) return { s: null };           // unknown column → blank (validate reports it)
        return { t: 'raw', run: (ctx) => ctx.cols[i] };    // raw passthrough; consumers coerce
      }
      case 'neg': {
        const ep = build(node.e);
        if (ep.s !== undefined) { const v = N(ep.s); return { s: v === null ? null : -v }; }
        const a = numVec(ep); const S = f64();
        return { t: 'num', run: (ctx) => { const x = a(ctx), out = S(ctx.n); for (let i = 0; i < ctx.n; i++) out[i] = -x[i]; return out; } };
      }
      case '+': case '-': case '*': case '/': {
        const lp = build(node.l), rp = build(node.r), op = node.t, S = f64();
        const lk = lp.s !== undefined ? N(lp.s) : null, rk = rp.s !== undefined ? N(rp.s) : null;
        if (lp.s !== undefined && lk === null) return { s: null };      // blank scalar → blank result
        if (rp.s !== undefined && rk === null) return { s: null };
        const a = numVec(lp), b = numVec(rp);
        return { t: 'num', run: (ctx) => {
          const n = ctx.n, out = S(n);
          const A = a ? a(ctx) : null, B = b ? b(ctx) : null;
          if (op === '+') { if (A && B) for (let i = 0; i < n; i++) out[i] = A[i] + B[i]; else if (A) for (let i = 0; i < n; i++) out[i] = A[i] + rk; else for (let i = 0; i < n; i++) out[i] = lk + B[i]; }
          else if (op === '-') { if (A && B) for (let i = 0; i < n; i++) out[i] = A[i] - B[i]; else if (A) for (let i = 0; i < n; i++) out[i] = A[i] - rk; else for (let i = 0; i < n; i++) out[i] = lk - B[i]; }
          else if (op === '*') { if (A && B) for (let i = 0; i < n; i++) out[i] = A[i] * B[i]; else if (A) for (let i = 0; i < n; i++) out[i] = A[i] * rk; else for (let i = 0; i < n; i++) out[i] = lk * B[i]; }
          else { if (A && B) for (let i = 0; i < n; i++) { const d = B[i]; out[i] = d === 0 ? NaN : A[i] / d; } else if (A) { if (rk === 0) out.fill(NaN, 0, n); else for (let i = 0; i < n; i++) out[i] = A[i] / rk; } else for (let i = 0; i < n; i++) { const d = B[i]; out[i] = d === 0 ? NaN : lk / d; } }
          return out;
        } };
      }
      case 'cmp': {
        let lp = build(node.l), rp = build(node.r), op = node.op;
        if (lp.s !== undefined && rp.s === undefined) { const t2 = lp; lp = rp; rp = t2; op = CMP_INV[op]; }   // scalar OP col → col FLIP scalar
        if (lp.s !== undefined) return { s: compare(lp.s, rp.s, op, N) };   // both scalar (e.g. an unknown column) → fold
        const S = u8();
        if (rp.s !== undefined) {
          const k = rp.s, kn = N(k);
          if (kn !== null && lp.t !== 'bool') {            // FAST: numeric threshold — THE filter shape (bools numeric-blank → generic)
            const a = numVec(lp);
            return { t: 'bool', run: (ctx) => {
              const n = ctx.n, out = S(n), A = a(ctx);
              if (op === '=') for (let i = 0; i < n; i++) out[i] = A[i] === kn ? 1 : 0;
              else if (op === '!=') for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 1 : (v !== kn ? 1 : 0); }
              else if (op === '>') for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v > kn ? 1 : 0); }
              else if (op === '>=') for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v >= kn ? 1 : 0); }
              else if (op === '<') for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v < kn ? 1 : 0); }
              else for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v <= kn ? 1 : 0); }
              return out;
            } };
          }
          const run = lp.run, tt = lp.t;                   // string/blank scalar — eq/compare loops
          if ((op === '=' || op === '!=') && typeof k === 'string' && !isBlank(k) && tt === 'raw') {
            // FAST: category equality (LITO = "OX"). k is non-numeric here (kn === null),
            // so eq() always lands on the String branch: blank → false, else String(v) === k.
            const yes = op === '=' ? 1 : 0, no = op === '=' ? 0 : 1;
            return { t: 'bool', run: (ctx) => {
              const n = ctx.n, out = S(n), src = run(ctx);
              for (let i = 0; i < n; i++) {
                const v = src[i];
                out[i] = v === k ? yes : (v == null || v === '' || v !== v || (Array.isArray(v) && v.length === 0) ? no : (String(v) === k ? yes : no));
              }
              return out;
            } };
          }
          return { t: 'bool', run: (ctx) => {
            const n = ctx.n, out = S(n), src = run(ctx);
            if (op === '=') for (let i = 0; i < n; i++) out[i] = eq(bget(tt, src, i), k, N) ? 1 : 0;
            else if (op === '!=') for (let i = 0; i < n; i++) out[i] = eq(bget(tt, src, i), k, N) ? 0 : 1;
            else for (let i = 0; i < n; i++) { const r = compare(bget(tt, src, i), k, op, N); out[i] = r === null ? 2 : (r ? 1 : 0); }
            return out;
          } };
        }
        const lr = lp.run, lt = lp.t, rr = rp.run, rt = rp.t;   // col-op-col — generic (compare handles = / != internally)
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), A = lr(ctx), B = rr(ctx);
          for (let i = 0; i < n; i++) { const r = compare(bget(lt, A, i), bget(rt, B, i), op, N); out[i] = r === null ? 2 : (r ? 1 : 0); }
          return out;
        } };
      }
      case 'between': {
        const ep = build(node.e), lo = build(node.lo), hi = build(node.hi), S = u8();
        if (ep.s !== undefined && lo.s !== undefined && hi.s !== undefined) {           // all scalar → fold
          const ge = compare(ep.s, lo.s, '>=', N), le = compare(ep.s, hi.s, '<=', N);
          return { s: (ge === null || le === null) ? null : (ge && le) };
        }
        const lk = lo.s !== undefined ? N(lo.s) : null, hk = hi.s !== undefined ? N(hi.s) : null;
        if (ep.s === undefined && ep.t !== 'bool' && lo.s !== undefined && hi.s !== undefined && lk !== null && hk !== null) {   // FAST: literal bounds
          const a = numVec(ep);
          return { t: 'bool', run: (ctx) => { const n = ctx.n, out = S(n), A = a(ctx); for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v >= lk && v <= hk ? 1 : 0); } return out; } };
        }
        // generic (rare): mixed scalar/vector bounds
        const gv = (p, i, ctx, bufs) => p.s !== undefined ? p.s : bget(p.t, bufs.get(p), i);
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n);
          const bufs = new Map(); for (const p of [ep, lo, hi]) if (p.run) bufs.set(p, p.run(ctx));
          for (let i = 0; i < n; i++) {
            const ge = compare(gv(ep, i, ctx, bufs), gv(lo, i, ctx, bufs), '>=', N), le = compare(gv(ep, i, ctx, bufs), gv(hi, i, ctx, bufs), '<=', N);
            out[i] = (ge === null || le === null) ? 2 : ((ge && le) ? 1 : 0);
          }
          return out;
        } };
      }
      case 'in': {
        const ep = build(node.e), members = node.set.map(build), S = u8();
        if (ep.s !== undefined && members.every((m) => m.s !== undefined)) return { s: inSet(ep.s, members.map((m) => m.s)) };
        if (ep.s === undefined && members.every((m) => m.s !== undefined)) {     // FAST: literal set → prebuilt Set
          const set = new Set(members.filter((m) => !isBlank(m.s)).map((m) => String(m.s)));
          const run = ep.run, tt = ep.t;
          return { t: 'bool', run: (ctx) => { const n = ctx.n, out = S(n), src = run(ctx); for (let i = 0; i < n; i++) { const v = bget(tt, src, i); out[i] = isBlank(v) ? 0 : (set.has(String(v)) ? 1 : 0); } return out; } };
        }
        const run = ep.run, tt = ep.t;
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), src = run ? run(ctx) : null;
          const bufs = members.map((m) => (m.run ? m.run(ctx) : null));
          for (let i = 0; i < n; i++) { const ms = members.map((m, j) => (m.s !== undefined ? m.s : bget(m.t, bufs[j], i))); out[i] = inSet(ep.s !== undefined ? ep.s : bget(tt, src, i), ms) ? 1 : 0; }
          return out;
        } };
      }
      case 'contains': {
        const lp = build(node.l), rp = build(node.r), S = u8();
        const lr = lp.run, lt = lp.t;
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), A = lr ? lr(ctx) : null, B = rp.run ? rp.run(ctx) : null;
          for (let i = 0; i < n; i++) out[i] = contains(lp.s !== undefined ? lp.s : bget(lt, A, i), rp.s !== undefined ? rp.s : bget(rp.t, B, i)) ? 1 : 0;
          return out;
        } };
      }
      case 'matches': {
        const ep = build(node.e), re = makeRegExp(node.re), S = u8(), run = ep.run, tt = ep.t;
        if (ep.s !== undefined) return { s: matches(ep.s, re) };
        return { t: 'bool', run: (ctx) => { const n = ctx.n, out = S(n), src = run ? run(ctx) : null; for (let i = 0; i < n; i++) out[i] = matches(ep.s !== undefined ? ep.s : bget(tt, src, i), re) ? 1 : 0; return out; } };
      }
      case 'isblank': case 'isfilled': {
        const p = build(node.e), want = node.t === 'isblank', S = u8();
        if (p.s !== undefined) return { s: want === isBlank(p.s) };
        const run = p.run, tt = p.t;
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), src = run(ctx);
          if (tt === 'num') for (let i = 0; i < n; i++) { const b = src[i] !== src[i]; out[i] = (b === want) ? 1 : 0; }
          else if (tt === 'bool') for (let i = 0; i < n; i++) { const b = src[i] === 2; out[i] = (b === want) ? 1 : 0; }
          else { const tv = ArrayBuffer.isView(src); for (let i = 0; i < n; i++) { const v = src[i]; const b = tv ? v !== v : isBlank(v === undefined ? null : v); out[i] = (b === want) ? 1 : 0; } }
          return out;
        } };
      }
      case 'not': {
        const p = build(node.e), S = u8();
        if (p.s !== undefined) return { s: p.s !== true };
        const run = p.run, tt = p.t;
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), src = run(ctx);
          if (tt === 'bool') for (let i = 0; i < n; i++) out[i] = src[i] === 1 ? 0 : 1;
          else for (let i = 0; i < n; i++) out[i] = bget(tt, src, i) === true ? 0 : 1;
          return out;
        } };
      }
      case 'and': case 'or': {
        const lp = build(node.l), rp = build(node.r), isAnd = node.t === 'and', S = u8();
        const truthy = (p, buf, i) => (p.s !== undefined ? p.s === true : (p.t === 'bool' ? buf[i] === 1 : bget(p.t, buf, i) === true));
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n);
          const A = lp.run ? lp.run(ctx) : null, B = rp.run ? rp.run(ctx) : null;
          if (lp.t === 'bool' && rp.t === 'bool' && A && B) {   // FAST: the common boolean pair
            if (isAnd) for (let i = 0; i < n; i++) out[i] = (A[i] === 1 && B[i] === 1) ? 1 : 0;
            else for (let i = 0; i < n; i++) out[i] = (A[i] === 1 || B[i] === 1) ? 1 : 0;
          } else if (isAnd) for (let i = 0; i < n; i++) out[i] = (truthy(lp, A, i) && truthy(rp, B, i)) ? 1 : 0;
          else for (let i = 0; i < n; i++) out[i] = (truthy(lp, A, i) || truthy(rp, B, i)) ? 1 : 0;
          return out;
        } };
      }
      case 'call': {
        const args = node.args.map(build), S = arr();
        if (node.fn === 'if') {
          const [c, a, b] = args;
          return { t: 'raw', run: (ctx) => {
            const n = ctx.n, out = S(ctx.n);
            const C = c.run ? c.run(ctx) : null, A = a.run ? a.run(ctx) : null, B = b.run ? b.run(ctx) : null;
            for (let i = 0; i < n; i++) {
              const cv = c.s !== undefined ? c.s === true : (c.t === 'bool' ? C[i] === 1 : bget(c.t, C, i) === true);
              out[i] = cv ? (a.s !== undefined ? a.s : bget(a.t, A, i)) : (b.s !== undefined ? b.s : bget(b.t, B, i));
            }
            return out;
          } };
        }
        const fn = FN[node.fn];                            // generic: shared helpers, per-row over vectors
        return { t: 'raw', run: (ctx) => {
          const n = ctx.n, out = S(ctx.n);
          const bufs = args.map((p) => (p.run ? p.run(ctx) : null));
          const av = new Array(args.length);
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < args.length; j++) av[j] = args[j].s !== undefined ? args[j].s : bget(args[j].t, bufs[j], i);
            const r = fn(av, N); out[i] = r === undefined ? null : r;
          }
          return out;
        } };
      }
    }
    return { s: null };
  }

  const plan = build(ast);
  if (plan.s !== undefined) {                              // whole expression is a constant
    const v = plan.s; let buf = null;
    return (cols, n) => { if (!buf || buf.length < n) { buf = new Array(n); } buf.fill(v, 0, n); return { t: 'raw', buf }; };
  }
  return (cols, n) => { const r = plan.run({ cols, n }); return { t: plan.t, buf: r }; };
}

// boolean face: (cols, n) → Uint8Array 0/1 mask (blank → 0), buffer reused.
function compileChunkBool(exprOrAst, columns, opts = {}) {
  const f = compileChunk(exprOrAst, columns, opts);
  let mask = null;
  return (cols, n) => {
    const { t, buf } = f(cols, n);
    if (t === 'bool' && buf instanceof Uint8Array) {
      if (mask === buf) return mask;                       // (defensive; plans own their buffers)
      mask = mask && mask.length >= n ? mask : new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = buf[i] === 1 ? 1 : 0;
      return mask;
    }
    mask = mask && mask.length >= n ? mask : new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = buf[i] === true ? 1 : 0;
    return mask;
  };
}

// ── src/complete.js ──

// @gcu/expr — context-aware completion for the filter / calc editors. Given the
// source + caret, it figures out what's expected *here* and offers it:
//   • a VALUE position (after `col =`, `col in (`, `col contains`, …) → the column's
//     distinct values, QUOTED — this is the one that closes the bare-word-vs-quoted
//     footgun: you pick "OXIDE" from a list instead of typing bare ox.
//   • an OPERAND position (start, after and/or/not/`(`) → columns + functions.
//   • an OPERATOR position (an operand just ended) → comparisons + keywords.
//
// Heuristic, token-driven (rides tokenize), not a full grammar — but it covers the
// shapes people actually type. Returns { from, to, options:[{value,kind,detail}] };
// the host replaces src[from..to] with a chosen option.value.


const CMP_OPS = ['=', '!=', '<', '>', '<=', '>=', '==', '<>'];
const VALUE_KW = ['in', 'contains', 'like', 'matches'];
const RESET_KW = ['and', 'or', 'not', 'between'];        // crossing one of these ends "this comparison"
const quoteVal = (v) => '"' + String(v).replace(/"/g, '') + '"';

// Is the nearest enclosing `(` an `in (` list (vs a grouping / function paren)?
function insideInList(toks) {
  let depth = 0;
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.kind === 'punct' && t.value === ')') depth++;
    else if (t.kind === 'punct' && t.value === '(') {
      if (depth === 0) { const prev = toks[k - 1]; return !!(prev && prev.kind === 'keyword' && prev.value.toLowerCase() === 'in'); }
      depth--;
    }
  }
  return false;
}

// The column being compared = scan back to the nearest column, stopping if we cross
// a boolean/range keyword (that ended the previous comparison).
function compareColumn(toks) {
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.kind === 'column') return t.value;
    if (t.kind === 'keyword' && RESET_KW.includes(t.value.toLowerCase())) return null;
  }
  return null;
}

/**
 * @param {string} src
 * @param {number} pos  caret index (default = end)
 * @param {object} ctx  { columns: [{name,type}|name], values?: (col)=>string[] | {col:[…]} }
 * @returns {{from:number, to:number, options:Array<{value:string,kind:string,detail?:string}>}}
 */
function complete(src, pos, ctx = {}) {
  src = String(src == null ? '' : src);
  pos = Math.max(0, Math.min(pos == null ? src.length : pos, src.length));
  const columns = (ctx.columns || []).map((c) => (typeof c === 'string' ? { name: c, type: 'string' } : { name: c.name, type: c.type || 'string' }));
  const valFn = typeof ctx.values === 'function' ? ctx.values
    : (ctx.values ? (n) => ctx.values[n] || ctx.values[String(n).toLowerCase()] || [] : () => []);

  const before = src.slice(0, pos);
  // NB the fragment class keeps `-` (and backtick as an open quote) so typing
  // `OK-Ind` still prefix-matches the column OK-Indic even though idents can't
  // contain `-` — this is a UI heuristic, not the grammar.
  const fm = before.match(/(["'`]?)([A-Za-z0-9_-]*)$/) || ['', '', ''];
  const quote = fm[1] || '', frag = fm[2] || '';
  const from = pos - quote.length - frag.length;
  let to = pos;
  if (quote && src[to] === quote) to++;                  // a value typed between quotes → replace the closing one too

  const toks = tokenize(src.slice(0, from)).filter((t) => t.kind !== 'error');
  const last = toks[toks.length - 1];
  const lastLc = last ? last.value.toLowerCase() : '';
  const lc = frag.toLowerCase();
  const pre = (s) => s.toLowerCase().startsWith(lc);     // prefix match
  const opts = [];

  const valueHere = last && (
    (last.kind === 'operator' && CMP_OPS.includes(last.value)) ||
    (last.kind === 'keyword' && VALUE_KW.includes(lastLc)) ||
    (last.kind === 'punct' && (last.value === '(' || last.value === ',') && insideInList(toks))
  );

  if (valueHere) {
    const col = compareColumn(toks);
    const vals = col ? (valFn(col) || []) : [];
    for (const v of vals) if (pre(String(v))) opts.push({ value: quoteVal(v), kind: 'value', detail: col });
    if (opts.length) return { from, to, options: opts.slice(0, 50) };
    // numeric column (no value list) → fall through to columns/functions
  }

  const operandEnded = last && (last.kind === 'column' || last.kind === 'string' || last.kind === 'number' || (last.kind === 'punct' && last.value === ')'));
  if (operandEnded && !valueHere) {                      // expect an operator / keyword
    for (const o of ['=', '!=', '<', '>', '<=', '>=']) if (pre(o)) opts.push({ value: o, kind: 'operator' });
    for (const kw of ['and', 'or', 'between', 'in', 'contains', 'like', 'matches', 'is blank', 'is filled', 'is not blank', 'not in', 'not contains']) if (pre(kw)) opts.push({ value: kw, kind: 'keyword' });
    return { from, to, options: opts.slice(0, 50) };
  }

  // default: an operand position → columns + functions (+ leading `not`).
  // Non-plain names emit the backtick escape (quoteIdent — the pandas convention).
  for (const c of columns) if (pre(c.name)) opts.push({ value: quoteIdent(c.name), kind: 'column', detail: c.type });
  for (const fn of Object.keys(CALLFNS)) if (pre(fn)) opts.push({ value: fn + '(', kind: 'function' });
  if (pre('not')) opts.push({ value: 'not', kind: 'keyword' });
  return { from, to, options: opts.slice(0, 50) };
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
  tokenize,
  quoteIdent,
  CALLFNS,
  ExprParseError,
  evaluate,
  evalBool,
  constraintValid,
  compile,
  compileValue,
  compileBool,
  compileChunk,
  compileChunkBool,
  deps,
  validate,
  canMatch,
  complete,
  isBlank,
  num,
  FN,
};
