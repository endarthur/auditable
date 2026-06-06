// @gcu/over — OVER (Ordered/Vectorized Expression Runner): the table-transform DSL
// Auto-generated from ext/over/src/ — do not edit directly

// -- dimensions/dimensions.js (inlined) --

// @gcu/dimensions — the dimension algebra at the heart of dimensional analysis.
//
// A dimension is a sparse object `{ axis: integerExponent }`. Dimensions form a
// free abelian group under multiplication (componentwise exponent add); the
// identity is `{}` (scalar / dimensionless) and the inverse is negation. That's the
// whole model — small, total, and exact (integer exponents, no floats).
//
// This is the zero-dependency core shared across GCU: ep's @gcu/numbat does full
// unit resolution + conversion on top of it; auditable's @gcu/over uses it for
// compile-time grade-math checking (with a domain unit table where, deliberately,
// %/g·t⁻¹/ppm are DISTINCT axes — mining grades must not silently mix even though a
// physics engine would call them all dimensionless). The axis KEYS are the caller's
// vocabulary: numbat uses 'length'/'mass'/'time'/…; a domain layer can mint its own.

// Equal iff every axis has the same exponent (missing = 0, so key order and stored
// zeros don't matter).
const dimEq = (a, b) => {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] || 0) !== (b[k] || 0)) return false;
  }
  return true;
};

// Product: add exponents componentwise, dropping any that cancel to zero.
const dimMul = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] || 0) + (b[k] || 0);
    if (n) r[k] = n;
  }
  return r;
};

// Quotient: subtract exponents componentwise, dropping zeros.
const dimDiv = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] || 0) - (b[k] || 0);
    if (n) r[k] = n;
  }
  return r;
};

// Raise to an integer power: scale every exponent, dropping zeros.
const dimPow = (d, n) => {
  const r = {};
  for (const k in d) {
    const e = d[k] * n;
    if (e) r[k] = e;
  }
  return r;
};

// Reciprocal dimension (negate all exponents).
const dimInv = (d) => dimPow(d, -1);

// True for the scalar / dimensionless dimension only. (Checks Object.keys, so a
// stored `{length: 0}` reads as non-empty — but the arithmetic above never produces
// stored zeros, so that case doesn't arise in practice.)
const dimEmpty = (d) => Object.keys(d).length === 0;

// Human-readable form: `mass·length^-3`, or `-` for dimensionless.
const dimFormat = (d) => {
  const parts = Object.entries(d).map(([k, v]) => (v === 1 ? k : `${k}^${v}`));
  return parts.join('·') || '-';
};

// DimRegistry — a name → dim-vector table. Base dimensions allocate a fresh axis
// named after themselves (lowercased); derived dimensions store a precomputed vector
// (built via the arithmetic above). Re-defining with the same shape is idempotent
// (so a vendored module's `dimension Length` won't conflict with a host's pre-seed);
// re-defining with a different shape throws.
class DimRegistry {
  constructor() {
    this._dims = new Map();
  }

  defineBase(name) {
    const axis = name.toLowerCase();
    this._define(name, { [axis]: 1 });
  }

  defineDerived(name, dim) {
    this._define(name, dim);
  }

  _define(name, dim) {
    if (this._dims.has(name)) {
      if (dimEq(this._dims.get(name), dim)) return;
      throw new Error(`dimension already defined with different shape: ${name}`);
    }
    this._dims.set(name, dim);
  }

  resolve(name) { return this._dims.get(name) ?? null; }
  has(name) { return this._dims.has(name); }
  list() { return [...this._dims.entries()].map(([name, dim]) => ({ name, dim })); }
}

// -- util.js --

// @gcu/over — shared zero-dep primitives used across the pipeline modules. Kept in
// ONE place because the concat build flattens every module into a single scope, so a
// helper defined privately in two modules would collide (a hard `const` redeclare).
// Each module imports what it needs; the bundle ends up with one definition.

// absent = null (string/category absent) OR NaN (numeric absent) — the type-
// polymorphic split (the NaN keystone). `x !== x` is the branch-free NaN test.
const isAbsent = (x) => x == null || x !== x;

// group-key / eq-key field separator — a control char that won't occur in data.
const SEP = String.fromCharCode(1);

// numeric comparator (sorting interval bounds / lo-keys).
const numCmp = (a, b) => Number(a) - Number(b);

// a reference table is an array of rows, or a { rows } result (so transforms chain).
const refRowsOf = (t) => (Array.isArray(t) ? t : (t && t.rows) || null);

// the relational operators — shared by the parser's `isRel` and the emitter's
// `isBoolish` (same set, one definition).
const REL = new Set(['==', '!=', '<', '<=', '>', '>=']);

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
//   t ∈ pragma | newline | num | str | field | ident | unit | op | eof
// `[g/t]` lexes as a single `unit` token (raw text between the brackets) — a unit
// annotation in a type spec (`GRADE : float[g/t]`); the only use of [] so far.

const OP3 = [];                                   // (none yet)
const OP2 = ['==', '!=', '<=', '>=', '??'];
const OP1 = ['=', '<', '>', '+', '-', '*', '/', '(', ')', '{', '}', ':', ',', ';', '.'];
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

    if (c === '[') {                                // [unit] — a unit annotation
      const startLine = line, startCol = col; adv();
      let v = '';
      while (i < n && at() !== ']') { if (at() === '\n') throw new OverLexError('unterminated [unit]', startLine, startCol); v += at(); adv(); }
      if (i >= n) throw new OverLexError('unterminated [unit]', startLine, startCol);
      adv();                                        // closing ]
      toks.push({ t: 'unit', v: v.trim(), line: startLine, col: startCol }); continue;
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
//   Stmt = Assign  { kind:'field'|'let', target:{name, spec?}, value:Expr|null }
//                  (value null = a bare `NAME : spec` annotation — type/unit only)
//        | If      { clauses:[{test:Expr, body:[Stmt]}], alternate?:[Stmt] }
//        | Project { name:'keep'|'saveonly'|'erase', fields:[string] }
//        | Control { name:'delete'|'exit' }
//        | Check   { severity:'warn'|'error', label?:string, test:Expr }   // check / require
//   TypeSpec { vtype?:'int'|'float'|'bool'|'string'|'category', unit?:string, default?:Expr }
//   Expr = Num{value} | Str{value} | Bool{value} | Absent
//        | Field{name} | Unary{op:'-', operand} | Binary{op,left,right}
//        | Call{name, args:[Expr]} | Match{subject, arms:[{rel?,test?,value}], default?}



const TYPES = new Set(['int', 'float', 'bool', 'string', 'category']);
const STMT_KW = new Set(['if', 'elseif', 'else', 'end', 'keep', 'saveonly', 'erase', 'delete', 'exit', 'let', 'check', 'require']);

class OverParseError extends Error {
  constructor(msg, tok) { super(`over: ${msg}${tok ? ` (line ${tok.line})` : ''}`); this.tok = tok; }
}

function parse(src) { return parseTokens(lex(src)); }

function parseTokens(toks) {
  let p = 0;
  const cur = () => toks[p];
  const peek = () => toks[p + 1];
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
      if (t.v === 'check' || t.v === 'require') return parseCheck();
      if (STMT_KW.has(t.v)) throw err(`unexpected "${t.v}"`);
    }
    return parseAssign();
  }

  // `: vtype` | `: vtype[unit]` | `: [unit]` (implies float) | `… default EXPR`.
  function parseTypeSpec() {
    expectOp(':');
    const spec = {};
    if (cur().t === 'ident' && TYPES.has(cur().v)) spec.vtype = next().v;   // optional vtype
    if (cur().t === 'unit') spec.unit = next().v;                           // optional [unit]
    if (!spec.vtype && spec.unit) spec.vtype = 'float';                     // a bare unit implies float
    if (!spec.vtype) throw err(`expected a type (${[...TYPES].join('/')}) or a [unit], got ${desc(cur())}`);
    if (isId('default')) { next(); spec.default = parseExpr(); }            // per-column fill
    return spec;
  }

  function parseAssign() {
    const t = cur();
    if (t.t !== 'ident' && t.t !== 'field') throw err(`expected a column name, got ${desc(t)}`);
    const name = next().v;
    const target = { name };
    if (isOp(':')) target.spec = parseTypeSpec();
    // `NAME : spec` with no `=` is a bare annotation — declare a column's type/unit
    // without assigning a value (the column passes through unchanged).
    if (target.spec && !isOp('=')) return { type: 'Assign', kind: 'field', target, value: null };
    expectOp('=');
    return { type: 'Assign', kind: 'field', target, value: parseExpr() };
  }

  function parseLet() {
    expectId('let');
    const name = fieldName();
    expectOp('=');
    return { type: 'Assign', kind: 'let', target: { name }, value: parseExpr() };
  }

  // `check [ "label": ] PREDICATE` — an observational validation rule (reports).
  // `require …` is the same shape but ENFORCING (a failed rule throws after the pass).
  // A leading `STRING :` is the label (a predicate starting with a string would be
  // `STRING ==` etc., never `STRING :`), else the predicate text labels it.
  function parseCheck() {
    const kw = next().v;                       // 'check' | 'require'
    let label = null;
    if (cur().t === 'str' && peek() && peek().t === 'op' && peek().v === ':') { label = next().v; expectOp(':'); }
    return { type: 'Check', severity: kw === 'require' ? 'error' : 'warn', label, test: parseExpr() };
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
  // Chained comparisons (Python-style): `a <= b < c` → `(a <= b) and (b < c)`.
  // Useful generally (`0 < grade < 100`) and exactly what an interval predicate
  // wants (`from <= DEPTH < to`). The shared operand is re-referenced in the AST
  // (fine for OVER's pure column/expr operands).
  function parseRel() {
    let left = parseAdd();
    if (!isRel()) return left;
    let prev = left, result = null;
    while (isRel()) {
      const op = next().v;
      const right = parseAdd();
      const comp = { type: 'Binary', op, left: prev, right };
      result = result ? { type: 'Binary', op: 'and', left: result, right: comp } : comp;
      prev = right;
    }
    return result;
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
    return parsePostfix();
  }

  // window postfix: `aggCall over GROUP [order EXPR] [where EXPR]` — binds tighter
  // than arithmetic, so `FE / mean(FE) over LITHO` is `FE / (mean(FE) over LITHO)`.
  // `order` makes it a running (ordered) window; `where` filters the accumulation.
  function parsePostfix() {
    let e = parsePrimary();
    if (isId('over')) {
      next();
      const win = { type: 'Window', agg: e, group: parseGroupSpec() };
      if (isId('order')) { next(); if (isId('by')) next(); win.order = parseExpr(); }
      if (isId('where')) { next(); win.where = parseExpr(); }
      e = win;
    } else if (isId('where') && e.type === 'Call') {
      // aggregating join: `AGG(args) where PREDICATE` (no `over`). Only an aggregate
      // CALL takes a bare `where` — so a window's `order EXPR where FILTER` (EXPR is
      // a plain field/expr) isn't misread as a join. The predicate is greedy
      // (consumes to end of expression, like `lookup`) — so inline use needs an
      // assign-first. join.js validates the aggregate + analyzes the predicate.
      next();
      e = { type: 'JoinAgg', agg: e, predicate: parseExpr() };
    }
    return e;
  }

  // GROUP = `all` | `()` (whole table) | column | `(col, col, …)`.
  function parseGroupSpec() {
    if (isId('all')) { next(); return 'all'; }
    if (isOp('(')) {
      next();
      const cols = [];
      if (!isOp(')')) for (;;) { cols.push(fieldName()); if (isOp(',')) { next(); continue; } break; }
      expectOp(')');
      return cols.length ? cols : 'all';
    }
    return [fieldName()];
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
      if (t.v === 'lookup') return parseLookup();
      next();
      if (isOp('(')) {
        next();
        const args = [];
        if (!isOp(')')) for (;;) { args.push(parseExpr()); if (isOp(',')) { next(); continue; } break; }
        expectOp(')');
        return { type: 'Call', name: t.v, args };
      }
      if (isOp('.')) { next(); return { type: 'Qualified', table: t.v, col: fieldName() }; }   // table.col
      return { type: 'Field', name: t.v };
    }
    throw err(`unexpected ${desc(t)}`);
  }

  // SQL-y join: `lookup TABLE.valueCol where PREDICATE`. The value is a qualified
  // ref; the predicate is an `and` of comparisons between TABLE.col and this row's
  // values. The compiler reads the predicate shape to pick the index (lookup.js).
  function parseLookup() {
    expectId('lookup');
    const value = parsePrimary();
    if (value.type !== 'Qualified') throw err('lookup expects `lookup TABLE.column where …`');
    expectId('where');
    return { type: 'Lookup', value, predicate: parseExpr() };
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

// -- units.js --

// @gcu/over — units: compile-time dimensional checking of grade math. A column can
// carry a UNIT (a dimension) beside its vtype; units propagate through arithmetic in
// the schema pass and mismatches WARN (advisory, like AIR hints — never an error,
// never a runtime cost: the emitted JS is unchanged). This catches the silent grade
// disasters — adding a % grade to a g/t grade, compositing in feet against a metre
// model, computing metal with the wrong unit.
//
// Built on @gcu/dimensions (the shared algebra). The KEY domain choice: grade units
// (%, g/t, ppm, oz/t) get DISTINCT axes so they never silently mix — a physics engine
// would reduce all of them to "dimensionless" and miss the headline error. Physical
// units (m, t, m³) share real axes so density·volume→tonnes & grade·tonnes→metal fall
// out. m vs ft are distinct axes too (Tier 1 has no conversion — mixing them warns).


// Atomic unit symbols → dimension. Grade units are their OWN axes (pct/gpt/ppm/ozt);
// physical units get a per-symbol base axis (so m≠ft, t≠g — Tier 1 keeps them apart).
const U = {
  '%': { pct: 1 }, 'pct': { pct: 1 }, 'percent': { pct: 1 },
  'g/t': { gpt: 1 }, 'gpt': { gpt: 1 }, 'gpt_au': { gpt: 1 },
  'ppm': { ppm: 1 }, 'ppb': { ppb: 1 },
  'oz/t': { ozt: 1 }, 'opt': { ozt: 1 },
  'm': { m: 1 }, 'cm': { cm: 1 }, 'mm': { mm: 1 }, 'km': { km: 1 }, 'ft': { ft: 1 },
  't': { t: 1 }, 'kg': { kg: 1 }, 'g': { g: 1 }, 'lb': { lb: 1 }, 'oz': { oz: 1 },
};

// A single factor: `m` | `m3` | `m^3` | `ft2` — base symbol with an optional integer
// exponent. Unknown base → its own axis (lenient: a typo'd unit type-checks as a
// distinct unit, so it mismatches a correct one and surfaces the typo).
function factorDim(sym) {
  const m = sym.match(/^([A-Za-z%]+?)\^?(-?\d+)?$/);
  if (!m) return { [sym]: 1 };
  const base = m[1], exp = m[2] ? parseInt(m[2], 10) : 1;
  const baseDim = (base in U) ? U[base] : { [base]: 1 };
  return dimPow(baseDim, exp);
}

// Parse a unit string → dimension. Atomic symbols (incl. grade compounds like `g/t`)
// resolve directly; anything else is a product/quotient of factors (`t/m3`, `g/cm3`).
function parseUnit(str) {
  const s = String(str || '').trim();
  if (!s || s === '1' || s === '-') return {};        // dimensionless
  if (s in U) return U[s];                             // atomic (g/t, oz/t, %, …)
  let dim = {}, op = '*';
  const re = /([*/·])|([^*/·\s]+)/g;
  let mm;
  while ((mm = re.exec(s)) !== null) {
    if (mm[1]) op = mm[1] === '/' ? '/' : '*';
    else { const f = factorDim(mm[2]); dim = op === '/' ? dimDiv(dim, f) : dimMul(dim, f); op = '*'; }
  }
  return dim;
}

const UNIT_PRESERVING = new Set(['abs', 'min', 'max', 'minia', 'maxia', 'round', 'int']);
const AGG_PRESERVING = new Set(['mean', 'sum', 'min', 'max', 'std', 'first', 'last', 'prev', 'next']);

// Infer the unit (a dim) of an expression, or null = "no unit info" (polymorphic — a
// bare literal or undeclared column adopts the other operand's unit, so adding a
// constant to a g/t doesn't nag). uctx = { unitOf(name) → dim|null, warn(msg) }.
function inferUnit(expr, uctx) {
  if (!expr) return null;                  // bare annotation (no value) → no inferred unit
  switch (expr.type) {
    case 'Field': return uctx.unitOf(expr.name);
    case 'Unary': return inferUnit(expr.operand, uctx);
    case 'Binary': return binaryUnit(expr, uctx);
    case 'Call': return UNIT_PRESERVING.has(expr.name) && expr.args[0] ? inferUnit(expr.args[0], uctx) : null;
    case 'Match': return matchUnit(expr, uctx);
    case 'Window': {
      const a = expr.agg;
      return a && a.name && AGG_PRESERVING.has(a.name) && a.args && a.args[0] ? inferUnit(a.args[0], uctx) : null;
    }
    default: return null;       // Num/Str/Bool/Absent → polymorphic; Lookup/JoinAgg/count → unknown
  }
}

function binaryUnit(e, uctx) {
  const op = e.op;
  if (op === 'and' || op === 'or' || op === '??') return null;
  const lu = inferUnit(e.left, uctx), ru = inferUnit(e.right, uctx);
  if (op === '+' || op === '-') {
    if (lu && ru) {
      if (!dimEq(lu, ru)) { uctx.warn(`${op === '+' ? 'adding' : 'subtracting'} incompatible units (${dimFormat(lu)} vs ${dimFormat(ru)})`); return null; }
      return lu;
    }
    return lu || ru;            // one side unitless → adopt the other's unit (no nag)
  }
  if (op === '*') return (!lu && !ru) ? null : dimMul(lu || {}, ru || {});
  if (op === '/') return (!lu && !ru) ? null : dimDiv(lu || {}, ru || {});
  // comparison → bool, no unit; but flag comparing across units
  if (lu && ru && !dimEq(lu, ru)) uctx.warn(`comparing incompatible units (${dimFormat(lu)} vs ${dimFormat(ru)})`);
  return null;
}

function matchUnit(e, uctx) {
  const us = e.arms.map((a) => inferUnit(a.value, uctx));
  if (e.default) us.push(inferUnit(e.default, uctx));
  const known = us.filter(Boolean);
  if (!known.length) return null;
  return known.every((u) => dimEq(u, known[0])) ? known[0] : null;
}

export { dimEq, dimFormat };   // re-exported for the schema pass

// -- schema.js --

// @gcu/over — the static schema pass (SPEC §5, the auditable core). Walk the AST
// once, BEFORE any row, and resolve the output column list as a pure function of
// (transform, input schema, dialect). Evaluation never invents a column.
//
//   schemaPass(ast, inputSchema, opts?) → { columns, lets, warnings }
//     inputSchema: [{ name, type|vtype, … }]   (extra props pass through)
//     columns:     [{ name, vtype, … }]         the resolved, ordered output
//     lets:        [{ name, vtype }]             scratch temps (not in output)
//     warnings:    [string]                      e.g. use-before-def, name-rule
//
// Type inference is dataflow + branch-merge (unify) with bool↔numeric coercion,
// matching the AIR typing model. `vtype` ∈ int | float | bool | string | category
// | dynamic. Native relational/logical → bool; compat → float.


const NUM = new Set(['int', 'float']);
const STR = new Set(['string', 'category']);

// Are any units declared (input schema or a `[unit]` type spec)? If not, the whole
// unit channel is skipped — zero overhead when nobody asked for units.
function unitsInPlay(ast, inputSchema) {
  if (inputSchema.some((c) => c.unit)) return true;
  let found = false;
  (function walk(sts) {
    for (const st of sts || []) {
      if (st.type === 'Assign' && st.target.spec && st.target.spec.unit) found = true;
      else if (st.type === 'If') { st.clauses.forEach((c) => walk(c.body)); walk(st.alternate); }
    }
  })(ast && ast.statements);
  return found;
}

const FN_NUMERIC = new Set(['abs', 'sqrt', 'exp', 'log', 'loge', 'logn', 'pow', 'rais',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'azimuth', 'phi', 'mod', 'modc',
  'special', 'round', 'min', 'max', 'minia', 'maxia', 'ijkget']);
const FN_INT = new Set(['int', 'len', 'ijknum', 'xyzijk', 'bin']);
const FN_STRING = new Set(['concat', 'substr', 'trim', 'ucase', 'lcase', 'string', 'join', 'field', 'type', 'binlabel']);
const FN_PASSTHRU = new Set(['default', 'first', 'last', 'prev', 'next']);   // return arg[0]'s type
const FN_LOGICAL = new Set(['not']);

// Unify two types into the most specific common type (bool coerces to int in a
// numeric context; mixed/unknown → dynamic).
function unify(a, b) {
  if (a === b) return a;
  if (!a || a === 'dynamic' || !b || b === 'dynamic') return 'dynamic';
  if (NUM.has(a) && NUM.has(b)) return (a === 'float' || b === 'float') ? 'float' : 'int';
  if (a === 'bool' && NUM.has(b)) return b;              // bool + int → int, bool + float → float
  if (b === 'bool' && NUM.has(a)) return a;
  if (STR.has(a) && STR.has(b)) return 'string';
  return 'dynamic';
}

function numericResult(a, b, op) {
  if (op === '/') return 'float';
  const an = a === 'bool' ? 'int' : a, bn = b === 'bool' ? 'int' : b;
  if (an === 'int' && bn === 'int') return 'int';
  if (NUM.has(an) && NUM.has(bn)) return 'float';
  return 'float';                                         // dynamic/unknown operand → assume float
}

function inferExprType(expr, ctx) {
  switch (expr.type) {
    case 'Num': return Number.isInteger(expr.value) ? 'int' : 'float';
    case 'Str': return 'string';
    case 'Bool': return 'bool';
    case 'Absent': return 'dynamic';
    case 'Field': {
      const t = ctx.get(expr.name);
      if (t === undefined) ctx.warn(`references column "${expr.name}" before it exists`);
      return t || 'dynamic';
    }
    case 'Unary': {
      const t = inferExprType(expr.operand, ctx);
      return t === 'float' ? 'float' : (t === 'int' || t === 'bool') ? 'int' : 'dynamic';
    }
    case 'Binary': {
      const lt = inferExprType(expr.left, ctx), rt = inferExprType(expr.right, ctx);
      const op = expr.op;
      if (op === '+' || op === '-' || op === '*' || op === '/') return numericResult(lt, rt, op);
      if (op === '??') return unify(lt, rt);
      // relational / logical
      return ctx.dialect === 'compat' ? 'float' : 'bool';
    }
    case 'Call': {
      const n = expr.name;
      if (FN_NUMERIC.has(n)) return 'float';
      if (FN_INT.has(n)) return 'int';
      if (FN_STRING.has(n)) return 'string';
      if (FN_LOGICAL.has(n)) return ctx.dialect === 'compat' ? 'float' : 'bool';
      if (FN_PASSTHRU.has(n)) return expr.args[0] ? inferExprType(expr.args[0], ctx) : 'dynamic';
      return 'dynamic';
    }
    case 'Match': {
      let t = expr.default ? inferExprType(expr.default, ctx) : undefined;
      for (const arm of expr.arms) t = t === undefined ? inferExprType(arm.value, ctx) : unify(t, inferExprType(arm.value, ctx));
      return t || 'dynamic';
    }
    case 'Window': {
      const n = expr.agg && expr.agg.type === 'Call' ? expr.agg.name : null;
      if (n === 'count') return 'int';
      if (n === 'mean' || n === 'std') return 'float';
      if (n === 'sum') return expr.agg.args[0] && inferExprType(expr.agg.args[0], ctx) === 'int' ? 'int' : 'float';
      // min/max + positional (prev/next/first/last) take the arg's type
      if (['min', 'max', 'prev', 'next', 'first', 'last'].includes(n)) return expr.agg.args[0] ? inferExprType(expr.agg.args[0], ctx) : 'dynamic';
      return 'dynamic';
    }
    case 'JoinAgg': {
      // aggregate over another table — args reference the MATCHED row (unknown to
      // this schema), so the type is fixed by the aggregate, not the arg.
      const n = expr.agg && expr.agg.type === 'Call' ? expr.agg.name : null;
      if (n === 'count') return 'int';
      return 'float';                       // sum/mean/min/max/std/wmean over matches
    }
    default: return 'dynamic';
  }
}

const NAME_RULES = {
  compat: { max: 8, re: /^[A-Z][A-Z0-9_]*$/, label: 'classic .dm (≤8, UPPER, [A-Z0-9_])' },
  'compat-extended': { max: 24, re: /^[A-Z][A-Z0-9_]*$/, label: 'extended .dm (≤24, UPPER, [A-Z0-9_])' },
};

function schemaPass(ast, inputSchema = [], opts = {}) {
  const dialect = (ast && ast.dialect) || opts.dialect || 'native';
  const warnings = [];

  const units = unitsInPlay(ast, inputSchema);

  // current output columns, in order, by name
  const map = new Map();
  const order = [];
  const lets = new Map();
  const letUnits = new Map();
  for (const c of inputSchema) {
    const col = { ...c, name: c.name, vtype: normalizeType(c.vtype || c.type) };
    if (units && c.unit != null) col.unit = typeof c.unit === 'string' ? parseUnit(c.unit) : c.unit;
    map.set(col.name, col); order.push(col.name);
  }

  const ctx = {
    dialect,
    get: (name) => lets.has(name) ? lets.get(name) : (map.has(name) ? map.get(name).vtype : undefined),
    warn: (m) => warnings.push(m),
  };
  // unit channel (parallel to ctx): name → dim|null. Only consulted when `units`.
  const uctx = {
    unitOf: (name) => letUnits.has(name) ? letUnits.get(name) : (map.has(name) ? (map.get(name).unit || null) : null),
    warn: (m) => warnings.push(m),
  };

  function declare(name, vtype, hasSpec) {
    if (lets.has(name)) lets.delete(name);                 // a field shadows/replaces a prior let
    if (map.has(name)) {
      const col = map.get(name);
      col.vtype = hasSpec ? vtype : unify(col.vtype, vtype);
    } else {
      map.set(name, { name, vtype }); order.push(name);
    }
    const rule = NAME_RULES[dialect];
    if (rule && (name.length > rule.max || !rule.re.test(name)))
      warnings.push(`column "${name}" violates ${rule.label}`);
  }

  function walk(statements) {
    for (const st of statements) {
      switch (st.type) {
        case 'Assign': {
          const t = st.target.spec && st.target.spec.vtype ? st.target.spec.vtype : inferExprType(st.value, ctx);
          if (st.kind === 'let') lets.set(st.target.name, t);
          else declare(st.target.name, t, !!(st.target.spec && st.target.spec.vtype));
          if (units) {
            const annotation = st.value == null;
            const declaredUnit = st.target.spec && st.target.spec.unit ? parseUnit(st.target.spec.unit) : null;
            let unit, apply = true;
            if (annotation) {
              unit = declaredUnit;
              apply = declaredUnit != null;        // a vtype-only annotation leaves the unit untouched
            } else if (declaredUnit) {
              unit = declaredUnit;
              const inferred = inferUnit(st.value, uctx);
              if (inferred && !dimEq(inferred, unit))
                warnings.push(`column "${st.target.name}": declared [${st.target.spec.unit}] but the expression is ${dimFormat(inferred)}`);
            } else {
              unit = inferUnit(st.value, uctx);
            }
            if (apply) {
              if (st.kind === 'let') { if (unit) letUnits.set(st.target.name, unit); else letUnits.delete(st.target.name); }
              else { const col = map.get(st.target.name); if (col) { if (unit) col.unit = unit; else delete col.unit; } }
            }
          }
          break;
        }
        case 'If': {
          // Branch-merge approximation: walk every branch on the same env so each
          // branch-declared column lands; declare() unifies a column's type across
          // the branches that assign it. (A column assigned in only some branches
          // still appears — it may be absent in the others at runtime.)
          for (const cl of st.clauses) walk(cl.body);
          if (st.alternate) walk(st.alternate);
          break;
        }
        case 'Project': {
          if (st.name === 'erase') {
            for (const f of st.fields) { if (map.delete(f)) order.splice(order.indexOf(f), 1); else warnings.push(`erase: no column "${f}"`); }
          } else { // keep | saveonly → restrict to the listed fields, in that order
            const next = [];
            for (const f of st.fields) {
              if (map.has(f)) next.push(f); else warnings.push(`${st.name}: no column "${f}"`);
            }
            order.length = 0; order.push(...next);
            for (const k of [...map.keys()]) if (!next.includes(k)) map.delete(k);
          }
          break;
        }
        case 'Control': break;                             // delete / exit: no schema effect
        case 'Check': inferExprType(st.test, ctx); break;      // validate refs (warns); no output column
        default: break;
      }
    }
  }

  walk((ast && ast.statements) || []);

  return {
    columns: order.map((name) => map.get(name)),
    lets: [...lets].map(([name, vtype]) => ({ name, vtype })),
    warnings,
  };
}

function normalizeType(t) {
  if (!t) return 'dynamic';
  const s = String(t).toLowerCase();
  if (s === 'number' || s === 'f64' || s === 'double' || s === 'real') return 'float';
  if (s === 'i32' || s === 'integer' || s === 'int') return 'int';
  if (s === 'boolean' || s === 'bool') return 'bool';
  if (s === 'str' || s === 'string' || s === 'text' || s === 'alpha') return 'string';
  if (NUM.has(s) || STR.has(s) || s === 'bool' || s === 'dynamic') return s;
  return 'dynamic';
}

// -- runtime.js --

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
function _overCmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const overRuntime = {
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
  eq: (a, b) => !isAbsent(a) && !isAbsent(b) && (a === b || _overCmp(a, b) === 0),
  ne: (a, b) => !isAbsent(a) && !isAbsent(b) && !(a === b || _overCmp(a, b) === 0),
  lt: (a, b) => !isAbsent(a) && !isAbsent(b) && _overCmp(a, b) < 0,
  le: (a, b) => !isAbsent(a) && !isAbsent(b) && _overCmp(a, b) <= 0,
  gt: (a, b) => !isAbsent(a) && !isAbsent(b) && _overCmp(a, b) > 0,
  ge: (a, b) => !isAbsent(a) && !isAbsent(b) && _overCmp(a, b) >= 0,
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
    // classify into ascending half-open bins [b0,b1), [b1,b2), … — bin() → 0-based
    // index (groupable), binlabel() → a readable range. absent → absent.
    bin: (x, ...breaks) => (isAbsent(x) ? NaN : breaks.reduce((k, b) => k + (n(x) >= n(b) ? 1 : 0), 0)),
    binlabel: (x, ...breaks) => {
      if (isAbsent(x) || !breaks.length) return null;
      const v = n(x);
      let k = 0; while (k < breaks.length && v >= n(breaks[k])) k++;
      if (k === 0) return `< ${breaks[0]}`;
      if (k === breaks.length) return `>= ${breaks[k - 1]}`;
      return `${breaks[k - 1]} - ${breaks[k]}`;
    },
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

// -- emit.js --

// @gcu/over — direct-emit row compiler. Lowers the AST to a JS row function the
// driver runs per record. This is the chunk-3 executor (the proven strata
// `compileFormula`/`new Function` pattern); the `over` AIR lowerer is the next
// chunk's drop-in swap behind the same AST→row-fn interface.
//
// Emitted shape: `(out, ctx, _over) => { … }` — `out` is the working row (seeded
// from the input row, so reads see the evolving row top-to-bottom, EXTRA-style);
// writes land on `out`; `ctx.drop` / `ctx.exit` carry `delete` / `exit`; a window
// expression emits `ctx.win(id, key)` (the driver's two-pass fills ctx.win).
//
// Expression emission is parameterized by an "emit context" (ec) — { ref, defaults,
// onWindow } — so the same emitters serve the row body AND window-argument
// extraction (which reads input rows).



const CMP_FN = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const ARITH_FN = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };

const isBoolish = (e) =>
  e.type === 'Bool' ||
  (e.type === 'Binary' && (REL.has(e.op) || e.op === 'and' || e.op === 'or')) ||
  (e.type === 'Call' && e.name === 'not');

const litDefault = (def) =>
  def.type === 'Absent' ? 'null'
    : def.type === 'Str' ? JSON.stringify(def.value)
      : def.type === 'Bool' ? (def.value ? 'true' : 'false')
        : String(def.value);

function collectDefaults(statements, out = new Map()) {
  for (const st of statements) {
    if (st.type === 'Assign' && st.target.spec && st.target.spec.default) {
      const d = st.target.spec.default;
      if (['Num', 'Str', 'Bool', 'Absent'].includes(d.type)) out.set(st.target.name, litDefault(d));
    } else if (st.type === 'If') {
      for (const c of st.clauses) collectDefaults(c.body, out);
      if (st.alternate) collectDefaults(st.alternate, out);
    }
  }
  return out;
}

// ── expression emit (parameterized by emit context `ec`) ──
function emitExpr(e, ec) {
  switch (e.type) {
    case 'Num': return String(e.value);
    case 'Str': return JSON.stringify(e.value);
    case 'Bool': return e.value ? 'true' : 'false';
    case 'Absent': return 'null';
    case 'Field': return ec.ref(e.name);
    case 'Unary': return `_over.neg(${emitExpr(e.operand, ec)})`;
    case 'Binary': return emitBinary(e, ec);
    case 'Call': return emitCall(e, ec);
    case 'Match': return emitMatch(e, ec);
    case 'Window': return ec.onWindow(e, ec);
    case 'Lookup': {
      if (!ec.hasCtx) throw new Error('over: lookup is not allowed inside a window aggregate / order / where');
      const s = e._spec;
      const eq = `[${s.eqProbes.map((p) => emitExpr(p, ec)).join(', ')}]`;
      const pos = s.posProbe ? emitExpr(s.posProbe, ec) : 'null';
      return `ctx.lookup(${s.indexId}, ${eq}, ${pos}, ${JSON.stringify(s.valueCol)})`;
    }
    case 'JoinAgg': {
      if (!ec.hasCtx) throw new Error('over: a join aggregate is not allowed inside a window aggregate / order / where');
      const s = e._jaSpec;                  // eq/lo/hi probes evaluate against THIS row
      const eq = `[${s.eqProbes.map((p) => emitExpr(p, ec)).join(', ')}]`;
      const lo = s.loProbe ? emitExpr(s.loProbe, ec) : 'null';
      const hi = s.hiProbe ? emitExpr(s.hiProbe, ec) : 'null';
      return `ctx.joinAgg(${s.jaId}, ${eq}, ${lo}, ${hi})`;
    }
    case 'Qualified':                       // matched-row ref — only emittable in a join arg ec
      if (ec.qualified) return ec.qualified(e);
      throw new Error('over: a qualified reference (table.col) is only valid in a `lookup`/join `where` clause');
    default: throw new Error(`over emit: unknown expression "${e.type}"`);
  }
}

function emitBinary(e, ec) {
  const { op } = e;
  if (ARITH_FN[op]) return `_over.${ARITH_FN[op]}(${emitExpr(e.left, ec)}, ${emitExpr(e.right, ec)})`;
  if (op === 'and' || op === 'or') return `_over.${op}(${emitExpr(e.left, ec)}, ${emitExpr(e.right, ec)})`;
  if (op === '??') return `_over.coalesce(${emitExpr(e.left, ec)}, ${emitExpr(e.right, ec)})`;
  if (op === '==' || op === '!=') {                        // `== absent` / `!= absent` → presence check
    if (e.right.type === 'Absent') return `_over.${op === '==' ? 'isAbsent' : 'present'}(${emitExpr(e.left, ec)})`;
    if (e.left.type === 'Absent') return `_over.${op === '==' ? 'isAbsent' : 'present'}(${emitExpr(e.right, ec)})`;
  }
  return `_over.${CMP_FN[op]}(${emitExpr(e.left, ec)}, ${emitExpr(e.right, ec)})`;
}

function emitCall(e, ec) {
  if (e.name === 'not') return `_over.not(${emitExpr(e.args[0], ec)})`;
  if (e.name === 'present') return `_over.present(${emitExpr(e.args[0], ec)})`;
  if (e.name === 'absent') return 'null';                  // compat: absent() literal
  if (e.name === 'default') {                              // per-column declared fill
    const a = e.args[0];
    return a && a.type === 'Field' && ec.defaults.has(a.name) ? ec.defaults.get(a.name) : 'null';
  }
  return `_over.call(${JSON.stringify(e.name)}${e.args.map((a) => ', ' + emitExpr(a, ec)).join('')})`;
}

function emitMatch(e, ec) {
  const arms = e.arms.map((arm) => {
    let cond;
    if (arm.rel) cond = `_over.rel(${JSON.stringify(arm.rel)}, _m, ${emitExpr(arm.test, ec)})`;
    else if (isBoolish(arm.test)) cond = `_over.truthy(${emitExpr(arm.test, ec)})`;
    else cond = `_over.eq(_m, ${emitExpr(arm.test, ec)})`;
    return { cond, value: emitExpr(arm.value, ec) };
  });
  const def = e.default ? emitExpr(e.default, ec) : 'null';
  const chain = arms.reduceRight((acc, a) => `(${a.cond} ? ${a.value} : ${acc})`, def);
  return `((_m) => ${chain})(${emitExpr(e.subject, ec)})`;
}

// group key for a window node, emitted against the working row (pass 2)
function windowKey(node) {
  return node.group === 'all' ? 'null'
    : `[${node.group.map((c) => `out[${JSON.stringify(c)}]`).join(', ')}]`;
}

// ── the row function ──
function emitRowSource(ast) {
  const lets = new Map();           // letName → local id
  const defaults = collectDefaults(ast.statements);
  let lc = 0;

  const ec = {
    ref: (name) => (lets.has(name) ? lets.get(name) : `out[${JSON.stringify(name)}]`),
    defaults,
    onWindow: (node) => `ctx.win(${node._winId | 0}, ${windowKey(node)})`,
    hasCtx: true,                    // the row fn has ctx → lookup() allowed here
  };

  function block(statements) { return statements.map(stmt).filter(Boolean).join('\n'); }

  function stmt(st) {
    switch (st.type) {
      case 'Assign': {
        if (st.value == null) return '';                    // bare annotation — type/unit only, no row code
        const v = emitExpr(st.value, ec);
        if (st.kind === 'let') { const id = `_l${lc++}`; lets.set(st.target.name, id); return `let ${id} = ${v};`; }
        lets.delete(st.target.name);
        return `out[${JSON.stringify(st.target.name)}] = ${v};`;
      }
      case 'If': {
        let s = '';
        st.clauses.forEach((c, i) => {
          s += `${i ? ' else ' : ''}if (_over.truthy(${emitExpr(c.test, ec)})) {\n${block(c.body)}\n}`;
        });
        if (st.alternate) s += ` else {\n${block(st.alternate)}\n}`;
        return s;
      }
      case 'Control':
        return st.name === 'delete' ? 'ctx.drop = true; return;' : 'ctx.exit = true; return;';
      case 'Check':                                         // observational — report only, row unchanged
        return `ctx.check(${st._checkId | 0}, _over.truthy(${emitExpr(st.test, ec)}));`;
      case 'Project': return '';                            // driver-level (output projection)
      default: throw new Error(`over emit: unknown statement "${st.type}"`);
    }
  }

  return block(ast.statements);
}

function compileRowFn(ast, runtime = overRuntime) {
  const source = emitRowSource(ast);
  const fn = new Function('out', 'ctx', '_over', source);   // controlled emission (no AIR yet)
  return { source, run: (out, ctx) => { fn(out, ctx, runtime); return out; } };
}

// Compile a standalone expression over an input row — used by the window two-pass
// to extract aggregate arguments + filters. Reads the row as `out` (no writes).
function compileExpr(expr, runtime = overRuntime) {
  const ec = {
    ref: (name) => `out[${JSON.stringify(name)}]`,
    defaults: new Map(),
    onWindow: () => { throw new Error('over: a window aggregate cannot nest inside another'); },
  };
  const fn = new Function('out', '_over', `return ${emitExpr(expr, ec)};`);
  return (row) => fn(row, runtime);
}

// -- windows.js --

// @gcu/over — window aggregates (SPEC §7, the `over` feature, the name).
// `agg(expr) over GROUP [order EXPR] [where EXPR]` — an aggregate over a group,
// used per row. Two-pass: pass 1 computes each window, pass 2 (the row body, via
// ctx.win) reads it.
//   • unordered (no `order`) → one value per group key (mean/sum/count/min/max/std).
//   • ordered (`order EXPR`) → a RUNNING value per row, accumulated in order within
//     the group (RUNLEN = sum(LENGTH) over BHID order DEPTH). Absorbs EXTRA's
//     first/prev/next accumulation idiom.
//   • `where EXPR` filters which rows participate in the accumulation.
// In-memory accumulators here; the sluice mergeable/parallel path is the big-data
// upgrade (the workbench pattern). Explicit prev/next/first/last lag-lead: next.




const AGG = new Set(['count', 'sum', 'mean', 'min', 'max', 'std']);
const POSITIONAL = new Set(['prev', 'next', 'first', 'last']);   // lag/lead/edge — need `order`

// order comparator: numeric when both numbers else lexical; absent sorts last.
function cmpOrder(a, b) {
  const aa = isAbsent(a), bb = isAbsent(b);
  if (aa || bb) return aa && bb ? 0 : aa ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const keyOf = (group, get) => (group === 'all' ? '' : group.map((c) => String(get(c))).join(SEP));

// Walk every expression in the AST, tag each Window node with `_winId`, and
// return the window definitions (id, aggregate, arg, group, order, where).
function collectWindows(ast) {
  const defs = [];

  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'Window') {
      const name = e.agg && e.agg.type === 'Call' ? e.agg.name : null;
      const isAgg = AGG.has(name), isPos = POSITIONAL.has(name);
      if (!isAgg && !isPos)
        throw new Error(`over: "${name}" is not a window function (aggregates: ${[...AGG].join('/')}; positional: ${[...POSITIONAL].join('/')})`);
      if (isPos && !e.order) throw new Error(`over: ${name}() needs an \`order\` — e.g. ${name}(FE) over BHID order DEPTH`);
      if (isPos && !(e.agg.args && e.agg.args[0])) throw new Error(`over: ${name}() needs a column argument`);
      e._winId = defs.length;
      defs.push({
        id: e._winId, aggName: e.agg.name, argExpr: e.agg.args[0] || null, group: e.group,
        orderExpr: e.order || null, whereExpr: e.where || null, ordered: !!e.order,
      });
    }
    expr(e.operand); expr(e.left); expr(e.right); expr(e.agg); expr(e.subject); expr(e.default);
    if (e.args) e.args.forEach(expr);
    if (e.arms) e.arms.forEach((a) => { expr(a.test); expr(a.value); });
  }
  function stmt(st) {
    if (st.type === 'Assign') expr(st.value);
    else if (st.type === 'Check') expr(st.test);
    else if (st.type === 'If') { st.clauses.forEach((c) => { expr(c.test); c.body.forEach(stmt); }); if (st.alternate) st.alternate.forEach(stmt); }
  }
  ast.statements.forEach(stmt);
  return defs;
}

// A streaming accumulator per aggregate (absent ignored; count() counts rows). std
// is population std (Welford). For ordered windows the same accumulator is fed in
// sorted order, reading result() after each row → the running value.
function makeAcc(aggName) {
  switch (aggName) {
    case 'count': { let n = 0; return { add() { n++; }, result() { return n; } }; }
    case 'sum': { let s = 0, any = false; return { add(v) { if (!isAbsent(v)) { s += Number(v); any = true; } }, result() { return any ? s : NaN; } }; }
    case 'mean': { let s = 0, n = 0; return { add(v) { if (!isAbsent(v)) { s += Number(v); n++; } }, result() { return n ? s / n : NaN; } }; }
    case 'min': { let m = null; return { add(v) { if (!isAbsent(v)) { const x = Number(v); if (m == null || x < m) m = x; } }, result() { return m == null ? NaN : m; } }; }
    case 'max': { let m = null; return { add(v) { if (!isAbsent(v)) { const x = Number(v); if (m == null || x > m) m = x; } }, result() { return m == null ? NaN : m; } }; }
    case 'std': {
      let n = 0, mean = 0, m2 = 0;
      return { add(v) { if (!isAbsent(v)) { const x = Number(v); n++; const d = x - mean; mean += d / n; m2 += d * (x - mean); } }, result() { return n > 1 ? Math.sqrt(m2 / n) : 0; } };
    }
    default: throw new Error(`over: unknown aggregate "${aggName}"`);
  }
}

// Pass 1: compute each window — unordered (one value per group) or ordered (a
// running value per row). `where` filters which rows participate.
function computeWindows(defs, rows) {
  return defs.map((d) => (d.ordered ? computeOrdered(d, rows) : computeUnordered(d, rows)));
}

function computeUnordered(d, rows) {
  const argFn = d.argExpr ? compileExpr(d.argExpr) : () => null;
  const whereFn = d.whereExpr ? compileExpr(d.whereExpr) : null;
  const accs = new Map();
  for (const row of rows) {
    if (whereFn && !overRuntime.truthy(whereFn(row))) continue;
    const key = keyOf(d.group, (c) => row[c]);
    let acc = accs.get(key);
    if (!acc) { acc = makeAcc(d.aggName); accs.set(key, acc); }
    acc.add(argFn(row));
  }
  const byKey = new Map();
  for (const [k, a] of accs) byKey.set(k, a.result());
  return { ordered: false, byKey };       // every group row sees byKey[its group]
}

function computeOrdered(d, rows) {
  const argFn = d.argExpr ? compileExpr(d.argExpr) : () => null;
  const orderFn = compileExpr(d.orderExpr);
  const whereFn = d.whereExpr ? compileExpr(d.whereExpr) : null;
  const byRow = new Array(rows.length).fill(NaN);   // rows not in the window stay NaN
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (whereFn && !overRuntime.truthy(whereFn(rows[i]))) continue;
    const key = keyOf(d.group, (c) => rows[i][c]);
    let g = groups.get(key); if (!g) { g = []; groups.set(key, g); }
    g.push(i);
  }
  const positional = POSITIONAL.has(d.aggName);
  for (const g of groups.values()) {
    g.sort((a, b) => cmpOrder(orderFn(rows[a]), orderFn(rows[b])));
    if (positional) {
      const last = g.length - 1;
      for (let k = 0; k <= last; k++) {
        let v;
        switch (d.aggName) {
          case 'first': v = argFn(rows[g[0]]); break;
          case 'last': v = argFn(rows[g[last]]); break;
          case 'prev': v = k > 0 ? argFn(rows[g[k - 1]]) : null; break;       // lag — absent at the edge
          case 'next': v = k < last ? argFn(rows[g[k + 1]]) : null; break;    // lead
        }
        byRow[g[k]] = v;
      }
    } else {
      const acc = makeAcc(d.aggName);
      for (const idx of g) { acc.add(argFn(rows[idx])); byRow[idx] = acc.result(); }   // running through this row
    }
  }
  return { ordered: true, byRow };
}

// Pass 2 lookup (called as ctx.win): unordered → keyParts (the working row's
// group-column values); ordered → rowIndex (the running value at that row).
function winLookup(results, id, keyParts, rowIndex) {
  const r = results[id];
  if (!r) return null;
  if (r.ordered) return rowIndex == null ? null : (r.byRow[rowIndex] ?? null);
  const key = keyParts == null ? '' : keyParts.map(String).join(SEP);
  return r.byKey.has(key) ? r.byKey.get(key) : null;
}

// -- lookup.js --

// @gcu/over — lookup / join (SQL-y, multi-table).
//
//   DENSITY = lookup densities.density where densities.litho == LITHO
//   DOMAIN  = lookup domains.code where domains.hole == hole and domains.from <= DEPTH < domains.to
//
// `lookup TABLE.valueCol where PREDICATE`. The predicate is an `and` of comparisons,
// each between a TABLE.<col> (qualified ref) and a row value. The compiler reads the
// predicate SHAPE and picks the index — pure equality → hash; equality + a range
// pair → per-eq-key sorted intervals + binary search (the geology join). Tables are
// injected by name (run(rows, { table })); left-join (unmatched → absent). Index is
// built once per (table, eq-cols, range-cols) and shared across value columns.


const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==' };

// The table a predicate joins against = the first qualified ref's table.
function tableOfPredicate(pred) {
  let t = null;
  (function f(e) { if (!e || typeof e !== 'object' || t) return; if (e.type === 'Qualified') { t = e.table; return; } f(e.left); f(e.right); })(pred);
  return t;
}

// Decompose an `and` of comparisons (`TABLE.col <cmp> rowValue`) into equality
// terms + an optional range pair. Shared by `lookup` (point-in-interval) and the
// aggregating join (interval overlap) — the ONLY difference between the two is
// whether the two range bounds probe the same row value (`from <= DEPTH < to` →
// contains) or two different ones (`from < TO and to > FROM` → overlap). Both fall
// out of the same analysis; `loProbe`/`hiProbe` carry them for whoever needs them.
function analyzePredicate(predicate, table) {
  const terms = [];
  (function flat(e) { if (e && e.type === 'Binary' && e.op === 'and') { flat(e.left); flat(e.right); } else terms.push(e); })(predicate);

  const eqRefCols = [], eqProbes = [], lows = [], highs = [];
  for (const t of terms) {
    if (!t || t.type !== 'Binary' || !FLIP[t.op]) throw new Error('over: a `where` must be comparisons joined by `and`');
    const lq = t.left.type === 'Qualified' && t.left.table === table;
    const rq = t.right.type === 'Qualified' && t.right.table === table;
    if (lq === rq) throw new Error(`over: each condition must compare ${table}.<col> with a row value`);
    const refCol = lq ? t.left.col : t.right.col;
    const op = lq ? t.op : FLIP[t.op];            // normalize: ref on the left
    const probe = lq ? t.right : t.left;
    if (op === '==') { eqRefCols.push(refCol); eqProbes.push(probe); }
    else if (op === '<=' || op === '<') lows.push({ refCol, op, probe });    // ref ≤ probe → ref is LO
    else highs.push({ refCol, op, probe });                                  // ref ≥ probe → ref is HI
  }

  let range = null;
  if (lows.length || highs.length) {
    if (lows.length !== 1 || highs.length !== 1)
      throw new Error('over: a range needs one lower (TABLE.from <= pos) and one upper (pos < TABLE.to) bound');
    range = { loCol: lows[0].refCol, hiCol: highs[0].refCol, loOp: lows[0].op, hiOp: highs[0].op,
      loProbe: lows[0].probe, hiProbe: highs[0].probe, posProbe: lows[0].probe };
  }
  return { eqRefCols, eqProbes, range };
}

// Analyze a Lookup node's value + predicate → equality refs/probes + an optional
// range. Throws on anything outside `and` of `TABLE.col <cmp> rowValue`.
function analyze(node) {
  if (node.value.type !== 'Qualified') throw new Error('over: lookup expects `lookup TABLE.column where …`');
  const table = node.value.table, valueCol = node.value.col;
  const { eqRefCols, eqProbes, range } = analyzePredicate(node.predicate, table);
  return { table, valueCol, eqRefCols, eqProbes, range };
}

// Collect Lookup nodes: assign each a dedup'd indexId, tag node._spec (for emit),
// return the unique index defs to build.
function collectLookups(ast) {
  const defs = [];
  const byKey = new Map();

  function consider(node) {
    const a = analyze(node);
    const rk = a.range ? `${a.range.loCol}|${a.range.hiCol}|${a.range.loOp}|${a.range.hiOp}` : '';
    const key = a.table + SEP + a.eqRefCols.join(',') + SEP + rk;
    let indexId = byKey.get(key);
    if (indexId === undefined) {
      indexId = defs.length; byKey.set(key, indexId);
      defs.push({ table: a.table, eqRefCols: a.eqRefCols, range: a.range ? { loCol: a.range.loCol, hiCol: a.range.hiCol, loOp: a.range.loOp, hiOp: a.range.hiOp } : null });
    }
    node._spec = { indexId, valueCol: a.valueCol, eqProbes: a.eqProbes, posProbe: a.range ? a.range.posProbe : null };
  }
  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'Lookup') consider(e);
    expr(e.operand); expr(e.left); expr(e.right); expr(e.agg); expr(e.subject); expr(e.default); expr(e.predicate); expr(e.value);
    if (e.args) e.args.forEach(expr);
    if (e.arms) e.arms.forEach((arm) => { expr(arm.test); expr(arm.value); });
  }
  function stmt(st) {
    if (st.type === 'Assign') expr(st.value);
    else if (st.type === 'Check') expr(st.test);
    else if (st.type === 'If') { st.clauses.forEach((c) => { expr(c.test); c.body.forEach(stmt); }); if (st.alternate) st.alternate.forEach(stmt); }
  }
  ast.statements.forEach(stmt);
  return defs;
}

function hasLookups(defs) { return !!(defs && defs.length); }

// Build each index once: a hash (eq-only) or per-eq-key sorted intervals (range).
function buildLookups(defs, tables) {
  return defs.map((d) => {
    const refRows = refRowsOf(tables && tables[d.table]);
    if (!refRows) throw new Error(`over: lookup table "${d.table}" was not provided to run(rows, tables)`);
    const eqKey = (r) => d.eqRefCols.map((c) => String(r[c])).join(SEP);
    if (!d.range) {
      const m = new Map();
      for (const r of refRows) { const k = eqKey(r); if (!m.has(k)) m.set(k, r); }   // first wins
      return { range: false, m };
    }
    const groups = new Map();
    for (const r of refRows) {
      if (isAbsent(r[d.range.loCol]) || isAbsent(r[d.range.hiCol])) continue;
      const k = eqKey(r);
      let g = groups.get(k); if (!g) { g = []; groups.set(k, g); }
      g.push({ lo: r[d.range.loCol], hi: r[d.range.hiCol], row: r });
    }
    for (const g of groups.values()) g.sort((a, b) => numCmp(a.lo, b.lo));
    return { range: true, m: groups, loOp: d.range.loOp, hiOp: d.range.hiOp };
  });
}

// ctx.lookup(indexId, eqVals[], posVal, valueCol) — the row fn probes here.
function makeLookup(indexes) {
  return (indexId, eqVals, posVal, valueCol) => {
    const idx = indexes[indexId];
    const eqKey = eqVals.map(String).join(SEP);
    if (!idx.range) {
      const row = idx.m.get(eqKey);
      if (!row) return null;
      const v = row[valueCol]; return v === undefined ? null : v;
    }
    if (isAbsent(posVal)) return null;
    const arr = idx.m.get(eqKey);
    if (!arr || !arr.length) return null;
    const loOk = idx.loOp === '<=' ? (lo) => numCmp(lo, posVal) <= 0 : (lo) => numCmp(lo, posVal) < 0;
    const hiOk = idx.hiOp === '>' ? (hi) => numCmp(posVal, hi) < 0 : (hi) => numCmp(posVal, hi) <= 0;
    let lo = 0, hi = arr.length - 1, found = -1;     // rightmost interval with lo "below" pos
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (loOk(arr[mid].lo)) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found < 0 || !hiOk(arr[found].hi)) return null;
    const v = arr[found].row[valueCol]; return v === undefined ? null : v;
  };
}

// -- join.js --

// @gcu/over — aggregating join (the natural seam past single-match `lookup`).
//
//   N     = count() where assays.hole == hole and assays.from < TO and assays.to > FROM
//   MAXFE = max(assays.fe) where assays.hole == hole and assays.from < TO and assays.to > FROM
//   GRADE = wmean(assays.fe, overlap) where assays.hole == hole and assays.from < TO and assays.to > FROM
//
// `AGG(args) where PREDICATE` (no `over` — that's a window over THIS table; this
// aggregates ANOTHER table). Same predicate machinery as `lookup`: the compiler
// reads the shape and picks the index — equality → hash groups; an equality + a
// range pair → per-eq-key sorted intervals. The difference from `lookup` is that we
// ENUMERATE every match and fold it through an accumulator instead of taking one.
//
//   • the range pair is an interval-OVERLAP query (`assays.from < TO and assays.to >
//     FROM` → ref intervals that overlap this row's [FROM, TO)); a contains predicate
//     (`from <= DEPTH < to`, as `lookup` uses) also works (matches collapse to a point).
//   • `overlap` (a contextual word inside the aggregate args) = the overlap length
//     between this row's interval and the matched row's — so length-weighting is one
//     word. It's derived from the predicate's interval bounds; 0 for a point query.
//   • aggregate args read the matched row via qualified refs (`assays.fe`) and this
//     row via bare names (`FROM`); left-join (no matches → absent / count 0).
//
// In-memory build-once-probe, like `lookup`; the sluice mergeable path is the
// big-data upgrade. Index defs dedup by (table, eq-cols, range-cols).






const JOIN_AGG = new Set(['count', 'sum', 'mean', 'min', 'max', 'std', 'wmean']);

// weighted mean — Σ(value·weight)/Σ(weight); absent value OR weight skips the pair.
function makeWAcc() {
  let sw = 0, swv = 0;
  return { add(v, w) { if (!isAbsent(v) && !isAbsent(w)) { const ww = Number(w); sw += ww; swv += Number(v) * ww; } }, result() { return sw ? swv / sw : NaN; } };
}

// emit context for an aggregate argument: bare name → this row (`row`), qualified
// ref → the matched row (`ref`), the word `overlap` → the per-match length (`ov`).
function joinArgEc(table) {
  return {
    ref: (name) => (name === 'overlap' ? 'ov' : `row[${JSON.stringify(name)}]`),
    qualified: (e) => {
      if (e.table !== table) throw new Error(`over: a join references two tables ("${table}" and "${e.table}") — one table per join`);
      return `ref[${JSON.stringify(e.col)}]`;
    },
    defaults: new Map(),
    onWindow: () => { throw new Error('over: a window aggregate cannot nest inside a join aggregate'); },
    hasCtx: false,                  // no lookup / join nesting inside an arg
  };
}

function compileArg(expr, table) {
  const fn = new Function('ref', 'row', 'ov', '_over', `return ${emitExpr(expr, joinArgEc(table))};`);
  return (ref, row, ov) => fn(ref, row, ov, overRuntime);
}

// Collect JoinAgg nodes: validate, compile the per-match arg/weight functions, tag
// each node with `_jaSpec` (eq/lo/hi probes — emitted against THIS row), and return
// the specs (one per node, indexed by jaId; `.indexKey` dedups the built index).
function collectJoinAggs(ast) {
  const specs = [];

  function consider(node) {
    const agg = node.agg;
    const aggName = agg && agg.type === 'Call' ? agg.name : null;
    if (!JOIN_AGG.has(aggName))
      throw new Error(`over: a join aggregate must be ${[...JOIN_AGG].join('/')} — got ${aggName ? `"${aggName}()"` : 'a non-aggregate'} before \`where\``);
    const table = tableOfPredicate(node.predicate);
    if (!table) throw new Error('over: a join `where` must compare a table column (e.g. `assays.hole == hole`)');
    const { eqRefCols, eqProbes, range } = analyzePredicate(node.predicate, table);

    let argFn = null, weightFn = null;
    const args = agg.args || [];
    if (aggName === 'count') { if (args.length) throw new Error('over: count() takes no argument in a join'); }
    else if (aggName === 'wmean') {
      if (args.length !== 2) throw new Error('over: wmean(value, weight) needs a value and a weight');
      argFn = compileArg(args[0], table); weightFn = compileArg(args[1], table);
    } else {
      if (args.length !== 1) throw new Error(`over: ${aggName}(value) needs one argument in a join`);
      argFn = compileArg(args[0], table);
    }

    const rk = range ? `${range.loCol}|${range.hiCol}|${range.loOp}|${range.hiOp}` : '';
    const indexKey = table + SEP + eqRefCols.join(',') + SEP + rk;
    const jaId = specs.length;
    specs.push({
      jaId, indexKey, table, eqRefCols, aggName, argFn, weightFn,
      range: range ? { loCol: range.loCol, hiCol: range.hiCol, loOp: range.loOp, hiOp: range.hiOp } : null,
    });
    node._jaSpec = { jaId, eqProbes, loProbe: range ? range.loProbe : null, hiProbe: range ? range.hiProbe : null };
  }

  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'JoinAgg') consider(e);
    expr(e.operand); expr(e.left); expr(e.right); expr(e.agg); expr(e.subject); expr(e.default); expr(e.predicate); expr(e.value);
    if (e.args) e.args.forEach(expr);
    if (e.arms) e.arms.forEach((a) => { expr(a.test); expr(a.value); });
  }
  function stmt(st) {
    if (st.type === 'Assign') expr(st.value);
    else if (st.type === 'Check') expr(st.test);
    else if (st.type === 'If') { st.clauses.forEach((c) => { expr(c.test); c.body.forEach(stmt); }); if (st.alternate) st.alternate.forEach(stmt); }
  }
  ast.statements.forEach(stmt);
  return specs;
}

function hasJoinAggs(specs) { return !!(specs && specs.length); }

// Build each index once (deduped by indexKey): eq-only → hash of eq-key → [rows];
// range → per-eq-key intervals sorted ascending by lo (for the prefix scan).
function buildJoinIndexes(specs, tables) {
  const byKey = new Map();
  for (const s of specs) {
    if (byKey.has(s.indexKey)) continue;
    const refRows = refRowsOf(tables && tables[s.table]);
    if (!refRows) throw new Error(`over: join table "${s.table}" was not provided to run(rows, tables)`);
    const eqKey = (r) => s.eqRefCols.map((c) => String(r[c])).join(SEP);
    if (!s.range) {
      const m = new Map();
      for (const r of refRows) { const k = eqKey(r); let g = m.get(k); if (!g) { g = []; m.set(k, g); } g.push(r); }
      byKey.set(s.indexKey, { range: false, m });
    } else {
      const groups = new Map();
      for (const r of refRows) {
        if (isAbsent(r[s.range.loCol]) || isAbsent(r[s.range.hiCol])) continue;
        const k = eqKey(r);
        let g = groups.get(k); if (!g) { g = []; groups.set(k, g); }
        g.push({ lo: r[s.range.loCol], hi: r[s.range.hiCol], row: r });
      }
      for (const g of groups.values()) g.sort((a, b) => numCmp(a.lo, b.lo));
      byKey.set(s.indexKey, { range: true, m: groups, loOp: s.range.loOp, hiOp: s.range.hiOp });
    }
  }
  return byKey;
}

function feed(acc, s, ref, row, ov) {
  if (s.aggName === 'count') { acc.add(1); return; }
  if (s.aggName === 'wmean') { acc.add(s.argFn(ref, row, ov), s.weightFn(ref, row, ov)); return; }
  acc.add(s.argFn ? s.argFn(ref, row, ov) : null);
}

// ctx.joinAgg(jaId, eqVals[], loVal, hiVal, row) — enumerate the matches, fold them.
function makeJoinAgg(byKey, specs) {
  return (jaId, eqVals, loVal, hiVal, row) => {
    const s = specs[jaId];
    const idx = byKey.get(s.indexKey);
    const eqKey = eqVals.map(String).join(SEP);
    const acc = s.aggName === 'wmean' ? makeWAcc() : makeAcc(s.aggName);

    if (!idx.range) {
      const arr = idx.m.get(eqKey);
      if (arr) for (const r of arr) feed(acc, s, r, row, 0);
      return acc.result();
    }
    const arr = idx.m.get(eqKey);
    if (arr && arr.length) {
      const loOk = idx.loOp === '<' ? (lo) => numCmp(lo, loVal) < 0 : (lo) => numCmp(lo, loVal) <= 0;
      const hiOk = idx.hiOp === '>' ? (hi) => numCmp(hi, hiVal) > 0 : (hi) => numCmp(hi, hiVal) >= 0;
      // sorted asc by lo, so loOk is a true-prefix → binary-search its length.
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (loOk(arr[mid].lo)) lo = mid + 1; else hi = mid; }
      for (let k = 0; k < lo; k++) {
        const e = arr[k];
        if (!hiOk(e.hi)) continue;          // overlaps on lo, but not on hi
        const ov = Math.max(0, Math.min(Number(loVal), Number(e.hi)) - Math.max(Number(hiVal), Number(e.lo)));
        feed(acc, s, e.row, row, ov);
      }
    }
    return acc.result();
  };
}

// -- check.js --

// @gcu/over — `check` (the validation report — the word in the app's name).
//
//   check "from before to":  FROM < TO
//   check "fe is a percent":  assays.fe <= 100
//   GAP = FROM - prev(TO) over hole order FROM
//   check "no downhole gaps": GAP == 0 or present(GAP) == false   # first interval has no prev
//
// A `check` is OBSERVATIONAL: rows pass through unchanged, and each rule accumulates
// a pass/fail count + a few offending rows into a report returned alongside the rows.
// It rides the existing machinery — the schema pass already resolves columns before a
// row runs (so a rule naming a missing column warns statically), and the executor
// already runs a row function with a ctx (so `check` just adds `ctx.check(id, bool)`).
// The report is a plain count, so it merges trivially for the big-data path later.

const SAMPLE_K = 5;   // offending rows kept per rule (for the report)

// A readable label for an unlabeled rule — a tiny unparse of the predicate; null for
// anything exotic (the caller falls back to `check N`).
function exprText(e) {
  if (!e || typeof e !== 'object') return null;
  switch (e.type) {
    case 'Num': return String(e.value);
    case 'Str': return JSON.stringify(e.value);
    case 'Bool': return String(e.value);
    case 'Absent': return 'absent';
    case 'Field': return e.name;
    case 'Qualified': return `${e.table}.${e.col}`;
    case 'Unary': { const o = exprText(e.operand); return o == null ? null : `-${o}`; }
    case 'Binary': { const l = exprText(e.left), r = exprText(e.right); return (l == null || r == null) ? null : `${l} ${e.op} ${r}`; }
    case 'Call': { const a = (e.args || []).map(exprText); return a.some((x) => x == null) ? null : `${e.name}(${a.join(', ')})`; }
    default: return null;
  }
}

// Tag each Check node with `_checkId` (in document order, descending into branches)
// and return the rule defs (id + label + severity). Emit reads `_checkId`; the driver
// keys the report by id.
function collectChecks(ast) {
  const defs = [];
  function stmt(st) {
    if (st.type === 'Check') {
      const id = defs.length;
      st._checkId = id;
      defs.push({ id, label: st.label || exprText(st.test) || `check ${id + 1}`, severity: st.severity || 'warn' });
    } else if (st.type === 'If') {
      st.clauses.forEach((c) => c.body.forEach(stmt));
      if (st.alternate) st.alternate.forEach(stmt);
    }
  }
  ast.statements.forEach(stmt);
  return defs;
}

function hasChecks(defs) { return !!(defs && defs.length); }

// The per-run report accumulator. `check(id, ok, row)` from the row pass; `report()`
// → [{ rule, severity, passed, failed, sample }] (sample = up to SAMPLE_K rows).
function makeCheckReport(defs) {
  const acc = defs.map((d) => ({ rule: d.label, severity: d.severity, passed: 0, failed: 0, sample: [] }));
  return {
    check(id, ok, row) {
      const a = acc[id];
      if (ok) a.passed++;
      else { a.failed++; if (a.sample.length < SAMPLE_K) a.sample.push(row); }
    },
    report() { return acc; },
  };
}

// `require` rules ENFORCE: any error-severity rule with failures gates the run.
function hasFailedRequire(checks) {
  return checks.some((c) => c.severity === 'error' && c.failed > 0);
}

// Thrown by run() when a `require` rule fails. Carries the FULL report so the caller
// sees every failure (warns included), not just the first.
class OverCheckError extends Error {
  constructor(checks) {
    const failed = checks.filter((c) => c.severity === 'error' && c.failed > 0);
    super(`over: ${failed.length} required rule(s) failed — ${failed.map((c) => `"${c.rule}" (${c.failed})`).join(', ')}`);
    this.name = 'OverCheckError';
    this.checks = checks;
  }
}

// -- driver.js --

// @gcu/over — the driver. Runs a compiled row function over a record stream,
// applying the stream concerns: `delete` drops the row, `exit` stops the stream,
// and the resolved output columns (from the schema pass) project the result. When
// the transform has window aggregates, a first pass computes them per group
// (ctx.win) before the row pass.
//
// v0 table shape = an array of row objects ([{FE:62, …}, …]); strata's columnar
// table adapts to/from this at the surface.





const NO_WIN = () => null;
const NO_CHECK = () => {};

function applyRows(rowFn, outputColumns, rows, windowDefs, lookupDefs, joinDefs, checkDefs, tables) {
  const names = outputColumns.map((c) => c.name);
  const winResults = windowDefs && windowDefs.length ? computeWindows(windowDefs, rows) : null;
  // build the lookup / join indexes once (hash, or per-eq-key sorted intervals) per
  // the analyzed predicate shape, before the row pass.
  const lookup = hasLookups(lookupDefs) ? makeLookup(buildLookups(lookupDefs, tables || {})) : NO_WIN;
  const joinAgg = hasJoinAggs(joinDefs) ? makeJoinAgg(buildJoinIndexes(joinDefs, tables || {}), joinDefs) : null;
  const checker = hasChecks(checkDefs) ? makeCheckReport(checkDefs) : null;

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const work = { ...rows[i] };             // seed from input → unassigned columns pass through
    // ctx.win carries the row index so ordered (running) windows resolve per-row;
    // ctx.joinAgg gets the working row so aggregate args can read this row's fields;
    // ctx.check accumulates the validation report (sampling the INPUT row on failure).
    const win = winResults ? (id, key) => winLookup(winResults, id, key, i) : NO_WIN;
    const ctx = { drop: false, exit: false, win, lookup, joinAgg: NO_WIN, check: NO_CHECK };
    if (joinAgg) ctx.joinAgg = (id, eq, lo, hi) => joinAgg(id, eq, lo, hi, work);
    if (checker) ctx.check = (id, ok) => checker.check(id, ok, rows[i]);
    rowFn.run(work, ctx);
    if (!ctx.drop) {
      const projected = {};
      for (const n of names) projected[n] = n in work ? work[n] : null;
      out.push(projected);
    }
    if (ctx.exit) break;
  }
  const checks = checker ? checker.report() : [];
  if (hasFailedRequire(checks)) throw new OverCheckError(checks);   // `require` gates the run
  return { rows: out, checks };
}

// -- api.js --

// @gcu/over — public API. compile(text, opts) → a transform: parse → schema pass
// → emit the row function → return { outputColumns, source, run(rows) }.
//
//   const t = compile('FE_N = FE / 100\nsaveonly(FE, FE_N)', { inputSchema });
//   t.outputColumns        // resolved BEFORE running (the schema-pass preview)
//   t.run(rows)            // → { columns, rows }
//
// If inputSchema is omitted it's inferred from the rows at run time (so
// `compile(text).run(rows)` just works); pass it when you want the preview.









function inferSchema(rows) {
  if (!rows || !rows.length) return [];
  const r0 = rows[0];
  return Object.keys(r0).map((name) => {
    const v = r0[name];
    const type = typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float')
      : typeof v === 'boolean' ? 'bool' : 'string';
    return { name, type };
  });
}

function compile(text, opts = {}) {
  const ast = parse(text);
  const windowDefs = collectWindows(ast);     // tags Window nodes with _winId — BEFORE emit
  const lookupSpecs = collectLookups(ast);    // validates lookup shapes + the (table,key) build specs
  const joinSpecs = collectJoinAggs(ast);     // validates `AGG(args) where …` joins + compiles per-match args
  const checkDefs = collectChecks(ast);       // tags Check nodes with _checkId + resolves rule labels
  const rowFn = compileRowFn(ast);
  const staticSchema = opts.inputSchema ? schemaPass(ast, opts.inputSchema, opts) : null;
  return {
    ast,
    dialect: ast.dialect,
    source: rowFn.source,
    windows: windowDefs.length,
    lookups: lookupSpecs.length,
    joins: joinSpecs.length,
    checks: checkDefs.length,
    outputColumns: staticSchema ? staticSchema.columns : null,
    warnings: staticSchema ? staticSchema.warnings : null,
    // tables: { name: rows[] | {rows} } — the reference tables lookup / join read.
    // run → { columns, rows, checks: [{ rule, passed, failed, sample }], warnings }.
    run(rows, tables) {
      const sch = staticSchema || schemaPass(ast, inferSchema(rows), opts);
      const res = applyRows(rowFn, sch.columns, rows, windowDefs, lookupSpecs, joinSpecs, checkDefs, tables);
      return { columns: sch.columns, rows: res.rows, checks: res.checks, warnings: sch.warnings };
    },
  };
}

// -- tag.js --

// @gcu/over — the notebook surface: the `over` tagged template + editor support
// (syntax highlighting + completions), self-registered as a tagged language.
//
//   const { over } = await load("@gcu/over");
//   const cleaned = over`
//     FE_N    = FE / mean(FE) over LITHO
//     ORETYPE = match FE { >=62:"HEMATITE", >=58:"ITABIRITE", _:"WASTE" }
//     saveonly(hole, FE, FE_N, ORETYPE)
//   `(rows);                       // → an array of result rows (+ .columns)
//
// The tag compiles once (parse + emit) and returns a transform you apply to a
// table (an array of row objects, or a { rows } result — so transforms chain).


function over(strings, ...values) {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += String(values[i]) + strings[i + 1];
  const c = compile(text);
  // (table, tables?) — `tables` are the reference tables lookup() reads:
  //   over`DENS = lookup(densities,"litho",LITHO,"density")`(rows, { densities })
  const fn = (table, tables) => {
    const rows = Array.isArray(table) ? table : (table && table.rows) || [];
    const result = c.run(rows, tables);
    Object.defineProperty(result.rows, 'columns', { value: result.columns, enumerable: false });
    Object.defineProperty(result.rows, 'checks', { value: result.checks, enumerable: false });        // validation report
    Object.defineProperty(result.rows, 'warnings', { value: result.warnings || [], enumerable: false });  // schema + unit warnings
    return result.rows;
  };
  fn.source = c.source;          // the emitted JS (inspectable)
  fn.ast = c.ast;
  fn.compiled = c;
  return fn;
}

// ── tokenizer (syntax highlighting inside over`…`) ──

const KEYWORDS = new Set([
  'if', 'elseif', 'else', 'end', 'keep', 'saveonly', 'erase', 'delete', 'exit',
  'let', 'match', 'and', 'or', 'not', 'over', 'all', 'where', 'order', 'by', 'default', 'lookup', 'check', 'require',
]);
const LITERALS = new Set(['true', 'false', 'absent']);
const FUNCTIONS = new Set([
  'count', 'sum', 'mean', 'min', 'max', 'std', 'minia', 'maxia', 'wmean', 'overlap', 'bin', 'binlabel',
  'prev', 'next', 'first', 'last',
  'abs', 'sqrt', 'exp', 'log', 'loge', 'logn', 'log10', 'pow', 'rais', 'mod',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'int', 'round', 'present',
  'len', 'ucase', 'lcase', 'trim', 'string', 'concat', 'substr',
  'xyzijk', 'ijknum', 'ijkget',
]);

function tokenizeOver(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;
  while (i < len) {
    const c = code[i];
    if (c === '#') { const s = i; while (i < len && code[i] !== '\n') i++; tokens.push({ type: 'cmt', text: code.slice(s, i) }); continue; }
    if (c === '%' && (i === 0 || code[i - 1] === '\n')) { const s = i; while (i < len && code[i] !== '\n') i++; tokens.push({ type: 'cmt', text: code.slice(s, i) }); continue; }
    if (c === '"') { const s = i; i++; while (i < len && code[i] !== '"') { if (code[i] === '\\') i++; i++; } if (i < len) i++; tokens.push({ type: 'str', text: code.slice(s, i) }); continue; }
    if (c === '`') { const s = i; i++; while (i < len && code[i] !== '`') i++; if (i < len) i++; tokens.push({ type: 'id', text: code.slice(s, i) }); continue; }   // backtick column name
    if (c === '[') { const s = i; i++; while (i < len && code[i] !== ']') i++; if (i < len) i++; tokens.push({ type: 'const', text: code.slice(s, i) }); continue; }   // [unit] annotation
    if (/\d/.test(c) || (c === '.' && /\d/.test(code[i + 1] || ''))) { const s = i; while (i < len && /[0-9.eE+-]/.test(code[i])) i++; tokens.push({ type: 'num', text: code.slice(s, i) }); continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const s = i; while (i < len && /[A-Za-z0-9_$]/.test(code[i])) i++;
      const w = code.slice(s, i);
      if (KEYWORDS.has(w)) tokens.push({ type: 'kw', text: w });
      else if (LITERALS.has(w)) tokens.push({ type: 'const', text: w });
      else if (FUNCTIONS.has(w) || (i < len && code[i] === '(')) tokens.push({ type: 'fn', text: w });
      else tokens.push({ type: 'id', text: w });
      continue;
    }
    if ('=<>!+-*/?'.includes(c)) { const s = i; i++; if (i < len && '=?'.includes(code[i])) i++; tokens.push({ type: 'op', text: code.slice(s, i) }); continue; }
    if ('(){}:,;'.includes(c)) { tokens.push({ type: 'punc', text: c }); i++; continue; }
    tokens.push({ type: '', text: c }); i++;
  }
  return tokens;
}

function overCompletions() {
  const items = [];
  for (const w of KEYWORDS) items.push({ text: w, kind: 'kw' });
  for (const w of LITERALS) items.push({ text: w, kind: 'const' });
  for (const w of FUNCTIONS) items.push({ text: w, kind: 'fn' });
  return items;
}

// ── self-registration (tagged language: highlighting + completions) ──

if (typeof window !== 'undefined') {
  const register = window.auditable && window.auditable.registerExtension;
  if (register) {
    register({ name: '@gcu/over', version: '0.1.0', taggedLanguage: { name: 'over', tokenize: tokenizeOver, completions: overCompletions } });
  } else {
    if (!window._taggedLanguages) window._taggedLanguages = {};
    window._taggedLanguages.over = { tokenize: tokenizeOver, completions: overCompletions };
  }
}

export {
  OverCheckError,
  OverLexError,
  OverParseError,
  REL,
  SEP,
  analyzePredicate,
  applyRows,
  buildJoinIndexes,
  buildLookups,
  collectChecks,
  collectJoinAggs,
  collectLookups,
  collectWindows,
  compile,
  compileExpr,
  compileRowFn,
  computeWindows,
  emitExpr,
  emitRowSource,
  hasChecks,
  hasFailedRequire,
  hasJoinAggs,
  hasLookups,
  inferExprType,
  inferUnit,
  isAbsent,
  lex,
  makeAcc,
  makeCheckReport,
  makeJoinAgg,
  makeLookup,
  numCmp,
  over,
  overRuntime,
  parse,
  parseTokens,
  parseUnit,
  refRowsOf,
  schemaPass,
  tableOfPredicate,
  unify,
  winLookup,
};
