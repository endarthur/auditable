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
export const CALLFNS = {
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
export function quoteIdent(name) {
  const s = String(name);
  return PLAIN_IDENT.test(s) && !RESERVED.has(s.toLowerCase()) ? s : '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

export class ExprParseError extends Error {
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
export function parse(src) {
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
    if (word('between')) { const kt = toks[i]; i++; const lo = add(); if (!(word('and') || op('&&'))) fail("expected 'and' in between"); i++; return fin({ t: 'between', e: l, lo, hi: add(), opStart: kt.start, opEnd: kt.end }); }
    if (word('contains')) { const kt = toks[i]; i++; return fin({ t: 'contains', l, r: add(), opStart: kt.start, opEnd: kt.end }); }
    if (word('in')) { const kt = toks[i]; i++; return fin({ t: 'in', e: l, set: inList(), opStart: kt.start, opEnd: kt.end }); }
    if (word('like')) { const kt = toks[i]; i++; return fin({ t: 'matches', e: l, re: likeToRegex(eatStr()), opStart: kt.start, opEnd: kt.end }); }
    if (word('matches')) { const kt = toks[i]; i++; return fin({ t: 'matches', e: l, re: eatStr(), opStart: kt.start, opEnd: kt.end }); }
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

export const asAst = (x) => (typeof x === 'string' ? parse(x) : x);

// ── tokenize: classified, positioned tokens for syntax highlighting + completion.
// Best-effort (tolerant lexer) so it works on a half-typed expression. kinds:
// column · string · number · operator · punct · keyword · function · boolean · error.
export function tokenize(src) {
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
