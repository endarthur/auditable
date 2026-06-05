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

const FN_NUMERIC = new Set(['abs', 'sqrt', 'exp', 'log', 'loge', 'logn', 'pow', 'rais',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'azimuth', 'phi', 'mod', 'modc',
  'special', 'round', 'min', 'max', 'minia', 'maxia', 'ijkget']);
const FN_INT = new Set(['int', 'len', 'ijknum', 'xyzijk']);
const FN_STRING = new Set(['concat', 'substr', 'trim', 'ucase', 'lcase', 'string', 'join', 'field', 'type']);
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

function inferType(expr, ctx) {
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
      const t = inferType(expr.operand, ctx);
      return t === 'float' ? 'float' : (t === 'int' || t === 'bool') ? 'int' : 'dynamic';
    }
    case 'Binary': {
      const lt = inferType(expr.left, ctx), rt = inferType(expr.right, ctx);
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
      if (FN_PASSTHRU.has(n)) return expr.args[0] ? inferType(expr.args[0], ctx) : 'dynamic';
      return 'dynamic';
    }
    case 'Match': {
      let t = expr.default ? inferType(expr.default, ctx) : undefined;
      for (const arm of expr.arms) t = t === undefined ? inferType(arm.value, ctx) : unify(t, inferType(arm.value, ctx));
      return t || 'dynamic';
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

  // current output columns, in order, by name
  const map = new Map();
  const order = [];
  const lets = new Map();
  for (const c of inputSchema) {
    const col = { ...c, name: c.name, vtype: normalizeType(c.vtype || c.type) };
    map.set(col.name, col); order.push(col.name);
  }

  const ctx = {
    dialect,
    get: (name) => lets.has(name) ? lets.get(name) : (map.has(name) ? map.get(name).vtype : undefined),
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
          const t = st.target.spec && st.target.spec.vtype ? st.target.spec.vtype : inferType(st.value, ctx);
          if (st.kind === 'let') lets.set(st.target.name, t);
          else declare(st.target.name, t, !!(st.target.spec && st.target.spec.vtype));
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

const overRuntime = {
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

// -- emit.js --

// @gcu/over — direct-emit row compiler. Lowers the AST to a JS row function the
// driver runs per record. This is the chunk-3 executor (the proven strata
// `compileFormula`/`new Function` pattern); the `over` AIR lowerer is the next
// chunk's drop-in swap behind the same AST→row-fn interface.
//
// Emitted shape: `(out, ctx, _over) => { … }` — `out` is the working row (seeded
// from the input row, so reads see the evolving row top-to-bottom, EXTRA-style);
// writes land on `out`; `ctx.drop` / `ctx.exit` carry `delete` / `exit`.


const REL = new Set(['==', '!=', '<', '<=', '>', '>=']);
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

function emitRowSource(ast) {
  const lets = new Map();           // letName → local id
  const defaults = collectDefaults(ast.statements);
  let lc = 0;

  const ref = (name) => (lets.has(name) ? lets.get(name) : `out[${JSON.stringify(name)}]`);

  function expr(e) {
    switch (e.type) {
      case 'Num': return String(e.value);
      case 'Str': return JSON.stringify(e.value);
      case 'Bool': return e.value ? 'true' : 'false';
      case 'Absent': return 'null';
      case 'Field': return ref(e.name);
      case 'Unary': return `_over.neg(${expr(e.operand)})`;
      case 'Binary': return binary(e);
      case 'Call': return call(e);
      case 'Match': return match(e);
      default: throw new Error(`over emit: unknown expression "${e.type}"`);
    }
  }

  function binary(e) {
    const { op } = e;
    if (ARITH_FN[op]) return `_over.${ARITH_FN[op]}(${expr(e.left)}, ${expr(e.right)})`;
    if (op === 'and' || op === 'or') return `_over.${op}(${expr(e.left)}, ${expr(e.right)})`;
    if (op === '??') return `_over.coalesce(${expr(e.left)}, ${expr(e.right)})`;
    // relational — `== absent` / `!= absent` become presence checks (cf. sift)
    if ((op === '==' || op === '!=')) {
      if (e.right.type === 'Absent') return `_over.${op === '==' ? 'isAbsent' : 'present'}(${expr(e.left)})`;
      if (e.left.type === 'Absent') return `_over.${op === '==' ? 'isAbsent' : 'present'}(${expr(e.right)})`;
    }
    return `_over.${CMP_FN[op]}(${expr(e.left)}, ${expr(e.right)})`;
  }

  function call(e) {
    if (e.name === 'not') return `_over.not(${expr(e.args[0])})`;
    if (e.name === 'present') return `_over.present(${expr(e.args[0])})`;
    if (e.name === 'absent') return 'null';                          // compat: absent() literal
    if (e.name === 'default') {                                      // per-column declared fill
      const a = e.args[0];
      return a && a.type === 'Field' && defaults.has(a.name) ? defaults.get(a.name) : 'null';
    }
    return `_over.call(${JSON.stringify(e.name)}${e.args.map((a) => ', ' + expr(a)).join('')})`;
  }

  function match(e) {
    const arms = e.arms.map((arm) => {
      let cond;
      if (arm.rel) cond = `_over.rel(${JSON.stringify(arm.rel)}, _m, ${expr(arm.test)})`;
      else if (isBoolish(arm.test)) cond = `_over.truthy(${expr(arm.test)})`;
      else cond = `_over.eq(_m, ${expr(arm.test)})`;
      return { cond, value: expr(arm.value) };
    });
    const def = e.default ? expr(e.default) : 'null';
    const chain = arms.reduceRight((acc, a) => `(${a.cond} ? ${a.value} : ${acc})`, def);
    return `((_m) => ${chain})(${expr(e.subject)})`;
  }

  function block(statements) { return statements.map(stmt).filter(Boolean).join('\n'); }

  function stmt(st) {
    switch (st.type) {
      case 'Assign': {
        const v = expr(st.value);
        if (st.kind === 'let') { const id = `_l${lc++}`; lets.set(st.target.name, id); return `let ${id} = ${v};`; }
        lets.delete(st.target.name);
        return `out[${JSON.stringify(st.target.name)}] = ${v};`;
      }
      case 'If': {
        let s = '';
        st.clauses.forEach((c, i) => {
          s += `${i ? ' else ' : ''}if (_over.truthy(${expr(c.test)})) {\n${block(c.body)}\n}`;
        });
        if (st.alternate) s += ` else {\n${block(st.alternate)}\n}`;
        return s;
      }
      case 'Control':
        return st.name === 'delete' ? 'ctx.drop = true; return;' : 'ctx.exit = true; return;';
      case 'Project': return '';                                     // driver-level (output projection)
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

// -- driver.js --

// @gcu/over — the driver. Runs a compiled row function over a record stream,
// applying the stream concerns: `delete` drops the row, `exit` stops the stream,
// and the resolved output columns (from the schema pass) project the result.
//
// v0 table shape = an array of row objects ([{FE:62, …}, …]); strata's columnar
// table adapts to/from this at the surface. Windows (the two-pass) extend this
// driver later.

function applyRows(rowFn, outputColumns, rows) {
  const names = outputColumns.map((c) => c.name);
  const out = [];
  for (const row of rows) {
    const work = { ...row };                 // seed from input → unassigned columns pass through
    const ctx = { drop: false, exit: false };
    rowFn.run(work, ctx);
    if (!ctx.drop) {
      const projected = {};
      for (const n of names) projected[n] = n in work ? work[n] : null;
      out.push(projected);
    }
    if (ctx.exit) break;
  }
  return out;
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
  const rowFn = compileRowFn(ast);
  const staticSchema = opts.inputSchema ? schemaPass(ast, opts.inputSchema, opts) : null;
  return {
    ast,
    dialect: ast.dialect,
    source: rowFn.source,
    outputColumns: staticSchema ? staticSchema.columns : null,
    warnings: staticSchema ? staticSchema.warnings : null,
    run(rows) {
      const sch = staticSchema || schemaPass(ast, inferSchema(rows), opts);
      return { columns: sch.columns, rows: applyRows(rowFn, sch.columns, rows) };
    },
  };
}

export {
  OverLexError,
  OverParseError,
  applyRows,
  compile,
  compileRowFn,
  emitRowSource,
  inferType,
  lex,
  overRuntime,
  parse,
  parseTokens,
  schemaPass,
  unify,
};
