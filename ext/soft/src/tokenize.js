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

export function softSetLocale(locale) {
  if (!locale) { _localeLookup = null; _localeNoise = null; return; }
  _localeLookup = {};
  for (const [canonical, forms] of Object.entries(locale.keywords || {})) {
    for (const form of forms) _localeLookup[form.toLowerCase()] = canonical;
  }
  _localeNoise = locale.noise ? new Set(locale.noise.map(w => w.toLowerCase())) : null;
}

export function softGetLocale() { return _localeLookup; }

// ── main tokenizer ──

export function softTokenize(code) {
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

export { T, KEYWORDS };
