// @gcu/expr — static analysis over the AST: `deps` (the free column references, for
// reactive wiring + column-pushdown projection), `validate` (parse + unknown-column
// check with did-you-mean, for the filter box / calc editor's live feedback), and
// `canMatch` (conservative interval analysis for chunk/row-group push-down — "could
// any row in a chunk with these per-column stats match this predicate?").

import { parse, asAst, quoteIdent, ExprParseError } from './parse.js';
import { evaluate } from './eval.js';

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

// Small bounded Levenshtein for did-you-mean (early-out above `cap`).
function editDist(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Parse + (when `columns` is given) check every field ref resolves, case-insensitively.
// → { ok, errors: [{ kind, message, name?, suggestion? }] }. Never throws. Unknown
// columns get a did-you-mean: nearest known name by edit distance, or — the hyphen
// migration case — a known name that *starts with* the unknown + '-' (`OK` typed
// bare where `OK-Indic` exists → suggest the backticked form; `-` is subtraction).
export function validate(exprOrAst, columns) {
  let ast;
  try { ast = asAst(exprOrAst); }
  catch (e) { return { ok: false, errors: [{ kind: 'parse', message: (e instanceof ExprParseError ? e.message : String(e && e.message || e)) }] }; }
  const errors = [];
  if (columns) {
    const names = (columns || []).map((c) => String(typeof c === 'string' ? c : (c && c.name)));
    const known = new Set(names.map((n) => n.toLowerCase()));
    const seen = new Set();
    for (const name of deps(ast)) {
      const key = name.toLowerCase();
      if (known.has(key) || seen.has(key)) continue;
      seen.add(key);
      let best = null, bestD = 3;                                     // fuzzy: nearest known within distance 2
      for (const k of names) {
        if (k.toLowerCase().startsWith(key + '-')) { best = k; break; }   // the hyphen case wins outright
        const d = editDist(key, k.toLowerCase(), 2);
        if (d < bestD) { bestD = d; best = k; }
      }
      const suggestion = best ? quoteIdent(best) : undefined;
      errors.push({ kind: 'column', name, suggestion, message: `unknown column: ${name}${suggestion ? ` — did you mean ${suggestion}?` : ''}` });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── canMatch: chunk push-down ────────────────────────────────────────────────
// canMatch(expr, ranges) → false ONLY when provably no row in the chunk can match;
// true means "must scan". `ranges` = { columnName → { min, max, hasBlank? } } from
// chunk/row-group stats (Parquet footers, .dm band sidecars); lookup is
// case-insensitive (the language is). Conservative by construction: unknown node
// shapes, non-constant compare sides, parse errors, missing stats → true.
//
// Soundness note (`!=`): a BLANK row matches `AU != 5` (eq(blank,5) is false), and
// min/max stats don't describe blanks — so `!=` prunes only when the stats assert
// `hasBlank: false`. (Hand-rolled pushdowns typically miss this.)
const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!=' };
export function canMatch(exprOrAst, ranges) {
  let ast;
  try { ast = asAst(exprOrAst); } catch { return true; }
  const R = new Map(Object.entries(ranges || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  const rangeOf = (n) => (n && n.t === 'field' ? (R.get(n.name.toLowerCase()) || null) : null);
  const cnum = (n) => {                                               // constant-fold a field-free subtree to a finite number
    if (deps(n).length) return null;
    const v = evaluate(n, {});
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  };
  const usable = (fr) => fr && Number.isFinite(fr.min) && Number.isFinite(fr.max);
  function m(n) {
    switch (n.t) {
      case 'and': return m(n.l) && m(n.r);                            // either side impossible → the conjunction is
      case 'or': return m(n.l) || m(n.r);
      case 'cmp': {
        let fr = rangeOf(n.l), k = cnum(n.r), o = n.op;
        if (!usable(fr) || k === null) {
          const fr2 = rangeOf(n.r), k2 = cnum(n.l);
          if (usable(fr2) && k2 !== null) { fr = fr2; k = k2; o = FLIP[o]; }
          else return true;
        }
        switch (o) {
          case '>': return fr.max > k;
          case '>=': return fr.max >= k;
          case '<': return fr.min < k;
          case '<=': return fr.min <= k;
          case '=': return fr.min <= k && k <= fr.max;
          case '!=': return fr.hasBlank === false ? !(fr.min === k && fr.max === k) : true;
          default: return true;
        }
      }
      case 'between': {
        const fr = rangeOf(n.e), lo = cnum(n.lo), hi = cnum(n.hi);
        return (usable(fr) && lo !== null && hi !== null) ? (fr.max >= lo && fr.min <= hi) : true;
      }
      case 'in': {
        const fr = rangeOf(n.e); if (!usable(fr)) return true;
        return n.set.some((s) => { const k = cnum(s); return k === null ? true : (fr.min <= k && k <= fr.max); });
      }
      default: return true;                                           // not / contains / matches / calls / is blank — no pruning
    }
  }
  return m(ast);
}
