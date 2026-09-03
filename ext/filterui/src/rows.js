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

import { fmtNum, chainOf, leafSpec, FLIP_OP } from './core.js';

// a compact operator <select> that rewrites its clause on pick
export function opSelect(opts, cur, onPick) {
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
export function addConditionRow(meta, ctx, insert, defJoin, compact, hasText) {
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
export function renderChain(d, n, meta, ctx, delSelf) {
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

export function renderLeaf(d, leaf, meta, ctx, del) {
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
