// soft — syntax highlighting tokenizer + completions for CM6

import { KEYWORDS } from './tokenize.js';

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

export function tokenizeSoft(code) {
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

export function softIndent(state, textAfter, cx) {
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

export function softCompletions(prefix) {
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
