// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/calque/src/  Build: node ext/calque/build.js
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
    // directive: @name
    if (code[i] === '@') {
      const start = i;
      i++;
      while (i < len && /[\w]/.test(code[i])) i++;
      tokens.push({ type: 'dir', text: code.slice(start, i) });
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

const CALQUE_DIRECTIVES = ['@below', '@right', '@anchor', '@formula'];

function calqueCompletions(code, cursor, prefix) {
  if (cursor === undefined) {
    const items = [];
    for (const w of CALQUE_KEYWORDS) items.push({ text: w, kind: 'kw' });
    for (const w of CALQUE_BUILTINS) items.push({ text: w, kind: 'fn' });
    for (const w of CALQUE_DIRECTIVES) items.push({ text: w, kind: 'dir' });
    return items;
  }

  const items = [];
  const { functions, variables } = extractCalqueNames(code);

  for (const w of CALQUE_KEYWORDS) items.push({ text: w, kind: 'kw' });
  for (const w of CALQUE_BUILTINS) items.push({ text: w, kind: 'fn' });
  for (const w of CALQUE_DIRECTIVES) items.push({ text: w, kind: 'dir' });
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
  DIR: 'dir',
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

    // directive: @name
    if (source[i] === '@') {
      adv();
      const ws = i;
      while (i < len && /[\w]/.test(source[i])) adv();
      if (i > ws) {
        tokens.push({ type: TOK.DIR, value: source.slice(ws, i), line: tl, col: tc });
      }
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

  function parseDirective() {
    const name = eat(TOK.DIR).value;
    let args = [], kwargs = [];
    if (at(TOK.PUNC, '(')) {
      pos++; skipNL();
      if (!at(TOK.PUNC, ')')) {
        parseArg(args, kwargs);
        while (tryEat(TOK.PUNC, ',')) { skipNL(); parseArg(args, kwargs); }
      }
      skipNL(); eat(TOK.PUNC, ')');
    }
    return { name, args, kwargs };
  }

  function parseTopLevel() {
    // collect directives before binding
    const directives = [];
    while (at(TOK.DIR)) {
      directives.push(parseDirective());
      skipNL();
    }

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
    const binding = { type: 'Binding', name, expr, exported, line: nameTok.line, col: nameTok.col };
    if (directives.length) binding.directives = directives;
    return binding;
  }

  function parseSheetBlock(name) {
    eat(TOK.PUNC, '{');
    skipNL();
    const body = [];
    while (!at(TOK.PUNC, '}') && !at(TOK.EOF)) {
      // collect directives before binding
      const directives = [];
      while (at(TOK.DIR)) {
        directives.push(parseDirective());
        skipNL();
      }

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
      const binding = { type: 'Binding', name: bindName, expr, exported, line: bindTok.line, col: bindTok.col };
      if (directives.length) binding.directives = directives;
      body.push(binding);
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

// ── Excel format code engine for text() ──

function splitFmtSections(fmt) {
  // Split on unquoted semicolons into up to 4 sections: positive;negative;zero;text
  const sections = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
    if (ch === ';' && !inQuote) { sections.push(cur); cur = ''; continue; }
    cur += ch;
  }
  sections.push(cur);
  return sections;
}

function isDateFmt(section) {
  // Strip quoted strings, then check for date tokens
  const stripped = section.replace(/"[^"]*"/g, '');
  return /\b(yyyy|yy|mmmm|mmm|dd|hh|ss)\b/i.test(stripped) ||
         /\bmm\b/i.test(stripped);
}

function fmtDate(serial, section) {
  const d = serialToDate(Math.floor(serial));
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, day = d.getUTCDate();
  // Time from fractional part
  const frac = serial - Math.floor(serial);
  const totalSecs = Math.round(frac * 86400);
  const hh = Math.floor(totalSecs / 3600);
  const mm = Math.floor((totalSecs % 3600) / 60);
  const ss = totalSecs % 60;
  const pad = (n) => n < 10 ? '0' + n : '' + n;

  // Strip quotes, replace tokens largest-first to avoid partial matches
  let out = section;
  // Handle quoted literals — preserve them as markers then restore
  const literals = [];
  out = out.replace(/"([^"]*)"/g, (_, lit) => { literals.push(lit); return '\x00' + (literals.length - 1) + '\x00'; });

  out = out.replace(/yyyy/gi, '' + y);
  out = out.replace(/yy/gi, pad(y % 100));
  out = out.replace(/mmmm/gi, ['January','February','March','April','May','June','July','August','September','October','November','December'][mo - 1]);
  out = out.replace(/mmm/gi, ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1]);
  out = out.replace(/mm/gi, pad(mo));
  out = out.replace(/dd/gi, pad(day));
  out = out.replace(/hh/gi, pad(hh));
  out = out.replace(/ss/gi, pad(ss));

  // Restore quoted literals
  out = out.replace(/\x00(\d+)\x00/g, (_, i) => literals[+i]);
  return out;
}

function fmtNumber(v, section) {
  // Strip quoted literals, collect their positions for reassembly
  const literals = [];
  let work = section.replace(/"([^"]*)"/g, (_, lit) => { literals.push(lit); return '\x01'; });

  const hasPct = work.includes('%');
  if (hasPct) v *= 100;

  const hasComma = /[#0],/.test(work) || /,[#0]/.test(work);

  // Scientific notation
  const sciMatch = work.match(/[Ee][+\-](\d+)/);
  if (sciMatch) {
    const expDigits = sciMatch[1].length;
    const decMatch = work.match(/\.([#0]+)/);
    const decimals = decMatch ? decMatch[1].length : 0;
    let s = v.toExponential(decimals);
    // Pad exponent
    s = s.replace(/[eE]([+\-])(\d+)/, (_, sign, exp) => {
      return 'E' + sign + exp.padStart(expDigits, '0');
    });
    return s;
  }

  // Count decimal digits
  const decMatch = work.match(/\.([#0]+)/);
  const decimals = decMatch ? decMatch[1].length : 0;
  const decFmt = decMatch ? decMatch[1] : '';

  let abs = Math.abs(v);
  let fixed = abs.toFixed(decimals);

  // Split into integer and decimal parts
  let [intPart, decPart] = fixed.split('.');

  // Thousand separator
  if (hasComma) {
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Trim trailing zeros for '#' positions in decimal
  if (decPart && decFmt) {
    const chars = decPart.split('');
    for (let i = chars.length - 1; i >= 0; i--) {
      if (decFmt[i] === '#' && chars[i] === '0') chars[i] = '';
      else break;
    }
    decPart = chars.join('');
  }

  let result = decPart ? intPart + '.' + decPart : intPart;

  // Re-insert prefix/suffix literals from format
  // Extract the non-numeric chars before and after the number pattern
  const numPattern = /[#0.,]+(%)?/;
  const before = work.slice(0, work.search(numPattern)).replace(/\x01/g, () => literals.shift() || '');
  const afterStart = work.search(numPattern) + work.match(numPattern)[0].length;
  let after = work.slice(afterStart).replace(/\x01/g, () => literals.shift() || '');
  if (hasPct) after = after.replace('%', '') + '%';

  return before + result + after;
}

function formatExcel(v, fmt) {
  if (typeof fmt !== 'string') return toString(v);
  const sections = splitFmtSections(fmt);
  const num = toNumber(v);

  // Pick section based on value sign
  let section;
  if (sections.length >= 3 && num === 0) {
    section = sections[2] || sections[0];
  } else if (sections.length >= 2 && num < 0) {
    section = sections[1];
  } else {
    section = sections[0];
  }

  // For text section (4th), just substitute
  if (typeof v === 'string' && sections.length >= 4) {
    return sections[3].replace(/@/g, v);
  }

  if (isNaN(num)) return toString(v);

  if (isDateFmt(section)) return fmtDate(num, section);

  // For negative section, use absolute value (section handles the sign/formatting)
  const useVal = (sections.length >= 2 && num < 0) ? Math.abs(num) : num;
  return fmtNumber(useVal, section);
}

stdlib.text = function(val, fmt) {
  return broadcastUnary(v => formatExcel(v, fmt), val);
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




let _imports = {};

function evaluate(ast, opts) {
  const globalScope = new Map();
  const sheets = new Map();
  const exports = new Map();
  _imports = (opts && opts.imports) || {};

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

function resolveImport(data, sheetName) {
  // Already a calque table
  if (data && data.__table) return data;

  // Array of objects → convert to table
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
    const headers = Object.keys(data[0]);
    const columns = {};
    for (const h of headers) {
      const vals = data.map(r => r[h]);
      const allNum = vals.every(v => v === null || v === undefined || typeof v === 'number');
      columns[h] = allNum ? Float64Array.from(vals.map(v => v ?? NaN)) : vals;
    }
    const rows = data.length;
    return { __table: true, columns, headers, rows };
  }

  // Multi-sheet object: { SheetName: table/array, ... }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    const key = sheetName || keys[0];
    if (!key || !(key in data)) throw new Error(`import: sheet "${sheetName || '(default)'}" not found`);
    return resolveImport(data[key], null);
  }

  throw new Error('import: unsupported data format');
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
          // Wrap as binding since bare expressions fail the parser
          const wrappedTokens = lex('_tmp = ' + part.expr);
          const wrappedAST = parse(wrappedTokens);
          let val = evalExpr(wrappedAST.body[0].expr, scope, parentScope);
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
      const data = _imports[node.path];
      if (data === undefined) throw new Error(`import: no data provided for "${node.path}"`);
      return resolveImport(data, node.sheetName);
    }

    default:
      throw new Error(`Unknown AST node type: ${node.type}`);
  }
}

// -- layout.js --

// Layout engine — assign grid positions to bindings
//
// Input: AST + evalResult (from evaluate())
// Output: layout map — binding name → { col, row, rows, isColumn }
//
// Supports layout directives: @below(ref), @right(ref), @anchor(col, row)
// with optional gap: N kwarg on @below/@right.


function layout(ast, evalResult) {
  const sheets = {};
  const functions = [];

  // Collect bare bindings for Sheet1
  const bareBindings = [];

  for (const node of ast.body) {
    if (node.type === 'SheetBlock') {
      sheets[node.name] = layoutSheet(node.body, evalResult.sheets[node.name]);
    } else if (node.type === 'FuncDef') {
      functions.push({ name: node.name, params: node.params, body: node.body });
    } else if (node.type === 'Binding') {
      bareBindings.push(node);
    }
  }

  if (bareBindings.length > 0) {
    sheets['Sheet1'] = layoutBindings(bareBindings, (name) => evalResult.bindings[name]);
  }

  return { sheets, functions };
}

function layoutSheet(body, sheetData) {
  const nodes = body.filter(n => n.type === 'Binding');
  return layoutBindings(nodes, (name) => sheetData ? sheetData.scope.get(name) : undefined);
}

function layoutBindings(nodes, getVal) {
  const bindings = {};
  let maxRows = 0;
  let nextCol = 0;

  // Separate auto-placed and directive-placed bindings
  const autoNodes = [];
  const dirNodes = [];

  for (const node of nodes) {
    if (node.name.startsWith('_')) continue;
    const val = getVal(node.name);
    if (val !== undefined && isFunc(val)) continue;

    if (node.directives && node.directives.length > 0) {
      dirNodes.push(node);
    } else {
      autoNodes.push(node);
    }
  }

  // Pass 1: auto-place non-directive bindings sequentially
  for (const node of autoNodes) {
    const val = getVal(node.name);
    const isCol = val !== undefined && isColumn(val);
    const rows = isCol ? val.length : 1;
    bindings[node.name] = { col: nextCol, row: 1, rows, isColumn: isCol };
    if (rows > maxRows) maxRows = rows;
    nextCol++;
  }

  // Pass 2: resolve directive bindings
  for (const node of dirNodes) {
    const val = getVal(node.name);
    const isCol = val !== undefined && isColumn(val);
    const rows = isCol ? val.length : 1;

    const pos = resolveDirectives(node.directives, bindings, nextCol, node.name, isCol);
    const info = { col: pos.col, row: pos.row, rows, isColumn: isCol };
    if (pos.label !== undefined) info.label = pos.label;
    bindings[node.name] = info;
    if (pos.row + rows > maxRows + 1) maxRows = pos.row + rows - 1;
    // Don't increment nextCol — directive bindings use explicit positions
  }

  return { bindings, maxRows };
}

function resolveDirectives(directives, bindings, nextCol, name, isCol) {
  // Use the last positioning directive
  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];
    const gap = getGap(d);
    const label = getLabel(d, isCol);

    if (d.name === 'below') {
      if (d.args.length < 1 || d.args[0].type !== 'Ident') {
        throw new Error(`@below requires a binding reference in '${name}'`);
      }
      const refName = d.args[0].name;
      const ref = bindings[refName];
      if (!ref) throw new Error(`@below(${refName}): unknown binding '${refName}' in '${name}'`);
      // label "above" adds +1 for header row; "left"/false do not
      const headerOffset = label === 'above' ? 1 : 0;
      return { col: ref.col, row: ref.row + ref.rows + gap + headerOffset, label };
    }

    if (d.name === 'right') {
      if (d.args.length < 1 || d.args[0].type !== 'Ident') {
        throw new Error(`@right requires a binding reference in '${name}'`);
      }
      const refName = d.args[0].name;
      const ref = bindings[refName];
      if (!ref) throw new Error(`@right(${refName}): unknown binding '${refName}' in '${name}'`);
      return { col: ref.col + 1 + gap, row: ref.row };
    }

    if (d.name === 'anchor') {
      if (d.args.length < 2) {
        throw new Error(`@anchor requires (col, row) in '${name}'`);
      }
      const col = d.args[0].type === 'NumberLit' ? d.args[0].value : null;
      const row = d.args[1].type === 'NumberLit' ? d.args[1].value : null;
      if (col === null || row === null) {
        throw new Error(`@anchor requires numeric col and row in '${name}'`);
      }
      const anchorLabel = getLabel(d, isCol);
      // label false: data at exact row, no header offset
      // label "above" (default): header at row, data at row + 1
      // label "left": data at row + 1, header to the left
      const headerOffset = anchorLabel === false ? 0 : 1;
      return { col, row: row + headerOffset, label: anchorLabel };
    }

    if (d.name === 'formula') continue; // codegen-only, no layout effect
    throw new Error(`Unknown directive @${d.name} in '${name}'`);
  }

  // No positioning directive found — auto-place
  return { col: nextCol, row: 1 };
}

function getGap(directive) {
  if (!directive.kwargs) return 0;
  const gapKw = directive.kwargs.find(k => k.name === 'gap');
  if (!gapKw) return 0;
  if (gapKw.value.type === 'NumberLit') return gapKw.value.value;
  return 0;
}

function getLabel(directive, isCol) {
  if (!directive.kwargs) {
    // Default: @below + scalar → "left", else "above"
    return directive.name === 'below' && !isCol ? 'left' : 'above';
  }
  const labelKw = directive.kwargs.find(k => k.name === 'label');
  if (!labelKw) {
    return directive.name === 'below' && !isCol ? 'left' : 'above';
  }
  if (labelKw.value.type === 'BoolLit' && labelKw.value.value === false) return false;
  if (labelKw.value.type === 'StringLit') return labelKw.value.value;
  return 'above';
}

// -- codegen.js --

// Codegen — AST → xlsx formula strings + workbook assembly
//
// Walks AST nodes and emits xlsx formula strings. Produces a workbook
// structure that ext/sheet/ can write to an xlsx file.


// ── Helpers ──

function colLetter(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function escapeExcelString(s) {
  return '"' + s.replace(/"/g, '""') + '"';
}

// ── Function mapping ──

const FUNC_MAP = {
  sum: 'SUM', mean: 'AVERAGE', count: 'COUNTA', min: 'MIN', max: 'MAX',
  left: 'LEFT', right: 'RIGHT', mid: 'MID', len: 'LEN', trim: 'TRIM',
  text: 'TEXT', str: 'TEXT', date: 'DATE', year: 'YEAR', month: 'MONTH',
  day: 'DAY', today: 'TODAY', iferror: 'IFERROR', ifna: 'IFNA',
  round: 'ROUND', abs: 'ABS', floor: 'FLOOR.MATH', ceil: 'CEILING.MATH',
  sqrt: 'SQRT', log: 'LOG', exp: 'EXP', mod: 'MOD',
  scan: 'SCAN', sort: 'SORT', unique: 'UNIQUE', lookup: 'XLOOKUP',
};

// Reductions: their column args emit as ranges
const REDUCTIONS = new Set(['sum', 'mean', 'count', 'min', 'max']);

// Spilled: single formula produces dynamic array (only first cell gets formula)
const SPILLED = new Set(['scan', 'sort', 'unique']);

// Pointwise functions safe inside reductions (emit as range-applied)
const POINTWISE = new Set(['abs', 'round', 'floor', 'ceil', 'sqrt', 'log', 'exp', 'mod',
  'left', 'right', 'mid', 'len', 'trim', 'text', 'str', 'iferror', 'ifna']);

// Rolling ops: calque name → xlsx function
const ROLLING_OPS = { sum: 'SUM', mean: 'AVERAGE', count: 'COUNT', min: 'MIN', max: 'MAX' };

// Operator mapping calque → xlsx
const OP_MAP = { '==': '=', '/=': '<>', '!=': '<>' };

// ── Spilled formula detection ──

function isSpilledNode(node) {
  if (node.type === 'Subscript') return true;
  if (node.type === 'FuncCall' && SPILLED.has(node.name)) return true;
  return false;
}

// ── Baked pattern detection ──

function shouldBake(node, ctx) {
  if (node.type === 'ArrayLit') return 'array literal (data entry)';
  if (node.type === 'Range') return 'range expression (no xlsx equivalent)';
  if (node.type === 'FuncCall') {
    // rolling: emit formula only for string-named reductions (mean, sum, etc.)
    if (node.name === 'rolling') {
      if (node.args.length >= 3 && node.args[2].type === 'StringLit' && ROLLING_OPS[node.args[2].value]) {
        return null; // can emit
      }
      return 'rolling() with lambda (no clean formula)';
    }
    // Nested reduction: allow if inner is a known pointwise function, otherwise bake
    if (REDUCTIONS.has(node.name) && node.args.length > 0) {
      const arg = node.args[0];
      if (arg.type === 'FuncCall' && !POINTWISE.has(arg.name) && !REDUCTIONS.has(arg.name)) {
        return `nested reduction ${node.name}(${arg.name}()) (no formula pattern)`;
      }
    }
  }
  return null;
}

// ── Reference emission ──

function emitRef(name, ctx, asRange) {
  // Resolve binding → grid position
  const sheetName = ctx.currentSheet;
  let bindingSheet = sheetName;
  let bindingName = name;

  // Check cross-sheet: "Sheet.col" already split by caller via MemberAccess
  // Direct ident — look in current sheet first, then all sheets
  const layout = ctx.layout;
  let info = null;

  if (sheetName && layout.sheets[sheetName]) {
    info = layout.sheets[sheetName].bindings[bindingName];
  }
  if (!info) {
    // Search all sheets
    for (const [sn, sd] of Object.entries(layout.sheets)) {
      if (sd.bindings[bindingName]) {
        info = sd.bindings[bindingName];
        bindingSheet = sn;
        break;
      }
    }
  }

  if (!info) return null; // not a layout binding — will be baked

  const col = colLetter(info.col);
  const prefix = (bindingSheet !== sheetName && bindingSheet !== 'Sheet1') ?
    bindingSheet + '!' : '';

  if (asRange) {
    // Reduction range: column relative, rows absolute
    const startRow = info.row + 1; // 1-indexed xlsx
    const endRow = info.row + info.rows; // 1-indexed
    return `${prefix}${col}$${startRow}:${col}$${endRow}`;
  }

  if (!info.isColumn || info.rows === 1) {
    // Scalar → absolute reference
    const row = info.row + 1; // 1-indexed
    return `${prefix}$${col}$${row}`;
  }

  // Column → relative reference (row varies per cell)
  const row = ctx.row + info.row + 1; // 1-indexed
  return `${prefix}${col}${row}`;
}

function emitCrossSheetRef(sheetName, fieldName, ctx, asRange) {
  const layout = ctx.layout;
  const sd = layout.sheets[sheetName];
  if (!sd) return null;
  const info = sd.bindings[fieldName];
  if (!info) return null;

  const col = colLetter(info.col);
  const prefix = sheetName + '!';

  if (asRange) {
    const startRow = info.row + 1;
    const endRow = info.row + info.rows;
    return `${prefix}${col}$${startRow}:${col}$${endRow}`;
  }

  if (!info.isColumn || info.rows === 1) {
    const row = info.row + 1;
    return `${prefix}$${col}$${row}`;
  }

  const row = ctx.row + info.row + 1;
  return `${prefix}${col}${row}`;
}

// ── Binding info lookup ──

function resolveBindingInfo(name, ctx) {
  const layout = ctx.layout;
  if (ctx.currentSheet && layout.sheets[ctx.currentSheet]) {
    const info = layout.sheets[ctx.currentSheet].bindings[name];
    if (info) return info;
  }
  for (const sd of Object.values(layout.sheets)) {
    if (sd.bindings[name]) return sd.bindings[name];
  }
  return null;
}

// ── Formula emission ──

function emitFormula(node, ctx) {
  switch (node.type) {
    case 'NumberLit':
      return String(node.value);

    case 'StringLit':
      return escapeExcelString(node.value);

    case 'BoolLit':
      return node.value ? 'TRUE' : 'FALSE';

    case 'NullLit':
      return '""';

    case 'Ident': {
      // In LAMBDA context, params are bare names
      if (ctx.lambdaParams && ctx.lambdaParams.has(node.name)) {
        return node.name;
      }
      const ref = emitRef(node.name, ctx, ctx.inReduction);
      if (ref) return ref;
      // Not in layout — might be a stdlib function name used directly
      return null;
    }

    case 'BinOp': {
      const left = emitFormula(node.left, ctx);
      const right = emitFormula(node.right, ctx);
      if (left === null || right === null) return null;

      let op = OP_MAP[node.op] || node.op;

      if (op === 'and') return `AND(${left},${right})`;
      if (op === 'or') return `OR(${left},${right})`;

      return `${left}${op}${right}`;
    }

    case 'UnaryOp': {
      const operand = emitFormula(node.operand, ctx);
      if (operand === null) return null;
      if (node.op === '-') return `-${operand}`;
      if (node.op === 'not') return `NOT(${operand})`;
      return null;
    }

    case 'FuncCall': {
      // Check for baked patterns
      const bakeReason = shouldBake(node, ctx);
      if (bakeReason) return null;

      // rolling(col, window, 'op') → per-row reduction with sliding range
      if (node.name === 'rolling') {
        if (node.args.length < 3) return null;
        const colNode = node.args[0];
        const windowNode = node.args[1];
        const opNode = node.args[2];
        if (opNode.type !== 'StringLit' || !ROLLING_OPS[opNode.value]) return null;
        if (windowNode.type !== 'NumberLit') return null;
        const xlsFn = ROLLING_OPS[opNode.value];
        const w = Math.round(windowNode.value);
        const refName = colNode.type === 'Ident' ? colNode.name : null;
        if (!refName) return null;
        const info = resolveBindingInfo(refName, ctx);
        if (!info) return null;
        const letter = colLetter(info.col);
        const start = Math.max(0, ctx.row - w + 1);
        const startRow = info.row + 1 + start;
        const endRow = info.row + 1 + ctx.row;
        return `${xlsFn}(${letter}${startRow}:${letter}${endRow})`;
      }

      const xlsxName = FUNC_MAP[node.name];

      // User-defined function call (via definedNames LAMBDA)
      if (!xlsxName) {
        // Check if it's a user-defined function
        const udfNames = ctx.layout.functions.map(f => f.name);
        if (udfNames.includes(node.name)) {
          const args = node.args.map(a => emitFormula(a, ctx));
          if (args.some(a => a === null)) return null;
          return `${node.name}(${args.join(',')})`;
        }
        return null;
      }

      // Reduction functions — args emit as ranges
      if (REDUCTIONS.has(node.name)) {
        const reductionCtx = { ...ctx, inReduction: true };
        const args = node.args.map(a => emitFormula(a, reductionCtx));
        if (args.some(a => a === null)) return null;
        return `${xlsxName}(${args.join(',')})`;
      }

      // SCAN(init, range, LAMBDA) — spilled
      if (node.name === 'scan') {
        if (node.args.length < 3) return null;
        const rangeCtx = { ...ctx, inReduction: true };
        const col = emitFormula(node.args[0], rangeCtx);
        const init = emitFormula(node.args[1], ctx);
        const lambda = emitInlineLambda(node.args[2], ctx);
        if (!col || init === null || !lambda) return null;
        return `SCAN(${init},${col},${lambda})`;
      }

      // SORT(range) — spilled
      if (node.name === 'sort') {
        if (node.args.length < 1) return null;
        const rangeCtx = { ...ctx, inReduction: true };
        const col = emitFormula(node.args[0], rangeCtx);
        if (!col) return null;
        return `SORT(${col})`;
      }

      // UNIQUE(range) — spilled
      if (node.name === 'unique') {
        if (node.args.length < 1) return null;
        const rangeCtx = { ...ctx, inReduction: true };
        const col = emitFormula(node.args[0], rangeCtx);
        if (!col) return null;
        return `UNIQUE(${col})`;
      }

      // XLOOKUP(needle, keys, vals [, , match_mode]) — scalar or spilled
      if (node.name === 'lookup') {
        if (node.args.length < 3) return null;
        const needle = emitFormula(node.args[0], ctx);
        const rangeCtx = { ...ctx, inReduction: true };
        const keys = emitFormula(node.args[1], rangeCtx);
        const vals = emitFormula(node.args[2], rangeCtx);
        if (!needle || !keys || !vals) return null;
        // Check for nearest: "below" kwarg
        const nearestKw = node.kwargs && node.kwargs.find(k => k.name === 'nearest');
        if (nearestKw) {
          return `XLOOKUP(${needle},${keys},${vals},,-1)`;
        }
        return `XLOOKUP(${needle},${keys},${vals})`;
      }

      // Regular functions — pointwise
      const args = node.args.map(a => emitFormula(a, ctx));
      if (args.some(a => a === null)) return null;
      return `${xlsxName}(${args.join(',')})`;
    }

    case 'MemberAccess': {
      // Cross-sheet reference: Sales.revenue
      if (node.object.type === 'Ident') {
        const ref = emitCrossSheetRef(node.object.name, node.field, ctx, ctx.inReduction);
        if (ref) return ref;
      }
      return null;
    }

    case 'IfExpr': {
      const cond = emitFormula(node.cond, ctx);
      const then = emitFormula(node.then, ctx);
      const els = emitFormula(node.else, ctx);
      if (cond === null || then === null || els === null) return null;
      return `IF(${cond},${then},${els})`;
    }

    case 'TemplateStr': {
      // `${name} earned ${revenue:$#,##0.00}` → A2&" earned "&TEXT(B2,"$#,##0.00")
      const parts = [];
      for (const part of node.parts) {
        if (typeof part === 'string') {
          if (part.length > 0) parts.push(escapeExcelString(part));
        } else {
          // Parse the expression from the template part
          const exprFormula = emitTemplateExpr(part, ctx);
          if (exprFormula === null) return null;
          parts.push(exprFormula);
        }
      }
      if (parts.length === 0) return '""';
      if (parts.length === 1) return parts[0];
      return parts.join('&');
    }

    // Subscript → FILTER(range, condition)
    case 'Subscript': {
      const rangeCtx = { ...ctx, inReduction: true };
      const col = emitFormula(node.object, rangeCtx);
      const cond = emitFormula(node.index, rangeCtx);
      if (!col || !cond) return null;
      return `FILTER(${col},${cond})`;
    }

    // Baked patterns
    case 'ArrayLit':
    case 'Range':
      return null;

    case 'Lambda': {
      return emitInlineLambda(node, ctx);
    }

    default:
      return null;
  }
}

function emitTemplateExpr(part, ctx) {
  // part = { expr: "revenue", format: "$#,##0.00" } or { expr: "name" }
  // We need to parse the expression string into an AST node
  // For simplicity, handle the common case: identifier or member access
  const exprStr = part.expr.trim();

  // Try to resolve as simple ident
  let formula = emitRef(exprStr, ctx, false);
  if (!formula) {
    // Try member access: "Sales.revenue"
    const dot = exprStr.indexOf('.');
    if (dot > 0) {
      formula = emitCrossSheetRef(exprStr.slice(0, dot), exprStr.slice(dot + 1), ctx, false);
    }
  }
  if (!formula) return null;

  if (part.format) {
    return `TEXT(${formula},${escapeExcelString(part.format)})`;
  }
  return formula;
}

// ── Inline LAMBDA (for scan, etc.) ──

function emitInlineLambda(node, ctx) {
  if (node.type !== 'Lambda') return null;
  const lambdaParams = new Set(node.params);
  const lambdaCtx = { ...ctx, row: 0, lambdaParams };
  const bodyFormula = emitFormula(node.body, lambdaCtx);
  if (!bodyFormula) return null;
  const params = node.params.join(',');
  return `LAMBDA(${params},${bodyFormula})`;
}

// ── UDF → definedNames LAMBDA ──

function emitLambda(funcDef, ctx) {
  // Emit body at row 0 (scalars), with params as bare names
  const lambdaParams = new Set(funcDef.params);
  const lambdaCtx = { ...ctx, row: 0, lambdaParams };
  const bodyFormula = emitFormula(funcDef.body, lambdaCtx);
  if (!bodyFormula) return null;

  const params = funcDef.params.join(',');
  return `LAMBDA(${params},${bodyFormula})`;
}

// ── Workbook assembly ──

function codegen(ast, layoutResult, evalResult, opts) {
  const warnings = [];
  const workbook = { sheets: [], definedNames: [] };

  // Process UDFs → definedNames
  for (const func of layoutResult.functions) {
    const ctx = { layout: layoutResult, currentSheet: null, row: 0, inReduction: false };
    const formula = emitLambda(func, ctx);
    if (formula) {
      workbook.definedNames.push({ name: func.name, formula });
    } else {
      warnings.push(`Function ${func.name}(): could not emit LAMBDA, skipped`);
    }
  }

  // Process each sheet
  for (const [sheetName, sheetLayout] of Object.entries(layoutResult.sheets)) {
    const sheetData = evalResult.sheets[sheetName] || null;
    const globalBindings = evalResult.bindings;
    const columns = {};

    // Compute sheet maxRows for scalar broadcasting
    const sheetMaxRows = sheetLayout.maxRows || 1;

    for (const [bindingName, info] of Object.entries(sheetLayout.bindings)) {
      // Get evaluated value
      let val;
      if (sheetData) {
        val = sheetData.scope.get(bindingName);
      } else {
        val = globalBindings[bindingName];
      }

      // Find the AST node for this binding
      const bindingInfo = findBindingAST(ast, sheetName, bindingName);
      const astNode = bindingInfo ? bindingInfo.expr : null;

      // Try to generate formulas
      const ctx = {
        layout: layoutResult,
        currentSheet: sheetName,
        row: 0,
        inReduction: false,
      };

      let formulas = null;
      let bakeReason = null;

      // For scalars in sheets with columns, fill all rows to match grid display
      const numRows = info.isColumn ? info.rows : sheetMaxRows;

      // Check for @formula directive — verbatim Excel formula passthrough
      const formulaDir = bindingInfo?.directives?.find(d => d.name === 'formula');

      if (formulaDir && formulaDir.args.length > 0) {
        const raw = formulaDir.args[0];
        let fStr = typeof raw === 'string' ? raw : raw.value;
        if (!fStr.startsWith('=')) fStr = '=' + fStr;
        formulas = Array(numRows).fill(fStr);
      } else if (astNode) {
        bakeReason = shouldBake(astNode, ctx);

        if (!bakeReason) {
          const spilled = isSpilledNode(astNode);

          if (spilled) {
            // Spilled formula: single formula at row 0, null for rest
            const f = emitFormula(astNode, { ...ctx, row: 0 });
            if (f !== null) {
              const formulaArr = ['=' + f];
              for (let r = 1; r < numRows; r++) formulaArr.push(null);
              formulas = formulaArr;
            }
          } else {
            // Per-row formulas
            const formulaArr = [];
            let allOk = true;
            for (let r = 0; r < numRows; r++) {
              const rowCtx = { ...ctx, row: r };
              const f = emitFormula(astNode, rowCtx);
              if (f === null) { allOk = false; break; }
              formulaArr.push('=' + f);
            }
            if (allOk) formulas = formulaArr;
          }
        }
      }

      // Check if this binding has non-default positioning
      const hasPosition = info.row !== 1;

      if (formulas) {
        // Formulaic column
        const values = bakeValues(val, info, numRows);
        const colObj = { values, formulas };
        if (hasPosition) { colObj.col = info.col; colObj.row = info.row; }
        if (info.label !== undefined && info.label !== 'above') colObj.label = info.label;
        columns[bindingName] = colObj;
      } else {
        // Baked column
        if (bakeReason) {
          warnings.push(`${sheetName}.${bindingName}: baked — ${bakeReason}`);
        } else if (astNode) {
          warnings.push(`${sheetName}.${bindingName}: baked — could not emit formula`);
        }
        if (hasPosition) {
          const values = bakeValues(val, info, numRows);
          const colObj = { values, col: info.col, row: info.row };
          if (info.label !== undefined && info.label !== 'above') colObj.label = info.label;
          columns[bindingName] = colObj;
        } else {
          columns[bindingName] = bakeValues(val, info, numRows);
        }
      }
    }

    workbook.sheets.push({ name: sheetName, columns });
  }

  return { workbook, warnings };
}

function bakeValues(val, info, numRows) {
  if (val instanceof Float64Array) return val;
  if (isColumn(val)) return val;
  // Scalar — fill to numRows for consistent xlsx output
  if (numRows && numRows > 1) return Array(numRows).fill(val);
  return [val];
}

function findBindingAST(ast, sheetName, bindingName) {
  for (const node of ast.body) {
    if (node.type === 'SheetBlock' && node.name === sheetName) {
      for (const b of node.body) {
        if (b.type === 'Binding' && b.name === bindingName)
          return { expr: b.expr, directives: b.directives };
      }
    }
    if (sheetName === 'Sheet1' && node.type === 'Binding' && node.name === bindingName) {
      return { expr: node.expr, directives: node.directives };
    }
  }
  return null;
}

// -- grid.js --

// Grid renderer — calque result → DOM table display
//
// Takes a calque.run() result, renders each sheet as a <table>.
// Multiple sheets get tab buttons to switch between them.
// When layout directives (@below, @right, @anchor) are used,
// renders a spreadsheet-style positioned grid.



function grid(result) {
  const root = document.createElement('div');

  // Compute layout if AST is available
  const layoutResult = result._ast ? layout(result._ast, result) : null;

  // Collect sheet tables
  const sections = [];
  for (const [name, data] of Object.entries(result.sheets)) {
    const hasDirectives = layoutResult && hasPositionedBindings(layoutResult.sheets[name]);
    sections.push({ name, table: data.table, sheetLayout: hasDirectives ? layoutResult.sheets[name] : null, sheetData: data });
  }

  // Bare bindings (not in any sheet block)
  const bareKeys = [];
  for (const [k, v] of Object.entries(result.bindings)) {
    if (v && v.__table) continue; // sheet table reference
    if (typeof v === 'function') continue;
    bareKeys.push(k);
  }
  if (bareKeys.length > 0) {
    const hasDirectives = layoutResult && layoutResult.sheets['Sheet1'] && hasPositionedBindings(layoutResult.sheets['Sheet1']);
    sections.push({
      name: 'Bindings', bare: bareKeys, bindings: result.bindings,
      sheetLayout: hasDirectives ? layoutResult.sheets['Sheet1'] : null,
    });
  }

  if (sections.length === 0) {
    root.textContent = '(no data)';
    return root;
  }

  // Render each section's DOM
  const panels = sections.map(s => {
    if (s.sheetLayout) return renderPositioned(s);
    if (s.bare) return renderBare(s);
    return renderTable(s.table);
  });

  if (sections.length === 1) {
    root.appendChild(panels[0]);
    return root;
  }

  // Tab bar for multiple sections
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:0;margin-bottom:4px;';
  const btns = [];

  for (let i = 0; i < sections.length; i++) {
    const btn = document.createElement('button');
    btn.textContent = sections[i].name;
    btn.style.cssText = 'padding:3px 10px;border:1px solid #555;background:#1a1a1a;color:#aaa;cursor:pointer;font:inherit;font-size:0.85em;';
    if (i === 0) btn.style.borderRadius = '3px 0 0 3px';
    else if (i === sections.length - 1) btn.style.borderRadius = '0 3px 3px 0';
    else btn.style.borderRadius = '0';
    btn.onclick = () => show(i);
    tabBar.appendChild(btn);
    btns.push(btn);
  }

  const content = document.createElement('div');
  root.appendChild(tabBar);
  root.appendChild(content);

  function show(idx) {
    content.replaceChildren(panels[idx]);
    for (let i = 0; i < btns.length; i++) {
      btns[i].style.background = i === idx ? '#2a2a2a' : '#1a1a1a';
      btns[i].style.color = i === idx ? '#c89b3c' : '#aaa';
      btns[i].style.borderBottomColor = i === idx ? '#2a2a2a' : '#555';
    }
  }
  show(0);

  return root;
}

function hasPositionedBindings(sheetLayout) {
  if (!sheetLayout) return false;
  for (const info of Object.values(sheetLayout.bindings)) {
    if (info.row !== 1) return true;
  }
  return false;
}

function fmtCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function isNum(v) {
  return typeof v === 'number';
}

function renderTable(table) {
  const t = document.createElement('table');
  t.style.cssText = 'border-collapse:collapse;font-size:0.9em;';

  // Header
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of table.headers) {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.cssText = 'padding:3px 8px;border-bottom:1px solid #555;font-weight:600;text-align:left;';
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);

  // Body — render at least 1 row for scalar-only sheets
  const tbody = document.createElement('tbody');
  const rowCount = table.rows || (table.headers.length > 0 ? 1 : 0);
  for (let r = 0; r < rowCount; r++) {
    const tr = document.createElement('tr');
    for (const h of table.headers) {
      const td = document.createElement('td');
      const col = table.columns[h];
      const v = (Array.isArray(col) || ArrayBuffer.isView(col)) ? col[r] : col;
      td.textContent = fmtCell(v);
      td.style.cssText = 'padding:2px 8px;border-bottom:1px solid #333;';
      if (isNum(v)) td.style.textAlign = 'right';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);

  return t;
}

// ── Positioned grid renderer ──

function renderPositioned(section) {
  const sheetLayout = section.sheetLayout;
  const bindings = sheetLayout.bindings;

  // Get values from sheet data or bare bindings
  const getVal = (name) => {
    if (section.sheetData) return section.sheetData.scope.get(name);
    if (section.bindings) return section.bindings[name];
    return undefined;
  };

  // Build sparse cell map: { row → { col → { text, isHeader, isNum } } }
  const cellMap = new Map();
  let maxCol = 0;
  let maxRow = 0;

  const setCell = (r, c, text, isHeader, numeric) => {
    if (!cellMap.has(r)) cellMap.set(r, new Map());
    cellMap.get(r).set(c, { text, isHeader, isNum: numeric });
    if (c > maxCol) maxCol = c;
    if (r > maxRow) maxRow = r;
  };

  for (const [name, info] of Object.entries(bindings)) {
    const label = info.label;
    if (label === 'left') {
      // Header in cell to the left of data (same row), if col > 0
      if (info.col > 0) setCell(info.row, info.col - 1, name, true, false);
    } else if (label !== false) {
      // "above" or undefined: header in row above data (default)
      const headerRow = info.row - 1; // 0-indexed header row
      setCell(headerRow, info.col, name, true, false);
    }
    // label === false: no header cell

    const val = getVal(name);
    if (isColumn(val)) {
      for (let i = 0; i < val.length; i++) {
        setCell(info.row + i, info.col, fmtCell(val[i]), false, isNum(val[i]));
      }
    } else {
      setCell(info.row, info.col, fmtCell(val), false, isNum(val));
    }
  }

  // Render table
  const t = document.createElement('table');
  t.style.cssText = 'border-collapse:collapse;font-size:0.9em;';
  const tbody = document.createElement('tbody');

  for (let r = 0; r <= maxRow; r++) {
    const tr = document.createElement('tr');
    const rowData = cellMap.get(r);

    for (let c = 0; c <= maxCol; c++) {
      const cell = rowData && rowData.get(c);
      if (cell && cell.isHeader) {
        const th = document.createElement('th');
        th.textContent = cell.text;
        th.style.cssText = 'padding:3px 8px;border-bottom:1px solid #555;font-weight:600;text-align:left;';
        tr.appendChild(th);
      } else {
        const td = document.createElement('td');
        td.textContent = cell ? cell.text : '';
        td.style.cssText = 'padding:2px 8px;border-bottom:1px solid #333;';
        if (cell && cell.isNum) td.style.textAlign = 'right';
        tr.appendChild(td);
      }
    }

    tbody.appendChild(tr);
  }

  t.appendChild(tbody);
  return t;
}

function renderBare(section) {
  const t = document.createElement('table');
  t.style.cssText = 'border-collapse:collapse;font-size:0.9em;';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['name', 'value']) {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.cssText = 'padding:3px 8px;border-bottom:1px solid #555;font-weight:600;text-align:left;';
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const k of section.bare) {
    const v = section.bindings[k];
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = k;
    tdName.style.cssText = 'padding:2px 8px;border-bottom:1px solid #333;';
    tr.appendChild(tdName);

    const tdVal = document.createElement('td');
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      tdVal.textContent = Array.from(v).map(fmtCell).join(', ');
    } else {
      tdVal.textContent = fmtCell(v);
    }
    tdVal.style.cssText = 'padding:2px 8px;border-bottom:1px solid #333;';
    if (isNum(v)) tdVal.style.textAlign = 'right';
    tr.appendChild(tdVal);

    tbody.appendChild(tr);
  }
  t.appendChild(tbody);

  return t;
}

// -- api.js --

// Public API — tagged template, .run, .parse, .lex, self-registration
//
// Pipeline: source → lex → parse → evaluate → { bindings, exports, sheets, scope }









function toSource(stringsOrSource, values) {
  if (Array.isArray(stringsOrSource) || (stringsOrSource && stringsOrSource.raw)) {
    let source = stringsOrSource[0];
    for (let i = 0; i < values.length; i++) {
      source += String(values[i]);
      source += stringsOrSource[i + 1];
    }
    return source;
  }
  if (typeof stringsOrSource === 'string') return stringsOrSource;
  return null;
}

function calque(stringsOrSource, ...values) {
  // calque({ imports: {...} })`...` — curried with options
  if (typeof stringsOrSource === 'object' && !Array.isArray(stringsOrSource) && !stringsOrSource.raw) {
    const opts = stringsOrSource;
    return function(strings, ...vals) {
      const src = toSource(strings, vals);
      if (src !== null) return calque.run(src, opts);
      throw new Error('calque: expected tagged template after options');
    };
  }
  const source = toSource(stringsOrSource, values);
  if (source !== null) return calque.run(source);
  throw new Error('calque: expected string or tagged template');
}

calque.run = function(source, opts) {
  const tokens = lex(source);
  const ast = parse(tokens);
  const result = evaluate(ast, opts);
  result._ast = ast;
  result.compile = function() {
    const layoutResult = layout(ast, result);
    const { workbook, warnings } = codegen(ast, layoutResult, result);
    return { workbook, warnings };
  };
  return result;
};

calque.parse = function(source) {
  const tokens = lex(source);
  return parse(tokens);
};

calque.lex = function(source) {
  return lex(source);
};

calque.compile = function(stringsOrSource, ...values) {
  const source = toSource(stringsOrSource, values);
  if (source === null) throw new Error('calque.compile: expected string or tagged template');
  const result = calque.run(source);
  const { workbook, warnings } = result.compile();
  return { workbook, warnings, result };
};

calque.grid = function(result) {
  return grid(result);
};

// Internals for testing
calque._lex = lex;
calque._parse = parse;
calque._evaluate = evaluate;
calque._layout = layout;
calque._codegen = codegen;
calque._grid = grid;
calque._tokenize = tokenizeCalque;
calque._stdlib = stdlib;

// ── Self-registration ──

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/calque',
      version: '0.1.0',
      taggedLanguage: { name: 'calque', tokenize: tokenizeCalque, completions: calqueCompletions, sigHint: calqueSigHint },
    });
  } else {
    if (!window._taggedLanguages) window._taggedLanguages = {};
    window._taggedLanguages.calque = { tokenize: tokenizeCalque, completions: calqueCompletions, sigHint: calqueSigHint };
  }
}

export { calque };
