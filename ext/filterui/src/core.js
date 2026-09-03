// @gcu/filterui core — the pure half of the AST↔widget filter editor.
// Extracted from micro's fd* family (tools/micro). No DOM, no host state:
// span bookkeeping, clause classification, chain flattening, number/text
// formatting. The AST shapes are @gcu/expr's parse-with-spans nodes.

// Strip comments + join lines: the single-line toolbar mirror of a multiline
// expression (a # comment would otherwise eat the rest after joining).
export function flattenExpr(t) {
  return String(t).replace(/#[^\n]*/g, '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ');
}

// Format a numeric value at a slider step's precision (integers stay clean).
export function fmtNum(v, step) {
  return step >= 1 ? String(Math.round(v)) : String(+v.toFixed(Math.max(0, Math.ceil(-Math.log10(step)) + 1)));
}

// Span bookkeeping for surgical text edits: replacing one span shifts every
// sibling span after it and stretches any span containing it, so widget edits
// stay honest against the evolving source text between re-renders.
export class SpanSet {
  constructor() { this.spans = []; }
  clear() { this.spans = []; }
  push(sp) { this.spans.push(sp); return sp; }
  // Replace `sp` with `txt` inside `text`; returns the new text. Mutates the
  // tracked spans (including sp itself) to match.
  replaceIn(text, sp, txt) {
    const nt = text.slice(0, sp.start) + txt + text.slice(sp.end);
    const delta = txt.length - (sp.end - sp.start);
    for (const o of this.spans) {
      if (o === sp) continue;
      if (o.start >= sp.end) { o.start += delta; o.end += delta; }
      else if (o.start <= sp.start && o.end >= sp.end) { o.end += delta; }   // containing extent: stretch
    }
    sp.end = sp.start + txt.length;
    return nt;
  }
}

export const FLIP_OP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

// Flatten a same-joiner chain — but a PARENTHESIZED child stays a nested group
// (even same-op), so `A and (B or C)` and `A and (B and C)` both render as boxes.
export function chainOf(n) {
  if (!n || (n.t !== 'and' && n.t !== 'or')) return { op: null, items: n ? [n] : [], joiners: [] };
  const op = n.t, items = [], joiners = [];
  (function walk(x, root) {
    if (x && x.t === op && (root || x.gStart == null) && x.jStart != null) { walk(x.l); joiners.push({ start: x.jStart, end: x.jEnd }); walk(x.r); }
    else items.push(x);
  })(n, true);
  return { op, items, joiners };
}

// Classify a clause → a widget spec. `quoteIdent` is @gcu/expr's (injected so
// the core stays dependency-free).
export function leafSpec(n, quoteIdent) {
  const isF = (x) => x && x.t === 'field', numLit = (x) => x && (x.t === 'num' || (x.t === 'neg' && x.start != null)) && x.start != null;
  const numVal = (x) => (x.t === 'neg' ? -x.e.v : x.v);
  const opSp = (x) => (x.opStart != null ? { start: x.opStart, end: x.opEnd } : null);
  if (n.t === 'cmp') {
    if (isF(n.l) && numLit(n.r)) return { kind: 'slider', col: n.l.name, op: n.op, sp: n.r, v: numVal(n.r), opSp: opSp(n), node: n };
    if (isF(n.r) && numLit(n.l)) return { kind: 'slider', col: n.r.name, op: (FLIP_OP[n.op] || n.op), sp: n.l, v: numVal(n.l), flipped: true, opSp: opSp(n), node: n };
    if (isF(n.l) && n.r && n.r.t === 'str' && n.r.start != null && (n.op === '=' || n.op === '!=')) return { kind: 'chips', col: n.l.name, op: n.op, picks: [n.r], node: n };
  }
  if (n.t === 'between' && isF(n.e) && numLit(n.lo) && numLit(n.hi)) return { kind: 'range', col: n.e.name, lo: n.lo, hi: n.hi, vlo: numVal(n.lo), vhi: numVal(n.hi), node: n };
  if (n.t === 'in' && isF(n.e) && n.set.every((m2) => m2.t === 'str' && m2.start != null)) return { kind: 'chips', col: n.e.name, op: 'in', picks: n.set, node: n };
  if (n.t === 'isblank' && isF(n.e)) return { kind: 'flag', col: n.e.name, label: 'is blank', other: 'filled', node: n };
  if (n.t === 'isfilled' && isF(n.e)) return { kind: 'flag', col: n.e.name, label: 'is filled', other: 'blank', node: n };
  if ((n.t === 'contains' && isF(n.l) && n.r && n.r.t === 'str' && n.r.start != null)) return { kind: 'text', col: n.l.name, verb: 'contains', sp: n.r, v: n.r.v };
  if (n.t === 'matches' && isF(n.e)) return { kind: 'expr', label: (quoteIdent ? quoteIdent(n.e.name) : n.e.name) + ' matches …' };
  if (n.t === 'not') {                                      // postfix not keeps its extent (op edits stay honest);
    const inner = leafSpec(n.e, quoteIdent);                // prefix `not (…)` has none → structural edits hidden
    if (inner && inner.kind !== 'expr') { inner.negated = true; inner.node = n.start != null ? n : null; return inner; }
  }
  return { kind: 'expr', label: 'expression' };
}
