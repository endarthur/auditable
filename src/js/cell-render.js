// Cell rendering for md and html cell types.
//
// renderMdCell:    plain markdown rendering with optional `${expr}` template interpolation.
// renderHtmlCell:  full HTML cell binding — comment markers for text content,
//                  data-audit-abind for attribute bindings; widget wireup.
// wireWidgets:     bridges <audit-*> custom elements in HTML cells to the
//                  reactive DAG (each widget update triggers re-run).

import { S } from './state.js';
import { renderMd } from './markdown.js';
// Late-resolved (cycle): exec.js → cell-render.js → exec.js. ESM handles this
// because runDAG is only invoked at user-event time, not at module init.
import { runDAG } from './exec.js';

export function renderMdCell(cell) {
  const viewEl = cell.el.querySelector('.cell-md-view');
  if (!viewEl) return;

  // if no ${expr}, just render plain markdown
  if (!/\$\{[^}]+\}/.test(cell.code)) {
    viewEl.innerHTML = renderMd(cell.code);
    cell.el.classList.remove('stale', 'error');
    return;
  }

  // use only variables this cell references for stable function signatures
  const scopeKeys = cell.uses ? [...cell.uses].sort() : [];
  const scopeVals = scopeKeys.map(k => S.scope[k]);

  if (!cell._tplCache) cell._tplCache = {};
  const scopeSig = scopeKeys.join(',');
  if (cell._tplScopeSig !== scopeSig) {
    cell._tplCache = {};
    cell._tplScopeSig = scopeSig;
  }

  let interpolated = cell.code.replace(/\$\{([^}]+)\}/g, (match, expr) => {
    try {
      let fn = cell._tplCache[expr];
      if (!fn) {
        fn = new Function(...scopeKeys, '"use strict"; return (' + expr + ')');
        cell._tplCache[expr] = fn;
      }
      const val = fn(...scopeVals);
      return val === undefined ? '' : String(val);
    } catch (e) {
      return '[Error: ' + e.message + ']';
    }
  });

  viewEl.innerHTML = renderMd(interpolated);
  cell.el.classList.remove('stale', 'error');
  cell.el.classList.add('fresh');
  setTimeout(() => cell.el.classList.remove('fresh'), 800);
}

export function renderHtmlCell(cell) {
  const viewEl = cell.el.querySelector('.cell-html-view');
  const outputEl = cell.el.querySelector('.cell-output');
  if (!viewEl) return;
  if (outputEl) { outputEl.textContent = ''; outputEl.className = 'cell-output'; }

  // pre-populate scope with widget values (for self-reference)
  if (cell._inputs) {
    for (const [k, v] of Object.entries(cell._inputs)) {
      if (v !== undefined) S.scope[k] = v;
    }
  }

  const scopeKeys = cell.uses ? [...cell.uses].sort() : [];
  const scopeVals = scopeKeys.map(k => S.scope[k]);

  if (!cell._tplCache) cell._tplCache = {};
  const scopeSig = scopeKeys.join(',');
  if (cell._tplScopeSig !== scopeSig) {
    cell._tplCache = {};
    cell._tplScopeSig = scopeSig;
  }

  const evalExpr = (expr) => {
    try {
      let fn = cell._tplCache[expr];
      if (!fn) {
        fn = new Function(...scopeKeys, '"use strict"; return (' + expr + ')');
        cell._tplCache[expr] = fn;
      }
      const r = fn(...scopeVals);
      return r === undefined ? '' : String(r);
    } catch (e) {
      return '[Error: ' + e.message + ']';
    }
  };

  // strip // %directive lines from HTML rendering (directives are parsed from raw source)
  const htmlCode = cell.code.replace(/^\s*\/\/\s*%.+$/gm, '').trim();

  const hasExprs = /\$\{[^}]+\}/.test(htmlCode);

  // invalidate bindings if viewEl changed (e.g. split view swap)
  if (cell._bindViewEl !== viewEl) {
    cell._bindCode = null;
    cell._textMarkers = null;
    cell._bindViewEl = viewEl;
  }

  // first render or code change — full innerHTML with binding setup
  if (cell._bindCode !== cell.code || !cell._textMarkers) {
    if (!hasExprs) {
      viewEl.innerHTML = htmlCode;
    } else {
      // split on tags to classify ${expr} as text-content vs attribute-context
      const parts = htmlCode.split(/(<[^>]+>)/g);
      const textExprs = [];
      const attrBindings = []; // per-element: [{ attr, template }]
      let textIdx = 0;
      let html = '';

      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        if (p % 2 === 0) {
          // text content — wrap ${expr} with comment markers
          html += part.replace(/\$\{([^}]+)\}/g, (m, expr) => {
            textExprs.push(expr);
            return `<!--audit-bind:${textIdx++}-->${evalExpr(expr)}<!--/audit-bind-->`;
          });
        } else if (/\$\{/.test(part)) {
          // tag with ${expr} in attributes — evaluate inline, track templates
          const elemBinds = [];
          let tagHtml = part.replace(
            /([\w-]+)="([^"]*\$\{[^}]+\}[^"]*)"/g,
            (m, attrName, attrVal) => {
              elemBinds.push({ attr: attrName, template: attrVal });
              const evaluated = attrVal.replace(/\$\{([^}]+)\}/g, (m2, expr) => evalExpr(expr));
              return `${attrName}="${evaluated}"`;
            }
          );
          if (elemBinds.length > 0) {
            const idx = attrBindings.length;
            attrBindings.push(elemBinds);
            tagHtml = tagHtml.replace(/^(<[\w][\w-]*)/, `$1 data-audit-abind="${idx}"`);
          }
          html += tagHtml;
        } else {
          html += part;
        }
      }

      viewEl.innerHTML = html;

      // walk DOM to find comment marker pairs for text bindings
      const markers = [];
      const walker = document.createTreeWalker(viewEl, NodeFilter.SHOW_COMMENT);
      const starts = [];
      while (walker.nextNode()) {
        const c = walker.currentNode;
        const m = c.data.match(/^audit-bind:(\d+)$/);
        if (m) starts[parseInt(m[1])] = c;
        if (c.data === '/audit-bind') {
          for (let j = starts.length - 1; j >= 0; j--) {
            if (starts[j] && !markers[j]) {
              markers[j] = { start: starts[j], end: c };
              break;
            }
          }
        }
      }

      // resolve attribute binding element references
      for (let a = 0; a < attrBindings.length; a++) {
        const el = viewEl.querySelector(`[data-audit-abind="${a}"]`);
        if (el) for (const bind of attrBindings[a]) bind.el = el;
      }

      cell._textMarkers = markers;
      cell._textExprs = textExprs;
      cell._attrBindings = attrBindings;
    }

    cell._bindCode = cell.code;
    wireWidgets(cell, viewEl);

  } else if (hasExprs) {
    // re-render: same code, scope changed — patch bindings without touching DOM

    // patch text bindings via comment markers
    if (cell._textMarkers) {
      for (let i = 0; i < cell._textExprs.length; i++) {
        const marker = cell._textMarkers[i];
        if (!marker) continue;
        const val = evalExpr(cell._textExprs[i]);
        while (marker.start.nextSibling && marker.start.nextSibling !== marker.end) {
          marker.start.nextSibling.remove();
        }
        if (/<[a-z][\s\S]*>/i.test(val)) {
          const tpl = document.createElement('template');
          tpl.innerHTML = val;
          marker.start.parentNode.insertBefore(tpl.content, marker.end);
        } else {
          marker.start.parentNode.insertBefore(document.createTextNode(val), marker.end);
        }
      }
    }

    // patch attribute bindings
    if (cell._attrBindings) {
      for (const elemBinds of cell._attrBindings) {
        for (const bind of elemBinds) {
          if (!bind.el) continue;
          const val = bind.template.replace(/\$\{([^}]+)\}/g, (m, expr) => evalExpr(expr));
          bind.el.setAttribute(bind.attr, val);
        }
      }
    }
  }

  cell.el.classList.remove('stale', 'error');
  cell.el.classList.add('fresh');
  setTimeout(() => cell.el.classList.remove('fresh'), 800);
}

function wireWidgets(cell, viewEl) {
  if (!cell._inputs) cell._inputs = {};
  const widgets = viewEl.querySelectorAll(
    'audit-slider, audit-dropdown, audit-checkbox, audit-text-input'
  );
  // clean up previous listeners
  if (cell._widgetCleanups) {
    for (const cleanup of cell._widgetCleanups) cleanup();
  }
  cell._widgetCleanups = [];

  for (const w of widgets) {
    const name = w.name;
    if (!name) continue;
    // skip code-cell widgets (they have data-widget-key)
    if (w.dataset.widgetKey) continue;

    if (cell._inputs[name] !== undefined) {
      w.value = cell._inputs[name];
    } else {
      cell._inputs[name] = w.value;
    }

    const handler = () => {
      cell._inputs[name] = w.value;
      S.scope[name] = w.value;
      if (w.tagName === 'AUDIT-SLIDER' || w.tagName === 'AUDIT-TEXT-INPUT') {
        clearTimeout(cell._inputTimer);
        const delay = w.tagName === 'AUDIT-TEXT-INPUT' ? 300 : 80;
        cell._inputTimer = setTimeout(() => runDAG([cell.id]), delay);
      } else {
        runDAG([cell.id]);
      }
    };
    w.addEventListener('input', handler);
    cell._widgetCleanups.push(() => w.removeEventListener('input', handler));
  }
}

export { wireWidgets };
