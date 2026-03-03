// @auditable/calque — spreadsheet language
// Minimal array-oriented language that compiles to xlsx.

// -- highlight.js --

// Syntax highlighting — tokenizer + completions for auditable editor integration
//
// These keyword/builtin sets define calque's vocabulary. Shared between
// this module (editor highlighting + completions) and lex.js (compiler tokenizer).

const CALQUE_KEYWORDS = new Set([
  'if', 'then', 'else', 'and', 'or', 'not',
  'true', 'false', 'null', 'import', 'sheet',
]);

const CALQUE_BUILTINS = new Set([
  'sum', 'mean', 'count', 'min', 'max',
  'lookup', 'sort', 'unique',
  'scan', 'rolling',
  'left', 'right', 'mid', 'len', 'trim', 'text', 'str',
  'date', 'year', 'month', 'day', 'today',
  'iferror', 'ifna',
  'round', 'abs', 'floor', 'ceil', 'sqrt', 'log', 'exp', 'mod',
]);

function tokenizeCalque(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    // line comment: -- to end of line
    if (code[i] === '-' && code[i + 1] === '-') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // template string
    if (code[i] === '`') {
      const start = i;
      i++; // skip opening backtick
      while (i < len && code[i] !== '`') {
        if (code[i] === '$' && code[i + 1] === '{') {
          // push text before interpolation
          if (i > start + 1) {
            const seg = code.slice(start, i);
            tokens.push({ type: 'str', text: seg });
          }
          tokens.push({ type: 'punc', text: '${' });
          i += 2;
          // tokenize inside interpolation until matching }
          let depth = 1;
          const exprStart = i;
          while (i < len && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) break; }
            i++;
          }
          // tokenize the inner expression
          const inner = code.slice(exprStart, i);
          const innerTokens = tokenizeCalque(inner);
          tokens.push(...innerTokens);
          tokens.push({ type: 'punc', text: '}' });
          if (i < len) i++; // skip closing }
          // restart string segment tracking - use a pseudo-start
          continue;
        }
        if (code[i] === '\\') { i++; if (i < len) i++; }
        else i++;
      }
      if (i < len) i++; // skip closing backtick
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }
    // numbers
    if (/\d/.test(code[i]) || (code[i] === '.' && i + 1 < len && /\d/.test(code[i + 1]))) {
      const start = i;
      while (i < len && /\d/.test(code[i])) i++;
      if (code[i] === '.' && /\d/.test(code[i + 1] || '')) {
        i++;
        while (i < len && /\d/.test(code[i])) i++;
      }
      if (i < len && /[eE]/.test(code[i])) {
        i++;
        if (i < len && /[+-]/.test(code[i])) i++;
        while (i < len && /\d/.test(code[i])) i++;
      }
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }
    // string literal
    if (code[i] === '"') {
      const start = i;
      i++;
      while (i < len && code[i] !== '"') {
        if (code[i] === '\\') { i++; if (i < len) i++; }
        else i++;
      }
      if (i < len) i++;
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }
    // identifiers / keywords
    if (/[a-zA-Z_]/.test(code[i])) {
      const start = i;
      while (i < len && /[\w]/.test(code[i])) i++;
      const word = code.slice(start, i);
      if (CALQUE_KEYWORDS.has(word)) {
        tokens.push({ type: 'kw', text: word });
      } else if (CALQUE_BUILTINS.has(word)) {
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
      if (two === '..' || two === '->' || two === '==' || two === '/=' ||
          two === '!=' || two === '<=' || two === '>=') {
        tokens.push({ type: 'op', text: two });
        i += 2;
        continue;
      }
    }
    // single-char operators
    if ('+-*/^&<>='.includes(code[i])) {
      tokens.push({ type: 'op', text: code[i] });
      i++;
      continue;
    }
    // punctuation
    if ('()[]{},:'.includes(code[i])) {
      tokens.push({ type: 'punc', text: code[i] });
      i++;
      continue;
    }
    // dot (member access)
    if (code[i] === '.') {
      tokens.push({ type: 'punc', text: '.' });
      i++;
      continue;
    }
    // whitespace / other
    tokens.push({ type: '', text: code[i] });
    i++;
  }
  return tokens;
}

// ── Builtin signatures ──

const CALQUE_BUILTIN_SIGS = {
  sum:     { sig: 'sum(col)', desc: 'sum of column values' },
  mean:    { sig: 'mean(col)', desc: 'arithmetic mean' },
  count:   { sig: 'count(col)', desc: 'count non-blank values' },
  min:     { sig: 'min(col)', desc: 'minimum value' },
  max:     { sig: 'max(col)', desc: 'maximum value' },
  lookup:  { sig: 'lookup(needle, keys, values, nearest?)', desc: 'look up value by key' },
  sort:    { sig: 'sort(table, col, desc?)', desc: 'sort table by column' },
  unique:  { sig: 'unique(col)', desc: 'unique values' },
  scan:    { sig: 'scan(col, init, fn)', desc: 'cumulative scan with accumulator' },
  rolling: { sig: 'rolling(col, window, fn)', desc: 'windowed computation' },
  left:    { sig: 'left(str, n)', desc: 'first n characters' },
  right:   { sig: 'right(str, n)', desc: 'last n characters' },
  mid:     { sig: 'mid(str, start, n)', desc: 'substring from start' },
  len:     { sig: 'len(str)', desc: 'string length' },
  trim:    { sig: 'trim(str)', desc: 'remove leading/trailing whitespace' },
  text:    { sig: 'text(val, fmt)', desc: 'format value as string' },
  str:     { sig: 'str(val)', desc: 'convert to string' },
  date:    { sig: 'date(year, month, day)', desc: 'date serial number' },
  year:    { sig: 'year(date)', desc: 'year from date serial' },
  month:   { sig: 'month(date)', desc: 'month from date serial' },
  day:     { sig: 'day(date)', desc: 'day from date serial' },
  today:   { sig: 'today()', desc: 'current date serial number' },
  iferror: { sig: 'iferror(expr, fallback)', desc: 'fallback on error' },
  ifna:    { sig: 'ifna(expr, fallback)', desc: 'fallback on #N/A' },
  round:   { sig: 'round(val, digits?)', desc: 'round to digits' },
  abs:     { sig: 'abs(val)', desc: 'absolute value' },
  floor:   { sig: 'floor(val)', desc: 'round down' },
  ceil:    { sig: 'ceil(val)', desc: 'round up' },
  sqrt:    { sig: 'sqrt(val)', desc: 'square root' },
  log:     { sig: 'log(val, base?)', desc: 'logarithm (default base 10)' },
  exp:     { sig: 'exp(val)', desc: 'e^val' },
  mod:     { sig: 'mod(val, divisor)', desc: 'remainder' },
};

// ── User-defined name extraction ──

function extractCalqueNames(code) {
  const tokens = tokenizeCalque(code);
  const functions = [];
  const variables = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'id' && t.type !== 'fn') continue;
    const name = t.text;

    // look ahead past whitespace
    let j = i + 1;
    while (j < tokens.length && tokens[j].type === '') j++;

    // name(params) = expr → function
    if (j < tokens.length && tokens[j].text === '(') {
      // find matching )
      let k = j + 1, depth = 1;
      let paramText = '';
      while (k < tokens.length && depth > 0) {
        if (tokens[k].text === '(') depth++;
        else if (tokens[k].text === ')') { depth--; if (depth === 0) break; }
        paramText += tokens[k].text;
        k++;
      }
      // check for = after )
      let m = k + 1;
      while (m < tokens.length && tokens[m].type === '') m++;
      if (m < tokens.length && tokens[m].text === '=') {
        functions.push({ name, sig: `${name}(${paramText.trim()})`, desc: 'function' });
        i = m;
        continue;
      }
    }

    // name = expr → variable binding
    if (j < tokens.length && tokens[j].text === '=') {
      // make sure it's not ==
      if (j + 1 < tokens.length && tokens[j + 1].text === '=') continue;
      variables.push({ name, kind: 'binding' });
      i = j;
    }
  }

  return { functions, variables };
}

// ── Signature hints ──

function calqueSigHint(code, cursor) {
  const tokens = tokenizeCalque(code.slice(0, cursor));

  // compute token offsets
  const offsets = [];
  let pos = 0;
  for (const t of tokens) {
    offsets.push(pos);
    pos += t.text.length;
  }

  // scan backwards for unmatched (
  let depth = 0;
  let parenIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type === 'punc' || tokens[i].type === 'op') {
      if (tokens[i].text === ')') depth++;
      else if (tokens[i].text === '(') {
        if (depth === 0) { parenIdx = i; break; }
        depth--;
      }
    }
  }
  if (parenIdx < 0) return null;

  // find function name before the (
  let fnIdx = -1;
  for (let i = parenIdx - 1; i >= 0; i--) {
    if (tokens[i].type === '') continue;
    if (tokens[i].type === 'fn' || tokens[i].type === 'id') fnIdx = i;
    break;
  }
  if (fnIdx < 0) return null;

  const fnName = tokens[fnIdx].text;

  // look up signature
  let sig, desc;
  if (CALQUE_BUILTIN_SIGS[fnName]) {
    sig = CALQUE_BUILTIN_SIGS[fnName].sig;
    desc = CALQUE_BUILTIN_SIGS[fnName].desc;
  } else {
    const names = extractCalqueNames(code);
    const fn = names.functions.find(f => f.name === fnName);
    if (!fn) return null;
    sig = fn.sig;
    desc = fn.desc || '';
  }

  // count commas at depth 0 for paramIdx
  let paramIdx = 0;
  let d = 0;
  for (let i = parenIdx + 1; i < tokens.length; i++) {
    if (tokens[i].type === 'punc') {
      if (tokens[i].text === '(' || tokens[i].text === '[') d++;
      else if (tokens[i].text === ')' || tokens[i].text === ']') d--;
      else if (tokens[i].text === ',' && d === 0) paramIdx++;
    }
  }

  return { sig, desc, paramIdx, parenPos: offsets[parenIdx] };
}

// ── Completions ──

function calqueCompletions(code, cursor, prefix) {
  if (cursor === undefined) {
    const items = [];
    for (const w of CALQUE_KEYWORDS) items.push({ text: w, kind: 'kw' });
    for (const w of CALQUE_BUILTINS) items.push({ text: w, kind: 'fn' });
    return items;
  }

  const items = [];
  const { functions, variables } = extractCalqueNames(code);

  for (const w of CALQUE_KEYWORDS) items.push({ text: w, kind: 'kw' });
  for (const w of CALQUE_BUILTINS) items.push({ text: w, kind: 'fn' });
  for (const f of functions) items.push({ text: f.name, kind: 'fn' });
  for (const v of variables) items.push({ text: v.name, kind: 'var' });

  return items;
}

// -- lex.js --

// Lexer — structured tokenizer for the parser
//
// Calque uses -- for comments, .. for ranges, -> for lambdas.
// Significant newlines: emitted after tokens that can end a statement,
// suppressed after operators and inside bracket nesting.


const TOK = {
  NUM: 'num', STR: 'str', TMPL: 'tmpl', ID: 'id', KW: 'kw',
  OP: 'op', RANGE: 'range', PUNC: 'punc', NL: 'nl', EOF: 'eof',
};

// Tokens that can end a statement (NL emitted after these)
const STMT_ENDERS = new Set([TOK.NUM, TOK.STR, TOK.TMPL, TOK.ID, TOK.KW]);
const STMT_ENDER_PUNCS = new Set([')', ']', '}']);
// Keywords that end a statement
const STMT_ENDER_KWS = new Set(['true', 'false', 'null', 'else']);

function lex(source) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const len = source.length;
  let bracketDepth = 0;

  function adv() { if (source[i] === '\n') { line++; col = 1; } else { col++; } i++; }
  function peek() { return i < len ? source[i] : ''; }

  function shouldEmitNL() {
    if (bracketDepth > 0) return false;
    if (tokens.length === 0) return false;
    const last = tokens[tokens.length - 1];
    if (last.type === TOK.NL) return false;
    if (STMT_ENDERS.has(last.type)) {
      if (last.type === TOK.KW && !STMT_ENDER_KWS.has(last.value)) return false;
      return true;
    }
    if (last.type === TOK.PUNC && STMT_ENDER_PUNCS.has(last.value)) return true;
    return false;
  }

  while (i < len) {
    // whitespace (non-newline)
    if (source[i] === ' ' || source[i] === '\t' || source[i] === '\r') { adv(); continue; }

    // newline
    if (source[i] === '\n') {
      const nl = shouldEmitNL();
      adv();
      if (nl) tokens.push({ type: TOK.NL, value: '\\n', line: line - 1, col: 1 });
      continue;
    }

    // comment: -- to end of line
    if (source[i] === '-' && source[i + 1] === '-') {
      while (i < len && source[i] !== '\n') adv();
      continue;
    }

    const tl = line, tc = col;

    // template string: `text ${expr:fmt} text`
    if (source[i] === '`') {
      adv(); // skip opening backtick
      const parts = []; // (string | { expr, format? })[]
      let text = '';
      while (i < len && source[i] !== '`') {
        if (source[i] === '$' && source[i + 1] === '{') {
          adv(); adv(); // skip ${
          if (text) { parts.push(text); text = ''; }
          // collect expression (and optional :format) until }
          let expr = '';
          let format = null;
          let depth = 1;
          while (i < len && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') { depth--; if (depth === 0) break; }
            else if (source[i] === ':' && depth === 1 && format === null) {
              // everything after : is format spec
              format = '';
              adv();
              while (i < len && source[i] !== '}') {
                format += source[i];
                adv();
              }
              break;
            }
            expr += source[i];
            adv();
          }
          if (i < len) adv(); // skip }
          const part = { expr: expr.trim() };
          if (format !== null) part.format = format.trim();
          parts.push(part);
        } else if (source[i] === '\\') {
          adv();
          if (i < len) {
            const esc = source[i];
            if (esc === 'n') text += '\n';
            else if (esc === 't') text += '\t';
            else if (esc === '\\') text += '\\';
            else if (esc === '`') text += '`';
            else if (esc === '$') text += '$';
            else text += '\\' + esc;
            adv();
          }
        } else {
          text += source[i];
          adv();
        }
      }
      if (i < len) adv(); // skip closing backtick
      if (text) parts.push(text);
      tokens.push({ type: TOK.TMPL, value: parts, line: tl, col: tc });
      continue;
    }

    // number
    if (/\d/.test(source[i]) || (source[i] === '.' && i + 1 < len && /\d/.test(source[i + 1]))) {
      const start = i;
      while (i < len && /\d/.test(source[i])) adv();
      if (peek() === '.' && /\d/.test(source[i + 1] || '')) {
        // check it's not .. (range operator)
        if (source[i + 2] !== '.' || !/\d/.test(source[i + 1])) {
          adv(); // skip .
          while (i < len && /\d/.test(source[i])) adv();
        }
      }
      if (/[eE]/.test(peek())) {
        adv();
        if (/[+-]/.test(peek())) adv();
        while (i < len && /\d/.test(source[i])) adv();
      }
      const raw = source.slice(start, i);
      tokens.push({ type: TOK.NUM, value: Number(raw), raw, line: tl, col: tc });
      continue;
    }

    // string literal
    if (source[i] === '"') {
      adv();
      let str = '';
      while (i < len && source[i] !== '"') {
        if (source[i] === '\\') {
          adv();
          const esc = source[i];
          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else if (esc === '\\') str += '\\';
          else if (esc === '"') str += '"';
          else str += '\\' + esc;
          adv();
        } else {
          str += source[i];
          adv();
        }
      }
      if (i >= len) throw new SyntaxError(`Unterminated string at ${tl}:${tc}`);
      adv(); // skip closing quote
      tokens.push({ type: TOK.STR, value: str, line: tl, col: tc });
      continue;
    }

    // identifier / keyword
    if (/[a-zA-Z_]/.test(source[i])) {
      const start = i;
      while (i < len && /[\w]/.test(source[i])) adv();
      const val = source.slice(start, i);
      if (CALQUE_KEYWORDS.has(val)) {
        tokens.push({ type: TOK.KW, value: val, line: tl, col: tc });
      } else {
        tokens.push({ type: TOK.ID, value: val, line: tl, col: tc });
      }
      continue;
    }

    // multi-char operators
    if (source[i] === '.' && source[i + 1] === '.') {
      tokens.push({ type: TOK.RANGE, value: '..', line: tl, col: tc });
      adv(); adv();
      continue;
    }
    if (source[i] === '-' && source[i + 1] === '>') {
      tokens.push({ type: TOK.OP, value: '->', line: tl, col: tc });
      adv(); adv();
      continue;
    }
    if (source[i] === '=' && source[i + 1] === '=') {
      tokens.push({ type: TOK.OP, value: '==', line: tl, col: tc });
      adv(); adv();
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '=') {
      tokens.push({ type: TOK.OP, value: '/=', line: tl, col: tc });
      adv(); adv();
      continue;
    }
    if (source[i] === '!' && source[i + 1] === '=') {
      tokens.push({ type: TOK.OP, value: '!=', line: tl, col: tc });
      adv(); adv();
      continue;
    }
    if (source[i] === '<' && source[i + 1] === '=') {
      tokens.push({ type: TOK.OP, value: '<=', line: tl, col: tc });
      adv(); adv();
      continue;
    }
    if (source[i] === '>' && source[i + 1] === '=') {
      tokens.push({ type: TOK.OP, value: '>=', line: tl, col: tc });
      adv(); adv();
      continue;
    }

    // single-char operators
    if ('+-*/^&<>='.includes(source[i])) {
      tokens.push({ type: TOK.OP, value: source[i], line: tl, col: tc });
      adv();
      continue;
    }

    // punctuation (track bracket depth for NL suppression)
    if ('()[]{},:'.includes(source[i])) {
      const ch = source[i];
      if (ch === '(' || ch === '[' || ch === '{') bracketDepth++;
      if (ch === ')' || ch === ']' || ch === '}') bracketDepth = Math.max(0, bracketDepth - 1);
      tokens.push({ type: TOK.PUNC, value: ch, line: tl, col: tc });
      adv();
      continue;
    }

    // dot (member access)
    if (source[i] === '.') {
      tokens.push({ type: TOK.PUNC, value: '.', line: tl, col: tc });
      adv();
      continue;
    }

    // skip unknown
    adv();
  }

  // trailing NL
  if (shouldEmitNL()) tokens.push({ type: TOK.NL, value: '\\n', line, col });
  tokens.push({ type: TOK.EOF, value: '', line, col });
  return tokens;
}

// -- parse.js --

// Parser — recursive descent + Pratt precedence
//
// Calque grammar:
//   program = (sheetBlock | funcDef | binding | import)*
//   sheetBlock = ID '{' (binding | funcDef)* '}'
//   binding = ID '=' expr
//   funcDef = ID '(' params ')' '=' expr
//   expr = Pratt-parsed expression


// ── Operator binding powers ──

const PREFIX_BP = { '-': 20, 'not': 20 };

const INFIX_BP = {
  'or':  [2, 3],
  'and': [4, 5],
  '==':  [8, 9], '/=': [8, 9], '!=': [8, 9],
  '<':   [8, 9], '>':  [8, 9], '<=': [8, 9], '>=': [8, 9],
  '&':   [10, 11],
  '+':   [14, 15], '-': [14, 15],
  '*':   [16, 17], '/': [16, 17],
  '^':   [19, 18], // right-assoc
};

const RANGE_BP = 12; // ..

// ── Parser state ──

function parse(tokens) {
  let pos = 0;

  function cur() { return tokens[pos]; }
  function at(type, value) {
    const t = tokens[pos];
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }
  function eat(type, value) {
    if (!at(type, value)) {
      const t = cur();
      const exp = value !== undefined ? `${type} '${value}'` : type;
      throw new SyntaxError(`Expected ${exp}, got ${t.type} '${t.value}' at ${t.line}:${t.col}`);
    }
    return tokens[pos++];
  }
  function tryEat(type, value) {
    if (at(type, value)) return tokens[pos++];
    return null;
  }
  function skipNL() { while (at(TOK.NL)) pos++; }

  // ── Top-level ──

  function parseProgram() {
    const body = [];
    skipNL();
    while (!at(TOK.EOF)) {
      body.push(parseTopLevel());
      skipNL();
    }
    return { type: 'Program', body };
  }

  function parseTopLevel() {
    // import binding: name = import "path"
    // sheet block: Name { ... }
    // funcDef: name(params) = expr
    // binding: name = expr

    if (!at(TOK.ID)) {
      throw new SyntaxError(`Expected identifier at top level, got ${cur().type} '${cur().value}' at ${cur().line}:${cur().col}`);
    }

    const name = cur().value;
    const nameTok = cur();

    // Look ahead to determine what this is
    const saved = pos;

    // Sheet block: ID { ... }
    pos++;
    skipNL();
    if (at(TOK.PUNC, '{')) {
      return parseSheetBlock(name);
    }

    // FuncDef: name(params) = expr
    if (at(TOK.PUNC, '(')) {
      const result = tryParseFuncDef(name, nameTok);
      if (result) return result;
    }

    // Binding: name = expr
    pos = saved + 1;
    skipNL();
    eat(TOK.OP, '=');
    skipNL();
    const expr = parseExpr(0);
    const exported = !name.startsWith('_');
    return { type: 'Binding', name, expr, exported, line: nameTok.line, col: nameTok.col };
  }

  function parseSheetBlock(name) {
    eat(TOK.PUNC, '{');
    skipNL();
    const body = [];
    while (!at(TOK.PUNC, '}') && !at(TOK.EOF)) {
      if (!at(TOK.ID)) {
        throw new SyntaxError(`Expected identifier in sheet block, got ${cur().type} '${cur().value}' at ${cur().line}:${cur().col}`);
      }
      const bindName = cur().value;
      const bindTok = cur();
      pos++;
      skipNL();

      // funcDef inside sheet block
      if (at(TOK.PUNC, '(')) {
        const result = tryParseFuncDef(bindName, bindTok);
        if (result) { body.push(result); skipNL(); continue; }
      }

      eat(TOK.OP, '=');
      skipNL();
      const expr = parseExpr(0);
      const exported = !bindName.startsWith('_');
      body.push({ type: 'Binding', name: bindName, expr, exported, line: bindTok.line, col: bindTok.col });
      skipNL();
    }
    eat(TOK.PUNC, '}');
    return { type: 'SheetBlock', name, body };
  }

  function tryParseFuncDef(name, nameTok) {
    // Try to parse name(params) = expr
    // Save position for backtracking
    const saved = pos;
    pos++; // skip (
    skipNL();

    // Try parsing parameter list: comma-separated IDs
    const params = [];
    if (!at(TOK.PUNC, ')')) {
      if (!at(TOK.ID)) { pos = saved; return null; }
      params.push(eat(TOK.ID).value);
      while (tryEat(TOK.PUNC, ',')) {
        skipNL();
        if (!at(TOK.ID)) { pos = saved; return null; }
        params.push(eat(TOK.ID).value);
      }
    }
    skipNL();
    if (!at(TOK.PUNC, ')')) { pos = saved; return null; }
    pos++; // skip )
    skipNL();
    if (!at(TOK.OP, '=')) { pos = saved; return null; }
    pos++; // skip =
    skipNL();
    const body = parseExpr(0);
    return { type: 'FuncDef', name, params, body, line: nameTok.line, col: nameTok.col };
  }

  // ── Expressions (Pratt) ──

  function parseExpr(minBP) {
    let left = parsePrefix();

    while (true) {
      skipNL();
      if (at(TOK.EOF) || at(TOK.NL)) break;

      // Range operator (..)
      if (at(TOK.RANGE)) {
        if (RANGE_BP < minBP) break;
        pos++;
        skipNL();
        const right = parseExpr(RANGE_BP + 1);
        left = { type: 'Range', start: left, end: right };
        continue;
      }

      // Infix operator (including keyword ops: and, or)
      const opVal = at(TOK.OP) ? cur().value :
                    (at(TOK.KW) && (cur().value === 'and' || cur().value === 'or')) ? cur().value : null;
      if (opVal && INFIX_BP[opVal]) {
        const [lbp, rbp] = INFIX_BP[opVal];
        if (lbp < minBP) break;
        pos++;
        skipNL();
        const right = parseExpr(rbp);
        left = { type: 'BinOp', op: opVal, left, right };
        continue;
      }

      // Postfix: member access (.field)
      if (at(TOK.PUNC, '.')) {
        pos++;
        const field = eat(TOK.ID).value;
        left = { type: 'MemberAccess', object: left, field };
        continue;
      }

      // Postfix: function call (expr(...))
      if (at(TOK.PUNC, '(') && left.type === 'Ident') {
        left = parseFuncCall(left.name);
        continue;
      }

      // Postfix: subscript (expr[...])
      if (at(TOK.PUNC, '[')) {
        pos++;
        skipNL();
        const index = parseExpr(0);
        skipNL();
        eat(TOK.PUNC, ']');
        left = { type: 'Subscript', object: left, index };
        continue;
      }

      break;
    }

    return left;
  }

  function parsePrefix() {
    // Unary minus
    if (at(TOK.OP, '-')) {
      pos++;
      skipNL();
      const operand = parseExpr(PREFIX_BP['-']);
      return { type: 'UnaryOp', op: '-', operand };
    }

    // Unary not
    if (at(TOK.KW, 'not')) {
      pos++;
      skipNL();
      const operand = parseExpr(PREFIX_BP['not']);
      return { type: 'UnaryOp', op: 'not', operand };
    }

    // Grouped expression or lambda: (expr) or (params) -> expr
    if (at(TOK.PUNC, '(')) {
      return parseParenOrLambda();
    }

    // Array literal
    if (at(TOK.PUNC, '[')) {
      return parseArrayLit();
    }

    // Table literal or block
    if (at(TOK.PUNC, '{')) {
      return parseTableLit();
    }

    // If expression
    if (at(TOK.KW, 'if')) {
      return parseIfExpr();
    }

    // Import expression
    if (at(TOK.KW, 'import')) {
      return parseImport();
    }

    // Number literal
    if (at(TOK.NUM)) {
      const t = eat(TOK.NUM);
      return { type: 'NumberLit', value: t.value };
    }

    // String literal
    if (at(TOK.STR)) {
      const t = eat(TOK.STR);
      return { type: 'StringLit', value: t.value };
    }

    // Template string
    if (at(TOK.TMPL)) {
      const t = eat(TOK.TMPL);
      return { type: 'TemplateStr', parts: t.value };
    }

    // Boolean literals
    if (at(TOK.KW, 'true')) { pos++; return { type: 'BoolLit', value: true }; }
    if (at(TOK.KW, 'false')) { pos++; return { type: 'BoolLit', value: false }; }

    // Null literal
    if (at(TOK.KW, 'null')) { pos++; return { type: 'NullLit' }; }

    // Identifier
    if (at(TOK.ID)) {
      const t = eat(TOK.ID);
      return { type: 'Ident', name: t.value };
    }

    throw new SyntaxError(`Unexpected token ${cur().type} '${cur().value}' at ${cur().line}:${cur().col}`);
  }

  function parseParenOrLambda() {
    // Try lambda: (params) -> expr
    const saved = pos;
    pos++; // skip (
    skipNL();

    // Empty parens: () -> expr
    if (at(TOK.PUNC, ')')) {
      pos++; // skip )
      skipNL();
      if (at(TOK.OP, '->')) {
        pos++;
        skipNL();
        const body = parseExpr(0);
        return { type: 'Lambda', params: [], body };
      }
      // empty parens not followed by -> is an error
      pos = saved;
    } else {
      // Try comma-separated IDs
      const params = [];
      let isLambda = true;

      if (at(TOK.ID)) {
        params.push(cur().value);
        pos++;
        while (at(TOK.PUNC, ',')) {
          pos++;
          skipNL();
          if (!at(TOK.ID)) { isLambda = false; break; }
          params.push(cur().value);
          pos++;
        }
        skipNL();
        if (isLambda && at(TOK.PUNC, ')')) {
          pos++;
          skipNL();
          if (at(TOK.OP, '->')) {
            pos++;
            skipNL();
            const body = parseExpr(0);
            return { type: 'Lambda', params, body };
          }
        }
      }

      // Backtrack — it's a grouped expression
      pos = saved;
    }

    // Grouped expression
    pos++; // skip (
    skipNL();
    const expr = parseExpr(0);
    skipNL();
    eat(TOK.PUNC, ')');
    return expr;
  }

  function parseArrayLit() {
    eat(TOK.PUNC, '[');
    skipNL();
    const elements = [];
    if (!at(TOK.PUNC, ']')) {
      elements.push(parseExpr(0));
      while (tryEat(TOK.PUNC, ',')) {
        skipNL();
        if (at(TOK.PUNC, ']')) break; // trailing comma
        elements.push(parseExpr(0));
      }
    }
    skipNL();
    eat(TOK.PUNC, ']');
    return { type: 'ArrayLit', elements };
  }

  function parseTableLit() {
    eat(TOK.PUNC, '{');
    skipNL();
    const columns = [];
    while (!at(TOK.PUNC, '}') && !at(TOK.EOF)) {
      const name = eat(TOK.ID).value;
      eat(TOK.PUNC, ':');
      skipNL();
      const values = parseExpr(0);
      columns.push({ name, values });
      skipNL();
      tryEat(TOK.PUNC, ',');
      skipNL();
    }
    eat(TOK.PUNC, '}');
    return { type: 'TableLit', columns };
  }

  function parseIfExpr() {
    eat(TOK.KW, 'if');
    skipNL();
    const cond = parseExpr(0);
    skipNL();
    eat(TOK.KW, 'then');
    skipNL();
    const then = parseExpr(0);
    skipNL();
    eat(TOK.KW, 'else');
    skipNL();
    const els = parseExpr(0);
    return { type: 'IfExpr', cond, then, else: els };
  }

  function parseImport() {
    eat(TOK.KW, 'import');
    skipNL();
    const path = eat(TOK.STR).value;
    let sheetName = null;
    skipNL();
    if (at(TOK.KW, 'sheet')) {
      pos++;
      skipNL();
      sheetName = eat(TOK.STR).value;
    }
    return { type: 'Import', path, sheetName };
  }

  function parseFuncCall(name) {
    eat(TOK.PUNC, '(');
    skipNL();
    const args = [];
    const kwargs = [];
    if (!at(TOK.PUNC, ')')) {
      parseArg(args, kwargs);
      while (tryEat(TOK.PUNC, ',')) {
        skipNL();
        if (at(TOK.PUNC, ')')) break; // trailing comma
        parseArg(args, kwargs);
      }
    }
    skipNL();
    eat(TOK.PUNC, ')');
    return { type: 'FuncCall', name, args, kwargs };
  }

  function parseArg(args, kwargs) {
    skipNL();
    // Try name: value (keyword argument)
    if (at(TOK.ID)) {
      const saved = pos;
      const name = cur().value;
      pos++;
      if (at(TOK.PUNC, ':')) {
        pos++;
        skipNL();
        const value = parseExpr(0);
        kwargs.push({ name, value });
        return;
      }
      pos = saved;
    }
    args.push(parseExpr(0));
  }

  return parseProgram();
}

// -- stdlib.js --

// Standard library — runtime functions operating on calque values
//
// All functions have 1:1 xlsx formula equivalents.
// Operate on scalars, Float64Array columns, string[] columns, Uint8Array boolean columns.

function isColumn(v) {
  return v instanceof Float64Array || v instanceof Uint8Array || Array.isArray(v);
}

function columnLength(v) {
  if (v instanceof Float64Array || v instanceof Uint8Array) return v.length;
  if (Array.isArray(v)) return v.length;
  return 0;
}

function isTable(v) {
  return v && typeof v === 'object' && v.__table === true;
}

function isFunc(v) {
  return v && typeof v === 'object' && v.__func === true;
}

// ── Type coercion (Excel rules) ──

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return isNaN(n) ? NaN : n; // #VALUE! in Excel
  }
  return NaN;
}

function toString(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

// ── Broadcasting ──

function broadcast(op, a, b) {
  const aIsCol = isColumn(a);
  const bIsCol = isColumn(b);

  if (!aIsCol && !bIsCol) return op(a, b);

  if (aIsCol && bIsCol) {
    const len = a.length;
    if (b.length !== len) throw new Error(`Column length mismatch: ${len} vs ${b.length}`);
    const result = new Array(len);
    for (let i = 0; i < len; i++) result[i] = op(a[i], b[i]);
    return inferColumnType(result);
  }

  if (aIsCol) {
    const len = a.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) result[i] = op(a[i], b);
    return inferColumnType(result);
  }

  // bIsCol
  const len = b.length;
  const result = new Array(len);
  for (let i = 0; i < len; i++) result[i] = op(a, b[i]);
  return inferColumnType(result);
}

function broadcastUnary(op, a) {
  if (!isColumn(a)) return op(a);
  const len = a.length;
  const result = new Array(len);
  for (let i = 0; i < len; i++) result[i] = op(a[i]);
  return inferColumnType(result);
}

function inferColumnType(arr) {
  if (arr.length === 0) return new Float64Array(0);
  const first = arr[0];
  if (typeof first === 'number') {
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i];
    return out;
  }
  if (typeof first === 'boolean' || first === 0 || first === 1) {
    // check if all are boolean-like
    let allBool = true;
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== 'boolean' && arr[i] !== 0 && arr[i] !== 1) { allBool = false; break; }
    }
    if (allBool) {
      const out = new Uint8Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = arr[i] ? 1 : 0;
      return out;
    }
  }
  if (typeof first === 'string') return arr;
  // mixed — return as-is
  return arr;
}

// ── Arithmetic operations ──

const ops = {
  '+':  (a, b) => toNumber(a) + toNumber(b),
  '-':  (a, b) => toNumber(a) - toNumber(b),
  '*':  (a, b) => toNumber(a) * toNumber(b),
  '/':  (a, b) => { const d = toNumber(b); return d === 0 ? NaN : toNumber(a) / d; }, // #DIV/0!
  '^':  (a, b) => Math.pow(toNumber(a), toNumber(b)),
  '&':  (a, b) => toString(a) + toString(b),
  '==': (a, b) => a === b,
  '/=': (a, b) => a !== b,
  '!=': (a, b) => a !== b,
  '<':  (a, b) => toNumber(a) < toNumber(b),
  '>':  (a, b) => toNumber(a) > toNumber(b),
  '<=': (a, b) => toNumber(a) <= toNumber(b),
  '>=': (a, b) => toNumber(a) >= toNumber(b),
  'and': (a, b) => !!(a && b),
  'or':  (a, b) => !!(a || b),
  'neg': (a) => -toNumber(a),
  'not': (a) => !a,
};

// ── Range ──

function makeRange(start, end) {
  const s = Math.round(toNumber(start));
  const e = Math.round(toNumber(end));
  const len = Math.max(0, e - s + 1);
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) out[i] = s + i;
  return out;
}

// ── Standard library functions ──

const stdlib = {};

// Reductions
stdlib.sum = function(col) {
  if (!isColumn(col)) return toNumber(col);
  let s = 0;
  for (let i = 0; i < col.length; i++) s += toNumber(col[i]);
  return s;
};

stdlib.mean = function(col) {
  if (!isColumn(col)) return toNumber(col);
  if (col.length === 0) return NaN;
  return stdlib.sum(col) / col.length;
};

stdlib.count = function(col) {
  if (!isColumn(col)) return col === null || col === undefined ? 0 : 1;
  let c = 0;
  for (let i = 0; i < col.length; i++) {
    if (col[i] !== null && col[i] !== undefined) c++;
  }
  return c;
};

stdlib.min = function(col) {
  if (!isColumn(col)) return toNumber(col);
  if (col.length === 0) return Infinity;
  let m = Infinity;
  for (let i = 0; i < col.length; i++) {
    const v = toNumber(col[i]);
    if (v < m) m = v;
  }
  return m;
};

stdlib.max = function(col) {
  if (!isColumn(col)) return toNumber(col);
  if (col.length === 0) return -Infinity;
  let m = -Infinity;
  for (let i = 0; i < col.length; i++) {
    const v = toNumber(col[i]);
    if (v > m) m = v;
  }
  return m;
};

// Lookup
stdlib.lookup = function(needle, keys, values, opts) {
  if (!isColumn(keys)) throw new Error('lookup: keys must be a column');
  if (!isColumn(values)) throw new Error('lookup: values must be a column');

  const nearestMode = opts && opts.nearest;

  if (isColumn(needle)) {
    // vectorized lookup
    const result = new Array(needle.length);
    for (let i = 0; i < needle.length; i++) {
      result[i] = lookupOne(needle[i], keys, values, nearestMode);
    }
    return inferColumnType(result);
  }

  return lookupOne(needle, keys, values, nearestMode);
};

function lookupOne(needle, keys, values, nearestMode) {
  if (nearestMode === 'below') {
    // find largest key <= needle
    let bestIdx = -1, bestVal = -Infinity;
    for (let i = 0; i < keys.length; i++) {
      const k = toNumber(keys[i]);
      if (k <= toNumber(needle) && k > bestVal) { bestVal = k; bestIdx = i; }
    }
    return bestIdx >= 0 ? values[bestIdx] : null; // #N/A
  }
  // exact match
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === needle) return values[i];
  }
  return null; // #N/A
}

// Sort
stdlib.sort = function(table, col, opts) {
  if (isTable(table)) {
    const desc = opts && (opts.desc === true || opts === true);
    // sort table by column
    const indices = Array.from({ length: table.rows }, (_, i) => i);
    indices.sort((a, b) => {
      const va = col[a], vb = col[b];
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : toNumber(va) - toNumber(vb);
      return desc ? -cmp : cmp;
    });
    const result = { __table: true, columns: {}, headers: [...table.headers], rows: table.rows };
    for (const h of table.headers) {
      const src = table.columns[h];
      if (src instanceof Float64Array) {
        const out = new Float64Array(table.rows);
        for (let i = 0; i < table.rows; i++) out[i] = src[indices[i]];
        result.columns[h] = out;
      } else {
        const out = new Array(table.rows);
        for (let i = 0; i < table.rows; i++) out[i] = src[indices[i]];
        result.columns[h] = out;
      }
    }
    return result;
  }
  // sort a column
  if (!isColumn(col)) col = table; // sort(col) short form
  const arr = Array.from(table);
  const desc = col === true || (opts && opts.desc === true);
  arr.sort((a, b) => {
    if (typeof a === 'string') return desc ? b.localeCompare(a) : a.localeCompare(b);
    return desc ? toNumber(b) - toNumber(a) : toNumber(a) - toNumber(b);
  });
  return inferColumnType(arr);
};

// Unique
stdlib.unique = function(col) {
  if (!isColumn(col)) return col;
  const seen = new Set();
  const result = [];
  for (let i = 0; i < col.length; i++) {
    if (!seen.has(col[i])) { seen.add(col[i]); result.push(col[i]); }
  }
  return inferColumnType(result);
};

// Scan
stdlib.scan = function(col, init, fn) {
  if (!isColumn(col)) throw new Error('scan: first argument must be a column');
  const result = new Array(col.length);
  let acc = init;
  for (let i = 0; i < col.length; i++) {
    if (isFunc(fn)) {
      acc = fn.__body(acc, col[i]);
    } else if (typeof fn === 'function') {
      acc = fn(acc, col[i]);
    } else {
      throw new Error('scan: third argument must be a function');
    }
    result[i] = acc;
  }
  return inferColumnType(result);
};

// Rolling
stdlib.rolling = function(col, window, fn) {
  if (!isColumn(col)) throw new Error('rolling: first argument must be a column');
  const w = Math.round(toNumber(window));
  const result = new Array(col.length);
  for (let i = 0; i < col.length; i++) {
    const start = Math.max(0, i - w + 1);
    const slice = col.slice(start, i + 1);
    if (isFunc(fn)) {
      result[i] = fn.__body(slice);
    } else if (typeof fn === 'function') {
      result[i] = fn(slice);
    } else if (typeof fn === 'string' && stdlib[fn]) {
      result[i] = stdlib[fn](slice);
    } else {
      throw new Error('rolling: third argument must be a function');
    }
  }
  return inferColumnType(result);
};

// String functions
stdlib.left = function(s, n) {
  n = Math.round(toNumber(n));
  return broadcast((s, _) => toString(s).slice(0, n), s, 0);
};

stdlib.right = function(s, n) {
  n = Math.round(toNumber(n));
  return broadcast((s, _) => { const str = toString(s); return str.slice(Math.max(0, str.length - n)); }, s, 0);
};

stdlib.mid = function(s, start, n) {
  start = Math.round(toNumber(start));
  n = Math.round(toNumber(n));
  // Excel MID is 1-indexed
  return broadcastUnary(v => toString(v).slice(start - 1, start - 1 + n), s);
};

stdlib.len = function(s) {
  return broadcastUnary(v => toString(v).length, s);
};

stdlib.trim = function(s) {
  return broadcastUnary(v => toString(v).trim(), s);
};

stdlib.text = function(val, fmt) {
  // Simple formatting - full Excel format codes would be Phase 2
  return broadcastUnary(v => {
    if (typeof fmt === 'string' && fmt.includes('#')) {
      // numeric format: count decimal places from format
      const decMatch = fmt.match(/\.(0+|#+)/);
      const decimals = decMatch ? decMatch[1].length : 0;
      return toNumber(v).toFixed(decimals);
    }
    return toString(v);
  }, val);
};

stdlib.str = function(val) {
  return broadcastUnary(v => toString(v), val);
};

// Date functions (Excel serial number system)
// Excel epoch: 1899-12-30 (with 1900 leap year bug). Use UTC to avoid DST issues.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86400000;

function dateToSerial(y, m, d) {
  const ms = Date.UTC(y, m - 1, d) - EXCEL_EPOCH;
  let serial = Math.floor(ms / MS_PER_DAY);
  // 1900 leap year bug: Excel thinks Feb 29, 1900 exists (serial 60)
  if (serial >= 60) serial++;
  return serial;
}

function serialToDate(serial) {
  if (serial >= 61) serial--; // undo 1900 leap year bug
  return new Date(EXCEL_EPOCH + serial * MS_PER_DAY);
}

stdlib.date = function(y, m, d) {
  return dateToSerial(toNumber(y), toNumber(m), toNumber(d));
};

stdlib.year = function(serial) {
  return broadcastUnary(v => serialToDate(toNumber(v)).getUTCFullYear(), serial);
};

stdlib.month = function(serial) {
  return broadcastUnary(v => serialToDate(toNumber(v)).getUTCMonth() + 1, serial);
};

stdlib.day = function(serial) {
  return broadcastUnary(v => serialToDate(toNumber(v)).getUTCDate(), serial);
};

stdlib.today = function() {
  const now = new Date();
  return dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
};

// Error functions
stdlib.iferror = function(expr, fallback) {
  if (isColumn(expr)) {
    const result = new Array(expr.length);
    for (let i = 0; i < expr.length; i++) {
      const v = expr[i];
      result[i] = (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) ?
        (isColumn(fallback) ? fallback[i] : fallback) : v;
    }
    return inferColumnType(result);
  }
  return (expr === null || expr === undefined || (typeof expr === 'number' && isNaN(expr))) ? fallback : expr;
};

stdlib.ifna = function(expr, fallback) {
  // In our runtime, #N/A is represented as null
  if (isColumn(expr)) {
    const result = new Array(expr.length);
    for (let i = 0; i < expr.length; i++) {
      result[i] = (expr[i] === null) ?
        (isColumn(fallback) ? fallback[i] : fallback) : expr[i];
    }
    return inferColumnType(result);
  }
  return expr === null ? fallback : expr;
};

// Math functions
stdlib.round = function(val, digits) {
  const d = digits !== undefined ? Math.round(toNumber(digits)) : 0;
  const factor = Math.pow(10, d);
  return broadcastUnary(v => Math.round(toNumber(v) * factor) / factor, val);
};

stdlib.abs = function(val) {
  return broadcastUnary(v => Math.abs(toNumber(v)), val);
};

stdlib.floor = function(val) {
  return broadcastUnary(v => Math.floor(toNumber(v)), val);
};

stdlib.ceil = function(val) {
  return broadcastUnary(v => Math.ceil(toNumber(v)), val);
};

stdlib.sqrt = function(val) {
  return broadcastUnary(v => Math.sqrt(toNumber(v)), val);
};

stdlib.log = function(val, base) {
  const b = base !== undefined ? toNumber(base) : 10;
  return broadcastUnary(v => Math.log(toNumber(v)) / Math.log(b), val);
};

stdlib.exp = function(val) {
  return broadcastUnary(v => Math.exp(toNumber(v)), val);
};

stdlib.mod = function(val, divisor) {
  return broadcast((a, b) => {
    const d = toNumber(b);
    return d === 0 ? NaN : toNumber(a) % d;
  }, val, divisor);
};

// -- eval.js --

// Evaluator — AST → typed array results
//
// Walks the AST produced by parse.js, evaluates expressions using
// stdlib functions and broadcasting. Produces a scope of bindings.




function evaluate(ast) {
  const globalScope = new Map();
  const sheets = new Map();
  const exports = new Map();

  for (const node of ast.body) {
    if (node.type === 'SheetBlock') {
      const sheetScope = new Map();
      for (const binding of node.body) {
        evalStatement(binding, sheetScope, globalScope);
      }
      // Build table from sheet bindings
      const table = buildSheetTable(sheetScope);
      globalScope.set(node.name, table);
      sheets.set(node.name, { scope: sheetScope, table });
      // Collect exports
      for (const binding of node.body) {
        if (binding.type === 'Binding' && binding.exported) {
          exports.set(node.name + '.' + binding.name, resolveInScope(binding.name, sheetScope, globalScope));
        }
      }
    } else {
      evalStatement(node, globalScope, null);
      if (node.type === 'Binding' && node.exported) {
        exports.set(node.name, globalScope.get(node.name));
      }
    }
  }

  return {
    bindings: Object.fromEntries(globalScope),
    exports: Object.fromEntries(exports),
    sheets: Object.fromEntries(sheets),
    scope: globalScope,
  };
}

function evalStatement(node, scope, parentScope) {
  if (node.type === 'Binding') {
    const value = evalExpr(node.expr, scope, parentScope);
    scope.set(node.name, value);
  } else if (node.type === 'FuncDef') {
    scope.set(node.name, {
      __func: true,
      params: node.params,
      body: node.body,
      closure: scope,
      parentScope: parentScope,
      __body: makeCallable(node.params, node.body, scope, parentScope),
    });
  }
}

function makeCallable(params, bodyAST, closure, parentScope) {
  return function(...args) {
    const callScope = new Map(closure);
    for (let i = 0; i < params.length; i++) {
      callScope.set(params[i], i < args.length ? args[i] : null);
    }
    return evalExpr(bodyAST, callScope, parentScope);
  };
}

function resolveInScope(name, scope, parentScope) {
  if (scope && scope.has(name)) return scope.get(name);
  if (parentScope && parentScope.has(name)) return parentScope.get(name);
  return undefined;
}

function buildSheetTable(scope) {
  const headers = [];
  const columns = {};
  let rows = 0;
  for (const [name, value] of scope) {
    if (isFunc(value)) continue; // skip function definitions
    headers.push(name);
    columns[name] = value;
    if (isColumn(value)) rows = Math.max(rows, value.length);
  }
  return { __table: true, columns, headers, rows };
}

function evalExpr(node, scope, parentScope) {
  switch (node.type) {
    case 'NumberLit': return node.value;
    case 'StringLit': return node.value;
    case 'BoolLit':   return node.value;
    case 'NullLit':   return null;

    case 'Ident': {
      const v = resolveInScope(node.name, scope, parentScope);
      if (v === undefined && stdlib[node.name]) return stdlib[node.name];
      if (v === undefined) throw new Error(`Undefined variable: ${node.name}`);
      return v;
    }

    case 'BinOp': {
      const left = evalExpr(node.left, scope, parentScope);
      const right = evalExpr(node.right, scope, parentScope);
      const op = ops[node.op];
      if (!op) throw new Error(`Unknown operator: ${node.op}`);
      return broadcast(op, left, right);
    }

    case 'UnaryOp': {
      const operand = evalExpr(node.operand, scope, parentScope);
      if (node.op === '-') return broadcastUnary(ops.neg, operand);
      if (node.op === 'not') return broadcastUnary(ops.not, operand);
      throw new Error(`Unknown unary operator: ${node.op}`);
    }

    case 'ArrayLit': {
      const elements = node.elements.map(e => evalExpr(e, scope, parentScope));
      // Determine array type from elements
      if (elements.length === 0) return new Float64Array(0);
      if (elements.every(e => typeof e === 'number')) {
        return Float64Array.from(elements);
      }
      if (elements.every(e => typeof e === 'string')) {
        return elements;
      }
      if (elements.every(e => typeof e === 'boolean')) {
        return Uint8Array.from(elements.map(e => e ? 1 : 0));
      }
      return elements;
    }

    case 'TableLit': {
      const columns = {};
      const headers = [];
      let rows = 0;
      for (const col of node.columns) {
        const value = evalExpr(col.values, scope, parentScope);
        columns[col.name] = value;
        headers.push(col.name);
        if (isColumn(value)) rows = Math.max(rows, value.length);
      }
      return { __table: true, columns, headers, rows };
    }

    case 'Range': {
      const start = evalExpr(node.start, scope, parentScope);
      const end = evalExpr(node.end, scope, parentScope);
      return makeRange(start, end);
    }

    case 'MemberAccess': {
      const obj = evalExpr(node.object, scope, parentScope);
      if (isTable(obj)) {
        if (obj.columns[node.field] !== undefined) return obj.columns[node.field];
        throw new Error(`Table has no column '${node.field}'`);
      }
      if (obj && typeof obj === 'object' && node.field in obj) return obj[node.field];
      throw new Error(`Cannot access '${node.field}' on ${typeof obj}`);
    }

    case 'Subscript': {
      const obj = evalExpr(node.object, scope, parentScope);
      const index = evalExpr(node.index, scope, parentScope);
      // Filter: col[boolCol]
      if (isColumn(obj) && isColumn(index)) {
        const result = [];
        for (let i = 0; i < obj.length; i++) {
          if (index[i]) result.push(obj[i]);
        }
        if (result.length === 0) return obj instanceof Float64Array ? new Float64Array(0) : [];
        if (obj instanceof Float64Array) return Float64Array.from(result);
        return result;
      }
      // Numeric index
      if (typeof index === 'number') {
        return obj[Math.round(index)];
      }
      throw new Error('Invalid subscript');
    }

    case 'FuncCall': {
      const fn = resolveInScope(node.name, scope, parentScope) || stdlib[node.name];
      if (!fn) throw new Error(`Undefined function: ${node.name}`);

      const args = node.args.map(a => evalExpr(a, scope, parentScope));

      // Build kwargs object if any
      let kwargsObj = null;
      if (node.kwargs.length > 0) {
        kwargsObj = {};
        for (const kw of node.kwargs) {
          kwargsObj[kw.name] = evalExpr(kw.value, scope, parentScope);
        }
      }

      // User-defined function
      if (isFunc(fn)) {
        return fn.__body(...args);
      }

      // Stdlib function — pass kwargs as last argument if present
      if (typeof fn === 'function') {
        if (kwargsObj) args.push(kwargsObj);
        return fn(...args);
      }

      throw new Error(`'${node.name}' is not callable`);
    }

    case 'Lambda': {
      return {
        __func: true,
        params: node.params,
        body: node.body,
        closure: scope,
        parentScope: parentScope,
        __body: makeCallable(node.params, node.body, scope, parentScope),
      };
    }

    case 'IfExpr': {
      const cond = evalExpr(node.cond, scope, parentScope);
      const then = evalExpr(node.then, scope, parentScope);
      const els = evalExpr(node.else, scope, parentScope);

      if (isColumn(cond)) {
        // Pointwise if
        const len = cond.length;
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
          const c = cond[i];
          const t = isColumn(then) ? then[i] : then;
          const e = isColumn(els) ? els[i] : els;
          result[i] = c ? t : e;
        }
        // infer type
        if (result.length > 0 && typeof result[0] === 'number') return Float64Array.from(result);
        return result;
      }

      return cond ? then : els;
    }

    case 'TemplateStr': {
      // Desugar: concatenate parts with & and text() for formatted expressions
      let result = '';
      let isColumnResult = false;
      let colLen = 0;

      // First pass: evaluate all parts and detect columns
      const evaluated = [];
      for (const part of node.parts) {
        if (typeof part === 'string') {
          evaluated.push(part);
        } else {
          // Parse and evaluate the expression
          const tokens = lex(part.expr);
          const exprAST = parse(tokens);
          // The parsed result is a Program; we want the first binding's expr or the first expression
          let val;
          if (exprAST.body.length === 1 && exprAST.body[0].type === 'Binding') {
            val = evalExpr(exprAST.body[0].expr, scope, parentScope);
          } else {
            // Try evaluating as expression — wrap in a binding for simplicity
            // Actually, a bare expression at top level would fail our parser.
            // Template expressions are simple, so re-parse as expression via a binding.
            const wrappedTokens = lex('_tmp = ' + part.expr);
            const wrappedAST = parse(wrappedTokens);
            val = evalExpr(wrappedAST.body[0].expr, scope, parentScope);
          }
          if (part.format) {
            val = stdlib.text(val, part.format);
          }
          if (isColumn(val)) { isColumnResult = true; colLen = val.length; }
          evaluated.push(val);
        }
      }

      if (!isColumnResult) {
        // All scalar
        return evaluated.map(v => typeof v === 'string' ? v : String(v == null ? '' : v)).join('');
      }

      // Broadcast to column
      const resultArr = new Array(colLen);
      for (let i = 0; i < colLen; i++) {
        let s = '';
        for (const v of evaluated) {
          if (typeof v === 'string') s += v;
          else if (isColumn(v)) s += String(v[i] == null ? '' : v[i]);
          else s += String(v == null ? '' : v);
        }
        resultArr[i] = s;
      }
      return resultArr;
    }

    case 'Import': {
      // Import is a runtime operation that would need file access
      // For Phase 1, return a placeholder
      throw new Error('import requires runtime file access (not available in evaluator)');
    }

    default:
      throw new Error(`Unknown AST node type: ${node.type}`);
  }
}

// -- api.js --

// Public API — tagged template, .run, .parse, .lex, self-registration
//
// Pipeline: source → lex → parse → evaluate → { bindings, exports, sheets, scope }






function calque(stringsOrSource, ...values) {
  // Tagged template: calque`source`
  if (Array.isArray(stringsOrSource) || (stringsOrSource && stringsOrSource.raw)) {
    let source = stringsOrSource[0];
    for (let i = 0; i < values.length; i++) {
      source += String(values[i]);
      source += stringsOrSource[i + 1];
    }
    return calque.run(source);
  }
  // Direct call: calque(source)
  if (typeof stringsOrSource === 'string') {
    return calque.run(stringsOrSource);
  }
  throw new Error('calque: expected string or tagged template');
}

calque.run = function(source) {
  const tokens = lex(source);
  const ast = parse(tokens);
  return evaluate(ast);
};

calque.parse = function(source) {
  const tokens = lex(source);
  return parse(tokens);
};

calque.lex = function(source) {
  return lex(source);
};

// Internals for testing
calque._lex = lex;
calque._parse = parse;
calque._evaluate = evaluate;
calque._tokenize = tokenizeCalque;
calque._stdlib = stdlib;

// ── Self-registration ──

if (typeof window !== 'undefined') {
  if (!window._taggedLanguages) window._taggedLanguages = {};
  window._taggedLanguages.calque = { tokenize: tokenizeCalque, completions: calqueCompletions, sigHint: calqueSigHint };
}

export { calque };
