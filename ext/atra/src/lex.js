// Lexer — tokenizer for the parser
//
// Atra's lexical design borrows from Fortran: ! for line comments, /= for not-equal,
// semicolons as whitespace (optional statement separators). Identifiers can contain dots
// for namespace-style access (e.g. physics.gravity), treated as a single token.

import { ATRA_KEYWORDS, ATRA_TYPES } from './highlight.js';

export const TOK = {
  NUM: 'num', STR: 'str', ID: 'id', KW: 'kw', OP: 'op', PUNC: 'punc', EOF: 'eof',
};

export function lex(source) {
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
      // hex literal: 0x or 0X
      if (source[i] === '0' && i + 1 < len && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        adv(); adv(); // skip 0x
        while (i < len && /[0-9a-fA-F]/.test(source[i])) adv();
        let typeSuffix = null;
        if (peek() === '_') {
          const s = source.slice(i + 1, i + 4);
          if (ATRA_TYPES.has(s)) { typeSuffix = s; adv(); adv(); adv(); adv(); }
        }
        const raw = source.slice(start, i);
        tokens.push({ type: TOK.NUM, value: String(Number(raw)), isFloat: false, typeSuffix, line: tl, col: tc });
        continue;
      }
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
    // character literal: 'A', '\n', '\0', etc.
    if (source[i] === "'") {
      adv(); // skip opening quote
      let ch;
      if (source[i] === '\\') {
        adv(); // skip backslash
        const esc = source[i];
        adv(); // skip escape char
        const escMap = { n: 10, r: 13, t: 9, '0': 0, '\\': 92, "'": 39 };
        if (escMap[esc] === undefined) throw new SyntaxError(`Unknown escape \\${esc} at ${tl}:${tc}`);
        ch = escMap[esc];
      } else {
        ch = source[i].codePointAt(0);
        adv();
      }
      if (source[i] !== "'") throw new SyntaxError(`Unterminated char literal at ${tl}:${tc}`);
      adv(); // skip closing quote
      tokens.push({ type: TOK.NUM, value: String(ch), isFloat: false, typeSuffix: 'i32', line: tl, col: tc });
      continue;
    }
    // string literal: "hello", "line\n"
    if (source[i] === '"') {
      adv(); // skip opening quote
      const chars = [];
      while (i < len && source[i] !== '"') {
        if (source[i] === '\\') {
          adv();
          const esc = source[i];
          const escMap = { n: 10, r: 13, t: 9, '0': 0, '\\': 92, '"': 34 };
          if (escMap[esc] === undefined) throw new SyntaxError(`Unknown escape \\${esc} at ${line}:${col}`);
          chars.push(escMap[esc]);
          adv();
        } else {
          const encoded = new TextEncoder().encode(source[i]);
          for (const b of encoded) chars.push(b);
          adv();
        }
      }
      if (i >= len) throw new SyntaxError(`Unterminated string literal at ${tl}:${tc}`);
      adv(); // skip closing quote
      tokens.push({ type: TOK.STR, value: chars, line: tl, col: tc });
      continue;
    }
    // identifier (dots allowed — namespaces by convention)
    if (/[a-zA-Z_]/.test(source[i])) {
      const start = i;
      while (i < len && /[\w.]/.test(source[i])) adv();
      // Trim trailing dot: partial namespace at EOF (e.g. "name.") shouldn't
      // swallow the dot. This lets the editor recover gracefully mid-typing.
      while (i > start + 1 && source[i - 1] === '.') { i--; col--; }
      let val = source.slice(start, i);
      // Tagged template interpolations become __INTERP_N__ markers in the source text.
      // The parser treats them as identifiers; codegen resolves them to imports.
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
    if ('+-*/<>=&|^~@'.includes(source[i])) {
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
