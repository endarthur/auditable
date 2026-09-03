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

import { SpanSet, flattenExpr } from './core.js';
import { renderChain, addConditionRow } from './rows.js';

export { flattenExpr };

export const FILTERUI_CSS = `
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
export function injectStyles(doc = document) {
  if (_styled) return;
  _styled = true;
  const st = doc.createElement('style');
  st.dataset.filterui = '1';
  st.textContent = FILTERUI_CSS;
  doc.head.appendChild(st);
}

export function createFilterDrawer(opts) {
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
