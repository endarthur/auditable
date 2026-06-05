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
    case 'Window': {
      const n = expr.agg && expr.agg.type === 'Call' ? expr.agg.name : null;
      if (n === 'count') return 'int';
      if (n === 'mean' || n === 'std') return 'float';
      if (n === 'sum') return expr.agg.args[0] && inferType(expr.agg.args[0], ctx) === 'int' ? 'int' : 'float';
      // min/max + positional (prev/next/first/last) take the arg's type
      if (['min', 'max', 'prev', 'next', 'first', 'last'].includes(n)) return expr.agg.args[0] ? inferType(expr.agg.args[0], ctx) : 'dynamic';
      return 'dynamic';
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
  if (e.name === 'lookup') {                               // lookup(table, "key", probe, "value")
    if (!ec.hasCtx) throw new Error('over: lookup() is not allowed inside a window aggregate / order / where');
    const a = e.args;
    return `ctx.lookup(${JSON.stringify(a[0].name)}, ${JSON.stringify(a[1].value)}, ${emitExpr(a[2], ec)}, ${JSON.stringify(a[3].value)})`;
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
const SEP = String.fromCharCode(1);   // group-key field separator

// missing = null (string absent) OR NaN (numeric absent) — aggregates skip it.
const isAbsent = (x) => x == null || x !== x;

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

// @gcu/over — lookup / equality join (multi-table). A row enriches itself from an
// injected reference table by an explicit key:
//
//   DENS = lookup(densities, "litho", LITHO, "density")
//          lookup(<table>,   <refKeyCol>, <probeExpr>, <valueCol>)
//
// table is an injected table (by name, via run(rows, { densities })); the ref key
// + value columns are explicit string literals (nothing inferred); the probe is any
// expression. Left-join: an unmatched key → absent. Build-once / probe-per-row, like
// windows: collectLookups → buildLookups (a hash per (table,key), cached) → the row
// fn probes via ctx.lookup. Interval/range joins add a second index shape next.

const SEP = String.fromCharCode(1);
const refRowsOf = (t) => (Array.isArray(t) ? t : (t && t.rows) || null);

// Validate a lookup Call's shape; returns { table, keyCol } | throws.
function lookupSpec(call) {
  const a = call.args || [];
  if (a.length !== 4)
    throw new Error('over: lookup(table, "keyCol", probe, "valueCol") takes 4 arguments');
  if (a[0].type !== 'Field')
    throw new Error('over: lookup\'s first argument must be a table name');
  if (a[1].type !== 'Str' || a[3].type !== 'Str')
    throw new Error('over: lookup\'s key + value columns must be string literals');
  return { table: a[0].name, keyCol: a[1].value, valueCol: a[3].value, probe: a[2] };
}

// Walk the AST, find every lookup() Call, validate it, and return the unique
// (table, key) build specs.
function collectLookups(ast) {
  const specs = [];
  const seen = new Set();

  function expr(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'Call' && e.name === 'lookup') {
      const s = lookupSpec(e);
      const k = s.table + SEP + s.keyCol;
      if (!seen.has(k)) { seen.add(k); specs.push({ table: s.table, keyCol: s.keyCol }); }
    }
    expr(e.operand); expr(e.left); expr(e.right); expr(e.agg); expr(e.subject); expr(e.default);
    if (e.args) e.args.forEach(expr);
    if (e.arms) e.arms.forEach((arm) => { expr(arm.test); expr(arm.value); });
  }
  function stmt(st) {
    if (st.type === 'Assign') expr(st.value);
    else if (st.type === 'If') { st.clauses.forEach((c) => { expr(c.test); c.body.forEach(stmt); }); if (st.alternate) st.alternate.forEach(stmt); }
  }
  ast.statements.forEach(stmt);
  return specs;
}

// Build one hash per (table, key): Map(keyValue → reference row). First row wins
// on a duplicate key. Throws if a referenced table wasn't provided.
function buildLookups(specs, tables) {
  const indexes = new Map();
  for (const { table, keyCol } of specs) {
    const refRows = refRowsOf(tables && tables[table]);
    if (!refRows) throw new Error(`over: lookup table "${table}" was not provided to run(rows, tables)`);
    const m = new Map();
    for (const r of refRows) if (!m.has(r[keyCol])) m.set(r[keyCol], r);
    indexes.set(table + SEP + keyCol, m);
  }
  return indexes;
}

// The ctx.lookup probe (closes over the built indexes). Unmatched → null (absent).
function makeLookup(indexes) {
  return (table, keyCol, keyVal, valCol) => {
    const m = indexes.get(table + SEP + keyCol);
    if (!m) return null;
    const row = m.get(keyVal);
    if (!row) return null;
    const v = row[valCol];
    return v === undefined ? null : v;
  };
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

function applyRows(rowFn, outputColumns, rows, windowDefs, lookupSpecs, tables) {
  const names = outputColumns.map((c) => c.name);
  const winResults = windowDefs && windowDefs.length ? computeWindows(windowDefs, rows) : null;
  // build the lookup hashes once (per (table,key)), before the row pass
  const lookup = lookupSpecs && lookupSpecs.length
    ? makeLookup(buildLookups(lookupSpecs, tables || {})) : NO_WIN;

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const work = { ...rows[i] };             // seed from input → unassigned columns pass through
    // ctx.win carries the row index so ordered (running) windows resolve per-row.
    const win = winResults ? (id, key) => winLookup(winResults, id, key, i) : NO_WIN;
    const ctx = { drop: false, exit: false, win, lookup };
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
  const windowDefs = collectWindows(ast);     // tags Window nodes with _winId — BEFORE emit
  const lookupSpecs = collectLookups(ast);    // validates lookup() shapes + the (table,key) build specs
  const rowFn = compileRowFn(ast);
  const staticSchema = opts.inputSchema ? schemaPass(ast, opts.inputSchema, opts) : null;
  return {
    ast,
    dialect: ast.dialect,
    source: rowFn.source,
    windows: windowDefs.length,
    lookups: lookupSpecs.length,
    outputColumns: staticSchema ? staticSchema.columns : null,
    warnings: staticSchema ? staticSchema.warnings : null,
    // tables: { name: rows[] | {rows} } — the reference tables lookup() reads.
    run(rows, tables) {
      const sch = staticSchema || schemaPass(ast, inferSchema(rows), opts);
      return { columns: sch.columns, rows: applyRows(rowFn, sch.columns, rows, windowDefs, lookupSpecs, tables) };
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
  'let', 'match', 'and', 'or', 'not', 'over', 'all', 'where', 'order', 'by', 'default',
]);
const LITERALS = new Set(['true', 'false', 'absent']);
const FUNCTIONS = new Set([
  'count', 'sum', 'mean', 'min', 'max', 'std', 'minia', 'maxia',
  'prev', 'next', 'first', 'last',
  'abs', 'sqrt', 'exp', 'log', 'loge', 'logn', 'log10', 'pow', 'rais', 'mod',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'int', 'round', 'present',
  'len', 'ucase', 'lcase', 'trim', 'string', 'concat', 'substr', 'lookup',
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
  OverLexError,
  OverParseError,
  applyRows,
  buildLookups,
  collectLookups,
  collectWindows,
  compile,
  compileExpr,
  compileRowFn,
  computeWindows,
  emitExpr,
  emitRowSource,
  inferType,
  lex,
  lookupSpec,
  makeLookup,
  over,
  overRuntime,
  parse,
  parseTokens,
  schemaPass,
  unify,
  winLookup,
};
