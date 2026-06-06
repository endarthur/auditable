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

import { lex } from './lex.js';
import { REL } from './util.js';

const TYPES = new Set(['int', 'float', 'bool', 'string', 'category']);
const STMT_KW = new Set(['if', 'elseif', 'else', 'end', 'keep', 'saveonly', 'erase', 'delete', 'exit', 'let', 'check', 'require']);

export class OverParseError extends Error {
  constructor(msg, tok) { super(`over: ${msg}${tok ? ` (line ${tok.line})` : ''}`); this.tok = tok; }
}

export function parse(src) { return parseTokens(lex(src)); }

export function parseTokens(toks) {
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
