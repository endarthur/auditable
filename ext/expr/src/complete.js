// @gcu/expr — context-aware completion for the filter / calc editors. Given the
// source + caret, it figures out what's expected *here* and offers it:
//   • a VALUE position (after `col =`, `col in (`, `col contains`, …) → the column's
//     distinct values, QUOTED — this is the one that closes the bare-word-vs-quoted
//     footgun: you pick "OXIDE" from a list instead of typing bare ox.
//   • an OPERAND position (start, after and/or/not/`(`) → columns + functions.
//   • an OPERATOR position (an operand just ended) → comparisons + keywords.
//
// Heuristic, token-driven (rides tokenize), not a full grammar — but it covers the
// shapes people actually type. Returns { from, to, options:[{value,kind,detail}] };
// the host replaces src[from..to] with a chosen option.value.

import { tokenize, CALLFNS } from './parse.js';

const CMP_OPS = ['=', '!=', '<', '>', '<=', '>=', '==', '<>'];
const VALUE_KW = ['in', 'contains', 'like', 'matches'];
const RESET_KW = ['and', 'or', 'not', 'between'];        // crossing one of these ends "this comparison"
const needsBracket = (n) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(n);
const quoteVal = (v) => '"' + String(v).replace(/"/g, '') + '"';

// Is the nearest enclosing `(` an `in (` list (vs a grouping / function paren)?
function insideInList(toks) {
  let depth = 0;
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.kind === 'punct' && t.value === ')') depth++;
    else if (t.kind === 'punct' && t.value === '(') {
      if (depth === 0) { const prev = toks[k - 1]; return !!(prev && prev.kind === 'keyword' && prev.value.toLowerCase() === 'in'); }
      depth--;
    }
  }
  return false;
}

// The column being compared = scan back to the nearest column, stopping if we cross
// a boolean/range keyword (that ended the previous comparison).
function compareColumn(toks) {
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.kind === 'column') return t.value;
    if (t.kind === 'keyword' && RESET_KW.includes(t.value.toLowerCase())) return null;
  }
  return null;
}

/**
 * @param {string} src
 * @param {number} pos  caret index (default = end)
 * @param {object} ctx  { columns: [{name,type}|name], values?: (col)=>string[] | {col:[…]} }
 * @returns {{from:number, to:number, options:Array<{value:string,kind:string,detail?:string}>}}
 */
export function complete(src, pos, ctx = {}) {
  src = String(src == null ? '' : src);
  pos = Math.max(0, Math.min(pos == null ? src.length : pos, src.length));
  const columns = (ctx.columns || []).map((c) => (typeof c === 'string' ? { name: c, type: 'string' } : { name: c.name, type: c.type || 'string' }));
  const valFn = typeof ctx.values === 'function' ? ctx.values
    : (ctx.values ? (n) => ctx.values[n] || ctx.values[String(n).toLowerCase()] || [] : () => []);

  const before = src.slice(0, pos);
  const fm = before.match(/(["']?)([A-Za-z0-9_-]*)$/) || ['', '', ''];
  const quote = fm[1] || '', frag = fm[2] || '';
  const from = pos - quote.length - frag.length;
  let to = pos;
  if (quote && src[to] === quote) to++;                  // a value typed between quotes → replace the closing one too

  const toks = tokenize(src.slice(0, from)).filter((t) => t.kind !== 'error');
  const last = toks[toks.length - 1];
  const lastLc = last ? last.value.toLowerCase() : '';
  const lc = frag.toLowerCase();
  const pre = (s) => s.toLowerCase().startsWith(lc);     // prefix match
  const opts = [];

  const valueHere = last && (
    (last.kind === 'operator' && CMP_OPS.includes(last.value)) ||
    (last.kind === 'keyword' && VALUE_KW.includes(lastLc)) ||
    (last.kind === 'punct' && (last.value === '(' || last.value === ',') && insideInList(toks))
  );

  if (valueHere) {
    const col = compareColumn(toks);
    const vals = col ? (valFn(col) || []) : [];
    for (const v of vals) if (pre(String(v))) opts.push({ value: quoteVal(v), kind: 'value', detail: col });
    if (opts.length) return { from, to, options: opts.slice(0, 50) };
    // numeric column (no value list) → fall through to columns/functions
  }

  const operandEnded = last && (last.kind === 'column' || last.kind === 'string' || last.kind === 'number' || (last.kind === 'punct' && last.value === ')'));
  if (operandEnded && !valueHere) {                      // expect an operator / keyword
    for (const o of ['=', '!=', '<', '>', '<=', '>=']) if (pre(o)) opts.push({ value: o, kind: 'operator' });
    for (const kw of ['and', 'or', 'between', 'in', 'contains', 'like', 'matches', 'is blank', 'is filled', 'is not blank', 'not in', 'not contains']) if (pre(kw)) opts.push({ value: kw, kind: 'keyword' });
    return { from, to, options: opts.slice(0, 50) };
  }

  // default: an operand position → columns + functions (+ leading `not`)
  for (const c of columns) if (pre(c.name)) opts.push({ value: needsBracket(c.name) ? `["${c.name}"]` : c.name, kind: 'column', detail: c.type });
  for (const fn of Object.keys(CALLFNS)) if (pre(fn)) opts.push({ value: fn + '(', kind: 'function' });
  if (pre('not')) opts.push({ value: 'not', kind: 'keyword' });
  return { from, to, options: opts.slice(0, 50) };
}
