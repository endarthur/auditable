// @gcu/over — the notebook surface: the `over` tagged template + editor support
// (syntax highlighting + completions), self-registered as a tagged language.
//
//   const { over } = await load("@gcu/over");
//   const cleaned = over`
//     FE_N    = FE / mean(FE) over LITHO
//     ORETYPE = match FE { >=62:"HEMATITE", >=58:"ITABIRITE", _:"WASTE" }
//     saveonly(hole, FE, FE_N, ORETYPE)
//   `(rows);                       // → an array of result rows (+ .columns)
//
// The tag compiles once (parse + emit) and returns a transform you apply to a
// table (an array of row objects, or a { rows } result — so transforms chain).

import { compile } from './api.js';

export function over(strings, ...values) {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += String(values[i]) + strings[i + 1];
  const c = compile(text);
  // (table, tables?) — `tables` are the reference tables lookup() reads:
  //   over`DENS = lookup(densities,"litho",LITHO,"density")`(rows, { densities })
  const fn = (table, tables) => {
    const rows = Array.isArray(table) ? table : (table && table.rows) || [];
    const result = c.run(rows, tables);
    Object.defineProperty(result.rows, 'columns', { value: result.columns, enumerable: false });
    Object.defineProperty(result.rows, 'checks', { value: result.checks, enumerable: false });   // validation report
    return result.rows;
  };
  fn.source = c.source;          // the emitted JS (inspectable)
  fn.ast = c.ast;
  fn.compiled = c;
  return fn;
}

// ── tokenizer (syntax highlighting inside over`…`) ──

const KEYWORDS = new Set([
  'if', 'elseif', 'else', 'end', 'keep', 'saveonly', 'erase', 'delete', 'exit',
  'let', 'match', 'and', 'or', 'not', 'over', 'all', 'where', 'order', 'by', 'default', 'lookup', 'check',
]);
const LITERALS = new Set(['true', 'false', 'absent']);
const FUNCTIONS = new Set([
  'count', 'sum', 'mean', 'min', 'max', 'std', 'minia', 'maxia', 'wmean', 'overlap',
  'prev', 'next', 'first', 'last',
  'abs', 'sqrt', 'exp', 'log', 'loge', 'logn', 'log10', 'pow', 'rais', 'mod',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'int', 'round', 'present',
  'len', 'ucase', 'lcase', 'trim', 'string', 'concat', 'substr',
  'xyzijk', 'ijknum', 'ijkget',
]);

function tokenizeOver(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;
  while (i < len) {
    const c = code[i];
    if (c === '#') { const s = i; while (i < len && code[i] !== '\n') i++; tokens.push({ type: 'cmt', text: code.slice(s, i) }); continue; }
    if (c === '%' && (i === 0 || code[i - 1] === '\n')) { const s = i; while (i < len && code[i] !== '\n') i++; tokens.push({ type: 'cmt', text: code.slice(s, i) }); continue; }
    if (c === '"') { const s = i; i++; while (i < len && code[i] !== '"') { if (code[i] === '\\') i++; i++; } if (i < len) i++; tokens.push({ type: 'str', text: code.slice(s, i) }); continue; }
    if (c === '`') { const s = i; i++; while (i < len && code[i] !== '`') i++; if (i < len) i++; tokens.push({ type: 'id', text: code.slice(s, i) }); continue; }   // backtick column name
    if (/\d/.test(c) || (c === '.' && /\d/.test(code[i + 1] || ''))) { const s = i; while (i < len && /[0-9.eE+-]/.test(code[i])) i++; tokens.push({ type: 'num', text: code.slice(s, i) }); continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const s = i; while (i < len && /[A-Za-z0-9_$]/.test(code[i])) i++;
      const w = code.slice(s, i);
      if (KEYWORDS.has(w)) tokens.push({ type: 'kw', text: w });
      else if (LITERALS.has(w)) tokens.push({ type: 'const', text: w });
      else if (FUNCTIONS.has(w) || (i < len && code[i] === '(')) tokens.push({ type: 'fn', text: w });
      else tokens.push({ type: 'id', text: w });
      continue;
    }
    if ('=<>!+-*/?'.includes(c)) { const s = i; i++; if (i < len && '=?'.includes(code[i])) i++; tokens.push({ type: 'op', text: code.slice(s, i) }); continue; }
    if ('(){}:,;'.includes(c)) { tokens.push({ type: 'punc', text: c }); i++; continue; }
    tokens.push({ type: '', text: c }); i++;
  }
  return tokens;
}

function overCompletions() {
  const items = [];
  for (const w of KEYWORDS) items.push({ text: w, kind: 'kw' });
  for (const w of LITERALS) items.push({ text: w, kind: 'const' });
  for (const w of FUNCTIONS) items.push({ text: w, kind: 'fn' });
  return items;
}

// ── self-registration (tagged language: highlighting + completions) ──

if (typeof window !== 'undefined') {
  const register = window.auditable && window.auditable.registerExtension;
  if (register) {
    register({ name: '@gcu/over', version: '0.1.0', taggedLanguage: { name: 'over', tokenize: tokenizeOver, completions: overCompletions } });
  } else {
    if (!window._taggedLanguages) window._taggedLanguages = {};
    window._taggedLanguages.over = { tokenize: tokenizeOver, completions: overCompletions };
  }
}

export { tokenizeOver, overCompletions };
