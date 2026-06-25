// @gcu/expr — static analysis over the AST: `deps` (the free column references, for
// reactive wiring + lamina's parseFields column-pushdown) and `validate` (parse +
// unknown-column check, for the filter box / calc-column editor's live feedback).

import { parse, asAst, ExprParseError } from './parse.js';

// Free field references — the expression's source columns (original case, deduped).
export function deps(exprOrAst) {
  const out = new Set();
  (function descend(n) {
    if (!n || typeof n !== 'object') return;
    if (n.t === 'field') { out.add(n.name); return; }
    if (Array.isArray(n.args)) for (const a of n.args) descend(a);   // function-call args
    if (Array.isArray(n.set)) for (const a of n.set) descend(a);     // `in` set members
    for (const k of ['e', 'l', 'r', 'lo', 'hi']) if (n[k]) descend(n[k]);
  })(asAst(exprOrAst));
  return [...out];
}

// Parse + (when `columns` is given) check every field ref resolves, case-insensitively.
// → { ok, errors: [{ kind, message, name? }] }. Never throws.
export function validate(exprOrAst, columns) {
  let ast;
  try { ast = asAst(exprOrAst); }
  catch (e) { return { ok: false, errors: [{ kind: 'parse', message: (e instanceof ExprParseError ? e.message : String(e && e.message || e)) }] }; }
  const errors = [];
  if (columns) {
    const known = new Set((columns || []).map((c) => String(typeof c === 'string' ? c : (c && c.name)).toLowerCase()));
    const seen = new Set();
    for (const name of deps(ast)) {
      const key = name.toLowerCase();
      if (!known.has(key) && !seen.has(key)) { seen.add(key); errors.push({ kind: 'column', name, message: `unknown column: ${name}` }); }
    }
  }
  return { ok: errors.length === 0, errors };
}
