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

export class OverLexError extends Error {
  constructor(msg, line, col) { super(`over: ${msg} (line ${line})`); this.line = line; this.col = col; }
}

export function lex(src) {
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
