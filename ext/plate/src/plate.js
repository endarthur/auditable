// @gcu/plate — the compositor. A page hosting panels from the registry, wired to
// the cross-surface selection/linking contract.
//
// createPlate(el, opts) builds a paper (the page) inside `el`, places panels as
// absolutely-positioned frames, and routes selections:
//   • a panel brush → opts.host.selection.publish(descriptor)
//   • an incoming descriptor → resolve to a key set → panel.setHighlight(set)
// Resolution is generic: kind:"rows" carries keys directly; kind:"none"/"cols"
// clears; kind:"filter" carries a structured predicate, evaluated over plate's
// own data IF the host injected an evaluator (opts.evaluatePredicate) — so the
// engine stays ZERO-DEP and the strata-flavoured predicate lib never imports
// into it. (That predicate lib extracts to @gcu/sift once plate is its second
// consumer; until then the surface passes strata's evaluatePredicate in.)
//
// Zero imports beyond sibling modules; like the other @gcu base libs, plate runs
// in any JS env with a DOM. opts.host.selection is capability-optional (absent
// standalone → linking is simply inert).

import { getPanelKind } from './registry.js';
import { pageDims, contentRect, resolveFrame } from './page.js';

// Resolve a selection descriptor → a Set<string> of keys to highlight (or null
// to clear). Pure + DOM-free so it's unit-testable and reusable: kind:"rows"
// carries keys directly; kind:"none"/"cols"/unknown clears; kind:"filter"
// carries a structured predicate, evaluated over `data` IF an evaluator is
// supplied (else the filter is inert — the engine never imports a predicate
// lib). `data` = { columns:{name:values[]}, keys:[] }. `evalPred(pred, get)`
// is strata's evaluatePredicate (injected); get(name) → the row's value.
export function resolveSelection(desc, data, evalPred) {
  if (!desc) return null;
  if (desc.kind === 'rows') return new Set((desc.rows || []).map(String));
  if (desc.kind === 'filter' && desc.predicate && evalPred) {
    const cols = (data && data.columns) || {};
    const keys = (data && data.keys) || [];
    const out = new Set();
    for (let i = 0; i < keys.length; i++) {
      const get = (name) => { const a = cols[name]; return a ? a[i] : undefined; };
      try { if (evalPred(desc.predicate, get)) out.add(String(keys[i])); } catch { /* skip row */ }
    }
    return out;
  }
  return null;   // none / cols / unknown → clear
}

export function createPlate(el, opts = {}) {
  const host = opts.host || {};
  const link = host.selection || null;            // { publish, subscribe } | null
  const evalPred = opts.evaluatePredicate || null;  // injected; for kind:"filter"

  let pageSpec = opts.page || { size: 'A4', orientation: 'landscape', margins: {} };
  let data = { columns: {}, keys: [], numericColumns: [] };
  let linked = !!link;
  let incoming = null;                            // last descriptor received
  const panels = [];                             // { id, kind, frame, spec, frameEl, instance }
  let nextId = 1;

  // ── DOM: a scrollable backdrop holding the paper ──
  el.innerHTML = '';
  el.classList.add('plate-root');
  el.style.position = el.style.position || 'relative';
  el.style.overflow = 'auto';
  const paper = document.createElement('div');
  paper.className = 'plate-page';
  paper.style.position = 'relative';
  paper.style.margin = '16px auto';
  el.appendChild(paper);

  function layout() {
    const dims = pageDims(pageSpec.size, pageSpec.orientation);
    paper.style.width = dims.w + 'px';
    paper.style.height = dims.h + 'px';
    const content = contentRect(dims, pageSpec.margins);
    for (const p of panels) {
      const r = resolveFrame(p.frame, content);
      p.frameEl.style.left = r.x + 'px';
      p.frameEl.style.top = r.y + 'px';
      p.frameEl.style.width = r.w + 'px';
      p.frameEl.style.height = r.h + 'px';
    }
  }

  // ── selection resolution (the pure helper, bound to this plate's data) ──
  const resolve = (desc) => resolveSelection(desc, data, evalPred);

  function applyHighlight() {
    const set = linked ? resolve(incoming) : null;
    for (const p of panels) p.instance && p.instance.setHighlight(set);
  }

  if (link) {
    link.subscribe((desc) => { incoming = desc; applyHighlight(); });
  }

  // A panel brushed → publish (echo-suppress + dataset/origin/epoch are the
  // host's job; the panel supplies kind/rows/cols).
  function onPanelSelect(desc) {
    if (link) link.publish(desc);
  }

  function instantiate(p) {
    if (p.instance) { p.instance.destroy(); p.instance = null; }
    const kindDef = getPanelKind(p.kind);
    if (!kindDef) { p.frameEl.textContent = 'unknown panel: ' + p.kind; return; }
    const spec = p.spec || kindDef.defaultSpec(data);
    p.spec = spec;
    p.instance = kindDef.render(p.frameEl, spec, data, { onSelect: onPanelSelect });
    if (incoming && linked) p.instance.setHighlight(resolve(incoming));
  }

  return {
    // Add a panel of `kind` at `frame` ('full' | {x,y,w,h}); returns its id.
    addPanel({ kind, frame = 'full', spec = null } = {}) {
      const id = 'p' + (nextId++);
      const frameEl = document.createElement('div');
      frameEl.className = 'plate-frame';
      frameEl.dataset.panel = id;
      frameEl.style.position = 'absolute';
      paper.appendChild(frameEl);
      const p = { id, kind, frame, spec, frameEl, instance: null };
      panels.push(p);
      layout();
      instantiate(p);
      return id;
    },

    // Replace the dataset for every panel (the bound file's columns + keys).
    setData(next) {
      data = next || { columns: {}, keys: [], numericColumns: [] };
      for (const p of panels) instantiate(p);
      applyHighlight();
    },

    // Update one panel's spec (e.g. the x/y column choice).
    setPanelSpec(id, spec) {
      const p = panels.find((q) => q.id === id);
      if (p && p.instance) { p.spec = { ...p.spec, ...spec }; p.instance.update(spec); }
    },

    setPage(spec) { pageSpec = { ...pageSpec, ...spec }; layout(); },

    // The opt-in, visible linking toggle (§7 discipline). Off → ignore incoming.
    setLinked(v) { linked = !!v; applyHighlight(); },
    get linked() { return linked; },
    get lastSelection() { return incoming; },

    panelIds() { return panels.map((p) => p.id); },
    getPanelSpec(id) { const p = panels.find((q) => q.id === id); return p ? { ...p.spec } : null; },
    getPanelInstance(id) { const p = panels.find((q) => q.id === id); return p ? p.instance : null; },  // smoke/debug

    destroy() {
      for (const p of panels) p.instance && p.instance.destroy();
      panels.length = 0;
      el.innerHTML = '';
    },
  };
}
