// Lexer — structured tokenizer for the parser
//
// Calque uses -- for comments, .. for ranges, -> for lambdas.
// Significant newlines: emitted after tokens that can end a statement,
// suppressed after operators and inside bracket nesting.

import { CALQUE_KEYWORDS, CALQUE_BUILTINS } from './highlight.js';

export const TOK = {
  NUM: 'num', STR: 'str', TMPL: 'tmpl', ID: 'id', KW: 'kw',
  OP: 'op', RANGE: 'range', PUNC: 'punc', NL: 'nl', EOF: 'eof',
  DIR: 'dir',
};

// Tokens that can end a statement (NL emitted after these)
const STMT_ENDERS = new Set([TOK.NUM, TOK.STR, TOK.TMPL, TOK.ID, TOK.KW]);
const STMT_ENDER_PUNCS = new Set([')', ']', '}']);
// Keywords that end a statement
const STMT_ENDER_KWS = new Set(['true', 'false', 'null', 'else']);

export function lex(source) {
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
