// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/soft/src/  Build: node ext/soft/build.js
// @gcu/soft — English keyword programming language for Auditable
// Soft cells, tagged template, data query pipeline.

// -- tokenize.js --

// soft — tokenizer
// Produces a flat token array from Soft source code.

// ── token types ──

const T = {
  NUM: 'NUM', STR: 'STR', ID: 'ID', KW: 'KW',
  OP: 'OP', CMP: 'CMP', CONCAT: 'CONCAT',
  BANG: 'BANG', LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  COMMA: 'COMMA', NL: 'NL', EOF: 'EOF',
  BITOP: 'BITOP', REGEX: 'REGEX',
};

// ── keywords ──

const KEYWORDS = new Set([
  // data query
  'take', 'from', 'keep', 'drop', 'only', 'where', 'pick', 'get',
  'average', 'total', 'count', 'smallest', 'largest', 'mean', 'sum',
  'min', 'max', 'group', 'by', 'each', 'in', 'sort', 'ascending',
  'descending', 'first', 'last', 'top', 'append', 'push',
  // general
  'set', 'to', 'of', 'the', 'a', 'an', 'that', 'this',
  'say', 'show', 'put', 'into', 'being', 'record',
  'load', 'save', 'open', 'close', 'write', 'read',
  'ask', 'wait', 'there', 'do', 'explain', 'assume', 'suppose',
  'try', 'fails', 'called', 'it', 'call', 'run', 'result',
  // control flow
  'if', 'unless', 'otherwise', 'else', 'end', 'repeat', 'times',
  'while', 'until', 'with', 'for', 'stop', 'skip', 'by',
  // functions/events
  'define', 'return', 'takes', 'use', 'as', 'many', 'all', 'on',
  // comparison/logic
  'above', 'below', 'is', 'not', 'and', 'or', 'between',
  'contains', 'matches', 'greater', 'less', 'more', 'under',
  'equals', 'equal', 'than', 'does', 'least', 'most',
  // arithmetic
  'plus', 'minus', 'over', 'mod', 'raised', 'negative',
  'bitwise', 'bit', 'shift', 'left', 'right', 'xor',
  // pipe
  'then',
  // other
  'round', 'rows', 'true', 'false', 'nothing', 'empty',
  'length', 'item', 'at', 'add', 'remove', 'list', 'yes', 'no',
  'character', 'characters', 'word', 'words', 'line', 'lines',
  'number', 'second', 'seconds', 'millisecond', 'milliseconds',
  'reading', 'writing', 'appending', 'boolean', 'time',
  'make',
]);

// ── string escape processing ──

function processEscapes(raw) {
  let out = '', i = 0;
  while (i < raw.length) {
    if (raw[i] !== '\\' || i + 1 >= raw.length) { out += raw[i++]; continue; }
    const c = raw[++i]; i++;
    switch (c) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      default: out += '\\' + c;
    }
  }
  return out;
}

// ── locale support ──

let _localeLookup = null; // word → canonical English keyword
let _localeNoise = null;  // set of noise words

function softSetLocale(locale) {
  if (!locale) { _localeLookup = null; _localeNoise = null; return; }
  _localeLookup = {};
  for (const [canonical, forms] of Object.entries(locale.keywords || {})) {
    for (const form of forms) _localeLookup[form.toLowerCase()] = canonical;
  }
  _localeNoise = locale.noise ? new Set(locale.noise.map(w => w.toLowerCase())) : null;
}

function softGetLocale() { return _localeLookup; }

// ── main tokenizer ──

function softTokenize(code) {
  const tokens = [];
  let pos = 0, line = 1, col = 0;
  const len = code.length;

  function ch(offset) { return pos + (offset || 0) < len ? code[pos + (offset || 0)] : ''; }
  function advance() { const c = code[pos++]; if (c === '\n') { line++; col = 0; } else { col++; } return c; }
  function peek() { return pos < len ? code[pos] : ''; }

  function emit(type, value, startLine, startCol) {
    tokens.push({ type, value, line: startLine, col: startCol });
  }

  function isIdStart(c) { return /[\p{L}_]/u.test(c); }
  function isIdCont(c) { return /[\p{L}\p{N}_]/u.test(c); }
  function isDigit(c) { return c >= '0' && c <= '9'; }

  while (pos < len) {
    const startLine = line, startCol = col;
    const c = peek();

    // ── whitespace (not newline) ──
    if (c === ' ' || c === '\t' || c === '\r') {
      advance();
      continue;
    }

    // ── newline ──
    if (c === '\n') {
      advance();
      // collapse consecutive newlines
      if (tokens.length === 0 || tokens[tokens.length - 1].type === T.NL) continue;
      emit(T.NL, '\n', startLine, startCol);
      continue;
    }

    // ── comment ──
    if (c === '#') {
      while (pos < len && peek() !== '\n') advance();
      continue;
    }

    // ── string ──
    if (c === '"') {
      advance(); // skip opening quote
      let raw = '';
      while (pos < len && peek() !== '"') {
        if (peek() === '\\' && pos + 1 < len) {
          raw += advance(); // backslash
          raw += advance(); // escaped char
        } else {
          raw += advance();
        }
      }
      if (pos < len) advance(); // skip closing quote
      emit(T.STR, processEscapes(raw), startLine, startCol);
      continue;
    }

    // ── number ──
    if (isDigit(c) || (c === '-' && isDigit(ch(1)) && shouldNegateBeUnary(tokens))) {
      let num = '';
      if (c === '-') num += advance();
      // hex, binary, octal
      if (peek() === '0' && pos + 1 < len && 'xXbBoO'.includes(ch(1))) {
        num += advance(); // 0
        num += advance(); // x/b/o
        while (pos < len && /[0-9a-fA-F]/.test(peek())) num += advance();
      } else {
        while (pos < len && isDigit(peek())) num += advance();
        if (pos < len && peek() === '.' && pos + 1 < len && isDigit(ch(1))) {
          num += advance(); // .
          while (pos < len && isDigit(peek())) num += advance();
        }
      }
      emit(T.NUM, num, startLine, startCol);
      continue;
    }

    // ── identifier / keyword ──
    if (isIdStart(c)) {
      let word = '';
      while (pos < len && (isIdCont(peek()) || peek() === '.')) word += advance();
      // locale: resolve to canonical English
      const lc = word.toLowerCase();
      if (_localeLookup && _localeLookup[lc]) {
        word = _localeLookup[lc];
      }
      // locale noise words → canonical noise
      if (_localeNoise && _localeNoise.has(lc)) {
        word = 'the'; // map to English noise word
      }
      // dot-path identifiers are always ID, never KW
      if (word.includes('.')) {
        emit(T.ID, word, startLine, startCol);
      } else if (KEYWORDS.has(word)) {
        emit(T.KW, word, startLine, startCol);
      } else {
        emit(T.ID, word, startLine, startCol);
      }
      continue;
    }

    // ── two-character operators ──
    const two = code.slice(pos, pos + 2);
    if (two === '**') { advance(); advance(); emit(T.OP, '**', startLine, startCol); continue; }
    if (two === '==') { advance(); advance(); emit(T.CMP, '==', startLine, startCol); continue; }
    if (two === '!=') { advance(); advance(); emit(T.CMP, '!=', startLine, startCol); continue; }
    if (two === '>=') { advance(); advance(); emit(T.CMP, '>=', startLine, startCol); continue; }
    if (two === '<=') { advance(); advance(); emit(T.CMP, '<=', startLine, startCol); continue; }
    if (two === '<<') { advance(); advance(); emit(T.BITOP, '<<', startLine, startCol); continue; }
    if (two === '>>') { advance(); advance(); emit(T.BITOP, '>>', startLine, startCol); continue; }

    // ── single-character operators ──
    if (c === '+') { advance(); emit(T.OP, '+', startLine, startCol); continue; }
    if (c === '-') { advance(); emit(T.OP, '-', startLine, startCol); continue; }
    if (c === '*') { advance(); emit(T.OP, '*', startLine, startCol); continue; }
    if (c === '/') {
      // regex literal: only after 'matches' keyword
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      if (prev && prev.type === T.KW && prev.value === 'matches') {
        advance(); // skip opening /
        let pattern = '';
        while (pos < len && peek() !== '/') {
          if (peek() === '\\' && pos + 1 < len) { pattern += advance(); pattern += advance(); }
          else { pattern += advance(); }
        }
        if (pos < len) advance(); // skip closing /
        let flags = '';
        while (pos < len && /[gimsuy]/.test(peek())) flags += advance();
        emit(T.REGEX, flags ? pattern + '/' + flags : pattern, startLine, startCol);
        continue;
      }
      advance(); emit(T.OP, '/', startLine, startCol); continue;
    }
    if (c === '%') { advance(); emit(T.OP, '%', startLine, startCol); continue; }
    if (c === '>') { advance(); emit(T.CMP, '>', startLine, startCol); continue; }
    if (c === '<') { advance(); emit(T.CMP, '<', startLine, startCol); continue; }
    if (c === '~') { advance(); emit(T.BITOP, '~', startLine, startCol); continue; }
    if (c === '&') { advance(); emit(T.CONCAT, '&', startLine, startCol); continue; }
    if (c === '!') { advance(); emit(T.BANG, '!', startLine, startCol); continue; }
    if (c === '(') { advance(); emit(T.LPAREN, '(', startLine, startCol); continue; }
    if (c === ')') { advance(); emit(T.RPAREN, ')', startLine, startCol); continue; }
    if (c === ',') { advance(); emit(T.COMMA, ',', startLine, startCol); continue; }

    // ── unknown — skip ──
    advance();
  }

  // ensure trailing NL
  if (tokens.length > 0 && tokens[tokens.length - 1].type !== T.NL) {
    emit(T.NL, '\n', line, col);
  }
  emit(T.EOF, '', line, col);
  return tokens;
}

// ── helper: should a `-` be treated as unary negation? ──
// True when `-` is at the start or follows an operator/keyword/NL/comma/lparen

function shouldNegateBeUnary(tokens) {
  if (tokens.length === 0) return true;
  const prev = tokens[tokens.length - 1];
  return prev.type === T.OP || prev.type === T.CMP || prev.type === T.CONCAT ||
    prev.type === T.BANG || prev.type === T.LPAREN || prev.type === T.COMMA ||
    prev.type === T.NL || prev.type === T.KW || prev.type === T.BITOP;
}

// -- parse.js --

// soft — recursive descent parser
// Produces an AST from a token stream. No external dependencies.


// ── AST node constructors ──

let _curLine = 1;
const N = (type, props) => ({ type, line: _curLine, ...props });

// ── parser ──

function softParse(code) {
  const tokens = softTokenize(code);
  let pos = 0;

  // -- token access --
  function cur() { const t = tokens[pos] || { type: T.EOF, value: '', line: _curLine }; _curLine = t.line || _curLine; return t; }
  function at(type, value) {
    const t = cur();
    if (value !== undefined) return t.type === type && t.value === value;
    return t.type === type;
  }
  function kw(value) { return at(T.KW, value); }
  function eat(type, value) {
    if (at(type, value)) { pos++; return true; }
    return false;
  }
  function eatKw(value) { return eat(T.KW, value); }
  function expect(type, value) {
    if (!eat(type, value)) {
      const t = cur();
      throw new Error(`Expected ${value || type} but got ${t.value || t.type} at line ${t.line}`);
    }
  }
  function expectKw(value) { expect(T.KW, value); }
  function skipNL() { while (at(T.NL)) pos++; }
  function expectNL() {
    if (!at(T.NL) && !at(T.EOF)) {
      const t = cur();
      throw new Error(`Expected newline but got ${t.value || t.type} at line ${t.line}`);
    }
    skipNL();
  }

  // -- name: accepts both ID and KW (for imported names that collide with keywords) --
  function expectName() {
    const t = cur();
    if (t.type === T.ID || t.type === T.KW) { pos++; return t.value; }
    throw new Error(`Expected name but got ${t.value || t.type} at line ${t.line}`);
  }

  // ── pre-scan for function signatures ──
  const signatures = new Map();

  const BLOCK_OPENERS = new Set(['define', 'if', 'unless', 'repeat', 'while', 'until', 'for', 'suppose', 'try', 'on']);
  function prescan() {
    let i = 0;
    let depth = 0; // track block nesting: only register top-level defines/uses
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === T.KW && t.value === 'end') { if (depth > 0) depth--; i++; continue; }
      if (t.type === T.KW && BLOCK_OPENERS.has(t.value) && t.value !== 'define') { depth++; i++; continue; }
      if (t.type === T.KW && (t.value === 'define' || t.value === 'use')) {
        const isNested = depth > 0;
        if (t.value === 'define') depth++;
        if (isNested) { i++; continue; } // skip nested defines
        i++;
        // skip to function name
        if (t.value === 'use') {
          // use <dotpath> [as <name>] [signature]
          if (i < tokens.length && tokens[i].type === T.ID) {
            const dotpath = tokens[i].value; i++;
            let name = dotpath;
            if (i < tokens.length && tokens[i].type === T.KW && tokens[i].value === 'as') {
              i++;
              if (i < tokens.length && (tokens[i].type === T.ID || tokens[i].type === T.KW)) {
                name = tokens[i].value; i++;
              }
            }
            const sig = prescanSig(i);
            signatures.set(name, sig.params);
            i = sig.end;
          }
        } else {
          // define <name> [takes|with] <signature>
          if (i < tokens.length && (tokens[i].type === T.ID || tokens[i].type === T.KW)) {
            const name = tokens[i].value; i++;
            const sig = prescanSig(i);
            signatures.set(name, sig.params);
            i = sig.end;
          }
        }
      } else {
        i++;
      }
    }
  }

  function prescanSig(start) {
    let i = start;
    const params = [];
    // skip noise words: takes, with (only before first param)
    while (i < tokens.length && tokens[i].type === T.KW &&
      (tokens[i].value === 'takes' || tokens[i].value === 'with')) { i++; }
    while (i < tokens.length && tokens[i].type !== T.NL && tokens[i].type !== T.EOF) {
      const t = tokens[i];
      // variadic
      if (t.type === T.KW && (t.value === 'many' || t.value === 'all')) {
        i++;
        if (i < tokens.length && (tokens[i].type === T.ID || tokens[i].type === T.KW)) {
          params.push({ param: tokens[i].value, variadic: true }); i++;
        }
        break;
      }
      // separator keyword (before a param or variadic)
      if (t.type === T.KW && !isExpressionStart(t.value) &&
        i + 1 < tokens.length && (tokens[i + 1].type === T.ID || tokens[i + 1].type === T.KW)) {
        if (t.value === 'and') { i++; continue; } // skip 'and' between params
        const sep = t.value; i++;
        // check for variadic after separator: "of many numbers"
        if (tokens[i].type === T.KW && (tokens[i].value === 'many' || tokens[i].value === 'all')) {
          i++;
          if (i < tokens.length && (tokens[i].type === T.ID || tokens[i].type === T.KW)) {
            params.push({ sep, param: tokens[i].value, variadic: true }); i++;
          }
          break;
        }
        const pname = tokens[i].value; i++;
        // check for default: param is <value>
        let dflt;
        if (i < tokens.length && tokens[i].type === T.KW && tokens[i].value === 'is') {
          i++;
          if (i < tokens.length) { dflt = tokens[i].value; i++; }
        }
        params.push({ sep, param: pname, default: dflt });
        continue;
      }
      // bare param
      if (t.type === T.ID || (t.type === T.KW && isParamName(t.value))) {
        const pname = t.value; i++;
        // check for default: param is <value>
        let dflt;
        if (i < tokens.length && tokens[i].type === T.KW && tokens[i].value === 'is') {
          i++;
          if (i < tokens.length) { dflt = tokens[i].value; i++; }
        }
        params.push({ param: pname, default: dflt });
        continue;
      }
      break;
    }
    return { params, end: i };
  }

  function isExpressionStart(kw) {
    return ['set', 'say', 'show', 'put', 'if', 'unless', 'repeat', 'while', 'until',
      'for', 'define', 'return', 'take', 'from', 'keep', 'drop', 'only', 'where',
      'pick', 'get', 'sort', 'first', 'last', 'top', 'count', 'average', 'total',
      'smallest', 'largest', 'mean', 'sum', 'min', 'max', 'group', 'round',
      'load', 'save', 'ask', 'add', 'remove', 'on', 'use', 'explain', 'assume',
      'suppose', 'try', 'stop', 'skip', 'end', 'otherwise', 'else', 'open',
      'close', 'write', 'read', 'wait', 'append', 'make'].includes(kw);
  }

  function isParamName(kw) {
    // keywords that can serve as parameter names in signatures
    return !isExpressionStart(kw);
  }

  // ── expression parsing (precedence climbing) ──

  // level 11: and/or (logic)
  function expression() {
    return inlineConditional();
  }

  function inlineConditional() {
    let left = concat();
    if (kw('if')) {
      pos++;
      const cond = condition();
      expectKw('otherwise');
      const right = concat();
      return N('Ternary', { ifTrue: left, cond, ifFalse: right });
    }
    return left;
  }

  // level 9: & (string concat)
  function concat() {
    let left = logic();
    while (eat(T.CONCAT)) {
      left = N('BinOp', { op: '&', left, right: logic() });
    }
    return left;
  }

  // level 11: and/or (logic) — only in expression context, not condition
  function logic() {
    let left = comparison();
    while (kw('and') || kw('or')) {
      // peek: "and then" is a pipe, not logic
      if (kw('and') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'then') break;
      const op = cur().value; pos++;
      left = N('Logic', { op, left, right: comparison() });
    }
    return left;
  }

  // level 10: comparisons
  function comparison() {
    let left = bitwise();
    // is a / is not a → type check
    if (kw('is')) {
      const saved = pos; pos++;
      const negated = !!eatKw('not');
      if (kw('a') || kw('an')) {
        pos++;
        const typeName = expectName();
        const node = N('TypeCheck', { expr: left, typeName });
        return negated ? N('Unary', { op: 'not', expr: node }) : node;
      }
      pos = saved; // backtrack
    }
    // between
    if (kw('between')) {
      pos++;
      const lo = arithmetic();
      expectKw('and');
      const hi = arithmetic();
      return N('Between', { value: left, lo, hi });
    }
    // contains
    if (kw('contains')) { pos++; return N('Compare', { op: 'contains', left, right: bitwise() }); }
    // matches
    if (kw('matches')) { pos++; return N('Compare', { op: 'matches', left, right: bitwise() }); }
    // regular comparison operators
    const cop = comparisonOp();
    if (cop) {
      const right = bitwise();
      return N('Compare', { op: cop, left, right });
    }
    return left;
  }

  function isComparisonNext() {
    const t = cur();
    if (t.type === T.CMP) return true;
    if (t.type === T.KW) {
      return ['above', 'below', 'is', 'equals', 'greater', 'less', 'more', 'under', 'at', 'does'].includes(t.value);
    }
    return false;
  }

  function comparisonOp() {
    // skip noise words before comparison (allows "se x for ao menos 5" in Portuguese)
    const savedNoise = pos;
    while (kw('the') || kw('a') || kw('an')) pos++;
    if (pos > savedNoise && !at(T.CMP) && !kw('above') && !kw('below') && !kw('is') && !kw('at') &&
      !kw('equals') && !kw('greater') && !kw('less') && !kw('more') && !kw('under') && !kw('does') && !kw('not')) {
      pos = savedNoise; // backtrack — no comparison follows
    }
    if (eat(T.CMP, '>')) return '>';
    if (eat(T.CMP, '<')) return '<';
    if (eat(T.CMP, '==')) return '==';
    if (eat(T.CMP, '!=')) return '!=';
    if (eat(T.CMP, '>=')) return '>=';
    if (eat(T.CMP, '<=')) return '<=';
    if (kw('above')) { pos++; eatKw('of'); return '>'; }
    if (kw('below')) { pos++; eatKw('of'); return '<'; }
    if (kw('is')) {
      const saved = pos; pos++;
      if (kw('not')) {
        pos++;
        if (kw('a') || kw('an')) { pos = saved; return null; } // is not a → type check, not comparison
        return '!=';
      }
      if (kw('a') || kw('an')) { pos = saved; return null; } // is a → type check, not comparison
      if (kw('above')) { pos++; eatKw('of'); return '>'; }
      if (kw('below')) { pos++; eatKw('of'); return '<'; }
      if (kw('equal')) { pos++; eatKw('to'); return '=='; } // "is equal to"
      if (kw('greater')) { pos++; eatKw('than'); return '>'; } // "is greater than"
      if (kw('less')) { pos++; eatKw('than'); return '<'; } // "is less than"
      // "is at least" / "is at most"
      if (kw('at') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'least') { pos += 2; return '>='; }
      if (kw('at') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'most') { pos += 2; return '<='; }
      return '==';
    }
    if (kw('at')) {
      if (tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'least') {
        pos += 2; return '>=';
      }
      if (tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'most') {
        pos += 2; return '<=';
      }
    }
    if (kw('equals')) { pos++; return '=='; }
    if (kw('greater')) { pos++; eatKw('than'); return '>'; }
    if (kw('less')) { pos++; eatKw('than'); return '<'; }
    if (kw('more')) { pos++; eatKw('than'); return '>'; }
    if (kw('under')) { pos++; return '<'; }
    // "not is" / "não é" → != (Portuguese word order: não before é)
    if (kw('not')) {
      const saved = pos; pos++;
      if (kw('is')) { pos++; return '!='; }
      pos = saved;
    }
    // "does not equal" → !=
    if (kw('does')) {
      const saved = pos; pos++;
      if (kw('not')) { pos++; if (eatKw('equal')) return '!='; }
      pos = saved;
    }
    return null;
  }

  // level 8: bitwise
  function bitwise() {
    let left = shift();
    while (true) {
      if (kw('bitwise') || kw('bit')) {
        const saved = pos; pos++;
        if (kw('and')) { pos++; left = N('BinOp', { op: 'bitand', left, right: shift() }); continue; }
        if (kw('or')) { pos++; left = N('BinOp', { op: 'bitor', left, right: shift() }); continue; }
        if (kw('xor')) { pos++; left = N('BinOp', { op: 'bitxor', left, right: shift() }); continue; }
        pos = saved; break;
      }
      if (kw('xor')) { pos++; left = N('BinOp', { op: 'bitxor', left, right: shift() }); continue; }
      break;
    }
    return left;
  }

  // level 7: shift
  function shift() {
    let left = arithmetic();
    while (true) {
      if (eat(T.BITOP, '<<')) { left = N('BinOp', { op: '<<', left, right: arithmetic() }); continue; }
      if (eat(T.BITOP, '>>')) { left = N('BinOp', { op: '>>', left, right: arithmetic() }); continue; }
      if (kw('shift')) {
        pos++;
        if (kw('left')) { pos++; left = N('BinOp', { op: '<<', left, right: arithmetic() }); continue; }
        if (kw('right')) { pos++; left = N('BinOp', { op: '>>', left, right: arithmetic() }); continue; }
      }
      break;
    }
    return left;
  }

  // level 6: +, -
  function arithmetic() {
    let left = term();
    while (true) {
      if (eat(T.OP, '+') || eatKw('plus')) { left = N('BinOp', { op: '+', left, right: term() }); continue; }
      if (eat(T.OP, '-') || eatKw('minus')) { left = N('BinOp', { op: '-', left, right: term() }); continue; }
      break;
    }
    return left;
  }

  // level 5: *, /, %
  function term() {
    let left = exponent();
    while (true) {
      if (eat(T.OP, '*') || eatKw('times')) { left = N('BinOp', { op: '*', left, right: exponent() }); continue; }
      if (eat(T.OP, '/') || eatKw('over')) { left = N('BinOp', { op: '/', left, right: exponent() }); continue; }
      if (eat(T.OP, '%') || eatKw('mod')) { left = N('BinOp', { op: '%', left, right: exponent() }); continue; }
      break;
    }
    return left;
  }

  // level 4: ** (right-associative)
  function exponent() {
    let left = unary();
    if (eat(T.OP, '**') || (eatKw('raised') && expectKw('to') || true)) {
      // right-associative: recurse into exponent
      if (tokens[pos - 1]?.value === '**' || tokens[pos - 1]?.value === 'to') {
        return N('BinOp', { op: '**', left, right: exponent() });
      }
    }
    return left;
  }

  // level 3: unary prefix
  function unary() {
    if (kw('not') || eat(T.BANG)) {
      if (kw('not')) pos++;
      return N('Unary', { op: 'not', expr: unary() });
    }
    // explicit invocation: call/run/result of — with optional args
    if (kw('call') || kw('run')) {
      pos++;
      const fn = atom(); // the function reference
      const args = [];
      while (!at(T.NL) && !at(T.EOF) && !kw('end') && !kw('then') && !kw('as') &&
        !kw('into') && !kw('called') && !at(T.RPAREN) && !isComparisonNext() &&
        !kw('and') && !kw('or') && !kw('if') && !kw('unless') && !at(T.CONCAT)) {
        args.push(arithmetic());
        if (!eat(T.COMMA)) break;
      }
      return N('Invoke', { expr: fn, args });
    }
    if (kw('result')) {
      const saved = pos; pos++;
      if (kw('of')) {
        pos++;
        const fn = atom();
        const args = [];
        while (!at(T.NL) && !at(T.EOF) && !kw('end') && !kw('then') && !kw('as') &&
          !kw('into') && !kw('called') && !at(T.RPAREN) && !isComparisonNext() &&
          !kw('and') && !kw('or') && !kw('if') && !kw('unless') && !at(T.CONCAT)) {
          args.push(arithmetic());
          if (!eat(T.COMMA)) break;
        }
        return N('Invoke', { expr: fn, args });
      }
      pos = saved;
    }
    if (kw('negative')) { pos++; return N('Unary', { op: 'neg', expr: unary() }); }
    if (eat(T.OP, '-')) { return N('Unary', { op: 'neg', expr: unary() }); }
    if (eat(T.BITOP, '~')) { return N('Unary', { op: 'bitnot', expr: unary() }); }
    if (kw('bit') || kw('bitwise')) {
      const saved = pos; pos++;
      if (kw('not')) { pos++; return N('Unary', { op: 'bitnot', expr: unary() }); }
      pos = saved;
    }
    if (kw('length')) {
      const saved = pos; pos++;
      if (kw('of')) { pos++; return N('LengthOf', { expr: atom() }); }
      pos = saved;
      // fall through — 'length' as a bare field name in row context
    }
    // round <expr> to <n> as an expression
    if (kw('round')) {
      const saved = pos; pos++;
      if (!kw('to') && !at(T.NL) && !at(T.EOF)) {
        const value = atom();
        if (kw('to') && tokens[pos + 1]?.type === T.NUM) {
          pos++;
          const places = parseNumber(cur().value); pos++;
          return N('RoundExpr', { value, places });
        }
      }
      pos = saved;
      // fall through — 'round' as pipeline statement handled elsewhere
    }
    // "number of words/characters/lines/items in X" — counting
    if (kw('number')) {
      const saved = pos; pos++;
      if (kw('of')) {
        pos++;
        if (kw('characters') || kw('words') || kw('lines') || kw('items')) {
          const kind = cur().value; pos++;
          expectKw('in');
          return N('CountChunks', { kind, expr: atom() });
        }
        pos = saved + 1; // backtrack past 'number' but before 'of'
      }
      pos = saved;
      // fall through — 'number' as a bare name or builtin
    }
    // chunk expressions: character/word/line/item N of X
    if (kw('character') || kw('word') || kw('line') || kw('item')) {
      const saved = pos;
      const kind = cur().value; pos++;
      // peek: if followed by a number/expr then 'of', it's a chunk read
      if (!kw('of') && !at(T.NL) && !at(T.EOF)) {
        const index = atom();
        if (kw('of')) {
          pos++;
          const target = unary(); // recurse to allow nesting: word 1 of line 0 of doc
          return N('Chunk', { kind, index, target });
        }
      }
      pos = saved;
      // fall through — bare field name
    }
    // chunk ranges: characters/words/lines N to M of X
    if (kw('characters') || kw('words') || kw('lines') || kw('items')) {
      const saved = pos;
      const kind = cur().value; pos++;
      if (!at(T.NL) && !at(T.EOF)) {
        const from = atom();
        if (kw('to')) {
          pos++;
          const to = atom();
          if (kw('of')) {
            pos++;
            return N('ChunkRange', { kind, from, to, target: unary() });
          }
        }
      }
      pos = saved;
      // fall through
    }
    return postfix();
  }

  // level 2: of chains
  function postfix() {
    let left = atom();
    while (kw('of')) {
      pos++;
      const right = atom();
      left = N('Of', { prop: left, obj: right });
    }
    return left;
  }

  // level 1: atoms
  function atom() {
    // skip noise words
    if (kw('the') || kw('a') || kw('an') || kw('that') || kw('this')) {
      pos++;
      return atom();
    }

    // number
    if (at(T.NUM)) {
      const v = cur().value; pos++;
      return N('Num', { value: parseNumber(v) });
    }

    // string
    if (at(T.STR)) {
      const v = cur().value; pos++;
      return N('Str', { value: v });
    }

    // regex literal
    if (at(T.REGEX)) {
      const v = cur().value; pos++;
      return N('Regex', { value: v });
    }

    // boolean
    if (kw('true') || kw('yes')) { pos++; return N('Bool', { value: true }); }
    if (kw('false') || kw('no')) { pos++; return N('Bool', { value: false }); }

    // null
    if (kw('nothing') || kw('empty')) { pos++; return N('Nothing'); }

    // it / that / result
    if (kw('it') || kw('that')) { pos++; return N('Ref', { name: 'it' }); }
    // 'result' as bare alias for 'it' (when not followed by 'of' — that's handled in unary)
    if (kw('result') && !(tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'of')) {
      pos++; return N('Ref', { name: 'it' });
    }

    // parenthesized
    if (eat(T.LPAREN)) {
      const expr = expression();
      expect(T.RPAREN);
      return N('Group', { expr });
    }

    // list literal — comma at end of line continues to next line
    // "list\n  item1,\n  item2" works (newline after list starts multi-line mode)
    if (kw('list')) {
      pos++;
      const multiline = at(T.NL);
      if (multiline) skipNL();
      const items = [];
      while (!at(T.EOF) && !kw('end') && !at(T.RPAREN)) {
        if (!multiline && at(T.NL)) break;
        items.push(arithmetic());
        if (eat(T.COMMA)) { skipNL(); continue; }
        break;
      }
      return N('List', { items });
    }

    // record literal
    if (kw('record')) {
      pos++;
      if (kw('with')) {
        // record with x, y, z shorthand
        pos++;
        const fields = [];
        while (!at(T.NL) && !at(T.EOF) && !kw('record') && !at(T.RPAREN)) {
          const name = expectName();
          if (kw('is')) { pos++; fields.push({ name, value: arithmetic() }); }
          else { fields.push({ name, ref: true }); }
          if (eat(T.COMMA)) { skipNL(); continue; }
          break;
        }
        return N('RecordWith', { fields });
      }
      const fields = [];
      while (!at(T.NL) && !at(T.EOF) && !kw('record') && !at(T.RPAREN) && !at(T.COMMA)) {
        // stop if the next token is not a valid field name
        if (!at(T.ID) && !(at(T.KW) && isParamName(cur().value))) break;
        const name = expectName();
        const value = arithmetic();
        fields.push({ name, value });
      }
      return N('Record', { fields });
    }

    // identifier — could be a variable ref, function call, or dot-path call
    if (at(T.ID)) {
      // builtin coercion: text <value>
      if (cur().value === 'text') {
        const saved = pos; pos++;
        if (!at(T.NL) && !at(T.EOF) && !kw('of') && !isComparisonNext()) {
          const arg = atom();
          return N('Call', { name: 'text', args: [arg] });
        }
        pos = saved;
      }
      const name = cur().value; pos++;
      // dot-path: consume comma-separated args
      if (name.includes('.')) {
        const args = [];
        while (!at(T.NL) && !at(T.EOF) && !kw('then') && !kw('as') && !kw('into') &&
          !kw('and') && !kw('or') && !at(T.RPAREN) && !isComparisonNext() &&
          !kw('if') && !kw('unless') && !kw('called')) {
          args.push(arithmetic());
          if (!eat(T.COMMA)) break;
        }
        if (args.length > 0) return N('Call', { name, args });
        return N('Ref', { name });
      }
      // registered function: always produce a Call node
      if (signatures.has(name)) {
        const sig = signatures.get(name);
        // if sig is empty or no args available, still produce Call with 0 args (auto-invoke)
        if (!at(T.NL) && !at(T.EOF) && !kw('end') && !kw('otherwise') && !kw('else') &&
          !kw('then') && !kw('as') && !kw('into') && !kw('called') && !at(T.RPAREN) &&
          !isComparisonNext() && !kw('and') && !kw('or') && !kw('if') && !kw('unless') &&
          !at(T.CONCAT)) {
          const args = parseCallArgs(name);
          return N('Call', { name, args });
        }
        return N('Call', { name, args: [] });
      }
      return N('Ref', { name });
    }

    // keyword used as a name (registered function)
    if (at(T.KW) && signatures.has(cur().value)) {
      const name = cur().value; pos++;
      // try to consume args (only if followed by a value, not a statement boundary)
      if (!at(T.NL) && !at(T.EOF) && !kw('end') && !kw('otherwise') && !kw('else') &&
        !kw('then') && !kw('as') && !kw('into') && !kw('called') && !at(T.RPAREN) &&
        !isComparisonNext() && !kw('and') && !kw('or') && !kw('if') && !kw('unless')) {
        const args = parseCallArgs(name);
        if (args.length > 0) return N('Call', { name, args });
      }
      return N('Ref', { name });
    }

    // builtin coercion calls: number (keyword) or text (ID) that take 1 arg
    if (kw('number') || (at(T.ID) && cur().value === 'text')) {
      const saved = pos;
      const name = cur().value; pos++;
      // only if followed by a value (not 'of', not comparison, not end of line)
      if (!at(T.NL) && !at(T.EOF) && !kw('of') && !isComparisonNext()) {
        const arg = atom();
        return N('Call', { name, args: [arg] });
      }
      pos = saved;
    }

    // fallback: treat unrecognized keywords as identifiers (field names in row context)
    if (at(T.KW)) {
      const name = cur().value; pos++;
      return N('Ref', { name });
    }

    const t = cur();
    throw new Error(`Unexpected token: ${t.value || t.type} at line ${t.line}`);
  }

  // ── repeat count expression (stops before times/time keyword) ──
  // Uses arithmetic but 'times' is NOT consumed as multiplication
  function repeatCountExpr() {
    let left = repeatTerm();
    while (true) {
      if (eat(T.OP, '+') || eatKw('plus')) { left = N('BinOp', { op: '+', left, right: repeatTerm() }); continue; }
      if (eat(T.OP, '-') || eatKw('minus')) { left = N('BinOp', { op: '-', left, right: repeatTerm() }); continue; }
      break;
    }
    return left;
  }
  function repeatTerm() {
    let left = exponent();
    while (true) {
      // times/time here means the loop terminator, not multiplication — stop
      if (kw('times') || kw('time')) break;
      if (eat(T.OP, '*')) { left = N('BinOp', { op: '*', left, right: exponent() }); continue; }
      if (eat(T.OP, '/') || eatKw('over')) { left = N('BinOp', { op: '/', left, right: exponent() }); continue; }
      if (eat(T.OP, '%') || eatKw('mod')) { left = N('BinOp', { op: '%', left, right: exponent() }); continue; }
      break;
    }
    return left;
  }

  // ── condition parsing (used by if/keep/while/etc.) ──

  function condition() {
    let left = singleCondition();
    while (kw('and') || kw('or')) {
      // "and then" is a pipe, not logic
      if (kw('and') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'then') break;
      const op = cur().value; pos++;
      left = N('Logic', { op, left, right: singleCondition() });
    }
    return left;
  }

  function singleCondition() {
    // there is a / there is no
    if (kw('there')) {
      pos++; expectKw('is');
      if (kw('no')) { pos++; const name = expectName(); return N('ThereIsNo', { name }); }
      eatKw('a'); eatKw('an');
      const name = expectName();
      return N('ThereIs', { name });
    }
    if (kw('not') || at(T.BANG)) {
      if (kw('not')) pos++; else pos++;
      return N('Unary', { op: 'not', expr: singleCondition() });
    }
    let left = concat();
    // between
    if (kw('between')) {
      pos++;
      const lo = arithmetic();
      expectKw('and');
      const hi = arithmetic();
      return N('Between', { value: left, lo, hi });
    }
    // contains
    if (kw('contains')) { pos++; return N('Compare', { op: 'contains', left, right: concat() }); }
    // matches
    if (kw('matches')) { pos++; return N('Compare', { op: 'matches', left, right: concat() }); }
    // is a / is not a type check
    if (kw('is')) {
      const saved = pos; pos++;
      const negated = !!eatKw('not');
      if (kw('a') || kw('an')) {
        pos++;
        const typeName = expectName();
        const node = N('TypeCheck', { expr: left, typeName });
        return negated ? N('Unary', { op: 'not', expr: node }) : node;
      }
      pos = saved;
    }
    // comparison
    const cop = comparisonOp();
    if (cop) {
      return N('Compare', { op: cop, left, right: concat() });
    }
    // bare truthy
    return left;
  }

  // ── statement parsing ──

  function program() {
    prescan();
    const body = [];
    skipNL();
    while (!at(T.EOF)) {
      body.push(statement());
      skipNL();
    }
    return N('Program', { body });
  }

  function block() {
    const body = [];
    skipNL();
    while (!at(T.EOF) && !kw('end') && !kw('otherwise') && !kw('else') && !kwIs('if', 'it')) {
      body.push(statement());
      skipNL();
    }
    return body;
  }

  // peek for "if it fails" (try/catch)
  function kwIs(a, b) {
    return kw(a) && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === b;
  }

  function statement() {
    const t = cur();

    // -- set --
    if (kw('set')) return setStmt();
    // -- put --
    if (kw('put')) return putStmt();
    // -- say / show --
    if (kw('say') || kw('show')) return sayStmt();
    // -- if --
    if (kw('if')) return ifStmt();
    // -- unless --
    if (kw('unless')) return unlessStmt();
    // -- repeat / while / until / for --
    if (kw('repeat') || kw('while') || kw('until') || kw('for')) return repeatStmt();
    // -- define --
    if (kw('define')) return defineStmt();
    // -- return --
    if (kw('return')) return returnStmt();
    // -- use --
    if (kw('use')) return useStmt();
    // -- stop (with optional suffix conditional) --
    if (kw('stop')) { pos++; return suffixConditional(N('Stop')); }
    // -- skip (with optional suffix conditional) --
    if (kw('skip')) { pos++; return suffixConditional(N('Skip')); }
    // -- add --
    if (kw('add')) return addStmt();
    // -- remove --
    if (kw('remove')) return removeStmt();
    // -- try --
    if (kw('try')) return tryStmt();
    // -- assume --
    if (kw('assume')) return assumeStmt();
    // -- suppose --
    if (kw('suppose')) return supposeStmt();
    // -- explain --
    if (kw('explain')) return explainStmt();
    // -- on (event) --
    if (kw('on')) return onStmt();

    // -- pipeline result capture (standalone into/as on its own line) --
    if (kw('into') || (kw('as') && tokens[pos + 1]?.type === T.ID)) {
      pos++; // eat 'into'/'as'
      const name = expectName();
      return N('Capture', { expr: N('Ref', { name: 'it' }), name });
    }

    // -- pipeline transforms --
    if (kw('take') || kw('from')) return takeStmt();
    if (kw('keep') || kw('drop') || kw('only') || kw('where')) return filterStmt();
    if (kw('sort')) return sortStmt();
    if (kw('average') || kw('total') || kw('smallest') || kw('largest') ||
      kw('mean') || kw('sum') || kw('min') || kw('max')) return aggStmt();
    if (kw('count')) return countStmt();
    if (kw('first') || kw('last') || kw('top')) return limitStmt();
    if (kw('group')) return groupStmt();
    if (kw('pick') || kw('get')) return pickStmt();
    if (kw('round')) return roundStmt();
    if (kw('with')) return withStmt();

    // -- load / save / make --
    if (kw('load')) return loadStmt();
    if (kw('save')) return saveStmt();
    if (kw('make')) return makeStmt();

    // -- statement-level function call (registered name) --
    if ((at(T.ID) || at(T.KW)) && signatures.has(cur().value)) {
      return identStmt();
    }

    // -- expression statement (possibly with suffix conditional or result capture) --
    return exprStmt();
  }

  function setStmt() {
    pos++; // eat 'set'
    // skip noise words: set THE cutoff to 50
    while (kw('the') || kw('a') || kw('an') || kw('that') || kw('this')) pos++;

    // check for chunk write: set word 2 of text to "big"
    if (kw('character') || kw('word') || kw('line') || kw('item')) {
      const kind = cur().value; pos++;
      const index = atom();
      expectKw('of');
      const target = expectName();
      expectKw('to');
      const value = expression();
      return N('SetChunk', { kind, index, target, value });
    }

    const name = expectName();

    // check for of-path write: set grade of row to 60
    if (kw('of')) {
      const path = [name];
      while (eatKw('of')) path.push(expectName());
      expectKw('to');
      const value = expression();
      return N('SetOf', { path, value });
    }

    expectKw('to');
    const value = expression();
    return N('Set', { name, value });
  }

  function putStmt() {
    pos++; // eat 'put'
    const value = expression();
    expectKw('into');
    // skip noise words
    while (kw('the') || kw('a') || kw('an') || kw('that') || kw('this')) pos++;

    // check for chunk target
    if (kw('character') || kw('word') || kw('line') || kw('item')) {
      const kind = cur().value; pos++;
      const index = atom();
      expectKw('of');
      const target = expectName();
      return N('SetChunk', { kind, index, target, value });
    }

    const name = expectName();
    // check for of-path
    if (kw('of')) {
      const path = [name];
      while (eatKw('of')) path.push(expectName());
      return N('SetOf', { path, value });
    }
    return N('Set', { name, value });
  }

  function sayStmt() {
    pos++; // eat 'say'/'show'
    const parts = [expression()];
    // juxtaposition: auto-concat when followed by a value token
    // STR/NUM/LPAREN are unambiguous. IDs are allowed too (common pattern: "text" variable "text")
    while (!at(T.NL) && !at(T.EOF) && (at(T.STR) || at(T.NUM) || at(T.LPAREN) || at(T.ID) ||
      (at(T.KW) && !isComparisonNext() && !kw('if') && !kw('unless') && !kw('and') && !kw('or') &&
       !kw('then') && !kw('as') && !kw('into') && !kw('called') && !kw('end')))) {
      parts.push(expression());
    }
    if (parts.length === 1) return N('Say', { value: parts[0] });
    return N('Say', { value: N('Juxtapose', { parts }) });
  }

  function ifStmt() {
    pos++; // eat 'if'
    const cond = condition();
    eatKw('do');
    expectNL();
    const body = block();
    let elseBody = null;
    if (kw('otherwise') || kw('else')) {
      pos++;
      expectNL();
      elseBody = block();
    }
    expectKw('end');
    return N('If', { cond, body, elseBody });
  }

  function unlessStmt() {
    pos++; // eat 'unless'
    const cond = condition();
    eatKw('do');
    expectNL();
    const body = block();
    expectKw('end');
    return N('If', { cond: N('Unary', { op: 'not', expr: cond }), body, elseBody: null });
  }

  function repeatStmt() {
    const word = cur().value; pos++;

    // while/until at statement start
    if (word === 'while') {
      const cond = condition();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('While', { cond, body });
    }
    if (word === 'until') {
      const cond = condition();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('While', { cond: N('Unary', { op: 'not', expr: cond }), body });
    }
    if (word === 'for') {
      eatKw('each');
      const varName = expectName();
      expectKw('in');
      const iter = expression();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('ForEach', { varName, iter, body });
    }

    // repeat ...
    // repeat each
    if (eatKw('for') || eatKw('to')) { /* optional filler: "repeat for each" / "repita para cada" */ }
    if (kw('each')) {
      pos++;
      const varName = expectName();
      expectKw('in');
      const iter = expression();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('ForEach', { varName, iter, body });
    }
    // repeat while
    if (kw('while')) {
      pos++;
      const cond = condition();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('While', { cond, body });
    }
    // repeat until
    if (kw('until')) {
      pos++;
      const cond = condition();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('While', { cond: N('Unary', { op: 'not', expr: cond }), body });
    }
    // repeat from X to Y [by Z] as I
    if (kw('from')) {
      pos++;
      const from = arithmetic();
      expectKw('to');
      const to = arithmetic();
      let step = null;
      if (eatKw('by')) step = arithmetic();
      if (eatKw('as') || eatKw('into')) { /* consume */ }
      const varName = expectName();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('RangeLoop', { varName, from, to, step, body });
    }
    // repeat N times — parse count as a simple expression, stop before times/time
    const count = repeatCountExpr();
    if (!eatKw('times')) eatKw('time');
    eatKw('do'); expectNL();
    const body = block();
    expectKw('end');
    return N('Repeat', { count, body });
  }

  function defineStmt() {
    pos++; // eat 'define'
    const name = expectName();
    const sig = parseSignature();
    expectNL();
    const body = block();
    expectKw('end');
    return N('Define', { name, sig, body });
  }
  // note: nested defines are NOT registered in signatures — sibling inner functions
  // call each other via `call`/`run`/`result of`. this avoids the return-auto-call
  // problem where `return inner_func` would invoke instead of returning the value.

  function parseSignature() {
    const params = [];
    // skip noise: takes, with
    while (kw('takes') || kw('with')) pos++;
    while (!at(T.NL) && !at(T.EOF)) {
      // variadic
      if (kw('many') || kw('all')) {
        pos++;
        const pname = expectName();
        params.push({ param: pname, variadic: true });
        break;
      }
      // skip 'and' between params
      if (kw('and')) { pos++; continue; }
      // separator keyword + param (or variadic)
      if (at(T.KW) && !isExpressionStart(cur().value)) {
        const nextTok = tokens[pos + 1];
        if (nextTok && (nextTok.type === T.ID || (nextTok.type === T.KW && isParamName(nextTok.value)))) {
          const sep = cur().value; pos++;
          // check for variadic after separator: "of many numbers"
          if (kw('many') || kw('all')) {
            pos++;
            const pname = expectName();
            params.push({ sep, param: pname, variadic: true });
            break;
          }
          const pname = expectName();
          let dflt;
          if (eatKw('is')) dflt = expression();
          params.push({ sep, param: pname, default: dflt });
          continue;
        }
      }
      // bare param
      if (at(T.ID) || (at(T.KW) && isParamName(cur().value))) {
        const pname = expectName();
        let dflt;
        if (eatKw('is')) dflt = expression();
        params.push({ param: pname, default: dflt });
        continue;
      }
      break;
    }
    return params;
  }

  function returnStmt() {
    pos++; // eat 'return'
    if (at(T.NL) || at(T.EOF)) return N('Return', { value: null });
    return N('Return', { value: expression() });
  }

  function makeStmt() {
    pos++; // eat 'make'
    const tag = expression();
    let parent = null;
    if (eatKw('in')) parent = expression();
    let name = null;
    if (eatKw('as') || eatKw('into')) name = expectName();
    return N('Make', { tag, parent, name });
  }

  function loadStmt() {
    pos++; // eat 'load'
    const path = expression();
    let name = null;
    if (eatKw('into') || eatKw('as')) name = expectName();
    return N('Load', { path, name });
  }

  function saveStmt() {
    pos++; // eat 'save'
    const value = expression();
    expectKw('to');
    const path = expression();
    return N('Save', { value, path });
  }

  function useStmt() {
    pos++; // eat 'use'
    const t = cur();
    if (t.type !== T.ID) throw new Error(`Expected dot-path after 'use' at line ${t.line}`);
    const path = t.value; pos++;
    let alias = null;
    if (eatKw('as')) alias = expectName();
    // optional signature (skip for now — pre-scan already captured it)
    return N('Use', { path, alias });
  }

  function addStmt() {
    pos++; // eat 'add'
    const value = expression();
    expectKw('to');
    const target = expectName();
    return N('Add', { value, target });
  }

  function removeStmt() {
    pos++; // eat 'remove'
    const value = expression();
    expectKw('from');
    const target = expectName();
    return N('Remove', { value, target });
  }

  function tryStmt() {
    pos++; // eat 'try'
    expectNL();
    const body = block();
    expectKw('if'); expectKw('it'); expectKw('fails');
    expectNL();
    const handler = block();
    expectKw('end');
    return N('Try', { body, handler });
  }

  function assumeStmt() {
    pos++; // eat 'assume'
    const cond = condition();
    let message = null;
    if (eatKw('otherwise')) message = expression();
    return N('Assume', { cond, message });
  }

  function supposeStmt() {
    pos++; // eat 'suppose'
    const name = expectName();
    expectKw('is');
    const value = expression();
    expectNL();
    const body = block();
    expectKw('end');
    return N('Suppose', { name, value, body });
  }

  function explainStmt() {
    pos++; // eat 'explain'
    // for now, just parse the rest as an expression
    const expr = expression();
    return N('Explain', { expr });
  }

  function onStmt() {
    pos++; // eat 'on'
    const event = expectName();
    let target = null;
    // optional target and params
    if (at(T.ID) || at(T.KW)) {
      if (!at(T.NL)) target = expectName();
    }
    expectNL();
    const body = block();
    expectKw('end');
    return N('On', { event, target, body });
  }

  // ── pipeline transforms ──

  function pipelineCapture(node) {
    // check for "called <name>" mid-pipeline naming
    if (eatKw('called')) {
      const capName = expectName();
      node = N('PipeCalled', { step: node, name: capName });
    }
    // check for "then" / "and then" chaining
    return maybeThen(node);
  }

  function maybeThen(node) {
    const steps = [node];
    while (true) {
      // "and then" or bare "then"
      if (kw('and') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'then') {
        pos += 2;
      } else if (eatKw('then')) {
        // consumed
      } else {
        break;
      }
      steps.push(parsePipelineStep());
    }
    if (steps.length === 1) {
      // check for terminal capture after the whole chain
      if (eatKw('as') || eatKw('into')) {
        const name = expectName();
        return N('Capture', { expr: steps[0], name });
      }
      return steps[0];
    }
    let result = N('Pipeline', { steps });
    // terminal capture
    if (eatKw('as') || eatKw('into')) {
      const name = expectName();
      return N('Capture', { expr: result, name });
    }
    return result;
  }

  // parse a single pipeline step (after 'then') — raw, no pipelineCapture wrapping
  function parsePipelineStep() {
    let node;
    if (kw('keep') || kw('drop') || kw('only') || kw('where')) node = filterRaw();
    else if (kw('sort')) node = sortRaw();
    else if (kw('average') || kw('total') || kw('smallest') || kw('largest') ||
      kw('mean') || kw('sum') || kw('min') || kw('max')) node = aggRaw();
    else if (kw('count')) node = countRaw();
    else if (kw('first') || kw('last') || kw('top')) node = limitRaw();
    else if (kw('group')) node = groupRaw();
    else if (kw('pick') || kw('get')) node = pickRaw();
    else if (kw('round')) node = roundRaw();
    else if (kw('with')) node = withRaw();
    else {
      // function piping: piped value becomes first arg
      const expr = expression();
      return N('PipeCall', { expr });
    }
    // handle called (but NOT then — that's handled by the outer maybeThen)
    if (eatKw('called')) {
      const capName = expectName();
      node = N('PipeCalled', { step: node, name: capName });
    }
    return node;
  }

  // ── raw pipeline parsers (no capture/then wrapping) ──

  function filterRaw() {
    const op = cur().value; pos++;
    const cond = condition();
    return N('Filter', { op: (op === 'drop') ? 'drop' : 'keep', cond });
  }
  function sortRaw() {
    pos++; eatKw('by');
    const field = expectName();
    let order = 'ascending';
    if (eatKw('descending')) order = 'descending';
    else eatKw('ascending');
    return N('Sort', { field, order });
  }
  function aggRaw() {
    const op = cur().value; pos++;
    eatKw('of');
    const field = expectName();
    const canon = { average: 'average', mean: 'average', total: 'total', sum: 'total',
      smallest: 'smallest', min: 'smallest', largest: 'largest', max: 'largest' }[op] || op;
    return N('Aggregate', { op: canon, field });
  }
  function countRaw() { pos++; eatKw('rows'); return N('Count'); }
  function limitRaw() {
    const op = cur().value; pos++;
    let n = null;
    if (at(T.NUM)) { n = N('Num', { value: parseNumber(cur().value) }); pos++; }
    return N('Limit', { op: (op === 'top') ? 'first' : op, n });
  }
  function groupRaw() { pos++; expectKw('by'); return N('Group', { field: expectName() }); }
  function pickRaw() {
    pos++;
    const fields = [expectName()];
    while (eatKw('and')) fields.push(expectName());
    return N('Pick', { fields });
  }
  function roundRaw() {
    pos++;
    // round <expr> to <n> (explicit value) or round to <n> (pipeline, uses it)
    let value = null;
    if (!kw('to')) {
      value = arithmetic();
    }
    expectKw('to');
    const t = cur();
    if (t.type !== T.NUM) throw new Error(`Expected number after 'round to' at line ${t.line}`);
    const places = parseNumber(t.value); pos++;
    return N('Round', { places, value });
  }
  function withRaw() {
    pos++;
    const field = expectName();
    if (!eatKw('is') && !eatKw('being') && !eatKw('as'))
      throw new Error(`Expected 'is', 'being', or 'as' after field name in 'with' at line ${cur().line}`);
    return N('With', { field, expr: expression() });
  }

  // ── statement-level pipeline parsers (with capture/then) ──

  function takeStmt() { pos++; return pipelineCapture(N('Take', { name: expectName() })); }
  function filterStmt() { return pipelineCapture(filterRaw()); }
  function sortStmt() { return pipelineCapture(sortRaw()); }
  function aggStmt() { return pipelineCapture(aggRaw()); }
  function countStmt() { return pipelineCapture(countRaw()); }
  function limitStmt() { return pipelineCapture(limitRaw()); }
  function groupStmt() { return pipelineCapture(groupRaw()); }
  function pickStmt() { return pipelineCapture(pickRaw()); }
  function roundStmt() { return pipelineCapture(roundRaw()); }
  function withStmt() { return pipelineCapture(withRaw()); }

  function identStmt() {
    const name = cur().value; pos++;
    const args = parseCallArgs(name);
    const call = N('Call', { name, args });
    // result capture
    if (eatKw('as') || eatKw('into')) {
      const capName = expectName();
      return suffixConditional(N('Capture', { expr: call, name: capName }));
    }
    return suffixConditional(N('ExprStmt', { expr: call }));
  }

  function parseCallArgs(name) {
    const sig = signatures.get(name);
    const args = [];
    if (!sig || sig.length === 0) {
      // no declared sig: consume values until NL/EOF/statement keywords
      while (!at(T.NL) && !at(T.EOF) && !kw('as') && !kw('into') && !kw('if') && !kw('unless') && !kw('called')) {
        args.push(arithmetic());
        if (!eat(T.COMMA)) break;
      }
      return args;
    }
    // sig-aware parsing
    for (let i = 0; i < sig.length; i++) {
      const p = sig[i];
      // skip 'and' between params (§5.1)
      eatKw('and');
      // consume separator keyword if present
      if (p.sep) {
        if (kw(p.sep)) pos++;
        else if (i > 0) break; // optional trailing params
      }
      // variadic: collect remaining
      if (p.variadic) {
        while (!at(T.NL) && !at(T.EOF) && !kw('as') && !kw('into') && !kw('if') && !kw('unless') && !kw('called')) {
          eatKw('and'); // skip 'and' separators in variadic
          args.push(arithmetic());
          eat(T.COMMA);
        }
        break;
      }
      // regular param
      if (at(T.NL) || at(T.EOF)) {
        // no more args — use default if available
        break;
      }
      args.push(arithmetic());
    }
    return args;
  }

  function suffixConditional(stmt) {
    if (kw('if')) {
      pos++;
      const cond = condition();
      return N('If', { cond, body: [stmt], elseBody: null });
    }
    if (kw('unless')) {
      pos++;
      const cond = condition();
      return N('If', { cond: N('Unary', { op: 'not', expr: cond }), body: [stmt], elseBody: null });
    }
    return stmt;
  }

  function exprStmt() {
    const expr = expression();
    let node = N('ExprStmt', { expr });
    // check for then-chaining (allows "value" then func then func)
    node = maybeThen(node);
    // suffix conditional
    return suffixConditional(node);
  }

  // ── helpers ──

  function parseNumber(s) {
    if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
    if (s.startsWith('0b') || s.startsWith('0B')) return parseInt(s.slice(2), 2);
    if (s.startsWith('0o') || s.startsWith('0O')) return parseInt(s.slice(2), 8);
    return parseFloat(s);
  }

  return program();
}

// -- eval.js --

// soft — tree-walking evaluator
// Executes a Soft AST. No external dependencies except the parser.


// ── scope (lexical, with prototype chain) ──

function createScope(parent) {
  const scope = Object.create(parent || null);
  scope._parent = parent || null;
  return scope;
}

function scopeSet(scope, name, value) {
  // walk up to find owning scope; if none, create in current
  let s = scope;
  while (s) {
    if (Object.prototype.hasOwnProperty.call(s, name) && name !== '_parent') {
      s[name] = value; return;
    }
    if (!s._parent) break;
    s = s._parent;
  }
  scope[name] = value;
}

// ── return/stop/skip signals ──

class ReturnSignal { constructor(value) { this.value = value; } }
class StopSignal {}
class SkipSignal {}

// ── stringify (§12) ──

function softString(value) {
  if (value === null || value === undefined) return 'nothing';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    if (typeof value[0] === 'object' && value[0] !== null) return formatTable(value);
    return value.map(softString).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}: ${softString(v)}`).join(', ');
  }
  return String(value);
}

function formatTable(rows) {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k => Math.max(k.length, ...rows.map(r => softString(r[k]).length)));
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const sep = widths.map(w => '─'.repeat(w)).join('──');
  const body = rows.map(r => keys.map((k, i) => softString(r[k]).padEnd(widths[i])).join('  ')).join('\n');
  return header + '\n' + sep + '\n' + body;
}

// ── truthiness (§8) ──

function isTruthy(v) {
  if (v === false || v === null || v === undefined || v === 0 || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

// ── builtins (§10) ──

const BUILTINS = {
  abs: (x) => Math.abs(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  sqrt: (x) => Math.sqrt(x),
  random: () => Math.random(),
  number: (x) => Number(x),
  text: (x) => softString(x),
};

// ── glob matching ──

function globMatch(str, pattern) {
  // convert glob to regex
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      let cls = '[';
      i++;
      if (i < pattern.length && pattern[i] === '!') { cls += '^'; i++; }
      while (i < pattern.length && pattern[i] !== ']') { cls += pattern[i]; i++; }
      cls += ']';
      re += cls;
    }
    else re += c.replace(/[.*+?^${}()|\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re, 'i').test(str);
}

// ── main evaluator ──

function softEval(code, options) {
  const ast = typeof code === 'string' ? softParse(code) : code;
  const output = [];
  const globals = (options && options.globals) || {};
  const scope = createScope(null);

  // inject builtins into scope
  for (const [name, fn] of Object.entries(BUILTINS)) scope[name] = fn;

  // default host globals
  const defaultGlobals = {
    Math: typeof Math !== 'undefined' ? Math : {},
    Text: {
      upper: (s) => String(s).toUpperCase(),
      lower: (s) => String(s).toLowerCase(),
      trim: (s) => String(s).trim(),
      split: (s, sep) => String(s).split(sep),
      replace: (s, a, b) => String(s).replaceAll(a, b),
      starts: (s, p) => String(s).startsWith(p),
      ends: (s, p) => String(s).endsWith(p),
      slice: (s, a, b) => String(s).slice(a, b),
    },
    List: {
      range: (a, b, step) => { const r = []; if (b === undefined) { b = a; a = 0; } step = step || 1; for (let i = a; step > 0 ? i < b : i > b; i += step) r.push(i); return r; },
      reverse: (arr) => [...arr].reverse(),
      flat: (arr) => arr.flat(),
      unique: (arr) => [...new Set(arr)],
      join: (arr, sep) => arr.join(sep ?? ', '),
    },
  };

  // inject defaults, then user-provided globals override
  for (const [name, val] of Object.entries(defaultGlobals)) scope[name] = val;
  for (const [name, val] of Object.entries(globals)) scope[name] = val;

  // inject upstream scope (from Auditable DAG)
  const scopeInit = (options && options.scopeInit) || {};
  for (const [name, val] of Object.entries(scopeInit)) scope[name] = val;

  // host functions (file I/O, DOM, events — injected by cell handler)
  const host = (options && options.host) || {};

  // it — implicit result variable
  scope.it = null;

  let steps = 0;
  const maxSteps = (options && options.maxSteps) || 50000;
  let callDepth = 0;
  const maxCallDepth = (options && options.maxCallDepth) || 1000;

  function step() {
    if (++steps > maxSteps) throw new Error('Step limit exceeded (possible infinite loop)');
  }

  // ── eval node ──

  function lineError(node, e) {
    if (e._softLine) throw e; // already tagged
    const msg = e.message || String(e);
    const err = new Error(node.line ? `${msg} (line ${node.line})` : msg);
    err._softLine = true;
    throw err;
  }

  function evalNode(node, sc) {
    step();
    switch (node.type) {
      case 'Program': return evalProgram(node, sc);
      case 'Say': return evalSay(node, sc);
      case 'Set': return evalSet(node, sc);
      case 'SetOf': return evalSetOf(node, sc);
      case 'SetChunk': return evalSetChunk(node, sc);
      case 'If': return evalIf(node, sc);
      case 'While': return evalWhile(node, sc);
      case 'Repeat': return evalRepeat(node, sc);
      case 'ForEach': return evalForEach(node, sc);
      case 'RangeLoop': return evalRangeLoop(node, sc);
      case 'Define': return evalDefine(node, sc);
      case 'Return': return evalReturn(node, sc);
      case 'ExprStmt': return evalExprStmt(node, sc);
      case 'Capture': return evalCapture(node, sc);
      case 'Stop': throw new StopSignal();
      case 'Skip': throw new SkipSignal();
      case 'Add': return evalAdd(node, sc);
      case 'Remove': return evalRemove(node, sc);
      case 'Try': return evalTry(node, sc);
      case 'Assume': return evalAssume(node, sc);
      case 'Suppose': return evalSuppose(node, sc);
      case 'Use': return evalUse(node, sc);
      case 'On': return evalOn(node, sc);
      case 'Load': return evalLoad(node, sc);
      case 'Save': return evalSave(node, sc);
      case 'Make': return evalMake(node, sc);
      case 'Explain': return null; // TODO
      // pipeline transforms
      case 'Take': return evalTake(node, sc);
      case 'Filter': return evalFilter(node, sc);
      case 'Sort': return evalSort(node, sc);
      case 'Aggregate': return evalAggregate(node, sc);
      case 'Count': return evalCount(node, sc);
      case 'Limit': return evalLimit(node, sc);
      case 'Group': return evalGroup(node, sc);
      case 'Pick': return evalPick(node, sc);
      case 'Round': return evalRound(node, sc);
      case 'With': return evalWith(node, sc);
      case 'PipeCalled': return evalPipeCalled(node, sc);
      case 'Pipeline': return evalPipeline(node, sc);
      case 'PipeCall': return evalPipeCall(node, sc);
      default: throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  function evalExpr(node, sc) {
    step();
    try { return evalExprInner(node, sc); } catch (e) {
      if (e instanceof ReturnSignal || e instanceof StopSignal || e instanceof SkipSignal) throw e;
      if (e._softLine) throw e;
      lineError(node, e);
    }
  }
  function evalExprInner(node, sc) {
    switch (node.type) {
      case 'Num': return node.value;
      case 'Str': return node.value;
      case 'Regex': {
        // value is "pattern" or "pattern/flags"
        const v = node.value;
        const slashIdx = v.lastIndexOf('/');
        if (slashIdx > 0) return new RegExp(v.slice(0, slashIdx), v.slice(slashIdx + 1));
        return new RegExp(v);
      }
      case 'Bool': return node.value;
      case 'Nothing': return null;
      case 'Ref': return evalRef(node, sc);
      case 'Group': return evalExpr(node.expr, sc);
      case 'BinOp': return evalBinOp(node, sc);
      case 'Unary': return evalUnary(node, sc);
      case 'Compare': return evalCompare(node, sc);
      case 'Logic': return evalLogic(node, sc);
      case 'Of': return evalOf(node, sc);
      case 'LengthOf': return evalLengthOf(node, sc);
      case 'Call': return evalCall(node, sc);
      case 'List': return node.items.map(i => evalExpr(i, sc));
      case 'Record': return evalRecord(node, sc);
      case 'RecordWith': return evalRecordWith(node, sc);
      case 'Ternary': return evalTernary(node, sc);
      case 'Between': return evalBetween(node, sc);
      case 'TypeCheck': return evalTypeCheck(node, sc);
      case 'Invoke': return evalInvoke(node, sc);
      case 'RoundExpr': {
        const val = evalExpr(node.value, sc);
        const f = Math.pow(10, node.places);
        return Math.round(val * f) / f;
      }
      case 'Juxtapose': return node.parts.map(p => softString(evalExpr(p, sc))).join('');
      case 'Chunk': return evalChunk(node, sc);
      case 'ChunkRange': return evalChunkRange(node, sc);
      case 'CountChunks': return evalCountChunks(node, sc);
      case 'ThereIs': return sc[node.name] !== undefined && sc[node.name] !== null;
      case 'ThereIsNo': return sc[node.name] === undefined || sc[node.name] === null;
      default: throw new Error(`Unknown expr type: ${node.type}`);
    }
  }

  // ── statement evaluators ──

  function evalProgram(node, sc) {
    let result = null;
    for (const stmt of node.body) {
      result = evalNode(stmt, sc);
      if (result instanceof ReturnSignal) return result.value;
    }
    return result;
  }

  function evalBlock(body, sc) {
    let result = null;
    for (const stmt of body) {
      result = evalNode(stmt, sc);
      if (result instanceof ReturnSignal) return result;
    }
    return result;
  }

  function evalSay(node, sc) {
    const val = evalExpr(node.value, sc);
    output.push(val); // push raw value — cell handler decides rendering
    return null;
  }

  function evalSet(node, sc) {
    const val = evalExpr(node.value, sc);
    scopeSet(sc, node.name, val);
    return null;
  }

  // set grade of row to 60 → path = ['grade', 'row'], value = 60
  // resolves right to left: row.grade = 60
  function evalSetOf(node, sc) {
    const val = evalExpr(node.value, sc);
    const path = node.path; // ['grade', 'row'] or ['name', 'author', 'book']
    // rightmost name is the root object
    const root = sc[path[path.length - 1]];
    if (root == null) throw new Error(`"${path[path.length - 1]}" is not defined`);
    if (path.length === 2) {
      root[path[0]] = val;
    } else {
      // walk from right to left: book.author.name = val
      let obj = root;
      for (let i = path.length - 2; i > 0; i--) obj = obj[path[i]];
      obj[path[0]] = val;
    }
    return null;
  }

  // set word 2 of text to "big"
  function evalSetChunk(node, sc) {
    const val = evalExpr(node.value, sc);
    const idx = evalExpr(node.index, sc);
    const str = String(sc[node.target]);
    let result;
    switch (node.kind) {
      case 'character': {
        const chars = [...str];
        chars[idx] = String(val);
        result = chars.join('');
        break;
      }
      case 'word': {
        const words = str.split(/(\s+)/); // preserve whitespace
        let wordIdx = 0;
        for (let i = 0; i < words.length; i++) {
          if (!/^\s+$/.test(words[i])) {
            if (wordIdx === idx) { words[i] = String(val); break; }
            wordIdx++;
          }
        }
        result = words.join('');
        break;
      }
      case 'line': {
        const lines = str.split('\n');
        lines[idx] = String(val);
        result = lines.join('\n');
        break;
      }
      case 'item': {
        const items = str.split(',').map(s => s.trim());
        items[idx] = String(val);
        result = items.join(', ');
        break;
      }
      default: throw new Error(`Unknown chunk kind: ${node.kind}`);
    }
    scopeSet(sc, node.target, result);
    return null;
  }

  function evalIf(node, sc) {
    const cond = evalExpr(node.cond, sc);
    if (isTruthy(cond)) {
      return evalBlock(node.body, sc);
    } else if (node.elseBody) {
      return evalBlock(node.elseBody, sc);
    }
    return null;
  }

  function evalWhile(node, sc) {
    while (isTruthy(evalExpr(node.cond, sc))) {
      try {
        const r = evalBlock(node.body, sc);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalRepeat(node, sc) {
    const n = evalExpr(node.count, sc);
    for (let i = 0; i < n; i++) {
      try {
        const r = evalBlock(node.body, sc);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalForEach(node, sc) {
    const iter = evalExpr(node.iter, sc);
    if (!Array.isArray(iter)) throw new Error(`Cannot iterate over ${typeof iter}`);
    const loopScope = createScope(sc);
    for (const item of iter) {
      loopScope[node.varName] = item;
      try {
        const r = evalBlock(node.body, loopScope);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalRangeLoop(node, sc) {
    const from = evalExpr(node.from, sc);
    const to = evalExpr(node.to, sc);
    let stepVal = node.step ? evalExpr(node.step, sc) : (from <= to ? 1 : -1);
    const loopScope = createScope(sc);
    if (stepVal > 0) {
      for (let i = from; i <= to; i += stepVal) {
        loopScope[node.varName] = i;
        try {
          const r = evalBlock(node.body, loopScope);
          if (r instanceof ReturnSignal) return r;
        } catch (e) {
          if (e instanceof StopSignal) break;
          if (e instanceof SkipSignal) continue;
          throw e;
        }
      }
    } else {
      for (let i = from; i >= to; i += stepVal) {
        loopScope[node.varName] = i;
        try {
          const r = evalBlock(node.body, loopScope);
          if (r instanceof ReturnSignal) return r;
        } catch (e) {
          if (e instanceof StopSignal) break;
          if (e instanceof SkipSignal) continue;
          throw e;
        }
      }
    }
    return null;
  }

  function evalDefine(node, sc) {
    const fn = makeSoftFunction(node.name, node.sig, node.body, sc);
    sc[node.name] = fn;
    return null;
  }

  function makeSoftFunction(name, sig, body, defScope) {
    const fn = function (...args) {
      const callScope = createScope(defScope);
      // bind params from args
      let argIdx = 0;
      for (const p of sig) {
        if (p.variadic) {
          callScope[p.param] = args.slice(argIdx);
          break;
        }
        if (argIdx < args.length) {
          callScope[p.param] = args[argIdx++];
        } else if (p.default !== undefined) {
          // default may be an AST node (from parser) — evaluate it
          callScope[p.param] = (typeof p.default === 'object' && p.default && p.default.type)
            ? evalExpr(p.default, defScope) : p.default;
        } else {
          callScope[p.param] = null;
        }
      }
      const result = evalBlock(body, callScope);
      if (result instanceof ReturnSignal) return result.value;
      return null;
    };
    fn._softName = name;
    fn._softSig = sig;
    return fn;
  }

  function evalReturn(node, sc) {
    const val = node.value ? evalExpr(node.value, sc) : null;
    return new ReturnSignal(val);
  }

  function evalExprStmt(node, sc) {
    const val = evalExpr(node.expr, sc);
    sc.it = val;
    return val;
  }

  const STMT_TYPES = new Set(['Pipeline', 'Take', 'Filter', 'Sort', 'Aggregate', 'Count',
    'Limit', 'Group', 'Pick', 'Round', 'With', 'PipeCalled', 'ExprStmt']);
  function evalCapture(node, sc) {
    // Pipeline and transform nodes are statements, not expressions
    const val = STMT_TYPES.has(node.expr.type) ? evalNode(node.expr, sc) : evalExpr(node.expr, sc);
    sc.it = val;
    scopeSet(sc, node.name, sc.it); // use sc.it because pipeline transforms set it
    return null;
  }

  function evalAdd(node, sc) {
    const val = evalExpr(node.value, sc);
    const arr = sc[node.target];
    if (!Array.isArray(arr)) throw new Error(`Cannot add to non-list "${node.target}"`);
    arr.push(val);
    return null;
  }

  function evalRemove(node, sc) {
    const val = evalExpr(node.value, sc);
    const arr = sc[node.target];
    if (!Array.isArray(arr)) throw new Error(`Cannot remove from non-list "${node.target}"`);
    const idx = arr.indexOf(val);
    if (idx !== -1) arr.splice(idx, 1);
    return null;
  }

  function evalTry(node, sc) {
    try {
      return evalBlock(node.body, sc);
    } catch (e) {
      if (e instanceof ReturnSignal || e instanceof StopSignal || e instanceof SkipSignal) throw e;
      const handlerScope = createScope(sc);
      handlerScope['the error'] = e.message || String(e);
      return evalBlock(node.handler, handlerScope);
    }
  }

  function evalAssume(node, sc) {
    const cond = evalExpr(node.cond, sc);
    if (!isTruthy(cond)) {
      const msg = node.message ? evalExpr(node.message, sc) : 'Assumption failed';
      throw new Error(softString(msg));
    }
    return null;
  }

  function evalSuppose(node, sc) {
    const oldVal = sc[node.name];
    const val = evalExpr(node.value, sc);
    sc[node.name] = val;
    const result = evalBlock(node.body, sc);
    sc[node.name] = oldVal;
    if (result instanceof ReturnSignal) return result;
    return null;
  }

  function evalUse(node, sc) {
    // resolve dot-path from globals
    const parts = node.path.split('.');
    let val = globals;
    for (const p of parts) {
      if (val == null) throw new Error(`Cannot resolve "${node.path}"`);
      val = val[p];
    }
    const name = node.alias || parts[parts.length - 1];
    sc[name] = val;
    return null;
  }

  // ── host-dependent evaluators (file I/O, DOM, events) ──

  function evalLoad(node, sc) {
    const path = evalExpr(node.path, sc);
    if (!host.load) throw new Error('load is not available in this environment');
    const data = host.load(path);
    sc.it = data;
    if (node.name) scopeSet(sc, node.name, data);
    return data;
  }

  function evalSave(node, sc) {
    const value = evalExpr(node.value, sc);
    const path = evalExpr(node.path, sc);
    if (!host.save) throw new Error('save is not available in this environment');
    host.save(path, value);
    return null;
  }

  function evalMake(node, sc) {
    const tag = evalExpr(node.tag, sc);
    const parent = node.parent ? evalExpr(node.parent, sc) : null;
    if (!host.make) throw new Error('make is not available in this environment');
    const el = host.make(tag, parent);
    sc.it = el;
    if (node.name) scopeSet(sc, node.name, el);
    return el;
  }

  function evalOn(node, sc) {
    const event = node.event;
    const target = node.target ? sc[node.target] : null;
    if (!host.on) return null; // silently skip in headless
    const handler = (e) => {
      const handlerScope = createScope(sc);
      // inject event object properties into handler scope
      if (e) {
        if (node.target) handlerScope[node.target] = e.target || e;
        handlerScope['the event'] = e;
        // common event properties as bare names
        if (e.key !== undefined) handlerScope.key = e.key;
        if (e.target) handlerScope.target = e.target;
        if (e.value !== undefined) handlerScope.value = e.value;
        else if (e.target?.value !== undefined) handlerScope.value = e.target.value;
      }
      try { evalBlock(node.body, handlerScope); } catch (err) {
        if (err instanceof StopSignal) return;
        if (!(err instanceof ReturnSignal)) throw err;
      }
    };
    host.on(event, target, handler);
    return null;
  }

  // ── pipeline evaluators ──

  // helper: evaluate an expression in row context (bare identifiers resolve against row first)
  function evalInRowContext(node, row, sc) {
    const rowScope = createScope(sc);
    for (const [k, v] of Object.entries(row)) rowScope[k] = v;
    return evalExpr(node, rowScope);
  }

  function evalCondInRowContext(node, row, sc) {
    const rowScope = createScope(sc);
    for (const [k, v] of Object.entries(row)) rowScope[k] = v;
    return isTruthy(evalExpr(node, rowScope));
  }

  function pipeSet(sc, val) { sc.it = val; return val; }

  function evalTake(node, sc) {
    const val = sc[node.name];
    if (val === undefined) throw new Error(`"${node.name}" is not defined`);
    return pipeSet(sc, val);
  }

  function evalFilter(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot filter: not a list`);
    const keep = node.op === 'keep';
    const result = data.filter(row => {
      const match = evalCondInRowContext(node.cond, row, sc);
      return keep ? match : !match;
    });
    return pipeSet(sc, result);
  }

  function evalSort(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot sort: not a list`);
    const field = node.field;
    const desc = node.order === 'descending';
    const sorted = [...data].sort((a, b) => {
      const va = a[field], vb = b[field];
      if (va < vb) return desc ? 1 : -1;
      if (va > vb) return desc ? -1 : 1;
      return 0;
    });
    return pipeSet(sc, sorted);
  }

  function evalAggregate(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot aggregate: not a list`);
    const vals = data.map(r => r[node.field]);
    let result;
    switch (node.op) {
      case 'average': result = vals.reduce((s, v) => s + v, 0) / vals.length; break;
      case 'total': result = vals.reduce((s, v) => s + v, 0); break;
      case 'smallest': result = Math.min(...vals); break;
      case 'largest': result = Math.max(...vals); break;
      default: throw new Error(`Unknown aggregate: ${node.op}`);
    }
    return pipeSet(sc, result);
  }

  function evalCount(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot count: not a list`);
    return pipeSet(sc, data.length);
  }

  function evalLimit(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot limit: not a list`);
    const n = node.n ? evalExpr(node.n, sc) : 1;
    const result = node.op === 'first' ? data.slice(0, n) : data.slice(-n);
    return pipeSet(sc, result);
  }

  function evalGroup(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot group: not a list`);
    const field = node.field;
    const groups = new Map();
    for (const row of data) {
      const key = row[field];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const result = [];
    for (const [key, rows] of groups) {
      result.push({ [field]: key, rows, count: rows.length });
    }
    return pipeSet(sc, result);
  }

  function evalPick(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot pick: not a list`);
    if (node.fields.length === 1) {
      // single field → flat array of values
      const f = node.fields[0];
      return pipeSet(sc, data.map(r => r[f]));
    }
    // multiple fields → array of objects
    const result = data.map(r => {
      const obj = {};
      for (const f of node.fields) obj[f] = r[f];
      return obj;
    });
    return pipeSet(sc, result);
  }

  function evalRound(node, sc) {
    const val = node.value ? evalExpr(node.value, sc) : sc.it;
    if (typeof val !== 'number') throw new Error(`Cannot round: not a number`);
    const factor = Math.pow(10, node.places);
    return pipeSet(sc, Math.round(val * factor) / factor);
  }

  function evalWith(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot compute column: not a list`);
    const result = data.map(row => {
      const val = evalInRowContext(node.expr, row, sc);
      return { ...row, [node.field]: val };
    });
    return pipeSet(sc, result);
  }

  function evalPipeCalled(node, sc) {
    const val = evalNode(node.step, sc);
    scopeSet(sc, node.name, sc.it);
    return val;
  }

  function evalPipeline(node, sc) {
    for (const step of node.steps) evalNode(step, sc);
    return sc.it;
  }

  // function piping: "value then func" → func(value)
  function evalPipeCall(node, sc) {
    const val = sc.it;
    const expr = node.expr;
    // Call node: prepend piped value as first arg
    if (expr.type === 'Call') {
      const fn = expr.name.includes('.') ? evalDotPath(expr.name, sc) : sc[expr.name];
      if (typeof fn !== 'function') throw new Error(`"${expr.name}" is not a function`);
      const args = [val, ...expr.args.map(a => evalExpr(a, sc))];
      return pipeSet(sc, fn(...args));
    }
    // Ref node: call with piped value as only arg
    if (expr.type === 'Ref') {
      const fn = expr.name.includes('.') ? evalDotPath(expr.name, sc) : sc[expr.name];
      if (typeof fn !== 'function') throw new Error(`"${expr.name}" is not a function`);
      return pipeSet(sc, fn(val));
    }
    // fallback: just evaluate and set it
    const result = evalExpr(expr, sc);
    return pipeSet(sc, result);
  }

  function evalDotPath(name, sc) {
    const parts = name.split('.');
    let obj = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if (obj == null) return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  }

  // ── expression evaluators ──

  function evalRef(node, sc) {
    const name = node.name;
    // check scope chain — return raw value, no auto-call
    if (name in sc) {
      return sc[name];
    }
    // check dot-path: scope first, then globals
    if (name.includes('.')) {
      const parts = name.split('.');
      let val = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
      for (let i = 1; i < parts.length; i++) {
        if (val == null) return null;
        val = val[parts[i]];
      }
      return val;
    }
    return undefined;
  }

  function evalBinOp(node, sc) {
    if (node.op === '&') {
      return softString(evalExpr(node.left, sc)) + softString(evalExpr(node.right, sc));
    }
    const left = evalExpr(node.left, sc);
    const right = evalExpr(node.right, sc);
    switch (node.op) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right; // IEEE 754
      case '%': return left % right;
      case '**': return left ** right;
      case '<<': return left << right;
      case '>>': return left >> right;
      case 'bitand': return left & right;
      case 'bitor': return left | right;
      case 'bitxor': return left ^ right;
      default: throw new Error(`Unknown binop: ${node.op}`);
    }
  }

  function evalUnary(node, sc) {
    const val = evalExpr(node.expr, sc);
    switch (node.op) {
      case 'not': return !isTruthy(val);
      case 'neg': return -val;
      case 'bitnot': return ~val;
      default: throw new Error(`Unknown unary: ${node.op}`);
    }
  }

  function evalCompare(node, sc) {
    const left = evalExpr(node.left, sc);
    const right = evalExpr(node.right, sc);
    switch (node.op) {
      case '>': return left > right;
      case '<': return left < right;
      case '==':
        if (typeof left === 'string' && typeof right === 'string')
          return left.toLowerCase() === right.toLowerCase();
        return left === right;
      case '!=':
        if (typeof left === 'string' && typeof right === 'string')
          return left.toLowerCase() !== right.toLowerCase();
        return left !== right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      case 'contains':
        return String(left).toLowerCase().includes(String(right).toLowerCase());
      case 'matches':
        if (right instanceof RegExp) return right.test(String(left));
        return globMatch(String(left), String(right));
      default: throw new Error(`Unknown comparison: ${node.op}`);
    }
  }

  function evalLogic(node, sc) {
    const left = evalExpr(node.left, sc);
    if (node.op === 'and') return isTruthy(left) ? evalExpr(node.right, sc) : left;
    if (node.op === 'or') return isTruthy(left) ? left : evalExpr(node.right, sc);
    throw new Error(`Unknown logic op: ${node.op}`);
  }

  function evalOf(node, sc) {
    // flatten of-chain: name of author of book → [name, author, book]
    // Of nodes nest left: Of(Of(name, author), book)
    // Flatten props left-recursively, then obj is the root
    const chain = [];
    let n = node;
    while (n.type === 'Of') { chain.unshift(n.obj); n = n.prop; }
    chain.unshift(n); // leftmost prop (e.g. 'name')
    // chain is now [name, author, book] — leftmost prop first, root last
    // root is last, properties read right-to-left: book → .author → .name

    // evaluate root (last element)
    let obj = evalExpr(chain[chain.length - 1], sc);
    // walk properties right-to-left (from second-to-last down to first)
    for (let i = chain.length - 2; i >= 0; i--) {
      const prop = chain[i];
      let key;
      if (prop.type === 'Ref' && !prop.name.includes('.')) {
        key = prop.name;
      } else if (prop.type === 'Group') {
        key = evalExpr(prop, sc);
      } else {
        key = evalExpr(prop, sc);
      }
      // array mapping
      if (Array.isArray(obj)) { obj = obj.map(item => item?.[key]); continue; }
      if (obj == null) throw new Error('Cannot access property of nothing');
      obj = obj[key];
    }
    return obj;
  }

  function evalInvoke(node, sc) {
    const val = evalExpr(node.expr, sc);
    if (typeof val !== 'function') return val;
    const args = (node.args || []).map(a => evalExpr(a, sc));
    return val(...args);
  }

  function evalChunk(node, sc) {
    const target = evalExpr(node.target, sc);
    const idx = evalExpr(node.index, sc);
    const str = String(target);
    switch (node.kind) {
      case 'character': return str[idx] || '';
      case 'word': return (str.split(/\s+/)[idx]) || '';
      case 'line': return (str.split('\n')[idx]) || '';
      case 'item': return (str.split(',').map(s => s.trim())[idx]) || '';
      default: throw new Error(`Unknown chunk kind: ${node.kind}`);
    }
  }

  function evalChunkRange(node, sc) {
    const target = evalExpr(node.target, sc);
    const from = evalExpr(node.from, sc);
    const to = evalExpr(node.to, sc);
    const str = String(target);
    switch (node.kind) {
      case 'characters': return str.slice(from, to + 1);
      case 'words': return str.split(/\s+/).slice(from, to + 1).join(' ');
      case 'lines': return str.split('\n').slice(from, to + 1).join('\n');
      case 'items': return str.split(',').map(s => s.trim()).slice(from, to + 1).join(', ');
      default: throw new Error(`Unknown chunk range kind: ${node.kind}`);
    }
  }

  function evalCountChunks(node, sc) {
    const val = evalExpr(node.expr, sc);
    const str = String(val);
    switch (node.kind) {
      case 'characters': return str.length;
      case 'words': return str.split(/\s+/).filter(Boolean).length;
      case 'lines': return str.split('\n').length;
      case 'items': return str.split(',').length;
      default: throw new Error(`Unknown chunk count kind: ${node.kind}`);
    }
  }

  function evalLengthOf(node, sc) {
    const val = evalExpr(node.expr, sc);
    if (Array.isArray(val)) return val.length;
    if (typeof val === 'string') return val.length;
    return 0;
  }

  function evalCall(node, sc) {
    step();
    if (++callDepth > maxCallDepth) { callDepth--; throw new Error('Call depth exceeded (possible infinite recursion)'); }
    try {
    // resolve function
    let fn;
    if (node.name.includes('.')) {
      const parts = node.name.split('.');
      // resolve root: check scope first, then globals
      let obj = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
      for (let i = 1; i < parts.length - 1; i++) {
        if (obj == null) throw new Error(`Cannot resolve "${node.name}"`);
        obj = obj[parts[i]];
      }
      fn = obj?.[parts[parts.length - 1]];
      if (typeof fn === 'function') fn = fn.bind(obj);
    } else {
      fn = sc[node.name];
    }
    if (typeof fn !== 'function') {
      // if it's not a function but we have 0 args, just return the value
      if (node.args.length === 0) return fn;
      throw new Error(`"${node.name}" is not a function`);
    }
    const args = node.args.map(a => evalExpr(a, sc));
    return fn(...args);
    } finally { callDepth--; }
  }

  function evalRecord(node, sc) {
    const obj = {};
    for (const f of node.fields) obj[f.name] = evalExpr(f.value, sc);
    return obj;
  }

  function evalRecordWith(node, sc) {
    const obj = {};
    for (const f of node.fields) {
      obj[f.name] = f.ref ? sc[f.name] : evalExpr(f.value, sc);
    }
    return obj;
  }

  function evalTernary(node, sc) {
    return isTruthy(evalExpr(node.cond, sc))
      ? evalExpr(node.ifTrue, sc)
      : evalExpr(node.ifFalse, sc);
  }

  function evalBetween(node, sc) {
    const val = evalExpr(node.value, sc);
    const lo = evalExpr(node.lo, sc);
    const hi = evalExpr(node.hi, sc);
    return val >= lo && val <= hi;
  }

  function evalTypeCheck(node, sc) {
    const val = evalExpr(node.expr, sc);
    switch (node.typeName) {
      case 'number': case 'numbers': return typeof val === 'number';
      case 'text': return typeof val === 'string';
      case 'boolean': return typeof val === 'boolean';
      case 'list': return Array.isArray(val);
      case 'record': return typeof val === 'object' && val !== null && !Array.isArray(val);
      case 'nothing': return val === null || val === undefined;
      default: return false;
    }
  }

  // ── run ──
  evalNode(ast, scope);
  return { output, scope };
}

// -- highlight.js --

// soft — syntax highlighting tokenizer + completions for CM6


const SOFT_KEYWORDS = [...KEYWORDS];
const _kwSet = new Set(SOFT_KEYWORDS);

const SOFT_BUILTINS = ['abs', 'floor', 'ceil', 'sqrt', 'random', 'number', 'text'];
const _builtinSet = new Set(SOFT_BUILTINS);

// transforms and query keywords get a distinct color
const SOFT_TRANSFORMS = new Set([
  'take', 'from', 'keep', 'drop', 'only', 'where', 'pick', 'get',
  'sort', 'ascending', 'descending', 'first', 'last', 'top',
  'average', 'total', 'count', 'smallest', 'largest',
  'mean', 'sum', 'min', 'max', 'group', 'round', 'with',
  'say', 'show', 'set', 'put', 'define', 'return', 'assume',
  'add', 'remove', 'load', 'save', 'call', 'run',
]);

function tokenizeSoft(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code[i];

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      const start = i;
      while (i < len && (code[i] === ' ' || code[i] === '\t' || code[i] === '\n' || code[i] === '\r')) i++;
      tokens.push({ type: 'ws', text: code.slice(start, i) });
      continue;
    }

    // comment
    if (ch === '#') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }

    // string
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len && code[i] !== '"') {
        if (code[i] === '\\' && i + 1 < len) i++;
        i++;
      }
      if (i < len) i++;
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }

    // numbers
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      const start = i;
      if (ch === '0' && i + 1 < len && 'xXbBoO'.includes(code[i + 1])) {
        i += 2;
        while (i < len && /[0-9a-fA-F]/.test(code[i])) i++;
      } else {
        while (i < len && code[i] >= '0' && code[i] <= '9') i++;
        if (i < len && code[i] === '.') { i++; while (i < len && code[i] >= '0' && code[i] <= '9') i++; }
      }
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }

    // identifiers / keywords / builtins
    if (/[\p{L}_]/u.test(ch)) {
      const start = i;
      while (i < len && /[\p{L}\p{N}_.]/u.test(code[i])) i++;
      const word = code.slice(start, i);
      const isDotPath = word.includes('.');
      let type;
      if (isDotPath) type = 'fn';
      else if (_builtinSet.has(word)) type = 'fn';
      else if (SOFT_TRANSFORMS.has(word)) type = 'tf';
      else if (_kwSet.has(word)) type = 'kw';
      else type = 'id';
      tokens.push({ type, text: word });
      continue;
    }

    // operators/punctuation
    const start = i;
    // two-char ops
    if (i + 1 < len) {
      const two = code.slice(i, i + 2);
      if (['**', '==', '!=', '>=', '<=', '<<', '>>'].includes(two)) {
        i += 2;
        tokens.push({ type: 'op', text: two });
        continue;
      }
    }
    i++;
    tokens.push({ type: 'op', text: code.slice(start, i) });
  }

  return tokens;
}

// ── indentation ──

const BLOCK_OPENERS = new Set([
  'if', 'unless', 'repeat', 'while', 'until', 'for',
  'define', 'on', 'suppose', 'try', 'otherwise', 'else',
]);
const BLOCK_CLOSERS = new Set(['end']);
const DEDENT_LINES = new Set(['otherwise', 'else', 'end']);

function softIndent(state, textAfter, cx) {
  const pos = cx.pos;
  // get the indent of the previous non-blank line
  const doc = cx.state.doc;
  let prevLineIndent = 0;
  let prevLineText = '';
  const curLine = doc.lineAt(pos);
  for (let ln = curLine.number - 1; ln >= 1; ln--) {
    const line = doc.line(ln);
    const trimmed = line.text.trim();
    if (trimmed.length > 0) {
      prevLineIndent = line.text.match(/^ */)[0].length;
      prevLineText = trimmed;
      break;
    }
  }

  // check if previous line opens a block
  const prevFirstWord = prevLineText.split(/\s/)[0].toLowerCase();
  const prevOpens = BLOCK_OPENERS.has(prevFirstWord);
  // also check for "do" at end or "if it fails"
  const prevEndsDo = prevLineText.endsWith(' do');
  const prevIsFails = prevLineText.includes('if it fails');

  // check if current line is a closer/dedenter
  const curTrimmed = textAfter.trim();
  const curFirstWord = curTrimmed.split(/\s/)[0].toLowerCase();
  const curDedents = DEDENT_LINES.has(curFirstWord) || curTrimmed.startsWith('if it fails');

  let indent = prevLineIndent;
  if (prevOpens || prevEndsDo || prevIsFails) indent += 2;
  if (curDedents) indent -= 2;
  return Math.max(0, indent);
}

function softCompletions(prefix) {
  const lc = prefix.toLowerCase();
  const results = [];
  for (const kw of SOFT_KEYWORDS) {
    if (kw.startsWith(lc)) results.push(kw);
  }
  for (const bi of SOFT_BUILTINS) {
    if (bi.startsWith(lc)) results.push(bi);
  }
  return results;
}

// -- cell.js --

// soft — cell type handler: parseNames, findUses, execute




// ensure locale is active for parsing (DAG analysis may run before locale cell executes)
function _ensureLocale() {
  if (softGetLocale()) return; // already active
  if (typeof window === 'undefined') return;
  // check installed modules for a locale
  const mods = window._installedModules;
  if (!mods) return;
  for (const key of Object.keys(mods)) {
    if (key.startsWith('@gcu/soft/') && key !== '@gcu/soft') {
      try {
        let src = mods[key];
        if (src.compressed && !src.binary && window.decompressText) {
          // can't await here — try sync parse if source is already decoded
          return;
        }
        if (typeof src === 'string') { softSetLocale(JSON.parse(src)); return; }
        if (src.source && !src.compressed) { softSetLocale(JSON.parse(src.source)); return; }
      } catch { /* ignore */ }
    }
  }
  // check import cache
  const cache = window._importCache;
  if (!cache) return;
  for (const key of Object.keys(cache)) {
    if (key.startsWith('@gcu/soft/') && key !== '@gcu/soft' && cache[key]?.keywords) {
      softSetLocale(cache[key]);
      return;
    }
  }
}

// ── parseNames: extract top-level variable defines ──
// Walks the AST for Set, Define, Capture, Use at top level.

function softParseNames(code) {
  _ensureLocale();
  try {
    const ast = softParse(code);
    const defines = new Set();
    for (const node of ast.body) _collectDefines(node, defines);
    return defines;
  } catch {
    return _parseNamesRegex(code);
  }
}

function _collectDefines(node, defines) {
  switch (node.type) {
    case 'Set': defines.add(node.name); break;
    case 'Define': defines.add(node.name); break;
    case 'Capture': defines.add(node.name); break;
    case 'Use': defines.add(node.alias || node.path.split('.').pop()); break;
    case 'PipeCalled': if (node.name) defines.add(node.name); _collectDefines(node.step, defines); break;
    case 'If':
      for (const s of node.body) _collectDefines(s, defines);
      if (node.elseBody) for (const s of node.elseBody) _collectDefines(s, defines);
      break;
    case 'ForEach': case 'While': case 'Repeat': case 'RangeLoop':
      for (const s of node.body) _collectDefines(s, defines);
      break;
    default: break;
  }
}

function _parseNamesRegex(code) {
  const defines = new Set();
  for (const line of code.split('\n')) {
    const t = line.trim();
    let m;
    m = t.match(/^set\s+(?:the\s+)?(\w+)\s+to\b/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/^put\s+.+\s+into\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/^define\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\binto\s+(\w+)\s*$/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\bas\s+(\w+)\s*$/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\bcalled\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
  }
  return defines;
}

// ── findUses: find references to other cells ──

function softFindUses(code, allDefined) {
  _ensureLocale();
  const selfDefines = softParseNames(code);
  const uses = new Set();
  // strip comments and strings, then scan for identifiers
  const stripped = code.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const idRe = /\b([a-zA-Z_]\w*)\b/g;
  let m;
  while ((m = idRe.exec(stripped))) {
    if (allDefined.has(m[1]) && !selfDefines.has(m[1])) uses.add(m[1]);
  }
  return uses;
}

// ── execute: run a Soft cell ──

async function softExecute(code, scopeIn, cell) {
  const globals = {};

  // inject Math, standard JS globals
  if (typeof Math !== 'undefined') globals.Math = Math;
  if (typeof JSON !== 'undefined') globals.JSON = JSON;

  // Text utilities
  globals.Text = {
    upper: (s) => String(s).toUpperCase(),
    lower: (s) => String(s).toLowerCase(),
    trim: (s) => String(s).trim(),
    split: (s, sep) => String(s).split(sep),
    replace: (s, a, b) => String(s).replace(a, b),
    starts: (s, prefix) => String(s).startsWith(prefix),
    ends: (s, suffix) => String(s).endsWith(suffix),
    slice: (s, a, b) => String(s).slice(a, b),
  };

  // List utilities
  globals.List = {
    range: (a, b, step) => {
      const arr = [];
      if (b === undefined) { b = a; a = 0; }
      step = step || 1;
      for (let i = a; step > 0 ? i < b : i > b; i += step) arr.push(i);
      return arr;
    },
    reverse: (arr) => [...arr].reverse(),
    flat: (arr) => arr.flat(),
    unique: (arr) => [...new Set(arr)],
    join: (arr, sep) => arr.join(sep ?? ', '),
    zip: (...arrs) => arrs[0].map((_, i) => arrs.map(a => a[i])),
  };

  // Date utilities
  globals.Date = {
    now: () => Date.now(),
    today: () => new Date().toISOString().slice(0, 10),
  };

  // host functions for file I/O, DOM, events
  const host = {};
  const hasCtx = !!cell?._ctx;

  // CSV parser
  const csvParse = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim());
      const row = {};
      headers.forEach((h, i) => {
        const v = vals[i];
        row[h] = v !== undefined && v !== '' && !isNaN(v) ? Number(v) : (v || '');
      });
      return row;
    });
  };
  const parseContent = (path, text) => {
    if (path.endsWith('.json')) return JSON.parse(text);
    if (path.endsWith('.csv')) return csvParse(text);
    return text;
  };

  // pre-fetch URLs for load statements (async before sync evaluator runs)
  const prefetched = {};
  const urlPattern = /\bload\s+"(https?:\/\/[^"]+)"/g;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(code))) {
    const url = urlMatch[1];
    try { prefetched[url] = await (await fetch(url)).text(); } catch (e) { /* fetched at eval time */ }
  }

  // file I/O via VFS + prefetch cache
  const vfs = (typeof window !== 'undefined' && window._notebookVFS) ? window._notebookVFS : null;
  host.load = (path) => {
    // prefetched URL
    if (prefetched[path]) return parseContent(path, prefetched[path]);
    // VFS
    if (vfs) {
      try {
        const content = vfs.readFileSync(path, 'utf8');
        return parseContent(path, content);
      } catch { /* fall through */ }
    }
    // scope variable (load variableName)
    if (path in scopeIn) return scopeIn[path];
    throw new Error(`Cannot load "${path}": file not found`);
  };
  if (vfs) {
    host.save = (path, data) => {
      let content;
      if (typeof data === 'string') content = data;
      else if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        // CSV from array of records
        const keys = Object.keys(data[0]);
        content = keys.join(',') + '\n' + data.map(r => keys.map(k => r[k] ?? '').join(',')).join('\n');
      } else {
        content = JSON.stringify(data, null, 2);
      }
      vfs.writeFileSync(path, content);
    };
  }

  // DOM helpers
  if (hasCtx) {
    const outputEl = cell._ctx.outputEl;
    // cleanup tracking for event listeners
    const cleanups = [];
    if (cell._ctx.invalidation) {
      cell._ctx.invalidation.then(() => { for (const fn of cleanups) fn(); });
    }

    host.make = (tag, parent) => {
      const el = document.createElement(tag);
      (parent || outputEl).appendChild(el);
      return el;
    };
    host.on = (event, target, handler) => {
      let el = target || outputEl;
      if (typeof el === 'string') el = document.getElementById(el);
      if (el && el.addEventListener) {
        el.addEventListener(event, handler);
        cleanups.push(() => el.removeEventListener(event, handler));
      }
    };
  }

  const result = softEval(code, {
    globals,
    scopeInit: scopeIn,
    host,
  });

  // extract defines
  const defines = {};
  const cellDefines = softParseNames(code);
  for (const name of cellDefines) {
    if (result.scope[name] !== undefined) {
      defines[name] = result.scope[name];
    }
  }

  // build output
  if (hasCtx) {
    // render output to DOM — use ui.table for arrays-of-objects, display for everything else
    for (const val of result.output) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        cell._ctx.ui.table(val);
      } else if (typeof val === 'string') {
        cell._ctx.display(val);
      } else {
        cell._ctx.display(val);
      }
    }
    // last expression value as cell reactive output
    if (result.scope.it !== null && result.scope.it !== undefined && result.output.length === 0) {
      if (Array.isArray(result.scope.it) && result.scope.it.length > 0 && typeof result.scope.it[0] === 'object') {
        cell._ctx.ui.table(result.scope.it);
      } else {
        cell._ctx.display(result.scope.it);
      }
    }
    return { defines };
  }

  // headless mode — stringify raw values
  return {
    defines,
    output: result.output.length > 0
      ? result.output.map(v => typeof v === 'string' ? v : softStringify(v)).join('\n')
      : undefined,
  };
}

// -- tag.js --

// soft tagged template — use soft`...` in JS code cells
// Returns an object with all top-level defines as properties.



function softTag(strings, ...values) {
  // build code with _v0, _v1 placeholders
  let code = strings[0];
  for (let i = 0; i < values.length; i++) {
    code += '_v' + i + strings[i + 1];
  }

  // dedent: strip common leading whitespace
  const lines = code.split('\n');
  let start = 0;
  if (lines[start].trim() === '') start++;
  let minIndent = Infinity;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const indent = lines[i].match(/^ */)[0].length;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent > 0 && minIndent < Infinity) {
    for (let i = start; i < lines.length; i++) {
      if (lines[i].trim() !== '') lines[i] = lines[i].slice(minIndent);
    }
  }
  if (start > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  code = lines.join('\n');

  // inject interpolated values into scope
  const scopeInit = {};
  for (let i = 0; i < values.length; i++) scopeInit['_v' + i] = values[i];

  const result = softEval(code, { scopeInit });

  // extract non-underscore-prefixed defines
  const out = {};
  for (const [k, v] of Object.entries(result.scope)) {
    if (k.startsWith('_') || k === 'it') continue;
    if (typeof v === 'function' && !v._softName) continue;
    out[k] = v;
  }
  return out;
}

// -- register.js --

// soft — cell type, tagged language, plugin registration





const handler = {
  label: 'soft',
  color: '#c89b3c',
  shortcut: 'f',
  editDebounce: 500,
  indent: softIndent,
  indentUnit: '  ',
  parseNames: softParseNames,
  syntaxCheck: (code) => {
    try { softParse(code); return true; }
    catch { return false; }
  },
  findUses: softFindUses,
  execute: softExecute,
  tokenize: tokenizeSoft,
  completions: (prefix) => softCompletions(prefix),
  createEditor: (cell, onChange) => {
    if (!window._ctCreateEditor) return null;
    const wrap = document.createElement('div');
    wrap.className = 'editor-wrap';
    const editor = window._ctCreateEditor(wrap, cell.id, cell.code, 'soft', onChange);
    return {
      el: wrap,
      getCode: () => editor.view.state.doc.toString(),
      setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
      focus: () => editor.focus(),
      destroy: () => editor.destroy(),
    };
  },
};

// guard: only register once
if (!window._cellTypes?.['soft']) {
  // register 'soft' cell type
  if (window.registerCellType) {
    window.registerCellType('soft', handler, '@gcu/soft');
  } else if (window._cellTypes) {
    window._cellTypes['soft'] = handler;
  }

  // register tagged language for soft`` syntax highlighting
  window._taggedLanguages = window._taggedLanguages || {};
  window._taggedLanguages['soft'] = {
    tokenize: tokenizeSoft,
    completions: softCompletions,
    indent: softIndent,
  };

  // register as plugin
  if (window.registerPlugin) {
    window.registerPlugin('@gcu/soft', { description: 'English keyword programming language — soft cells and tagged template' });
  } else if (window._auditablePlugins) {
    window._auditablePlugins.set('@gcu/soft', { description: 'English keyword programming language — soft cells and tagged template' });
  }

  // global tag
  window.soft = softTag;

  // configure autocomplete for any existing soft cells (they were created before this plugin loaded)
  if (window._configurePluginAutocomplete) {
    window._configurePluginAutocomplete('soft');
  }
}


// expose setLocale on window for easy access from JS cells
window._softSetLocale = softSetLocale;

const soft = {
  softTag,
  handler,
  softParseNames,
  softFindUses,
  tokenizeSoft,
  softCompletions,
  setLocale: softSetLocale,
};

export { soft };
