// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/filterui — Bidirectional AST↔widget editor for @gcu/expr filter expressions — the text stays the truth, widgets surgically rewrite source spans. Extracted from micro's filter drawer; host-agnostic via injected providers.

// ── src/core.js ──

// @gcu/filterui core — the pure half of the AST↔widget filter editor.
// Extracted from micro's fd* family (tools/micro). No DOM, no host state:
// span bookkeeping, clause classification, chain flattening, number/text
// formatting. The AST shapes are @gcu/expr's parse-with-spans nodes.

// Strip comments + join lines: the single-line toolbar mirror of a multiline
// expression (a # comment would otherwise eat the rest after joining).
function flattenExpr(t) {
  return String(t).replace(/#[^\n]*/g, '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ');
}

// Format a numeric value at a slider step's precision (integers stay clean).
function fmtNum(v, step) {
  return step >= 1 ? String(Math.round(v)) : String(+v.toFixed(Math.max(0, Math.ceil(-Math.log10(step)) + 1)));
}

// Span bookkeeping for surgical text edits: replacing one span shifts every
// sibling span after it and stretches any span containing it, so widget edits
// stay honest against the evolving source text between re-renders.
class SpanSet {
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

const FLIP_OP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

// Flatten a same-joiner chain — but a PARENTHESIZED child stays a nested group
// (even same-op), so `A and (B or C)` and `A and (B and C)` both render as boxes.
function chainOf(n) {
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
function leafSpec(n, quoteIdent) {
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

// ── src/rows.js ──

// @gcu/filterui rows — the widget-row renderers. DOM-building but host-free:
// everything host-specific arrives through two objects.
//
// `meta` — the host's column metadata providers:
//   boundsFor(col, v)   → [lo, hi]      numeric bounds (v = a value in play)
//   valuesFor(col, cur) → [...]         category values (cur = current picks)
//   columns()           → { numeric: [...], categorical: [...] }   add-row picker
//
// `ctx` — the rewrite context (micro's FD_CTX contract, verbatim):
//   push(span)          register a span for shift-tracking
//   replace(span, txt)  surgically rewrite the span in the source text
//   rerender()          re-project widgets after a structural edit
//   addRow(meta, insert, defJoin, compact)?  the add-condition row (optional)
//   quoteIdent(name)    @gcu/expr's identifier quoting
//
// The same renderers serve any expression host — micro's filter drawer and its
// calc window both drive them with different ctx objects.


// a compact operator <select> that rewrites its clause on pick
function opSelect(opts, cur, onPick) {
  const s = document.createElement('select'); s.className = 'fd-opsel';
  for (const o of opts) s.append(new Option(o, o));
  s.value = cur;
  s.onchange = () => onPick(s.value);
  return s;
}

// the add-condition row: [joiner…] + [column…] → seeds an editable clause
// (numeric → `col > mid`, category → `col = "first"`; every piece is then
// changeable in place via the row's own op dropdown / widgets).
// `insert(clause, join)` splices it into the host's text; `hasText` gates the
// joiner picker (a first clause needs none).
function addConditionRow(meta, ctx, insert, defJoin, compact, hasText) {
  const row = document.createElement('div'); row.className = 'fd-row fd-add';
  let joinSel = null;
  if (hasText) {
    const opts = compact ? ['and', 'or'] : ['and', 'or', 'and ( … )', '( all ) or …'];
    joinSel = document.createElement('select'); joinSel.className = 'fd-opsel';
    for (const o of opts) joinSel.append(new Option(o, o));
    joinSel.value = defJoin;
    row.appendChild(joinSel);
  }
  const sel = document.createElement('select');
  const cols = meta.columns();
  sel.append(new Option('add condition…', ''));
  for (const c of cols.numeric || []) sel.append(new Option(c, 'n:' + c));
  for (const c of cols.categorical || []) sel.append(new Option(c, 'c:' + c));
  sel.onchange = () => {
    const v = sel.value; if (!v) return;
    const col = v.slice(2);
    let clause;
    if (v[0] === 'c') { const vals = meta.valuesFor(col, []); clause = ctx.quoteIdent(col) + ' = "' + (vals.find((x) => x) || vals[0] || '') + '"'; }
    else { const [lo, hi] = meta.boundsFor(col, 0); clause = ctx.quoteIdent(col) + ' > ' + fmtNum((lo + hi) / 2, (hi - lo) / 200 || 0.01); }
    insert(clause, joinSel ? joinSel.value : 'and');
  };
  row.appendChild(sel);
  return row;
}

// render one chain level: leaf rows joined by CLICKABLE and/or pills (each pill
// rewrites its own joiner token); nested/parenthesized groups indent, and a
// parenthesized group gets its own add row inserting INSIDE the brackets.
function renderChain(d, n, meta, ctx, delSelf) {
  const ch = chainOf(n);
  const extOf = (x) => (x && x.gStart != null ? { start: x.gStart, end: x.gEnd } : (x && x.start != null ? { start: x.start, end: x.end } : null));
  ch.items.forEach((it, i2) => {
    if (i2 > 0) {
      const j = ch.joiners[i2 - 1];
      const o = document.createElement('div'); o.className = 'fd-op'; o.textContent = ch.op;
      if (j && j.start != null) {
        ctx.push(j);
        o.classList.add('click'); o.title = 'switch and ↔ or';
        o.onclick = () => { ctx.replace(j, ch.op === 'and' ? 'or' : 'and'); ctx.rerender(); };
      }
      d.appendChild(o);
    }
    // this item's REMOVE: the clause + its adjoining joiner; a lone item
    // cascades to delSelf (the parent removes the whole group / clears)
    let del = null;
    if (ch.items.length === 1) del = delSelf || null;
    else {
      const ext = extOf(it);
      const j = i2 > 0 ? ch.joiners[i2 - 1] : ch.joiners[0];
      if (ext && j && j.start != null) {
        const cut = i2 > 0 ? { start: j.start, end: ext.end } : { start: ext.start, end: j.end };
        ctx.push(cut);
        del = () => { ctx.replace(cut, ''); ctx.rerender(); };
      }
    }
    const nested = it && (it.t === 'and' || it.t === 'or');
    if (nested || (it && it.gStart != null)) {
      const g = document.createElement('div'); g.className = 'fd-group';
      if (nested) renderChain(g, it, meta, ctx, del);
      else renderLeaf(g, it, meta, ctx, del);
      if (it.gStart != null && meta && ctx.addRow) {
        const at = { start: it.gEnd - 1, end: it.gEnd - 1 };   // just before the group's ')'
        ctx.push(at);
        g.appendChild(ctx.addRow(meta, (clause, join) => { ctx.replace(at, ' ' + join + ' ' + clause); ctx.rerender(); }, it.t === 'or' ? 'or' : 'and', true));
      }
      d.appendChild(g);
    } else renderLeaf(d, it, meta, ctx, del);
  });
}

function renderLeaf(d, leaf, meta, ctx, del) {
  const spec = leafSpec(leaf, ctx.quoteIdent);
  const row = document.createElement('div'); row.className = 'fd-row';
  const lab = document.createElement('b'); lab.textContent = (spec.negated ? 'not ' : '') + (spec.col || ''); row.appendChild(lab);
  const extent = spec.node && spec.node.start != null ? spec.node : null;
  if (extent) ctx.push(extent);
  if (spec.kind === 'slider' && meta) {
    row.classList.add('nw');
    ctx.push(spec.sp);
    const [lo, hi] = meta.boundsFor(spec.col, spec.v); const step = (hi - lo) / 200 || 0.01;
    if (spec.opSp) {
      ctx.push(spec.opSp);
      const opts = ['>', '>=', '<', '<=', '=', '!=']; if (extent) opts.push('between');
      row.appendChild(opSelect(opts, spec.op, (op2) => {
        if (op2 === 'between') ctx.replace(extent, ctx.quoteIdent(spec.col) + ' between ' + fmtNum(spec.v, step) + ' and ' + fmtNum(hi, step));
        else ctx.replace(spec.opSp, spec.flipped ? (FLIP_OP[op2] || op2) : op2);
        ctx.rerender();
      }));
    } else { const opEl = document.createElement('span'); opEl.textContent = spec.op; opEl.style.color = 'var(--dim)'; row.appendChild(opEl); }
    const sl = document.createElement('input'); sl.type = 'range'; sl.min = lo; sl.max = hi; sl.step = step; sl.value = spec.v;
    const nb = document.createElement('input'); nb.type = 'number'; nb.step = 'any'; nb.value = fmtNum(spec.v, step);
    const push = (v) => { ctx.replace(spec.sp, fmtNum(+v, step)); };
    sl.oninput = () => { nb.value = fmtNum(+sl.value, step); push(sl.value); };
    sl.onchange = () => ctx.rerender();                    // drag end → resync spans
    nb.onchange = () => { push(nb.value); ctx.rerender(); };
    row.append(sl, nb);
  } else if (spec.kind === 'range' && meta) {
    row.classList.add('nw');
    ctx.push(spec.lo); ctx.push(spec.hi);
    const [lo, hi] = meta.boundsFor(spec.col, (spec.vlo + spec.vhi) / 2); const step = (hi - lo) / 200 || 0.01;
    if (extent) {
      row.appendChild(opSelect(['between', '>', '>=', '<', '<=', '=', '!='], 'between', (op2) => {
        if (op2 === 'between') return;
        ctx.replace(extent, ctx.quoteIdent(spec.col) + ' ' + op2 + ' ' + fmtNum(spec.vlo, step));
        ctx.rerender();
      }));
    } else { const opEl = document.createElement('span'); opEl.textContent = 'between'; opEl.style.color = 'var(--dim)'; opEl.style.flex = '0 0 auto'; row.appendChild(opEl); }
    const mk = (sp, v) => { const nb = document.createElement('input'); nb.type = 'number'; nb.step = 'any'; nb.value = fmtNum(v, step); nb.onchange = () => { ctx.replace(sp, fmtNum(+nb.value, step)); ctx.rerender(); }; return nb; };
    const s1 = document.createElement('input'); s1.type = 'range'; s1.min = lo; s1.max = hi; s1.step = step; s1.value = spec.vlo;
    const s2 = document.createElement('input'); s2.type = 'range'; s2.min = lo; s2.max = hi; s2.step = step; s2.value = spec.vhi;
    s1.oninput = () => ctx.replace(spec.lo, fmtNum(+s1.value, step)); s2.oninput = () => ctx.replace(spec.hi, fmtNum(+s2.value, step));
    s1.onchange = s2.onchange = () => ctx.rerender();
    row.append(mk(spec.lo, spec.vlo), s1, s2, mk(spec.hi, spec.vhi));   // num | lo-slider | hi-slider | num, one aligned line
  } else if (spec.kind === 'chips' && meta) {
    spec.picks.forEach((m2) => ctx.push(m2));
    const cur = spec.picks.map((m2) => m2.v);
    const vals = meta.valuesFor(spec.col, cur);
    const q = (x) => '"' + x + '"';
    const curOp = spec.negated && spec.op === 'in' ? 'not in' : spec.op;
    if (extent && !(spec.negated && spec.op !== 'in')) {
      row.appendChild(opSelect(['=', '!=', 'in', 'not in'], curOp, (op2) => {
        const txt = (op2 === 'in' || op2 === 'not in')
          ? ctx.quoteIdent(spec.col) + ' ' + op2 + ' (' + cur.map(q).join(', ') + ')'
          : ctx.quoteIdent(spec.col) + ' ' + op2 + ' ' + q(cur[0]);
        ctx.replace(extent, txt);
        ctx.rerender();
      }));
    } else { const opEl = document.createElement('span'); opEl.textContent = curOp; opEl.style.color = 'var(--dim)'; row.appendChild(opEl); }
    for (const v of vals) {
      const ch = document.createElement('span'); ch.className = 'fd-chip' + (cur.includes(v) ? ' on' : ''); ch.textContent = v;
      ch.onclick = () => {
        if (spec.op === 'in') {                           // multi: rewrite the member-list span
          const now = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
          if (!now.length) return;
          const first = spec.picks[0], last = spec.picks[spec.picks.length - 1];
          ctx.replace({ start: first.start, end: last.end }, now.map(q).join(', '));
        } else ctx.replace(spec.picks[0], q(v));          // single: swap the literal
        ctx.rerender();
      };
      row.appendChild(ch);
    }
  } else if (spec.kind === 'text') {
    ctx.push(spec.sp);
    const t = document.createElement('input'); t.type = 'text'; t.value = spec.v; t.style.width = '140px';
    t.onchange = () => { ctx.replace(spec.sp, '"' + t.value.replace(/"/g, '') + '"'); ctx.rerender(); };
    row.append(document.createTextNode(spec.verb), t);
  } else if (spec.kind === 'flag') {
    const f = document.createElement('span'); f.className = 'fd-chip on'; f.textContent = spec.label;
    if (extent && !spec.negated) {                        // click → toggle blank ↔ filled
      f.title = 'switch blank ↔ filled';
      f.onclick = () => { ctx.replace(extent, ctx.quoteIdent(spec.col) + ' is ' + spec.other); ctx.rerender(); };
    }
    row.appendChild(f);
  } else {
    const x = document.createElement('span'); x.className = 'fd-expr'; x.textContent = spec.label || 'expression'; row.appendChild(x);
  }
  if (del) {
    const xb = document.createElement('button'); xb.className = 'fd-x'; xb.textContent = '×'; xb.title = 'remove this condition';
    xb.onclick = del;
    row.appendChild(xb);
  }
  d.appendChild(row);
}

// ── src/drawer.js ──

// @gcu/filterui drawer — the assembled filter editor: a multiline expression
// editor (two-way synced with the widgets, live-validated, optional highlight
// overlay) over the widget projection. The EXPRESSION stays the single source
// of truth: a widget is a projection of its AST clause, and touching one
// surgically rewrites its literal's source span in the text — user formatting
// preserved, spans shifted by the SpanSet between re-renders.
//
// createFilterDrawer(opts) → handle. opts:
//   host                  the drawer container element (positioning is host's)
//   expr                  { parse, validate, quoteIdent } — @gcu/expr, injected
//   meta                  { boundsFor, valuesFor, columns } — host providers
//   schema()              → validation schema | undefined (per render)
//   apply(text, source)   text changed — source: 'widget' | 'editor' | 'reset' |
//                         'clear'. The HOST owns debounce + actually filtering.
//   highlight(hl, text)?  optional syntax-highlight overlay renderer
//   title?                head label (default 'filter widgets')
//
// handle: { open(text), render(), getText(), setText(text), isDirty(), el }



const FILTERUI_CSS = `
.fdw .fd-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; color: var(--accent, #c89b3c); }
.fdw .fd-head button { background: none; border: 1px solid var(--bd2, #333); border-radius: 3px; color: var(--muted, #999); font-family: var(--mono, monospace); font-size: 11px; padding: 2px 8px; cursor: pointer; }
.fdw .fd-head button:hover { color: var(--text-hi, #eee); }
.fdw .fd-head .fd-dot { color: var(--warn, #c8a02e); margin-right: 4px; }
.fdw .fd-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.fdw .fd-row > b { color: var(--text-hi, #eee); font-weight: normal; min-width: 60px; }
.fdw .fd-op { color: var(--dim, #666); font-size: 10px; text-transform: uppercase; margin: -4px 0 4px 2px; }
.fdw input[type="range"] { flex: 1; min-width: 120px; accent-color: var(--accent, #c89b3c); }
.fdw input[type="number"], .fdw input[type="text"] { width: 84px; font-family: var(--mono, monospace); font-size: 12px; color: var(--text, #ccc); background: var(--bg-field, #222); border: 1px solid var(--bd2, #333); border-radius: 3px; padding: 2px 4px; }
.fdw .fd-chip { border: 1px solid var(--bd2, #333); border-radius: 10px; padding: 1px 9px; cursor: pointer; color: var(--muted, #999); user-select: none; }
.fdw .fd-chip.on { border-color: var(--accent, #c89b3c); color: var(--accent, #c89b3c); }
.fdw .fd-expr { color: var(--dim, #666); border: 1px dashed var(--bd2, #333); border-radius: 3px; padding: 1px 8px; }
.fdw .fd-add { color: var(--dim, #666); }
.fdw .fd-edwrap { position: relative; margin-bottom: 2px; }
.fdw .fd-hl { padding: 4px 6px; font-size: 12px; white-space: pre; }
.fdw .fd-editor { overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--bd2, #333) transparent; }
.fdw .fd-editor::-webkit-scrollbar { height: 7px; width: 7px; }
.fdw .fd-editor::-webkit-scrollbar-thumb { background: var(--bd2, #333); border-radius: 4px; }
.fdw .fd-editor::-webkit-scrollbar-track { background: transparent; }
.fdw .fd-hint { color: var(--dim, #666); margin: 2px 0 8px; }
.fdw .fd-editor { width: 100%; box-sizing: border-box; position: relative; z-index: 1; caret-color: var(--text-hi, #eee); font-family: var(--mono, monospace); font-size: 12px; background: transparent; border: 1px solid var(--bd2, #333); border-radius: 3px; padding: 4px 6px; resize: vertical; min-height: 2.6em; margin-bottom: 0; }
.fdw .fd-editor.hl-backed { color: transparent; }
.fdw .fd-editor::placeholder { color: var(--dim, #666); }
.fdw .fd-editor.err { border-color: #b0563a; }
.fdw .fd-err { color: #b0563a; font-size: 11px; min-height: 14px; margin-bottom: 6px; }
.fdw .fd-row.nw { flex-wrap: nowrap; }
.fdw .fd-row.nw input[type="number"] { width: 68px; flex: 0 0 auto; }
.fdw .fd-row.nw input[type="range"] { min-width: 56px; }
.fdw .fd-group { border-left: 2px solid var(--bd2, #333); padding: 6px 0 0 10px; margin: 2px 0 8px; }
.fdw .fd-op.click { cursor: pointer; display: inline-block; border: 1px solid transparent; border-radius: 8px; padding: 0 7px; }
.fdw .fd-op.click:hover { border-color: var(--bd2, #333); color: var(--text-hi, #eee); }
.fdw select { background: var(--bg-field, #222); color: var(--text, #ccc); border: 1px solid var(--bd2, #333); border-radius: 3px; font: inherit; font-family: var(--mono, monospace); font-size: 12px; padding: 2px 4px; }
.fdw .fd-opsel { flex: 0 0 auto; color: var(--muted, #999); }
.fdw .fd-x { flex: 0 0 auto; margin-left: auto; background: none; border: none; color: var(--dim, #666); font: inherit; font-size: 13px; cursor: pointer; padding: 0 3px; }
.fdw .fd-x:hover { color: #b0563a; }
`;

let _styled = false;
function injectStyles(doc = document) {
  if (_styled) return;
  _styled = true;
  const st = doc.createElement('style');
  st.dataset.filterui = '1';
  st.textContent = FILTERUI_CSS;
  doc.head.appendChild(st);
}

function createFilterDrawer(opts) {
  const { host, expr, meta, apply } = opts;
  const title = opts.title || 'filter widgets';
  const spans = new SpanSet();
  let text = '', snap = '';

  injectStyles(host.ownerDocument || document);
  host.classList.add('fdw');

  // ── skeleton (built once) ──
  host.textContent = '';
  const head = document.createElement('div'); head.className = 'fd-head';
  const ttl = document.createElement('span');
  const dot = document.createElement('span'); dot.className = 'fd-dot';
  ttl.append(dot, document.createTextNode(title));
  const btns = document.createElement('span');
  const rst = document.createElement('button'); rst.textContent = 'reset'; rst.title = 'restore the filter as it was when the drawer opened';
  rst.onclick = () => { setText(snap); apply(snap, 'reset'); render(); };
  btns.append(rst);                                        // no ×: the host's toggle closes; an × reads as "clear"
  head.append(ttl, btns);
  const edwrap = document.createElement('div'); edwrap.className = 'fd-edwrap';
  const edhl = document.createElement('div'); edhl.className = 'exprhl fd-hl'; edhl.setAttribute('aria-hidden', 'true');
  const ed = document.createElement('textarea'); ed.className = 'fd-editor'; ed.rows = 2; ed.spellcheck = false; ed.wrap = 'off';
  ed.placeholder = 'filter expression…  # comments ok';
  if (opts.highlight) ed.classList.add('hl-backed'); else edhl.style.display = 'none';
  const syncHL = () => { if (opts.highlight) { opts.highlight(edhl, ed.value); edhl.scrollLeft = ed.scrollLeft; edhl.scrollTop = ed.scrollTop || 0; } };
  for (const ev of ['scroll', 'keyup', 'click']) ed.addEventListener(ev, syncHL);
  ed.addEventListener('input', () => {                     // typing: mirror + validate live; the host applies when valid
    autosize(); syncHL();
    text = ed.value;
    dot.textContent = text === snap ? '' : '●';
    if (validateUI()) apply(text, 'editor');
  });
  ed.addEventListener('change', () => render());           // commit (blur) → re-project the widgets
  const err = document.createElement('div'); err.className = 'fd-err';
  const body = document.createElement('div'); body.className = 'fd-body';
  edwrap.append(edhl, ed);
  host.append(head, edwrap, err, body);

  function autosize() { ed.style.height = 'auto'; ed.style.height = Math.min(140, ed.scrollHeight + 2) + 'px'; syncHL(); }

  function validateUI() {
    const t = text; let ok = true, msg = '';
    if (t.trim() && expr.validate) {
      const v = expr.validate(t, opts.schema ? opts.schema() : undefined);
      ok = v.ok; msg = ok ? '' : ((v.errors[0] && v.errors[0].message) || 'invalid expression');
    }
    ed.classList.toggle('err', !ok); err.textContent = msg;
    return ok;
  }

  function setText(t) {
    text = t;
    if (document.activeElement !== ed) { ed.value = t; autosize(); }
    dot.textContent = t === snap ? '' : '●';
  }

  // widget edits land here: surgical span replace → new text → host apply
  function widgetReplace(sp, txt) {
    setText(spans.replaceIn(text, sp, txt));
    apply(text, 'widget');
  }

  const ctx = {
    push: (sp) => spans.push(sp),
    replace: widgetReplace,
    rerender: () => render(),
    quoteIdent: expr.quoteIdent,
    addRow: (m, insert, defJoin, compact) => addConditionRow(m, ctx, insert, defJoin, compact, !!text.trim()),
  };

  function render() {
    if (document.activeElement !== ed) { ed.value = text; autosize(); }
    validateUI();
    body.textContent = ''; spans.clear();
    dot.textContent = text === snap ? '' : '●';
    let ast = null; if (text.trim()) { try { ast = expr.parse(text); } catch { ast = null; } }
    if (text.trim() && !ast) { const r = document.createElement('div'); r.className = 'fd-row'; r.innerHTML = '<span class="fd-expr">can’t parse — fix the text first</span>'; body.appendChild(r); }
    if (!text.trim()) { const r = document.createElement('div'); r.className = 'fd-hint'; r.textContent = 'no filter yet — type an expression above, or add a condition below'; body.appendChild(r); }
    if (ast) renderChain(body, ast, meta, ctx, () => { setText(''); apply('', 'clear'); render(); });
    // the top-level add: joiner picker incl. bracket seeds — `and ( … )` opens a
    // new group after the current text; `( all ) or …` wraps EVERYTHING so far
    // and starts an alternative branch. A trailing # comment forces a newline
    // join so the appended clause can't be eaten by it.
    if (meta.columns) {
      body.appendChild(addConditionRow(meta, ctx, (clause, join) => {
        const cur = text.trim();
        if (!cur) { setText(clause); apply(clause, 'widget'); render(); return; }
        const sep = /#[^\n]*$/.test(cur) ? '\n' : ' ';
        let nt;
        if (join === 'and ( … )') nt = cur + sep + 'and (' + clause + ')';
        else if (join === '( all ) or …') nt = (cur.includes('\n') || cur.includes('#') ? '(\n' + cur + '\n)' : '(' + cur + ')') + ' or ' + clause;
        else nt = cur + sep + join + ' ' + clause;
        setText(nt); apply(nt, 'widget'); render();
      }, 'and', false, !!text.trim()));
    }
    if (opts.onRender) opts.onRender();
  }

  return {
    el: host,
    open(t) { text = snap = t || ''; render(); },
    render,
    getText: () => text,
    setText(t) { setText(t); },
    isDirty: () => text !== snap,
    ctx,                                                   // for hosts driving renderChain/renderLeaf directly
  };
}

// ── src/main.js ──

// @gcu/filterui — bidirectional AST↔widget editor for @gcu/expr expressions.
// Extracted from micro's filter drawer (the fd* family): the expression text
// stays the single source of truth; widgets are projections of AST clauses
// whose edits surgically rewrite source spans. Host-agnostic — micro and
// lamina drive it with their own metadata providers and apply callbacks.

export {
  flattenExpr,
  fmtNum,
  SpanSet,
  FLIP_OP,
  chainOf,
  leafSpec,
  opSelect,
  addConditionRow,
  renderChain,
  renderLeaf,
  createFilterDrawer,
  injectStyles,
  FILTERUI_CSS,
};
