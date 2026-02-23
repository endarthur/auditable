// @auditable/atra — Arithmetic TRAnspiler
// Fortran/Pascal hybrid → WebAssembly bytecode. Single-file compiler.

// ═══════════════════════════════════════════════════════════════════════════
// 1. HIGHLIGHT TOKENIZER + COMPLETIONS (for auditable syntax highlighting)
// ═══════════════════════════════════════════════════════════════════════════

const ATRA_KEYWORDS = new Set([
  'function','subroutine','begin','end','var','const','if','then','else',
  'for','while','do','break','and','or','not','mod','import','export',
  'call','array','true','false','from',
]);

const ATRA_TYPES = new Set(['i32','i64','f32','f64']);

const ATRA_BUILTINS = new Set([
  'sin','cos','sqrt','abs','floor','ceil','ln','exp','pow',
  'min','max','trunc','nearest','copysign','select',
  'clz','ctz','popcnt','rotl','rotr','memory_size','memory_grow',
]);

function tokenizeAtra(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    // line comment: ! to end of line
    if (code[i] === '!') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // numbers (with optional type suffix _f32, _f64, _i32, _i64)
    if (/\d/.test(code[i]) || (code[i] === '.' && i + 1 < len && /\d/.test(code[i + 1]))) {
      const start = i;
      while (i < len && /[0-9.]/.test(code[i])) i++;
      if (i < len && /[eE]/.test(code[i])) {
        i++;
        if (i < len && /[+-]/.test(code[i])) i++;
        while (i < len && /\d/.test(code[i])) i++;
      }
      // type suffix: _f32, _f64, _i32, _i64
      if (code[i] === '_' && i + 3 <= len && /^[fi]/.test(code[i + 1])) {
        const suf = code.slice(i + 1, i + 4);
        if (ATRA_TYPES.has(suf)) i += 4;
      }
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }
    // identifiers / keywords
    if (/[a-zA-Z_]/.test(code[i])) {
      const start = i;
      while (i < len && /[\w.]/.test(code[i])) i++;
      const word = code.slice(start, i);
      const lower = word.toLowerCase();
      if (ATRA_KEYWORDS.has(lower)) {
        tokens.push({ type: 'kw', text: word });
      } else if (ATRA_TYPES.has(lower)) {
        // type names as builtins when followed by (
        if (i < len && code[i] === '(') {
          tokens.push({ type: 'fn', text: word });
        } else {
          tokens.push({ type: 'const', text: word });
        }
      } else if (ATRA_BUILTINS.has(lower) || lower.startsWith('wasm.')) {
        tokens.push({ type: 'fn', text: word });
      } else if (i < len && code[i] === '(') {
        tokens.push({ type: 'fn', text: word });
      } else {
        tokens.push({ type: 'id', text: word });
      }
      continue;
    }
    // multi-char operators
    if (i + 1 < len) {
      const two = code[i] + code[i + 1];
      if (two === '**' || two === ':=' || two === '+=' || two === '-=' ||
          two === '*=' || two === '/=' || two === '==' || two === '<=' ||
          two === '>=' || two === '<<' || two === '>>') {
        tokens.push({ type: 'op', text: two });
        i += 2;
        continue;
      }
      // /= is not-equal (must check it's not /=something as divide-assign — but in atra /= is not-equal)
      if (code[i] === '/' && code[i + 1] === '=') {
        tokens.push({ type: 'op', text: '/=' });
        i += 2;
        continue;
      }
    }
    // single-char operators
    if ('+-*/<>=&|^~'.includes(code[i])) {
      tokens.push({ type: 'op', text: code[i] });
      i++;
      continue;
    }
    // punctuation
    if ('()[];,:'.includes(code[i])) {
      tokens.push({ type: 'punc', text: code[i] });
      i++;
      continue;
    }
    // whitespace / other
    tokens.push({ type: '', text: code[i] });
    i++;
  }
  return tokens;
}

function atraCompletions() {
  const items = [];
  for (const w of ATRA_KEYWORDS) items.push({ text: w, kind: 'kw' });
  for (const w of ATRA_TYPES)    items.push({ text: w, kind: 'const' });
  for (const w of ATRA_BUILTINS) items.push({ text: w, kind: 'fn' });
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. COMPILER TOKENIZER
// ═══════════════════════════════════════════════════════════════════════════

const TOK = {
  NUM: 'num', ID: 'id', KW: 'kw', OP: 'op', PUNC: 'punc', EOF: 'eof',
};

function lex(source) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const len = source.length;

  function adv() { if (source[i] === '\n') { line++; col = 1; } else { col++; } i++; }
  function peek() { return i < len ? source[i] : ''; }
  function peek2() { return i + 1 < len ? source[i] + source[i + 1] : source[i] || ''; }

  while (i < len) {
    // skip whitespace and semicolons
    if (' \t\r\n;'.includes(source[i])) { adv(); continue; }
    // comment
    if (source[i] === '!') {
      while (i < len && source[i] !== '\n') adv();
      continue;
    }
    const tl = line, tc = col;
    // number
    if (/\d/.test(source[i]) || (source[i] === '.' && i + 1 < len && /\d/.test(source[i + 1]))) {
      const start = i;
      let isFloat = false;
      while (i < len && /\d/.test(source[i])) adv();
      if (peek() === '.' && /\d/.test(source[i + 1] || '')) { isFloat = true; adv(); while (i < len && /\d/.test(source[i])) adv(); }
      if (/[eE]/.test(peek())) { isFloat = true; adv(); if (/[+-]/.test(peek())) adv(); while (i < len && /\d/.test(source[i])) adv(); }
      let typeSuffix = null;
      if (peek() === '_') {
        const s = source.slice(i + 1, i + 4);
        if (ATRA_TYPES.has(s)) { typeSuffix = s; adv(); adv(); adv(); adv(); }
      }
      const raw = source.slice(start, i);
      tokens.push({ type: TOK.NUM, value: raw, isFloat, typeSuffix, line: tl, col: tc });
      continue;
    }
    // identifier (including wasm.xxx)
    if (/[a-zA-Z_]/.test(source[i])) {
      const start = i;
      while (i < len && /\w/.test(source[i])) adv();
      // handle wasm.xxx
      if (source.slice(start, i) === 'wasm' && peek() === '.') {
        adv(); // skip .
        while (i < len && /[\w]/.test(source[i])) adv();
      }
      let val = source.slice(start, i);
      // interpolation markers: __INTERP_N__
      if (/^__INTERP_\d+__$/.test(val)) {
        tokens.push({ type: TOK.ID, value: val, interp: true, line: tl, col: tc });
      } else if (ATRA_KEYWORDS.has(val) || ATRA_TYPES.has(val)) {
        tokens.push({ type: TOK.KW, value: val, line: tl, col: tc });
      } else {
        tokens.push({ type: TOK.ID, value: val, line: tl, col: tc });
      }
      continue;
    }
    // multi-char operators
    const tw = peek2();
    if (tw === '**' || tw === ':=' || tw === '+=' || tw === '-=' || tw === '*=' ||
        tw === '==' || tw === '<=' || tw === '>=' || tw === '<<' || tw === '>>') {
      tokens.push({ type: TOK.OP, value: tw, line: tl, col: tc });
      adv(); adv();
      continue;
    }
    // /= — this is not-equal in atra
    if (source[i] === '/' && source[i + 1] === '=') {
      tokens.push({ type: TOK.OP, value: '/=', line: tl, col: tc });
      adv(); adv();
      continue;
    }
    // single-char operators
    if ('+-*/<>=&|^~'.includes(source[i])) {
      tokens.push({ type: TOK.OP, value: source[i], line: tl, col: tc });
      adv();
      continue;
    }
    // punctuation
    if ('()[];,:'.includes(source[i])) {
      tokens.push({ type: TOK.PUNC, value: source[i], line: tl, col: tc });
      adv();
      continue;
    }
    // skip unknown
    adv();
  }
  tokens.push({ type: TOK.EOF, value: '', line, col });
  return tokens;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. PARSER
// ═══════════════════════════════════════════════════════════════════════════

function parse(tokens) {
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
      else throw new SyntaxError(`Unexpected "${cur().value}" at ${cur().line}:${cur().col}`);
    }
    return { type: 'Program', body };
  }

  function isLocalContext() { return false; } // globals only at top level

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
        while (maybe(TOK.PUNC, ',')) lnames.push(eat(TOK.ID).value);
        eat(TOK.PUNC, ':');
        const lt = eat(TOK.KW).value;
        for (const ln of lnames) locals.push({ type: 'Local', name: ln, vtype: lt });
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
        while (maybe(TOK.PUNC, ',')) lnames.push(eat(TOK.ID).value);
        eat(TOK.PUNC, ':');
        const lt = eat(TOK.KW).value;
        for (const ln of lnames) locals.push({ type: 'Local', name: ln, vtype: lt });
      }
    }
    eat(TOK.KW, 'begin');
    const body = parseStatements('end');
    eat(TOK.KW, 'end');
    return { type: 'Subroutine', name, params, locals, body };
  }

  function parseParamEntries() {
    const params = [];
    while (cur().type === TOK.ID) {
      // Collect comma-separated names that share a type
      const names = [eat(TOK.ID).value];
      while (at(TOK.PUNC, ',') && tokens[pos + 1] && tokens[pos + 1].type === TOK.ID &&
             tokens[pos + 2] && (tokens[pos + 2].value === ',' || tokens[pos + 2].value === ':')) {
        pos++; // skip ,
        names.push(eat(TOK.ID).value);
      }
      eat(TOK.PUNC, ':');
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
    }
    eat(TOK.PUNC, ')');
    return params;
  }

  function parseStatements(endKw) {
    const stmts = [];
    while (!at(TOK.KW, endKw) && !at(TOK.EOF)) {
      // also stop at 'else' for if blocks
      if (endKw === 'end' && (at(TOK.KW, 'else'))) break;
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
    if (at(TOK.KW, 'call')) { pos++; const name = eat(TOK.ID).value; eat(TOK.PUNC, '('); const args = parseArgs(); eat(TOK.PUNC, ')'); return { type: 'Call', name, args }; }

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

  // Binding powers (higher = tighter)
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
      if (v === '**') return 22; // right-assoc handled by using rbp = 22 - 1
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
          // right-associative: use bp instead of bp+1
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
    // type conversion: i32(...), f64(...)  — types are keywords
    if (t.type === TOK.KW && ATRA_TYPES.has(t.value) && tokens[pos + 1] && tokens[pos + 1].value === '(') {
      pos++; // skip type keyword
      pos++; // skip (
      const arg = parseExpr(0);
      eat(TOK.PUNC, ')');
      return { type: 'FuncCall', name: t.value, args: [arg] };
    }
    throw new SyntaxError(`Unexpected token "${t.value}" at ${t.line}:${t.col}`);
  }

  return parseProgram();
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. CODE GENERATOR — emits Wasm binary
// ═══════════════════════════════════════════════════════════════════════════

// Wasm opcodes
const OP_UNREACHABLE = 0x00, OP_NOP = 0x01, OP_BLOCK = 0x02, OP_LOOP = 0x03,
  OP_IF = 0x04, OP_ELSE = 0x05, OP_END = 0x0b, OP_BR = 0x0c, OP_BR_IF = 0x0d,
  OP_RETURN = 0x0f, OP_CALL = 0x10, OP_SELECT = 0x1b,
  OP_LOCAL_GET = 0x20, OP_LOCAL_SET = 0x21, OP_LOCAL_TEE = 0x22,
  OP_GLOBAL_GET = 0x23, OP_GLOBAL_SET = 0x24,
  OP_I32_LOAD = 0x28, OP_I64_LOAD = 0x29, OP_F32_LOAD = 0x2a, OP_F64_LOAD = 0x2b,
  OP_I32_STORE = 0x36, OP_I64_STORE = 0x37, OP_F32_STORE = 0x38, OP_F64_STORE = 0x39,
  OP_MEMORY_SIZE = 0x3f, OP_MEMORY_GROW = 0x40,
  OP_I32_CONST = 0x41, OP_I64_CONST = 0x42, OP_F32_CONST = 0x43, OP_F64_CONST = 0x44,
  OP_I32_EQZ = 0x45, OP_I32_EQ = 0x46, OP_I32_NE = 0x47,
  OP_I32_LT_S = 0x48, OP_I32_LT_U = 0x49, OP_I32_GT_S = 0x4a, OP_I32_GT_U = 0x4b,
  OP_I32_LE_S = 0x4c, OP_I32_LE_U = 0x4d, OP_I32_GE_S = 0x4e, OP_I32_GE_U = 0x4f,
  OP_I64_EQZ = 0x50, OP_I64_EQ = 0x51, OP_I64_NE = 0x52,
  OP_I64_LT_S = 0x53, OP_I64_LT_U = 0x54, OP_I64_GT_S = 0x55, OP_I64_GT_U = 0x56,
  OP_I64_LE_S = 0x57, OP_I64_LE_U = 0x58, OP_I64_GE_S = 0x59, OP_I64_GE_U = 0x5a,
  OP_F32_EQ = 0x5b, OP_F32_NE = 0x5c, OP_F32_LT = 0x5d, OP_F32_GT = 0x5e, OP_F32_LE = 0x5f, OP_F32_GE = 0x60,
  OP_F64_EQ = 0x61, OP_F64_NE = 0x62, OP_F64_LT = 0x63, OP_F64_GT = 0x64, OP_F64_LE = 0x65, OP_F64_GE = 0x66,
  OP_I32_CLZ = 0x67, OP_I32_CTZ = 0x68, OP_I32_POPCNT = 0x69,
  OP_I32_ADD = 0x6a, OP_I32_SUB = 0x6b, OP_I32_MUL = 0x6c,
  OP_I32_DIV_S = 0x6d, OP_I32_DIV_U = 0x6e, OP_I32_REM_S = 0x6f, OP_I32_REM_U = 0x70,
  OP_I32_AND = 0x71, OP_I32_OR = 0x72, OP_I32_XOR = 0x73,
  OP_I32_SHL = 0x74, OP_I32_SHR_S = 0x75, OP_I32_SHR_U = 0x76,
  OP_I32_ROTL = 0x77, OP_I32_ROTR = 0x78,
  OP_I64_CLZ = 0x79, OP_I64_CTZ = 0x7a, OP_I64_POPCNT = 0x7b,
  OP_I64_ADD = 0x7c, OP_I64_SUB = 0x7d, OP_I64_MUL = 0x7e,
  OP_I64_DIV_S = 0x7f, OP_I64_DIV_U = 0x80, OP_I64_REM_S = 0x81, OP_I64_REM_U = 0x82,
  OP_I64_AND = 0x83, OP_I64_OR = 0x84, OP_I64_XOR = 0x85,
  OP_I64_SHL = 0x86, OP_I64_SHR_S = 0x87, OP_I64_SHR_U = 0x88,
  OP_I64_ROTL = 0x89, OP_I64_ROTR = 0x8a,
  OP_F32_ABS = 0x8b, OP_F32_NEG = 0x8c, OP_F32_CEIL = 0x8d, OP_F32_FLOOR = 0x8e,
  OP_F32_TRUNC = 0x8f, OP_F32_NEAREST = 0x90, OP_F32_SQRT = 0x91,
  OP_F32_ADD = 0x92, OP_F32_SUB = 0x93, OP_F32_MUL = 0x94, OP_F32_DIV = 0x95,
  OP_F32_MIN = 0x96, OP_F32_MAX = 0x97, OP_F32_COPYSIGN = 0x98,
  OP_F64_ABS = 0x99, OP_F64_NEG = 0x9a, OP_F64_CEIL = 0x9b, OP_F64_FLOOR = 0x9c,
  OP_F64_TRUNC = 0x9d, OP_F64_NEAREST = 0x9e, OP_F64_SQRT = 0x9f,
  OP_F64_ADD = 0xa0, OP_F64_SUB = 0xa1, OP_F64_MUL = 0xa2, OP_F64_DIV = 0xa3,
  OP_F64_MIN = 0xa4, OP_F64_MAX = 0xa5, OP_F64_COPYSIGN = 0xa6,
  OP_I32_WRAP_I64 = 0xa7,
  OP_I32_TRUNC_F32_S = 0xa8, OP_I32_TRUNC_F64_S = 0xaa,
  OP_I64_EXTEND_I32_S = 0xac, OP_I64_EXTEND_I32_U = 0xad,
  OP_I64_TRUNC_F32_S = 0xae, OP_I64_TRUNC_F64_S = 0xb0,
  OP_F32_CONVERT_I32_S = 0xb2, OP_F32_CONVERT_I64_S = 0xb4,
  OP_F32_DEMOTE_F64 = 0xb6,
  OP_F64_CONVERT_I32_S = 0xb7, OP_F64_CONVERT_I64_S = 0xb9,
  OP_F64_PROMOTE_F32 = 0xbb,
  OP_I32_REINTERPRET_F32 = 0xbc, OP_I64_REINTERPRET_F64 = 0xbd,
  OP_F32_REINTERPRET_I32 = 0xbe, OP_F64_REINTERPRET_I64 = 0xbf,
  OP_I32_EXTEND8_S = 0xc0, OP_I32_EXTEND16_S = 0xc1,
  OP_I64_EXTEND8_S = 0xc2, OP_I64_EXTEND16_S = 0xc3, OP_I64_EXTEND32_S = 0xc4;

// Wasm FC prefix opcodes (0xFC prefix)
const OP_FC_PREFIX = 0xfc;
const OP_I32_TRUNC_SAT_F32_S = 0, OP_I32_TRUNC_SAT_F32_U = 1,
  OP_I32_TRUNC_SAT_F64_S = 2, OP_I32_TRUNC_SAT_F64_U = 3,
  OP_I64_TRUNC_SAT_F32_S = 4, OP_I64_TRUNC_SAT_F32_U = 5,
  OP_I64_TRUNC_SAT_F64_S = 6, OP_I64_TRUNC_SAT_F64_U = 7;

// Wasm type codes
const WASM_I32 = 0x7f, WASM_I64 = 0x7e, WASM_F32 = 0x7d, WASM_F64 = 0x7c;
const WASM_VOID = 0x40;

function wasmType(t) {
  if (t === 'i32') return WASM_I32;
  if (t === 'i64') return WASM_I64;
  if (t === 'f32') return WASM_F32;
  if (t === 'f64') return WASM_F64;
  throw new Error('Unknown type: ' + t);
}

function typeSize(t) {
  if (t === 'i32' || t === 'f32') return 4;
  if (t === 'i64' || t === 'f64') return 8;
  throw new Error('Unknown type: ' + t);
}

function isFloat(t) { return t === 'f32' || t === 'f64'; }
function isInt(t) { return t === 'i32' || t === 'i64'; }

// ── ByteWriter ──

class ByteWriter {
  constructor() { this.buf = []; }
  byte(b) { this.buf.push(b & 0xff); }
  bytes(arr) { for (const b of arr) this.byte(b); }
  u32(v) { // LEB128 unsigned
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; this.byte(b); } while (v);
  }
  s32(v) { // LEB128 signed
    let more = true;
    while (more) {
      let b = v & 0x7f; v >>= 7;
      if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) more = false; else b |= 0x80;
      this.byte(b);
    }
  }
  s64(v) { // LEB128 signed for i64 (BigInt)
    v = BigInt(v);
    let more = true;
    while (more) {
      let b = Number(v & 0x7fn); v >>= 7n;
      if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = false; else b |= 0x80;
      this.byte(b);
    }
  }
  f32(v) { const buf = new ArrayBuffer(4); new DataView(buf).setFloat32(0, v, true); this.bytes(new Uint8Array(buf)); }
  f64(v) { const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, v, true); this.bytes(new Uint8Array(buf)); }
  str(s) { const enc = new TextEncoder().encode(s); this.u32(enc.length); this.bytes(enc); }
  section(id, contentFn) {
    const inner = new ByteWriter();
    contentFn(inner);
    this.byte(id);
    this.u32(inner.buf.length);
    this.bytes(inner.buf);
  }
  toUint8Array() { return new Uint8Array(this.buf); }
}

function codegen(ast, interpValues, userImports) {
  const w = new ByteWriter();

  // ── Collect info ──
  const globals = [];    // { name, vtype, mutable, init }
  const functions = [];  // AST nodes
  const imports = [];    // { name, moduleName, params, retType, interpIdx }
  const localFuncNames = new Set();

  for (const node of ast.body) {
    if (node.type === 'ConstDecl') globals.push({ name: node.name, vtype: node.vtype, mutable: false, init: node.init });
    else if (node.type === 'VarDecl') globals.push({ name: node.name, vtype: node.vtype, mutable: true, init: node.init });
    else if (node.type === 'Function' || node.type === 'Subroutine') { functions.push(node); localFuncNames.add(node.name); }
    else if (node.type === 'ImportDecl') imports.push(node);
  }

  // Math builtins that need importing
  const MATH_BUILTINS = { sin: 1, cos: 1, ln: 1, exp: 1, pow: 2, atan2: 2 };
  // Native builtins (no import needed) — resolved per-type in emitFuncCall
  const NATIVE_BUILTINS = new Set([
    'sqrt','abs','floor','ceil','trunc','nearest','copysign',
    'min','max','select',
    'clz','ctz','popcnt','rotl','rotr',
    'memory_size','memory_grow',
    'i32','i64','f32','f64', // type conversions
  ]);

  // Scan all function bodies for unresolved calls
  const usedCalls = new Set();
  function scanCalls(stmts) {
    for (const s of stmts) {
      if (s.type === 'Call' || s.type === 'FuncCall') usedCalls.add(s.name);
      if (s.type === 'If') { scanCalls(s.body); if (s.elseBody) scanCalls(s.elseBody); }
      if (s.type === 'For' || s.type === 'While' || s.type === 'DoWhile') scanCalls(s.body);
      // scan expressions
      scanExprCalls(s);
    }
  }
  function scanExprCalls(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FuncCall') usedCalls.add(node.name);
    // ** operator may need pow import (for non-sqrt, non-small-int exponents)
    if (node.type === 'BinOp' && node.op === '**') usedCalls.add('pow');
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(scanExprCalls);
      else if (v && typeof v === 'object' && v.type) scanExprCalls(v);
    }
  }
  for (const fn of functions) scanCalls(fn.body);

  // Auto-import math builtins that are actually used
  const mathImports = [];
  for (const name of usedCalls) {
    if (MATH_BUILTINS[name] !== undefined && !localFuncNames.has(name) && !imports.find(im => im.name === name)) {
      const nParams = MATH_BUILTINS[name];
      const params = [];
      for (let k = 0; k < nParams; k++) params.push({ type: 'Param', name: 'x' + k, vtype: 'f64', isArray: false, arrayDims: null });
      mathImports.push({ name, moduleName: 'math', params, retType: 'f64', interpIdx: null });
    }
  }

  // Auto-import from userImports or globalThis
  const hostImports = [];
  for (const name of usedCalls) {
    if (localFuncNames.has(name) || NATIVE_BUILTINS.has(name) || name.startsWith('wasm.') ||
        MATH_BUILTINS[name] !== undefined || imports.find(im => im.name === name)) continue;
    // check userImports then globalThis
    let fn = userImports && userImports[name];
    if (!fn && typeof globalThis !== 'undefined') fn = globalThis[name];
    if (typeof fn === 'function') {
      const nParams = fn.length;
      const params = [];
      for (let k = 0; k < nParams; k++) params.push({ type: 'Param', name: 'x' + k, vtype: 'f64', isArray: false, arrayDims: null });
      hostImports.push({ name, moduleName: 'host', params, retType: 'f64', interpIdx: null, jsFn: fn });
    }
  }

  const allImports = [...mathImports, ...imports, ...hostImports];

  // Build function index table: imports first, then local functions
  const funcIndex = {};
  let idx = 0;
  for (const im of allImports) { funcIndex[im.name] = idx++; }
  for (const fn of functions) { funcIndex[fn.name] = idx++; }

  // Global index table
  const globalIndex = {};
  for (let gi = 0; gi < globals.length; gi++) globalIndex[globals[gi].name] = gi;

  // ── Build type signatures ──
  function paramWasmType(p) { return p.isArray ? 'i32' : p.vtype; }
  function sigKey(params, retType) {
    return params.map(p => paramWasmType(p)).join(',') + ':' + (retType || '');
  }
  const sigMap = new Map();
  const sigList = []; // [{params, retType}]
  function getOrAddSig(params, retType) {
    const key = sigKey(params, retType);
    if (sigMap.has(key)) return sigMap.get(key);
    const id = sigList.length;
    sigList.push({ params, retType });
    sigMap.set(key, id);
    return id;
  }

  // Register all signatures
  const importSigIds = allImports.map(im => getOrAddSig(im.params, im.retType));
  const funcSigIds = functions.map(fn => {
    const retType = fn.type === 'Subroutine' ? null : fn.retType;
    return getOrAddSig(fn.params, retType);
  });

  // ── Determine memory ──
  const hasMemory = functions.some(fn => fn.params.some(p => p.isArray));
  const importMemory = userImports && userImports.__memory;

  // ── Emit Wasm binary ──
  // Magic + version
  w.bytes([0x00, 0x61, 0x73, 0x6d]); // \0asm
  w.bytes([0x01, 0x00, 0x00, 0x00]); // version 1

  // Type section (1)
  w.section(1, s => {
    s.u32(sigList.length);
    for (const sig of sigList) {
      s.byte(0x60); // func type
      s.u32(sig.params.length);
      for (const p of sig.params) s.byte(wasmType(paramWasmType(p)));
      if (sig.retType) { s.u32(1); s.byte(wasmType(sig.retType)); }
      else s.u32(0);
    }
  });

  // Import section (2)
  if (allImports.length > 0 || importMemory) {
    w.section(2, s => {
      s.u32(allImports.length + (importMemory ? 1 : 0));
      for (let ii = 0; ii < allImports.length; ii++) {
        const im = allImports[ii];
        s.str(im.moduleName);
        s.str(im.name);
        s.byte(0x00); // func import
        s.u32(importSigIds[ii]);
      }
      if (importMemory) {
        s.str('env');
        s.str('memory');
        s.byte(0x02); // memory import
        s.byte(0x00); // no max
        s.u32(1); // initial 1 page
      }
    });
  }

  // Function section (3)
  w.section(3, s => {
    s.u32(functions.length);
    for (const sigId of funcSigIds) s.u32(sigId);
  });

  // Memory section (5) — only if arrays used and no imported memory
  if (hasMemory && !importMemory) {
    w.section(5, s => {
      s.u32(1);
      s.byte(0x00); // no max
      s.u32(1); // initial: 1 page (64KB)
    });
  }

  // Global section (6)
  if (globals.length > 0) {
    w.section(6, s => {
      s.u32(globals.length);
      for (const g of globals) {
        s.byte(wasmType(g.vtype));
        s.byte(g.mutable ? 0x01 : 0x00);
        // init expression
        emitConstExpr(s, g.init, g.vtype);
        s.byte(OP_END);
      }
    });
  }

  // Export section (7)
  w.section(7, s => {
    const exports = functions.map((fn, i) => ({ name: fn.name, idx: allImports.length + i }));
    const memExport = (hasMemory && !importMemory) ? 1 : 0;
    s.u32(exports.length + memExport);
    for (const e of exports) {
      s.str(e.name);
      s.byte(0x00); // func export
      s.u32(e.idx);
    }
    if (memExport) {
      s.str('memory');
      s.byte(0x02); // memory export
      s.u32(0);
    }
  });

  // Code section (10)
  w.section(10, s => {
    s.u32(functions.length);
    for (const fn of functions) {
      const bodyWriter = new ByteWriter();
      emitFunctionBody(bodyWriter, fn);
      s.u32(bodyWriter.buf.length);
      s.bytes(bodyWriter.buf);
    }
  });

  return w.toUint8Array();

  // ── Helper: emit constant init expression ──
  function emitConstExpr(s, node, vtype) {
    if (!node) {
      // default zero
      if (vtype === 'i32') { s.byte(OP_I32_CONST); s.s32(0); }
      else if (vtype === 'i64') { s.byte(OP_I64_CONST); s.s64(0n); }
      else if (vtype === 'f32') { s.byte(OP_F32_CONST); s.f32(0); }
      else if (vtype === 'f64') { s.byte(OP_F64_CONST); s.f64(0); }
      return;
    }
    if (node.type === 'NumberLit') {
      const val = parseNumericValue(node, vtype);
      emitTypedConst(s, vtype, val);
      return;
    }
    if (node.type === 'UnaryOp' && node.op === '-' && node.operand.type === 'NumberLit') {
      const val = -parseNumericValue(node.operand, vtype);
      emitTypedConst(s, vtype, val);
      return;
    }
    throw new Error('Global init must be a constant expression');
  }

  function parseNumericValue(node, defaultType) {
    const raw = node.value;
    if (raw.includes('.') || raw.includes('e') || raw.includes('E') || node.isFloat) return parseFloat(raw);
    return parseInt(raw, 10);
  }

  function emitTypedConst(s, vtype, val) {
    if (vtype === 'i32') { s.byte(OP_I32_CONST); s.s32(val | 0); }
    else if (vtype === 'i64') { s.byte(OP_I64_CONST); s.s64(BigInt(val)); }
    else if (vtype === 'f32') { s.byte(OP_F32_CONST); s.f32(val); }
    else if (vtype === 'f64') { s.byte(OP_F64_CONST); s.f64(val); }
  }

  // ── Emit function body ──
  function emitFunctionBody(bw, fn) {
    const isFunc = fn.type === 'Function';
    const retType = isFunc ? fn.retType : null;

    // Build local map: params + locals + return var
    const localMap = {}; // name → { idx, vtype }
    let localIdx = 0;
    for (const p of fn.params) {
      localMap[p.name] = {
        idx: localIdx++,
        vtype: p.isArray ? 'i32' : p.vtype, // Wasm type: arrays are i32 pointers
        isArray: p.isArray,
        arrayDims: p.arrayDims,
        elemType: p.isArray ? p.vtype : null  // element type for load/store
      };
    }
    // Additional locals declared
    const declaredLocals = [...fn.locals];
    if (isFunc) {
      // hidden return local (uses function name)
      declaredLocals.push({ name: '$_return', vtype: retType });
    }
    for (const loc of declaredLocals) {
      localMap[loc.name] = { idx: localIdx++, vtype: loc.vtype };
    }

    // Emit local declarations (only the non-param ones)
    const localTypes = declaredLocals.map(l => l.vtype);
    // Compress: runs of same type
    const localRuns = [];
    for (const lt of localTypes) {
      if (localRuns.length > 0 && localRuns[localRuns.length - 1].type === lt) localRuns[localRuns.length - 1].count++;
      else localRuns.push({ count: 1, type: lt });
    }
    bw.u32(localRuns.length);
    for (const run of localRuns) {
      bw.u32(run.count);
      bw.byte(wasmType(run.type));
    }

    // Emit body statements
    let depth = 0; // current block nesting depth
    const breakTargets = []; // stack of {depth} for each enclosing loop's break block

    function emitStmts(stmts) { for (const s of stmts) emitStmt(s); }

    function emitStmt(stmt) {
      switch (stmt.type) {
        case 'Assign': {
          const target = stmt.name;
          // Assignment to function name = set return variable
          if (isFunc && target === fn.name) {
            emitExpr(stmt.value, retType);
            bw.byte(OP_LOCAL_SET);
            bw.u32(localMap['$_return'].idx);
          } else if (localMap[target]) {
            emitExpr(stmt.value, localMap[target].vtype);
            bw.byte(OP_LOCAL_SET);
            bw.u32(localMap[target].idx);
          } else if (globalIndex[target] !== undefined) {
            emitExpr(stmt.value, globals[globalIndex[target]].vtype);
            bw.byte(OP_GLOBAL_SET);
            bw.u32(globalIndex[target]);
          } else {
            throw new Error(`Undefined variable: ${target}`);
          }
          break;
        }
        case 'ArrayStore': {
          const info = localMap[stmt.name];
          if (!info) throw new Error(`Undefined array: ${stmt.name}`);
          const elemType = info.elemType || info.vtype;
          // compute address
          emitArrayAddr(stmt.name, stmt.indices, info, elemType);
          // compute value
          emitExpr(stmt.value, elemType);
          // store
          emitStore(elemType);
          break;
        }
        case 'If': {
          emitExpr(stmt.cond, 'i32');
          bw.byte(OP_IF);
          bw.byte(WASM_VOID);
          depth++;
          emitStmts(stmt.body);
          if (stmt.elseBody) {
            bw.byte(OP_ELSE);
            emitStmts(stmt.elseBody);
          }
          depth--;
          bw.byte(OP_END);
          break;
        }
        case 'For': {
          const vInfo = localMap[stmt.varName];
          if (!vInfo) throw new Error(`Undefined loop variable: ${stmt.varName}`);
          const vt = vInfo.vtype;
          emitExpr(stmt.start, vt);
          bw.byte(OP_LOCAL_SET);
          bw.u32(vInfo.idx);

          const hasStep = stmt.step !== null;

          bw.byte(OP_BLOCK); bw.byte(WASM_VOID); depth++;
          const breakDepth = depth; // break target = this block
          bw.byte(OP_LOOP); bw.byte(WASM_VOID); depth++;
          breakTargets.push(breakDepth);

          // condition check: br_if to break block
          bw.byte(OP_LOCAL_GET); bw.u32(vInfo.idx);
          emitExpr(stmt.end, vt);
          if (!hasStep) {
            emitCmp('>=', vt);
          } else {
            const stepIsNegLit = stmt.step.type === 'UnaryOp' && stmt.step.op === '-' && stmt.step.operand.type === 'NumberLit';
            const stepIsNegConst = stepIsNegLit || (stmt.step.type === 'NumberLit' && parseFloat(stmt.step.value) < 0);
            emitCmp(stepIsNegConst ? '<=' : '>=', vt);
          }
          bw.byte(OP_BR_IF); bw.u32(depth - breakDepth);

          emitStmts(stmt.body);

          // increment
          bw.byte(OP_LOCAL_GET); bw.u32(vInfo.idx);
          if (hasStep) { emitExpr(stmt.step, vt); } else { emitTypedConst(bw, vt, 1); }
          emitAdd(vt);
          bw.byte(OP_LOCAL_SET); bw.u32(vInfo.idx);

          bw.byte(OP_BR); bw.u32(0); // continue to loop
          depth--; bw.byte(OP_END); // end loop
          breakTargets.pop();
          depth--; bw.byte(OP_END); // end block
          break;
        }
        case 'While': {
          bw.byte(OP_BLOCK); bw.byte(WASM_VOID); depth++;
          const breakDepth = depth;
          bw.byte(OP_LOOP); bw.byte(WASM_VOID); depth++;
          breakTargets.push(breakDepth);

          emitExpr(stmt.cond, 'i32');
          bw.byte(OP_I32_EQZ);
          bw.byte(OP_BR_IF); bw.u32(depth - breakDepth);

          emitStmts(stmt.body);

          bw.byte(OP_BR); bw.u32(0); // continue loop
          depth--; bw.byte(OP_END); // end loop
          breakTargets.pop();
          depth--; bw.byte(OP_END); // end block
          break;
        }
        case 'DoWhile': {
          bw.byte(OP_BLOCK); bw.byte(WASM_VOID); depth++;
          const breakDepth = depth;
          bw.byte(OP_LOOP); bw.byte(WASM_VOID); depth++;
          breakTargets.push(breakDepth);

          emitStmts(stmt.body);

          emitExpr(stmt.cond, 'i32');
          bw.byte(OP_BR_IF); bw.u32(0); // continue if true

          depth--; bw.byte(OP_END); // end loop
          breakTargets.pop();
          depth--; bw.byte(OP_END); // end block
          break;
        }
        case 'Break': {
          if (breakTargets.length === 0) throw new Error('break outside loop');
          const targetDepth = breakTargets[breakTargets.length - 1];
          bw.byte(OP_BR);
          bw.u32(depth - targetDepth);
          break;
        }
        case 'Call': {
          // subroutine call or function call (result discarded)
          const fIdx = funcIndex[stmt.name];
          if (fIdx === undefined) throw new Error(`Undefined function: ${stmt.name}`);
          for (let ai = 0; ai < stmt.args.length; ai++) {
            // infer param type from declaration
            const paramType = getParamType(stmt.name, ai);
            emitExpr(stmt.args[ai], paramType);
          }
          bw.byte(OP_CALL);
          bw.u32(fIdx);
          break;
        }
        default:
          throw new Error(`Unknown statement type: ${stmt.type}`);
      }
    }

    function getParamType(funcName, paramIdx) {
      // check local functions
      const fn = functions.find(f => f.name === funcName);
      if (fn && fn.params[paramIdx]) return fn.params[paramIdx].isArray ? 'i32' : fn.params[paramIdx].vtype;
      // check imports
      const im = allImports.find(i => i.name === funcName);
      if (im && im.params[paramIdx]) return im.params[paramIdx].vtype;
      return 'f64'; // default
    }

    function resolveType(name) {
      if (localMap[name]) return localMap[name].vtype;
      if (globalIndex[name] !== undefined) return globals[globalIndex[name]].vtype;
      return null;
    }

    function inferExprType(expr) {
      switch (expr.type) {
        case 'NumberLit': {
          if (expr.typeSuffix) return expr.typeSuffix;
          if (expr.isFloat || expr.value.includes('.') || expr.value.includes('e') || expr.value.includes('E')) return 'f64';
          return 'i32';
        }
        case 'Ident': return resolveType(expr.name) || 'f64';
        case 'BinOp': return inferExprType(expr.left);
        case 'UnaryOp': return inferExprType(expr.operand);
        case 'FuncCall': {
          // type conversions
          if (ATRA_TYPES.has(expr.name)) return expr.name;
          // known return types
          const fn = functions.find(f => f.name === expr.name);
          if (fn && fn.retType) return fn.retType;
          return 'f64';
        }
        case 'ArrayAccess': {
          const info = localMap[expr.name];
          return info ? (info.elemType || info.vtype) : 'f64';
        }
        case 'IfExpr': return inferExprType(expr.thenExpr);
        default: return 'f64';
      }
    }

    function emitExpr(expr, expectedType) {
      const actualType = expectedType || inferExprType(expr);

      switch (expr.type) {
        case 'NumberLit': {
          const t = expectedType || inferExprType(expr);
          const raw = expr.value;
          if (t === 'i32') { bw.byte(OP_I32_CONST); bw.s32(parseInt(raw, 10) | 0); }
          else if (t === 'i64') { bw.byte(OP_I64_CONST); bw.s64(BigInt(parseInt(raw, 10))); }
          else if (t === 'f32') { bw.byte(OP_F32_CONST); bw.f32(parseFloat(raw)); }
          else { bw.byte(OP_F64_CONST); bw.f64(parseFloat(raw)); }
          break;
        }
        case 'Ident': {
          const name = expr.name;
          if (localMap[name]) { bw.byte(OP_LOCAL_GET); bw.u32(localMap[name].idx); }
          else if (globalIndex[name] !== undefined) { bw.byte(OP_GLOBAL_GET); bw.u32(globalIndex[name]); }
          else throw new Error(`Undefined variable: ${name}`);
          break;
        }
        case 'BinOp': {
          const t = expectedType || inferExprType(expr);
          emitBinOp(expr, t);
          break;
        }
        case 'UnaryOp': {
          const t = expectedType || inferExprType(expr);
          if (expr.op === '-') {
            if (t === 'f64') { emitExpr(expr.operand, t); bw.byte(OP_F64_NEG); }
            else if (t === 'f32') { emitExpr(expr.operand, t); bw.byte(OP_F32_NEG); }
            else if (t === 'i32') { bw.byte(OP_I32_CONST); bw.s32(0); emitExpr(expr.operand, t); bw.byte(OP_I32_SUB); }
            else if (t === 'i64') { bw.byte(OP_I64_CONST); bw.s64(0n); emitExpr(expr.operand, t); bw.byte(OP_I64_SUB); }
          } else if (expr.op === 'not') {
            emitExpr(expr.operand, 'i32');
            bw.byte(OP_I32_EQZ);
          } else if (expr.op === '~') {
            emitExpr(expr.operand, t);
            if (t === 'i32') { bw.byte(OP_I32_CONST); bw.s32(-1); bw.byte(OP_I32_XOR); }
            else if (t === 'i64') { bw.byte(OP_I64_CONST); bw.s64(-1n); bw.byte(OP_I64_XOR); }
          } else {
            emitExpr(expr.operand, t);
          }
          break;
        }
        case 'FuncCall': {
          emitFuncCall(expr, expectedType);
          break;
        }
        case 'ArrayAccess': {
          const info = localMap[expr.name];
          if (!info) throw new Error(`Undefined array: ${expr.name}`);
          const elemType = info.elemType || info.vtype;
          emitArrayAddr(expr.name, expr.indices, info, elemType);
          emitLoad(elemType);
          break;
        }
        case 'IfExpr': {
          const t = expectedType || inferExprType(expr.thenExpr);
          emitExpr(expr.cond, 'i32');
          bw.byte(OP_IF);
          bw.byte(wasmType(t));
          emitExpr(expr.thenExpr, t);
          bw.byte(OP_ELSE);
          emitExpr(expr.elseExpr, t);
          bw.byte(OP_END);
          break;
        }
        default:
          throw new Error(`Unknown expression type: ${expr.type}`);
      }
    }

    function emitBinOp(expr, t) {
      const op = expr.op;

      // Exponentiation
      if (op === '**') {
        emitPow(expr, t);
        return;
      }

      // Comparison operators return i32
      if (op === '==' || op === '/=' || op === '<' || op === '>' || op === '<=' || op === '>=') {
        const operandType = inferExprType(expr.left);
        emitExpr(expr.left, operandType);
        emitExpr(expr.right, operandType);
        emitCmp(op, operandType);
        return;
      }

      // Logical: and, or
      if (op === 'and') {
        emitExpr(expr.left, 'i32');
        emitExpr(expr.right, 'i32');
        bw.byte(OP_I32_AND);
        return;
      }
      if (op === 'or') {
        emitExpr(expr.left, 'i32');
        emitExpr(expr.right, 'i32');
        bw.byte(OP_I32_OR);
        return;
      }

      emitExpr(expr.left, t);
      emitExpr(expr.right, t);

      if (op === '+') emitAdd(t);
      else if (op === '-') emitSub(t);
      else if (op === '*') emitMul(t);
      else if (op === '/') emitDiv(t);
      else if (op === 'mod') {
        if (t === 'i32') bw.byte(OP_I32_REM_S);
        else if (t === 'i64') bw.byte(OP_I64_REM_S);
        else throw new Error('mod requires integer type');
      }
      else if (op === '&') { if (t === 'i32') bw.byte(OP_I32_AND); else bw.byte(OP_I64_AND); }
      else if (op === '|') { if (t === 'i32') bw.byte(OP_I32_OR); else bw.byte(OP_I64_OR); }
      else if (op === '^') { if (t === 'i32') bw.byte(OP_I32_XOR); else bw.byte(OP_I64_XOR); }
      else if (op === '<<') { if (t === 'i32') bw.byte(OP_I32_SHL); else bw.byte(OP_I64_SHL); }
      else if (op === '>>') { if (t === 'i32') bw.byte(OP_I32_SHR_S); else bw.byte(OP_I64_SHR_S); }
      else throw new Error(`Unknown operator: ${op}`);
    }

    function emitPow(expr, t) {
      // **0.5 → sqrt
      if (expr.right.type === 'NumberLit' && (expr.right.value === '0.5' || expr.right.value === '.5')) {
        emitExpr(expr.left, t);
        if (t === 'f64') bw.byte(OP_F64_SQRT);
        else if (t === 'f32') bw.byte(OP_F32_SQRT);
        return;
      }
      // General: call pow import (works for all cases including **2, **3)
      emitExpr(expr.left, 'f64');
      emitExpr(expr.right, 'f64');
      bw.byte(OP_CALL);
      bw.u32(funcIndex['pow']);
      // Convert result back if needed
      if (t === 'f32') bw.byte(OP_F32_DEMOTE_F64);
    }

    function emitFuncCall(expr, expectedType) {
      const name = expr.name;

      // Type conversions: i32(x), f64(x), etc.
      if (ATRA_TYPES.has(name)) {
        const fromType = inferExprType(expr.args[0]);
        const toType = name;
        emitExpr(expr.args[0], fromType);
        emitConversion(fromType, toType);
        return;
      }

      // Native builtins
      if (name === 'sqrt') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_SQRT); else bw.byte(OP_F64_SQRT); return; }
      if (name === 'abs') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_ABS); else bw.byte(OP_F64_ABS); return; }
      if (name === 'floor') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_FLOOR); else bw.byte(OP_F64_FLOOR); return; }
      if (name === 'ceil') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_CEIL); else bw.byte(OP_F64_CEIL); return; }
      if (name === 'trunc') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_TRUNC); else bw.byte(OP_F64_TRUNC); return; }
      if (name === 'nearest') { emitExpr(expr.args[0], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_NEAREST); else bw.byte(OP_F64_NEAREST); return; }
      if (name === 'min') { emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_MIN); else bw.byte(OP_F64_MIN); return; }
      if (name === 'max') { emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_MAX); else bw.byte(OP_F64_MAX); return; }
      if (name === 'copysign') { emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType); if (expectedType === 'f32') bw.byte(OP_F32_COPYSIGN); else bw.byte(OP_F64_COPYSIGN); return; }
      if (name === 'select') {
        // select(a, b, cond) — Wasm select picks a if cond!=0, b otherwise
        const t = expectedType || inferExprType(expr.args[0]);
        emitExpr(expr.args[0], t);
        emitExpr(expr.args[1], t);
        emitExpr(expr.args[2], 'i32');
        bw.byte(OP_SELECT);
        return;
      }
      if (name === 'clz') { emitExpr(expr.args[0], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_CLZ); else bw.byte(OP_I32_CLZ); return; }
      if (name === 'ctz') { emitExpr(expr.args[0], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_CTZ); else bw.byte(OP_I32_CTZ); return; }
      if (name === 'popcnt') { emitExpr(expr.args[0], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_POPCNT); else bw.byte(OP_I32_POPCNT); return; }
      if (name === 'rotl') { emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_ROTL); else bw.byte(OP_I32_ROTL); return; }
      if (name === 'rotr') { emitExpr(expr.args[0], expectedType); emitExpr(expr.args[1], expectedType); if (expectedType === 'i64') bw.byte(OP_I64_ROTR); else bw.byte(OP_I32_ROTR); return; }
      if (name === 'memory_size') { bw.byte(OP_MEMORY_SIZE); bw.u32(0); return; }
      if (name === 'memory_grow') { emitExpr(expr.args[0], 'i32'); bw.byte(OP_MEMORY_GROW); bw.u32(0); return; }

      // wasm.* escape hatch
      if (name.startsWith('wasm.')) {
        emitWasmBuiltin(name.slice(5), expr, expectedType);
        return;
      }

      // Regular function call
      const fIdx = funcIndex[name];
      if (fIdx === undefined) throw new Error(`Undefined function: ${name}`);
      for (let ai = 0; ai < expr.args.length; ai++) {
        const paramType = getParamType(name, ai);
        emitExpr(expr.args[ai], paramType);
      }
      bw.byte(OP_CALL);
      bw.u32(fIdx);
    }

    function emitWasmBuiltin(op, expr, expectedType) {
      const t = expectedType || 'i32';
      if (op === 'div_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_DIV_U : OP_I32_DIV_U); return; }
      if (op === 'rem_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_REM_U : OP_I32_REM_U); return; }
      if (op === 'shr_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_SHR_U : OP_I32_SHR_U); return; }
      if (op === 'lt_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_LT_U : OP_I32_LT_U); return; }
      if (op === 'gt_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_GT_U : OP_I32_GT_U); return; }
      if (op === 'le_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_LE_U : OP_I32_LE_U); return; }
      if (op === 'ge_u') { emitExpr(expr.args[0], t); emitExpr(expr.args[1], t); bw.byte(t === 'i64' ? OP_I64_GE_U : OP_I32_GE_U); return; }
      if (op === 'reinterpret_f64') { emitExpr(expr.args[0], 'f64'); bw.byte(OP_I64_REINTERPRET_F64); return; }
      if (op === 'reinterpret_f32') { emitExpr(expr.args[0], 'f32'); bw.byte(OP_I32_REINTERPRET_F32); return; }
      if (op === 'reinterpret_i64') { emitExpr(expr.args[0], 'i64'); bw.byte(OP_F64_REINTERPRET_I64); return; }
      if (op === 'reinterpret_i32') { emitExpr(expr.args[0], 'i32'); bw.byte(OP_F32_REINTERPRET_I32); return; }
      if (op === 'extend8_s') { emitExpr(expr.args[0], t); bw.byte(t === 'i64' ? OP_I64_EXTEND8_S : OP_I32_EXTEND8_S); return; }
      if (op === 'extend16_s') { emitExpr(expr.args[0], t); bw.byte(t === 'i64' ? OP_I64_EXTEND16_S : OP_I32_EXTEND16_S); return; }
      if (op === 'trunc_sat_s') {
        const fromType = inferExprType(expr.args[0]);
        emitExpr(expr.args[0], fromType);
        bw.byte(OP_FC_PREFIX);
        if (t === 'i32' && fromType === 'f32') bw.u32(OP_I32_TRUNC_SAT_F32_S);
        else if (t === 'i32' && fromType === 'f64') bw.u32(OP_I32_TRUNC_SAT_F64_S);
        else if (t === 'i64' && fromType === 'f32') bw.u32(OP_I64_TRUNC_SAT_F32_S);
        else if (t === 'i64' && fromType === 'f64') bw.u32(OP_I64_TRUNC_SAT_F64_S);
        return;
      }
      if (op === 'trunc_sat_u') {
        const fromType = inferExprType(expr.args[0]);
        emitExpr(expr.args[0], fromType);
        bw.byte(OP_FC_PREFIX);
        if (t === 'i32' && fromType === 'f32') bw.u32(OP_I32_TRUNC_SAT_F32_U);
        else if (t === 'i32' && fromType === 'f64') bw.u32(OP_I32_TRUNC_SAT_F64_U);
        else if (t === 'i64' && fromType === 'f32') bw.u32(OP_I64_TRUNC_SAT_F32_U);
        else if (t === 'i64' && fromType === 'f64') bw.u32(OP_I64_TRUNC_SAT_F64_U);
        return;
      }
      throw new Error(`Unknown wasm builtin: wasm.${op}`);
    }

    function emitConversion(from, to) {
      if (from === to) return;
      if (from === 'i32' && to === 'f64') bw.byte(OP_F64_CONVERT_I32_S);
      else if (from === 'i32' && to === 'f32') bw.byte(OP_F32_CONVERT_I32_S);
      else if (from === 'i32' && to === 'i64') bw.byte(OP_I64_EXTEND_I32_S);
      else if (from === 'i64' && to === 'i32') bw.byte(OP_I32_WRAP_I64);
      else if (from === 'i64' && to === 'f64') bw.byte(OP_F64_CONVERT_I64_S);
      else if (from === 'i64' && to === 'f32') bw.byte(OP_F32_CONVERT_I64_S);
      else if (from === 'f64' && to === 'i32') bw.byte(OP_I32_TRUNC_F64_S);
      else if (from === 'f64' && to === 'i64') bw.byte(OP_I64_TRUNC_F64_S);
      else if (from === 'f64' && to === 'f32') bw.byte(OP_F32_DEMOTE_F64);
      else if (from === 'f32' && to === 'f64') bw.byte(OP_F64_PROMOTE_F32);
      else if (from === 'f32' && to === 'i32') bw.byte(OP_I32_TRUNC_F32_S);
      else if (from === 'f32' && to === 'i64') bw.byte(OP_I64_TRUNC_F32_S);
      else throw new Error(`Cannot convert ${from} to ${to}`);
    }

    function emitArrayAddr(name, indices, info, elemType) {
      // Base pointer
      bw.byte(OP_LOCAL_GET);
      bw.u32(info.idx);

      const sz = typeSize(elemType);

      if (indices.length === 1) {
        // 1D: base + i * sizeof
        emitExpr(indices[0], 'i32');
        bw.byte(OP_I32_CONST); bw.s32(sz);
        bw.byte(OP_I32_MUL);
        bw.byte(OP_I32_ADD);
      } else if (indices.length === 3 && !info.arrayDims) {
        // 2D with explicit stride: a[i, stride, j] → base + (i*stride + j) * sizeof
        emitExpr(indices[0], 'i32');
        emitExpr(indices[1], 'i32');
        bw.byte(OP_I32_MUL);
        emitExpr(indices[2], 'i32');
        bw.byte(OP_I32_ADD);
        bw.byte(OP_I32_CONST); bw.s32(sz);
        bw.byte(OP_I32_MUL);
        bw.byte(OP_I32_ADD);
      } else if (indices.length === 2 && info.arrayDims && info.arrayDims.length === 2) {
        // 2D with declared dims: a[i, j] → base + (i*dim1 + j) * sizeof
        emitExpr(indices[0], 'i32');
        emitExpr(info.arrayDims[1], 'i32');
        bw.byte(OP_I32_MUL);
        emitExpr(indices[1], 'i32');
        bw.byte(OP_I32_ADD);
        bw.byte(OP_I32_CONST); bw.s32(sz);
        bw.byte(OP_I32_MUL);
        bw.byte(OP_I32_ADD);
      } else {
        throw new Error(`Unsupported array index pattern for ${name}`);
      }
    }

    function emitLoad(t) {
      if (t === 'i32') { bw.byte(OP_I32_LOAD); bw.u32(2); bw.u32(0); } // align=4
      else if (t === 'i64') { bw.byte(OP_I64_LOAD); bw.u32(3); bw.u32(0); }
      else if (t === 'f32') { bw.byte(OP_F32_LOAD); bw.u32(2); bw.u32(0); }
      else if (t === 'f64') { bw.byte(OP_F64_LOAD); bw.u32(3); bw.u32(0); }
    }

    function emitStore(t) {
      if (t === 'i32') { bw.byte(OP_I32_STORE); bw.u32(2); bw.u32(0); }
      else if (t === 'i64') { bw.byte(OP_I64_STORE); bw.u32(3); bw.u32(0); }
      else if (t === 'f32') { bw.byte(OP_F32_STORE); bw.u32(2); bw.u32(0); }
      else if (t === 'f64') { bw.byte(OP_F64_STORE); bw.u32(3); bw.u32(0); }
    }

    function emitCmp(op, t) {
      if (t === 'f64') {
        if (op === '==') bw.byte(OP_F64_EQ);
        else if (op === '/=') bw.byte(OP_F64_NE);
        else if (op === '<') bw.byte(OP_F64_LT);
        else if (op === '>') bw.byte(OP_F64_GT);
        else if (op === '<=') bw.byte(OP_F64_LE);
        else if (op === '>=') bw.byte(OP_F64_GE);
      } else if (t === 'f32') {
        if (op === '==') bw.byte(OP_F32_EQ);
        else if (op === '/=') bw.byte(OP_F32_NE);
        else if (op === '<') bw.byte(OP_F32_LT);
        else if (op === '>') bw.byte(OP_F32_GT);
        else if (op === '<=') bw.byte(OP_F32_LE);
        else if (op === '>=') bw.byte(OP_F32_GE);
      } else if (t === 'i32') {
        if (op === '==') bw.byte(OP_I32_EQ);
        else if (op === '/=') bw.byte(OP_I32_NE);
        else if (op === '<') bw.byte(OP_I32_LT_S);
        else if (op === '>') bw.byte(OP_I32_GT_S);
        else if (op === '<=') bw.byte(OP_I32_LE_S);
        else if (op === '>=') bw.byte(OP_I32_GE_S);
      } else if (t === 'i64') {
        if (op === '==') bw.byte(OP_I64_EQ);
        else if (op === '/=') bw.byte(OP_I64_NE);
        else if (op === '<') bw.byte(OP_I64_LT_S);
        else if (op === '>') bw.byte(OP_I64_GT_S);
        else if (op === '<=') bw.byte(OP_I64_LE_S);
        else if (op === '>=') bw.byte(OP_I64_GE_S);
      }
    }

    function emitAdd(t) {
      if (t === 'f64') bw.byte(OP_F64_ADD);
      else if (t === 'f32') bw.byte(OP_F32_ADD);
      else if (t === 'i32') bw.byte(OP_I32_ADD);
      else if (t === 'i64') bw.byte(OP_I64_ADD);
    }

    function emitSub(t) {
      if (t === 'f64') bw.byte(OP_F64_SUB);
      else if (t === 'f32') bw.byte(OP_F32_SUB);
      else if (t === 'i32') bw.byte(OP_I32_SUB);
      else if (t === 'i64') bw.byte(OP_I64_SUB);
    }

    function emitMul(t) {
      if (t === 'f64') bw.byte(OP_F64_MUL);
      else if (t === 'f32') bw.byte(OP_F32_MUL);
      else if (t === 'i32') bw.byte(OP_I32_MUL);
      else if (t === 'i64') bw.byte(OP_I64_MUL);
    }

    function emitDiv(t) {
      if (t === 'f64') bw.byte(OP_F64_DIV);
      else if (t === 'f32') bw.byte(OP_F32_DIV);
      else if (t === 'i32') bw.byte(OP_I32_DIV_S);
      else if (t === 'i64') bw.byte(OP_I64_DIV_S);
    }

    // ── Emit function body statements ──
    emitStmts(fn.body);

    // ── End of function body: return value ──
    if (isFunc) {
      bw.byte(OP_LOCAL_GET);
      bw.u32(localMap['$_return'].idx);
    }
    bw.byte(OP_END);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. TAGGED TEMPLATE GLUE + SELF-REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

function compileSource(source, interpValues, userImports) {
  const tokens = lex(source);
  const ast = parse(tokens);
  return codegen(ast, interpValues, userImports);
}

function instantiate(bytes, userImports, interpValues) {
  const importObj = { math: {} };

  // Math builtins
  importObj.math.sin = Math.sin;
  importObj.math.cos = Math.cos;
  importObj.math.ln = Math.log;
  importObj.math.exp = Math.exp;
  importObj.math.pow = Math.pow;
  importObj.math.atan2 = Math.atan2;

  // Host imports (from userImports or globalThis)
  importObj.host = {};
  if (userImports) {
    for (const [k, v] of Object.entries(userImports)) {
      if (k === '__memory' || k === 'memory') continue;
      if (typeof v === 'function') importObj.host[k] = v;
    }
  }

  // Interpolated imports
  if (interpValues) {
    for (let i = 0; i < interpValues.length; i++) {
      const v = interpValues[i];
      if (typeof v === 'function') {
        importObj.host['__INTERP_' + i + '__'] = v;
      }
    }
  }

  // Memory
  if (userImports && userImports.__memory) {
    if (!importObj.env) importObj.env = {};
    importObj.env.memory = userImports.__memory;
  }

  const mod = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(mod, importObj);
  return instance;
}

export function atra(stringsOrOpts, ...values) {
  // Curried form: atra({imports})`...`
  if (stringsOrOpts && !Array.isArray(stringsOrOpts) && typeof stringsOrOpts === 'object' && !stringsOrOpts.raw) {
    const opts = stringsOrOpts;
    return function(strings, ...vals) {
      return compileAndInstantiate(strings, vals, opts);
    };
  }
  // Direct form: atra`...`
  return compileAndInstantiate(stringsOrOpts, values, null);
}

function compileAndInstantiate(strings, values, userImports) {
  // Normalize: user passes { memory } but internal code uses __memory
  if (userImports && userImports.memory && !userImports.__memory) {
    userImports = Object.assign({}, userImports, { __memory: userImports.memory });
  }
  // Join template strings with interpolation markers
  let source = strings[0];
  for (let i = 0; i < values.length; i++) {
    // For numeric values, inline them directly
    if (typeof values[i] === 'number') {
      source += String(values[i]);
    } else {
      source += '__INTERP_' + i + '__';
    }
    source += strings[i + 1];
  }

  const bytes = compileSource(source, values, userImports);
  const instance = instantiate(bytes, userImports, values);
  return instance.exports;
}

// Direct compiler access
atra.compile = function(source) {
  return compileSource(source, null, null);
};

atra.parse = function(source) {
  const tokens = lex(source);
  return parse(tokens);
};

atra.dump = function(source) {
  const bytes = compileSource(source, null, null);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
};

// ── Self-registration ──

if (typeof window !== 'undefined') {
  if (!window._taggedLanguages) window._taggedLanguages = {};
  window._taggedLanguages.atra = { tokenize: tokenizeAtra, completions: atraCompletions };
}

// Attach internals for testing / advanced use
atra._lex = lex;
atra._parse = parse;
atra._tokenize = tokenizeAtra;
