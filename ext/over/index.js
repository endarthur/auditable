// @gcu/over — OVER (Ordered/Vectorized Expression Runner): the table-transform DSL
// Auto-generated from ext/over/src/ — do not edit directly

// -- lex.js --

// @gcu/over — lexer. Turns OVER source into a flat token stream.
//
// Line-oriented (statements are newline/`;`-separated): NEWLINE is a significant
// token. `#` runs to end of line (comment). A leading `%word` is a dialect pragma.
// Backtick-quoted text is a column name verbatim (spaces/unicode/digits ok);
// double-quoted text is a string value. `and`/`or` lex as operators; `not` is just
// a function name (`not(x)`). Everything else word-shaped is an `ident` and the
// parser decides whether it's a keyword.
//
// Token: { t, v, line, col }
//   t ∈ pragma | newline | num | str | field | ident | op | eof

const OP3 = [];                                   // (none yet)
const OP2 = ['==', '!=', '<=', '>=', '??'];
const OP1 = ['=', '<', '>', '+', '-', '*', '/', '(', ')', '{', '}', ':', ',', ';'];
const WORD_OPS = new Set(['and', 'or']);          // infix keyword operators

const isDigit = (c) => c >= '0' && c <= '9';
const isWordStart = (c) => /[A-Za-z_$]/.test(c);
const isWord = (c) => /[A-Za-z0-9_$]/.test(c);

class OverLexError extends Error {
  constructor(msg, line, col) { super(`over: ${msg} (line ${line})`); this.line = line; this.col = col; }
}

function lex(src) {
  const toks = [];
  let i = 0, line = 1, col = 1;
  const s = String(src).replace(/\r\n?/g, '\n');   // normalize newlines
  const n = s.length;
  const at = (k = 0) => s[i + k];
  const push = (t, v) => toks.push({ t, v, line, col });
  const adv = (k = 1) => { for (let j = 0; j < k; j++) { if (s[i] === '\n') { line++; col = 1; } else col++; i++; } };
  let lineStart = true;                             // are we at the first token of a line?

  while (i < n) {
    const c = at();

    if (c === '\n') { push('newline'); adv(); lineStart = true; continue; }
    if (c === ' ' || c === '\t') { adv(); continue; }

    if (c === '#') { while (i < n && at() !== '\n') adv(); continue; }   // comment

    // Dialect pragma: a leading %word on its own line.
    if (c === '%' && lineStart) {
      const startCol = col; adv();
      let w = '';
      while (i < n && isWord(at())) { w += at(); adv(); }
      toks.push({ t: 'pragma', v: w, line, col: startCol });
      lineStart = false; continue;
    }

    lineStart = false;

    if (c === '`') {                                // backtick column name
      const startLine = line, startCol = col; adv();
      let v = '';
      while (i < n && at() !== '`') { if (at() === '\n') throw new OverLexError('unterminated `column name`', startLine, startCol); v += at(); adv(); }
      if (i >= n) throw new OverLexError('unterminated `column name`', startLine, startCol);
      adv();                                        // closing backtick
      toks.push({ t: 'field', v, line: startLine, col: startCol }); continue;
    }

    if (c === '"') {                                // string value
      const startLine = line, startCol = col; adv();
      let v = '';
      while (i < n && at() !== '"') {
        if (at() === '\\') { adv(); v += at(); adv(); continue; }
        if (at() === '\n') throw new OverLexError('unterminated "string"', startLine, startCol);
        v += at(); adv();
      }
      if (i >= n) throw new OverLexError('unterminated "string"', startLine, startCol);
      adv();
      toks.push({ t: 'str', v, line: startLine, col: startCol }); continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(at(1)))) {
      const startCol = col; let raw = '';
      while (i < n && /[0-9.eE+\-]/.test(at())) {
        // stop a trailing +/- that isn't part of an exponent
        if ((at() === '+' || at() === '-') && !/[eE]/.test(raw[raw.length - 1])) break;
        raw += at(); adv();
      }
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new OverLexError(`bad number "${raw}"`, line, startCol);
      toks.push({ t: 'num', v: num, line, col: startCol }); continue;
    }

    if (isWordStart(c)) {
      const startCol = col; let w = '';
      while (i < n && isWord(at())) { w += at(); adv(); }
      if (WORD_OPS.has(w)) toks.push({ t: 'op', v: w, line, col: startCol });
      else toks.push({ t: 'ident', v: w, line, col: startCol });
      continue;
    }

    // operators / punctuation
    const two = s.slice(i, i + 2);
    if (OP2.includes(two)) { push('op', two); adv(2); continue; }
    if (OP1.includes(c)) { push('op', c); adv(); continue; }

    throw new OverLexError(`unexpected character "${c}"`, line, col);
  }

  push('eof');
  return toks;
}

// -- parse.js --

// @gcu/over — parser. Token stream → AST (the v0 row-map grammar; windows + the
// v1 statements `check`/`emit`/escape come later). Recursive descent.
//
// AST (type-discriminated plain objects):
//   Transform { dialect, statements:[Stmt] }
//   Stmt = Assign  { kind:'field'|'let', target:{name, spec?}, value:Expr }
//        | If      { clauses:[{test:Expr, body:[Stmt]}], alternate?:[Stmt] }
//        | Project { name:'keep'|'saveonly'|'erase', fields:[string] }
//        | Control { name:'delete'|'exit' }
//   TypeSpec { vtype?:'int'|'float'|'bool'|'string'|'category', default?:Expr }
//   Expr = Num{value} | Str{value} | Bool{value} | Absent
//        | Field{name} | Unary{op:'-', operand} | Binary{op,left,right}
//        | Call{name, args:[Expr]} | Match{subject, arms:[{rel?,test?,value}], default?}


const REL = new Set(['==', '!=', '<', '<=', '>', '>=']);
const TYPES = new Set(['int', 'float', 'bool', 'string', 'category']);
const STMT_KW = new Set(['if', 'elseif', 'else', 'end', 'keep', 'saveonly', 'erase', 'delete', 'exit', 'let']);

class OverParseError extends Error {
  constructor(msg, tok) { super(`over: ${msg}${tok ? ` (line ${tok.line})` : ''}`); this.tok = tok; }
}

function parse(src) { return parseTokens(lex(src)); }

function parseTokens(toks) {
  let p = 0;
  const cur = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v) => cur().t === 'op' && cur().v === v;
  const isId = (v) => cur().t === 'ident' && cur().v === v;
  const isRel = () => cur().t === 'op' && REL.has(cur().v);
  const err = (m, t = cur()) => new OverParseError(m, t);
  const desc = (t) => t.t === 'eof' ? 'end of input' : t.t === 'newline' ? 'end of line' : `"${t.v}"`;

  function expectOp(v) { if (!isOp(v)) throw err(`expected "${v}", got ${desc(cur())}`); return next(); }
  function expectId(v) { if (!isId(v)) throw err(`expected "${v}", got ${desc(cur())}`); return next(); }
  function skipSeps() { while (cur().t === 'newline' || isOp(';')) p++; }

  function fieldName() {
    const t = cur();
    if (t.t === 'field' || t.t === 'ident') { next(); return t.v; }
    throw err(`expected a column name, got ${desc(t)}`);
  }

  // ── statements ──
  function parseStatements(stops) {
    const out = [];
    for (;;) {
      skipSeps();
      const t = cur();
      if (t.t === 'eof') break;
      if (t.t === 'ident' && stops && stops.has(t.v)) break;
      out.push(parseStatement());
    }
    return out;
  }

  function parseStatement() {
    const t = cur();
    if (t.t === 'ident') {
      if (t.v === 'if') return parseIf();
      if (t.v === 'keep' || t.v === 'saveonly' || t.v === 'erase') return parseProject();
      if (t.v === 'delete' || t.v === 'exit') { next(); return { type: 'Control', name: t.v }; }
      if (t.v === 'let') return parseLet();
      if (STMT_KW.has(t.v)) throw err(`unexpected "${t.v}"`);
    }
    return parseAssign();
  }

  function parseTypeSpec() {
    expectOp(':');
    const spec = {};
    const t = cur();
    if (t.t !== 'ident' || !TYPES.has(t.v)) throw err(`expected a type (${[...TYPES].join('/')}), got ${desc(t)}`);
    spec.vtype = next().v;
    if (isId('default')) { next(); spec.default = parseExpr(); }   // per-column fill (units: later)
    return spec;
  }

  function parseAssign() {
    const t = cur();
    if (t.t !== 'ident' && t.t !== 'field') throw err(`expected a column name, got ${desc(t)}`);
    const name = next().v;
    const target = { name };
    if (isOp(':')) target.spec = parseTypeSpec();
    expectOp('=');
    const value = parseExpr();
    return { type: 'Assign', kind: 'field', target, value };
  }

  function parseLet() {
    expectId('let');
    const name = fieldName();
    expectOp('=');
    return { type: 'Assign', kind: 'let', target: { name }, value: parseExpr() };
  }

  function parseProject() {
    const name = next().v;                 // keep | saveonly | erase
    expectOp('(');
    const fields = [];
    if (!isOp(')')) for (;;) { fields.push(fieldName()); if (isOp(',')) { next(); continue; } break; }
    expectOp(')');
    return { type: 'Project', name, fields };
  }

  function parseIf() {
    expectId('if');
    const clauses = [];
    clauses.push({ test: parseExpr(), body: (skipSeps(), parseStatements(new Set(['elseif', 'else', 'end']))) });
    while (isId('elseif')) {
      next();
      clauses.push({ test: parseExpr(), body: (skipSeps(), parseStatements(new Set(['elseif', 'else', 'end']))) });
    }
    let alternate;
    if (isId('else')) { next(); skipSeps(); alternate = parseStatements(new Set(['end'])); }
    expectId('end');
    return { type: 'If', clauses, alternate };
  }

  // ── expressions (precedence low→high) ──
  function parseExpr() { return parseCoalesce(); }

  function parseCoalesce() {
    let left = parseOr();
    while (isOp('??')) { next(); left = { type: 'Binary', op: '??', left, right: parseOr() }; }
    return left;
  }
  function parseOr() {
    let left = parseAnd();
    while (isOp('or')) { next(); left = { type: 'Binary', op: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseRel();
    while (isOp('and')) { next(); left = { type: 'Binary', op: 'and', left, right: parseRel() }; }
    return left;
  }
  function parseRel() {
    const left = parseAdd();
    if (isRel()) { const op = next().v; return { type: 'Binary', op, left, right: parseAdd() }; }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (isOp('+') || isOp('-')) { const op = next().v; left = { type: 'Binary', op, left, right: parseMul() }; }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (isOp('*') || isOp('/')) { const op = next().v; left = { type: 'Binary', op, left, right: parseUnary() }; }
    return left;
  }
  function parseUnary() {
    if (isOp('-')) { next(); return { type: 'Unary', op: '-', operand: parseUnary() }; }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = cur();
    if (t.t === 'num') { next(); return { type: 'Num', value: t.v }; }
    if (t.t === 'str') { next(); return { type: 'Str', value: t.v }; }
    if (t.t === 'field') { next(); return { type: 'Field', name: t.v }; }
    if (isOp('(')) { next(); const e = parseExpr(); expectOp(')'); return e; }
    if (t.t === 'ident') {
      if (t.v === 'true') { next(); return { type: 'Bool', value: true }; }
      if (t.v === 'false') { next(); return { type: 'Bool', value: false }; }
      if (t.v === 'absent') { next(); return { type: 'Absent' }; }
      if (t.v === 'match') return parseMatch();
      next();
      if (isOp('(')) {
        next();
        const args = [];
        if (!isOp(')')) for (;;) { args.push(parseExpr()); if (isOp(',')) { next(); continue; } break; }
        expectOp(')');
        return { type: 'Call', name: t.v, args };
      }
      return { type: 'Field', name: t.v };
    }
    throw err(`unexpected ${desc(t)}`);
  }

  function parseMatch() {
    expectId('match');
    const subject = parseExpr();
    expectOp('{');
    const arms = [];
    let def;
    for (;;) {
      skipSeps();
      if (isOp('}')) break;
      if (isId('_')) { next(); expectOp(':'); def = parseExpr(); }
      else {
        let rel, test;
        if (isRel()) { rel = next().v; test = parseAdd(); }   // `>= 64` — implicit subject
        else test = parseExpr();                              // `"OX"` (equality) or a full bool guard
        expectOp(':');
        arms.push({ rel, test, value: parseExpr() });
      }
      skipSeps();
      if (isOp(',')) next();
    }
    expectOp('}');
    return { type: 'Match', subject, arms, default: def };
  }

  // ── program ──
  skipSeps();
  let dialect = 'native';
  if (cur().t === 'pragma') {
    dialect = cur().v;
    if (dialect !== 'native' && dialect !== 'compat') throw err(`unknown dialect pragma "%${dialect}" (native | compat)`);
    next();
  }
  const statements = parseStatements(null);
  if (cur().t !== 'eof') throw err(`unexpected ${desc(cur())} after transform`);
  return { type: 'Transform', dialect, statements };
}

export {
  OverLexError,
  OverParseError,
  lex,
  parse,
  parseTokens,
};
