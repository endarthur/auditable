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
export const CALLFNS = {
  if: [3, 3], round: [1, 2], int: [1, 1], abs: [1, 1],
  year: [1, 1], month: [1, 1], day: [1, 1],
  log: [1, 1], exp: [1, 1], sqrt: [1, 1], pow: [2, 2], min: [1, Infinity], max: [1, Infinity], clamp: [3, 3],
  ifnum: [2, 2], coalesce: [1, Infinity], isnum: [1, 1], isnan: [1, 1], isblank: [1, 1], isfilled: [1, 1],
};

export class ExprParseError extends Error {
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
export function parse(src) {
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

export const asAst = (x) => (typeof x === 'string' ? parse(x) : x);
