// Parser — recursive descent + Pratt expressions → AST
//
// Grammar sketch:
//   program    = { constDecl | varDecl | function | subroutine | import | export function }
//   function   = 'function' ID '(' params ')' ':' TYPE [var locals] 'begin' stmts 'end'
//   subroutine = 'subroutine' ID '(' params ')' [var locals] 'begin' stmts 'end'
//   params     = name {',' name} ':' TYPE {',' params}    — comma-separated names share a type
//   stmt       = if | for | while | do-while | break | tailcall | call | assign | arrayStore
//   assign     = ID ':=' expr  |  ID '+=' expr  |  ID '/=' expr  (etc.)
//   if         = 'if' '(' expr ')' 'then' stmts ['else' stmts | 'else' if] 'end' 'if'
//   for        = 'for' ID ':=' expr ',' expr [',' step] stmts 'end' 'for'
//   expr       = Pratt expression (see lbp for precedence tower)
//   atom       = number | ID | ID '(' args ')' | ID '[' indices ']' | '(' expr ')'
//              | TYPE '(' args ')'  — type conversion / vector constructor
//              | 'if' '(' expr ')' 'then' expr 'else' expr  — ternary

import { TOK } from './lex.js';
import { ATRA_TYPES } from './highlight.js';

export function parse(tokens) {
  let pos = 0;
  function cur() { return tokens[pos]; }
  function at(type, value) { const t = cur(); return t.type === type && (value === undefined || t.value === value); }
  function eat(type, value) {
    const t = cur();
    if (t.type !== type || (value !== undefined && t.value !== value))
      throw new SyntaxError(`Expected ${value || type} but got "${t.value}" at ${t.line}:${t.col}`);
    pos++;
    return t;
  }
  function maybe(type, value) { if (at(type, value)) { pos++; return true; } return false; }

  function parseProgram() {
    const body = [];
    while (!at(TOK.EOF)) {
      if (at(TOK.KW, 'const') && !isLocalContext()) body.push(parseGlobalConst());
      else if (at(TOK.KW, 'var') && !isLocalContext()) body.push(parseGlobalVar());
      else if (at(TOK.KW, 'function')) body.push(parseFunction());
      else if (at(TOK.KW, 'subroutine')) body.push(parseSubroutine());
      else if (at(TOK.KW, 'import')) body.push(parseImport());
      else if (at(TOK.KW, 'export')) { pos++; body.push(parseFunction(true)); }
      else if (at(TOK.KW, 'layout')) body.push(parseLayout());
      else throw new SyntaxError(`Unexpected "${cur().value}" at ${cur().line}:${cur().col}`);
    }
    return { type: 'Program', body };
  }

  function isLocalContext() { return false; } // globals only at top level

  function parseLayout() {
    eat(TOK.KW, 'layout');
    const packed = maybe(TOK.KW, 'packed');
    const name = eat(TOK.ID).value;
    const fields = [];
    while (!at(TOK.KW, 'end') && !at(TOK.EOF)) {
      const fnames = [eat(TOK.ID).value];
      while (at(TOK.PUNC, ',') && tokens[pos + 1] && tokens[pos + 1].type === TOK.ID &&
             tokens[pos + 2] && (tokens[pos + 2].value === ',' || tokens[pos + 2].value === ':')) {
        pos++; // skip comma
        fnames.push(eat(TOK.ID).value);
      }
      eat(TOK.PUNC, ':');
      // Accept KW (primitive types) or ID (layout names) in type position
      const ftok = cur();
      let ftype;
      if (ftok.type === TOK.KW) { ftype = eat(TOK.KW).value; }
      else if (ftok.type === TOK.ID) { ftype = eat(TOK.ID).value; }
      else throw new SyntaxError(`Expected type after ':' but got "${ftok.value}" at ${ftok.line}:${ftok.col}`);
      // Optional array count: type[N]
      let arrayCount = null;
      if (at(TOK.PUNC, '[')) {
        pos++; // skip [
        arrayCount = parseInt(eat(TOK.NUM).value, 10);
        eat(TOK.PUNC, ']');
      }
      for (const fn of fnames) fields.push({ name: fn, ftype, arrayCount });
    }
    eat(TOK.KW, 'end');
    maybe(TOK.KW, 'layout'); // optional trailing "layout" after "end"
    return { type: 'LayoutDecl', name, packed: !!packed, fields };
  }

  // Parse function type signature: function(x: f64, y: f64): f64
  function parseFuncTypeSig() {
    eat(TOK.KW, 'function');
    eat(TOK.PUNC, '(');
    const params = at(TOK.PUNC, ')') ? [] : parseParamEntries();
    eat(TOK.PUNC, ')');
    let retType = null;
    if (maybe(TOK.PUNC, ':')) retType = eat(TOK.KW).value;
    return { params, retType };
  }

  function parseGlobalConst() {
    eat(TOK.KW, 'const');
    const name = eat(TOK.ID).value;
    eat(TOK.PUNC, ':');
    const vtype = eat(TOK.KW).value;
    eat(TOK.OP, '=');
    const init = parseExpr(0);
    return { type: 'ConstDecl', name, vtype, init };
  }

  function parseGlobalVar() {
    eat(TOK.KW, 'var');
    const name = eat(TOK.ID).value;
    eat(TOK.PUNC, ':');
    if (at(TOK.KW, 'function')) {
      const funcSig = parseFuncTypeSig();
      let init = null;
      if (maybe(TOK.OP, '=')) init = parseExpr(0);
      return { type: 'VarDecl', name, vtype: 'i32', funcSig, init };
    }
    const vtype = eat(TOK.KW).value;
    let init = null;
    if (maybe(TOK.OP, '=')) init = parseExpr(0);
    return { type: 'VarDecl', name, vtype, init };
  }

  function parseImport() {
    eat(TOK.KW, 'import');
    // import function name(params): retType from 'module'
    // import name = ${interp}
    // import name(params): retType = ${interp}
    if (at(TOK.KW, 'function')) {
      pos++;
    }
    const name = eat(TOK.ID).value;
    let params = [], retType = null, moduleName = 'host', interpIdx = null;
    if (at(TOK.PUNC, '(')) {
      params = parseParamList();
    }
    if (maybe(TOK.PUNC, ':')) {
      retType = eat(TOK.KW).value;
    }
    if (maybe(TOK.OP, '=')) {
      // interpolation marker
      const t = eat(TOK.ID);
      interpIdx = t.value;
    } else if (maybe(TOK.KW, 'from')) {
      // 'module' — we just read the identifier as a string-like thing
      moduleName = eat(TOK.ID).value;
    }
    return { type: 'ImportDecl', name, params, retType, moduleName, interpIdx };
  }

  function parseFunction(exported = false) {
    eat(TOK.KW, 'function');
    const name = eat(TOK.ID).value;
    eat(TOK.PUNC, '(');
    const params = at(TOK.PUNC, ')') ? [] : parseParamEntries();
    eat(TOK.PUNC, ')');
    eat(TOK.PUNC, ':');
    const retType = eat(TOK.KW).value;
    const locals = [];
    if (at(TOK.KW, 'var')) {
      pos++;
      while (!at(TOK.KW, 'begin')) {
        const lnames = [eat(TOK.ID).value];
        while (at(TOK.PUNC, ',') && tokens[pos + 1] && tokens[pos + 1].type === TOK.ID &&
               tokens[pos + 2] && (tokens[pos + 2].value === ',' || tokens[pos + 2].value === ':')) {
          pos++; // skip ,
          lnames.push(eat(TOK.ID).value);
        }
        eat(TOK.PUNC, ':');
        if (at(TOK.KW, 'function')) {
          const funcSig = parseFuncTypeSig();
          for (const ln of lnames) locals.push({ type: 'Local', name: ln, vtype: 'i32', funcSig });
        } else if (at(TOK.KW, 'layout')) {
          pos++; // skip 'layout'
          const layoutName = eat(TOK.ID).value;
          for (const ln of lnames) locals.push({ type: 'Local', name: ln, vtype: 'i32', layoutType: layoutName });
        } else {
          const lt = eat(TOK.KW).value;
          for (const ln of lnames) locals.push({ type: 'Local', name: ln, vtype: lt });
        }
        maybe(TOK.PUNC, ','); // consume comma between local groups
      }
    }
    eat(TOK.KW, 'begin');
    const body = parseStatements('end');
    eat(TOK.KW, 'end');
    return { type: 'Function', name, params, retType, locals, body, exported };
  }

  function parseSubroutine() {
    eat(TOK.KW, 'subroutine');
    const name = eat(TOK.ID).value;
    eat(TOK.PUNC, '(');
    const params = at(TOK.PUNC, ')') ? [] : parseParamEntries();
    eat(TOK.PUNC, ')');
    const locals = [];
    if (at(TOK.KW, 'var')) {
      pos++;
      while (!at(TOK.KW, 'begin')) {
        const lnames = [eat(TOK.ID).value];
        while (at(TOK.PUNC, ',') && tokens[pos + 1] && tokens[pos + 1].type === TOK.ID &&
               tokens[pos + 2] && (tokens[pos + 2].value === ',' || tokens[pos + 2].value === ':')) {
          pos++; // skip ,
          lnames.push(eat(TOK.ID).value);
        }
        eat(TOK.PUNC, ':');
        if (at(TOK.KW, 'function')) {
          const funcSig = parseFuncTypeSig();
          for (const ln of lnames) locals.push({ type: 'Local', name: ln, vtype: 'i32', funcSig });
        } else if (at(TOK.KW, 'layout')) {
          pos++; // skip 'layout'
          const layoutName = eat(TOK.ID).value;
          for (const ln of lnames) locals.push({ type: 'Local', name: ln, vtype: 'i32', layoutType: layoutName });
        } else {
          const lt = eat(TOK.KW).value;
          for (const ln of lnames) locals.push({ type: 'Local', name: ln, vtype: lt });
        }
        maybe(TOK.PUNC, ','); // consume comma between local groups
      }
    }
    eat(TOK.KW, 'begin');
    const body = parseStatements('end');
    eat(TOK.KW, 'end');
    return { type: 'Subroutine', name, params, locals, body };
  }

  // Param grouping: "x, y: f64" shares a type across comma-separated names.
  // The lookahead (pos+2 is ',' or ':') distinguishes grouped names from the next param group.
  function parseParamEntries() {
    const params = [];
    while (cur().type === TOK.ID) {
      const names = [eat(TOK.ID).value];
      while (at(TOK.PUNC, ',') && tokens[pos + 1] && tokens[pos + 1].type === TOK.ID &&
             tokens[pos + 2] && (tokens[pos + 2].value === ',' || tokens[pos + 2].value === ':')) {
        pos++; // skip ,
        names.push(eat(TOK.ID).value);
      }
      eat(TOK.PUNC, ':');
      // function type: callback: function(x: f64): f64
      if (at(TOK.KW, 'function')) {
        const funcSig = parseFuncTypeSig();
        for (const n of names) params.push({ type: 'Param', name: n, vtype: 'i32', isArray: false, arrayDims: null, funcSig });
        maybe(TOK.PUNC, ','); // consume comma between param groups
        continue;
      }
      // layout type: ptr: layout Sphere
      if (at(TOK.KW, 'layout')) {
        pos++; // skip 'layout'
        const layoutName = eat(TOK.ID).value;
        for (const n of names) params.push({ type: 'Param', name: n, vtype: 'i32', isArray: false, arrayDims: null, layoutType: layoutName });
        maybe(TOK.PUNC, ','); // consume comma between param groups
        continue;
      }
      let isArray = false, arrayDims = null;
      if (at(TOK.KW, 'array')) {
        pos++;
        isArray = true;
        if (at(TOK.PUNC, '(')) {
          pos++;
          arrayDims = [];
          arrayDims.push(parseExpr(0));
          while (maybe(TOK.PUNC, ',')) arrayDims.push(parseExpr(0));
          eat(TOK.PUNC, ')');
        }
      }
      const vtype = eat(TOK.KW).value;
      for (const n of names) params.push({ type: 'Param', name: n, vtype, isArray, arrayDims });
      maybe(TOK.PUNC, ','); // consume comma between param groups
    }
    return params;
  }

  function parseParamList() {
    // simplified param list for imports: name: type, ...
    eat(TOK.PUNC, '(');
    const params = [];
    while (cur().type === TOK.ID) {
      const names = [eat(TOK.ID).value];
      while (at(TOK.PUNC, ',') && tokens[pos + 1] && tokens[pos + 1].type === TOK.ID &&
             tokens[pos + 2] && (tokens[pos + 2].value === ',' || tokens[pos + 2].value === ':')) {
        pos++;
        names.push(eat(TOK.ID).value);
      }
      eat(TOK.PUNC, ':');
      const vtype = eat(TOK.KW).value;
      for (const n of names) params.push({ type: 'Param', name: n, vtype, isArray: false, arrayDims: null });
      maybe(TOK.PUNC, ','); // consume comma between param groups
    }
    eat(TOK.PUNC, ')');
    return params;
  }

  function parseStatements(endKw) {
    const stmts = [];
    while (!at(TOK.KW, endKw) && !at(TOK.EOF)) {
      // also stop at 'else' for if blocks
      if (endKw === 'end' && at(TOK.KW, 'else')) break;
      stmts.push(parseStatement());
    }
    return stmts;
  }

  function parseStatement() {
    if (at(TOK.KW, 'if')) return parseIf();
    if (at(TOK.KW, 'for')) return parseFor();
    if (at(TOK.KW, 'while')) return parseWhile();
    if (at(TOK.KW, 'do')) return parseDoWhile();
    if (at(TOK.KW, 'break')) { pos++; return { type: 'Break' }; }
    if (at(TOK.KW, 'tailcall')) { pos++; const name = eat(TOK.ID).value; eat(TOK.PUNC, '('); const args = parseArgs(); eat(TOK.PUNC, ')'); return { type: 'TailCall', name, args }; }
    if (at(TOK.KW, 'call')) { pos++; const name = at(TOK.KW, 'return') ? (pos++, 'return') : eat(TOK.ID).value; eat(TOK.PUNC, '('); const args = parseArgs(); eat(TOK.PUNC, ')'); return { type: 'Call', name, args }; }

    // assignment or expression statement
    // look ahead: id := / id[...] := / id += etc.
    if (cur().type === TOK.ID) {
      const name = cur().value;
      // check for array store: id[
      if (tokens[pos + 1] && tokens[pos + 1].value === '[') {
        pos++;
        eat(TOK.PUNC, '[');
        const indices = [parseExpr(0)];
        while (maybe(TOK.PUNC, ',')) indices.push(parseExpr(0));
        eat(TOK.PUNC, ']');
        if (at(TOK.OP, ':=')) {
          pos++;
          const value = parseExpr(0);
          return { type: 'ArrayStore', name, indices, value };
        }
        // compound assignment on array
        const cop = cur().value;
        if (cop === '+=' || cop === '-=' || cop === '*=' || cop === '/=') {
          // Note: /= is ambiguous — as a statement start after array access, it's compound assign
          pos++;
          const rhs = parseExpr(0);
          const op = cop[0]; // +, -, *, /
          return { type: 'ArrayStore', name, indices, value: {
            type: 'BinOp', op, left: { type: 'ArrayAccess', name, indices }, right: rhs
          }};
        }
        throw new SyntaxError(`Expected := or compound assignment after array access at ${cur().line}:${cur().col}`);
      }
      if (tokens[pos + 1] && tokens[pos + 1].value === ':=') {
        pos++; pos++;
        const value = parseExpr(0);
        return { type: 'Assign', name, value };
      }
      // compound assignment: +=, -=, *=
      if (tokens[pos + 1] && (tokens[pos + 1].value === '+=' || tokens[pos + 1].value === '-=' || tokens[pos + 1].value === '*=')) {
        const cop = tokens[pos + 1].value;
        const op = cop[0];
        pos++; pos++;
        const rhs = parseExpr(0);
        return { type: 'Assign', name, value: { type: 'BinOp', op, left: { type: 'Ident', name }, right: rhs } };
      }
      // /= compound assignment (only when not in expression context — statement level)
      // Disambiguation: at statement level, id /= expr is compound divide-assign
      // But /= is also not-equal operator. At statement level: id /= expr → divide-assign.
      if (tokens[pos + 1] && tokens[pos + 1].value === '/=') {
        // look further: if this is a standalone statement (id /= expr), treat as compound assign
        const op = '/';
        pos++; pos++;
        const rhs = parseExpr(0);
        return { type: 'Assign', name, value: { type: 'BinOp', op, left: { type: 'Ident', name }, right: rhs } };
      }
    }

    // expression statement (e.g., bare function call)
    const expr = parseExpr(0);
    if (expr.type === 'FuncCall') return { type: 'Call', name: expr.name, args: expr.args };
    throw new SyntaxError(`Unexpected expression statement at ${cur().line}:${cur().col}`);
  }

  // The isElseIf flag controls 'end if' consumption: inner if in an else-if chain
  // lets the outermost if consume the single 'end if'. Without this, each level
  // would eat one 'end' and the nesting would break.
  function parseIf(isElseIf) {
    eat(TOK.KW, 'if');
    eat(TOK.PUNC, '(');
    const cond = parseExpr(0);
    eat(TOK.PUNC, ')');
    eat(TOK.KW, 'then');
    const body = [];
    while (!at(TOK.KW, 'else') && !at(TOK.KW, 'end') && !at(TOK.EOF)) {
      body.push(parseStatement());
    }
    let elseBody = null;
    if (maybe(TOK.KW, 'else')) {
      if (at(TOK.KW, 'if')) {
        // else if chain: inner parseIf handles everything including end if
        elseBody = [parseIf(true)];
      } else {
        elseBody = [];
        while (!at(TOK.KW, 'end') && !at(TOK.EOF)) {
          elseBody.push(parseStatement());
        }
      }
    }
    // Only consume 'end if' at the outermost if (not in else-if chain)
    if (!isElseIf && at(TOK.KW, 'end')) {
      pos++;
      maybe(TOK.KW, 'if');
    }
    return { type: 'If', cond, body, elseBody };
  }

  function parseFor() {
    eat(TOK.KW, 'for');
    const varName = eat(TOK.ID).value;
    eat(TOK.OP, ':=');
    const start = parseExpr(0);
    eat(TOK.PUNC, ',');
    const end = parseExpr(0);
    let step = null;
    if (maybe(TOK.PUNC, ',')) step = parseExpr(0);
    const body = [];
    while (!at(TOK.KW, 'end') && !at(TOK.EOF)) body.push(parseStatement());
    eat(TOK.KW, 'end');
    eat(TOK.KW, 'for');
    return { type: 'For', varName, start, end, step, body };
  }

  function parseWhile() {
    eat(TOK.KW, 'while');
    eat(TOK.PUNC, '(');
    const cond = parseExpr(0);
    eat(TOK.PUNC, ')');
    const body = [];
    while (!at(TOK.KW, 'end') && !at(TOK.EOF)) body.push(parseStatement());
    eat(TOK.KW, 'end');
    eat(TOK.KW, 'while');
    return { type: 'While', cond, body };
  }

  function parseDoWhile() {
    eat(TOK.KW, 'do');
    const body = [];
    while (!at(TOK.KW, 'while') && !at(TOK.EOF)) body.push(parseStatement());
    eat(TOK.KW, 'while');
    eat(TOK.PUNC, '(');
    const cond = parseExpr(0);
    eat(TOK.PUNC, ')');
    return { type: 'DoWhile', cond, body };
  }

  function parseArgs() {
    const args = [];
    if (!at(TOK.PUNC, ')')) {
      args.push(parseExpr(0));
      while (maybe(TOK.PUNC, ',')) args.push(parseExpr(0));
    }
    return args;
  }

  // ── Pratt expression parser ──

  // Binding powers (higher = tighter):
  //   or(2) < and(4) < ==/=/< />/<=/>=(6) < |(8) < ^(10) < &(12)
  //   < <</>> (14) < +/-(16) < */÷/mod(18) < **(22, right-assoc)
  function lbp(tok) {
    if (tok.type === TOK.KW) {
      if (tok.value === 'or') return 2;
      if (tok.value === 'and') return 4;
      if (tok.value === 'mod') return 18;
    }
    if (tok.type === TOK.OP) {
      const v = tok.value;
      if (v === '==' || v === '/=' || v === '<' || v === '>' || v === '<=' || v === '>=') return 6;
      if (v === '|') return 8;
      if (v === '^') return 10;
      if (v === '&') return 12;
      if (v === '<<' || v === '>>') return 14;
      if (v === '+' || v === '-') return 16;
      if (v === '*' || v === '/') return 18;
      if (v === '**') return 22; // right-assoc: parseExpr(bp) not parseExpr(bp+1)
    }
    return 0;
  }

  function parseExpr(minBp) {
    let left = parsePrefix();

    while (true) {
      const t = cur();
      const bp = lbp(t);
      if (bp === 0 || bp < minBp) break;

      // if-expression (ternary): if (cond) then a else b
      // Not handled here — it's a prefix form
      if (t.type === TOK.KW && t.value === 'or') { pos++; left = { type: 'BinOp', op: 'or', left, right: parseExpr(bp + 1) }; continue; }
      if (t.type === TOK.KW && t.value === 'and') { pos++; left = { type: 'BinOp', op: 'and', left, right: parseExpr(bp + 1) }; continue; }
      if (t.type === TOK.KW && t.value === 'mod') { pos++; left = { type: 'BinOp', op: 'mod', left, right: parseExpr(bp + 1) }; continue; }

      if (t.type === TOK.OP) {
        if (t.value === '**') {
          pos++;
          // Right-associativity trick: parseExpr(bp) instead of parseExpr(bp+1)
          // lets 2**3**4 parse as 2**(3**4).
          left = { type: 'BinOp', op: '**', left, right: parseExpr(bp) };
          continue;
        }
        pos++;
        left = { type: 'BinOp', op: t.value, left, right: parseExpr(bp + 1) };
        continue;
      }
      break;
    }
    return left;
  }

  function parsePrefix() {
    const t = cur();

    // parenthesized expression
    if (t.type === TOK.PUNC && t.value === '(') {
      pos++;
      const expr = parseExpr(0);
      eat(TOK.PUNC, ')');
      return expr;
    }

    // if-expression (ternary): if (cond) then a else b
    if (t.type === TOK.KW && t.value === 'if') {
      pos++;
      eat(TOK.PUNC, '(');
      const cond = parseExpr(0);
      eat(TOK.PUNC, ')');
      eat(TOK.KW, 'then');
      const thenExpr = parseExpr(0);
      eat(TOK.KW, 'else');
      const elseExpr = parseExpr(0);
      return { type: 'IfExpr', cond, thenExpr, elseExpr };
    }

    // unary minus
    if (t.type === TOK.OP && t.value === '-') {
      pos++;
      return { type: 'UnaryOp', op: '-', operand: parseExpr(21) };
    }
    // not
    if (t.type === TOK.KW && t.value === 'not') {
      pos++;
      return { type: 'UnaryOp', op: 'not', operand: parseExpr(21) };
    }
    // bitwise not
    if (t.type === TOK.OP && t.value === '~') {
      pos++;
      return { type: 'UnaryOp', op: '~', operand: parseExpr(21) };
    }
    // function reference: @funcname → table index
    if (t.type === TOK.OP && t.value === '@') {
      pos++;
      const name = cur();
      if (name.type !== TOK.ID) throw new SyntaxError(`Expected function name after @ at ${name.line}:${name.col}`);
      pos++;
      // consume dotted parts: @ns.func
      let fullName = name.value;
      while (cur().type === TOK.OP && cur().value === '.' && tokens[pos + 1] && tokens[pos + 1].type === TOK.ID) {
        pos++; // skip dot
        fullName += '.' + cur().value;
        pos++; // skip id
      }
      return { type: 'FuncRef', name: fullName };
    }
    // number literal
    if (t.type === TOK.NUM) {
      pos++;
      return { type: 'NumberLit', value: t.value, isFloat: t.isFloat, typeSuffix: t.typeSuffix };
    }
    // true/false
    if (t.type === TOK.KW && (t.value === 'true' || t.value === 'false')) {
      pos++;
      return { type: 'NumberLit', value: t.value === 'true' ? '1' : '0', isFloat: false, typeSuffix: 'i32' };
    }
    // identifier — may be function call, array access, or plain variable
    if (t.type === TOK.ID) {
      pos++;
      const name = t.value;
      // function call: name(...)
      if (at(TOK.PUNC, '(')) {
        pos++;
        const args = parseArgs();
        eat(TOK.PUNC, ')');
        return { type: 'FuncCall', name, args };
      }
      // array access: name[...]
      if (at(TOK.PUNC, '[')) {
        pos++;
        const indices = [parseExpr(0)];
        while (maybe(TOK.PUNC, ',')) indices.push(parseExpr(0));
        eat(TOK.PUNC, ']');
        return { type: 'ArrayAccess', name, indices };
      }
      return { type: 'Ident', name };
    }
    // type conversion / vector constructor: i32(...), f64(...), f64x2(a, b), etc.
    if (t.type === TOK.KW && ATRA_TYPES.has(t.value) && tokens[pos + 1] && tokens[pos + 1].value === '(') {
      pos++; // skip type keyword
      pos++; // skip (
      const args = parseArgs();
      eat(TOK.PUNC, ')');
      return { type: 'FuncCall', name: t.value, args };
    }
    throw new SyntaxError(`Unexpected token "${t.value}" at ${t.line}:${t.col}`);
  }

  return parseProgram();
}
