import { S } from './state.js';
import { buildDAG, topoSort, isManual, isNorun, isHidden, parseCellName, parseOutputId, parseOutputClass } from './dag.js';
import { _ctGetHandler, _ctRenderOutput, _ctIsExecutable } from './cell-types.js';
import { setMsg } from './ui.js';
import { refreshTaggedLanguages, getEditor } from './cm6.js';
import { std } from './stdlib.js';
import { signal, computed, effect, batch, h, each, render } from './sideact.js';
import { python, zenOfPython } from './python.js';
import { addCell } from './cell-ops.js';
import { renderMd } from './markdown.js';
import { syncModules } from './save.js';
import { createNotebookFs, fsRead } from './fs.js';
import { INJECTED_NAMES, TaggedContent, taggedTemplate, cellErrorLine, compileCellCode, cellCacheKey, executeDAG } from './engine.js';

// ── EXECUTION ENGINE ──
//
// Scope model: each cell runs inside an AsyncFunction where upstream variables
// are passed as parameters. This is pass-by-value for primitives — reassigning
// a variable in cell A (e.g. `grid = next`) does NOT propagate to cell B.
// Mutable state that needs to survive across callbacks belongs in %manual cells
// using DOM elements, objects, or closures.
//
// Cell builtins (display, canvas, slider, load, install, installBinary, etc.)
// are injected as additional parameters — listed in _injected, not in scope.
// They are NOT propagated to downstream cells.

// cellErrorLine, TaggedContent, taggedTemplate, INJECTED_NAMES — imported from engine.js
export { cellErrorLine };

// ── BINARY HELPERS ──

function uint8ToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function decodeBinary(entry) {
  const type = entry.type || 'application/octet-stream';
  const bytes = Uint8Array.from(atob(entry.source), c => c.charCodeAt(0));
  if (entry.compressed) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return URL.createObjectURL(new Blob([decompressed], { type }));
  }
  return URL.createObjectURL(new Blob([bytes], { type }));
}

// ── TEXT COMPRESSION ──
// TextEncoder → CompressionStream('gzip') → base64 (for persistent module storage)

async function compressText(str) {
  const bytes = new TextEncoder().encode(str);
  const cs = new CompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return uint8ToBase64(compressed);
}

// base64 → DecompressionStream('gzip') → TextDecoder (inverse of compressText)
async function decompressText(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Response(stream).text();
}


// ── EXECUTION ──

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

  // cache compiled template functions per expression
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

    // restore persisted value or read default
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

// ── cell context — shared builtins for code cells and plugin cells ──

function _createCellContext(cell) {
  // fire invalidation promise from previous run (cleanup resources)
  if (cell._invalidate) { cell._invalidate(); cell._invalidate = null; }

  const outputEl = cell.el.querySelector('.cell-output');
  let widgetEl = cell.el.querySelector('.cell-widgets');
  // plugin cells don't have a widget container — create one if missing
  if (!widgetEl) {
    widgetEl = document.createElement('div');
    widgetEl.className = 'cell-widgets';
    outputEl.parentNode.insertBefore(widgetEl, outputEl);
  }

  // preserve canvases before clearing output
  const prevCanvases = [...outputEl.querySelectorAll('canvas')];
  outputEl.textContent = '';
  outputEl.className = 'cell-output';
  const outClass = parseOutputClass(cell.code);
  if (outClass) outputEl.classList.add(...outClass.split(/\s+/));
  const outId = parseOutputId(cell.code);
  outputEl.id = outId || '';
  cell.el.classList.toggle('present-hidden', isHidden(cell.code));
  cell.error = null;

  // create invalidation promise for this run
  let invalidationResolve;
  const invalidation = new Promise(r => { invalidationResolve = r; });
  cell._invalidate = invalidationResolve;

  // stale guard — when invalidation fires, prevent old closures from mutating DOM
  let _stale = false;
  invalidation.then(() => { _stale = true; });

  // track which widgets are used this run
  const usedWidgets = new Set();
  let canvasIdx = 0;

  // build display function for this cell
  const display = (...args) => {
    if (_stale) return;
    for (const arg of args) {
      if (arg instanceof Element || (arg && arg.nodeType === 11)) {
        outputEl.appendChild(arg);
      } else if (arg instanceof TaggedContent) {
        const el = document.createElement('div');
        if (arg.type === 'md') el.innerHTML = renderMd(arg.content);
        else if (arg.type === 'html') el.innerHTML = arg.content;
        else if (arg.type === 'css') { const s = document.createElement('style'); s.textContent = arg.content; el.appendChild(s); }
        outputEl.appendChild(el);
      } else if (typeof arg === 'object' && arg !== null) {
        // _repr_html_() — rich display protocol (IPython convention)
        if (typeof arg._repr_html_ === 'function') {
          const el = document.createElement('div');
          el.innerHTML = arg._repr_html_();
          outputEl.appendChild(el);
        } else {
          const pre = document.createElement('span');
          try { pre.textContent = JSON.stringify(arg, null, 2); }
          catch { pre.textContent = String(arg); }
          outputEl.appendChild(pre);
          outputEl.appendChild(document.createTextNode('\n'));
        }
      } else {
        outputEl.appendChild(document.createTextNode(String(arg) + '\n'));
      }
    }
  };
  const displayHtml = (str) => display(new TaggedContent('html', str));

  // canvas helper — reuses existing canvas if dimensions match
  const canvas = (w = 400, h = 300) => {
    if (_stale) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; } // orphan
    const prev = prevCanvases[canvasIdx++];
    if (prev && prev.width === w && prev.height === h) {
      outputEl.appendChild(prev);
      return prev;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.style.background = '#000';
    outputEl.appendChild(c);
    return c;
  };

  // table helper
  const table = (data, columnsOrOpts) => {
    if (!data || !data.length) return;
    let cols, sortable = false, filter = false;
    if (Array.isArray(columnsOrOpts)) {
      cols = columnsOrOpts;
    } else if (columnsOrOpts && typeof columnsOrOpts === 'object') {
      cols = columnsOrOpts.columns;
      sortable = !!columnsOrOpts.sortable;
      filter = !!columnsOrOpts.filter;
    }
    cols = cols || Object.keys(data[0]);

    // detect numeric columns by scanning first 10 rows
    const isNumCol = {};
    for (const c of cols) {
      let allNum = true;
      for (const row of data.slice(0, 10)) {
        const v = row[c];
        if (v !== null && v !== undefined && typeof v !== 'number') { allNum = false; break; }
      }
      isNumCol[c] = allNum;
    }

    const wrap = document.createElement('div');
    let rows = [...data];
    let sortCol = null, sortAsc = true, filterStr = '';

    // filter input
    let filterInput;
    if (filter) {
      filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.placeholder = 'Filter\u2026';
      filterInput.style.cssText = 'width:200px;margin:2px 0 4px;padding:2px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);font:11px var(--mono);border-radius:2px;';
      wrap.appendChild(filterInput);
    }

    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');

    function renderHead() {
      thead.innerHTML = '';
      const hr = document.createElement('tr');
      for (const c of cols) {
        const th = document.createElement('th');
        th.style.textAlign = isNumCol[c] ? 'right' : 'left';
        let label = c;
        if (sortable) {
          th.style.cursor = 'pointer';
          th.style.userSelect = 'none';
          if (sortCol === c) label += sortAsc ? ' \u25b4' : ' \u25be';
        }
        th.textContent = label;
        if (sortable) th.addEventListener('click', () => {
          if (sortCol === c) sortAsc = !sortAsc;
          else { sortCol = c; sortAsc = true; }
          renderHead();
          renderBody();
        });
        hr.appendChild(th);
      }
      thead.appendChild(hr);
    }

    function renderBody() {
      tbody.innerHTML = '';
      let view = rows;
      if (filterStr) {
        const q = filterStr.toLowerCase();
        view = view.filter(row => cols.some(c => String(row[c] ?? '').toLowerCase().includes(q)));
      }
      if (sortCol) {
        view = [...view].sort((a, b) => {
          const va = a[sortCol], vb = b[sortCol];
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          const cmp = isNumCol[sortCol] ? va - vb : String(va).localeCompare(String(vb));
          return sortAsc ? cmp : -cmp;
        });
      }
      for (const row of view) {
        const tr = document.createElement('tr');
        for (const c of cols) {
          const td = document.createElement('td');
          const v = row[c];
          td.textContent = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v ?? '');
          td.style.textAlign = isNumCol[c] ? 'right' : 'left';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }

    renderHead();
    renderBody();
    t.appendChild(thead);
    t.appendChild(tbody);
    wrap.appendChild(t);

    if (filter) {
      filterInput.addEventListener('input', () => {
        filterStr = filterInput.value;
        renderBody();
      });
    }

    outputEl.appendChild(wrap);
  };

  // input widget helpers — persist state and DOM across re-runs
  if (!cell._inputs) cell._inputs = {};
  if (!cell._callbacks) cell._callbacks = {};

  const _tagMap = { slider: 'audit-slider', dropdown: 'audit-dropdown',
                    checkbox: 'audit-checkbox', text: 'audit-text-input' };

  const mkInput = (label, type, defaultVal, opts = {}) => {
    const key = label;
    const prev = cell._inputs[key];
    let val = prev !== undefined ? prev : defaultVal;
    usedWidgets.add(key);
    cell._callbacks[key] = { onInput: opts.onInput, onChange: opts.onChange };

    const tag = _tagMap[type];

    // check if widget DOM already exists
    const existing = widgetEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (existing) {
      // update attributes that may have changed on re-run
      existing.id = opts.id || '';
      if (opts.class) existing.className = opts.class; else existing.removeAttribute('class');
      if (type === 'slider') {
        if (opts.min != null) existing.setAttribute('min', opts.min);
        if (opts.max != null) existing.setAttribute('max', opts.max);
        if (opts.step != null) existing.setAttribute('step', opts.step);
      } else if (type === 'dropdown') {
        const newOpts = (opts.options || []).join(',');
        if (existing.getAttribute('options') !== newOpts) existing.setAttribute('options', newOpts);
      }
      cell._inputs[key] = existing.value;
      return cell._inputs[key];
    }

    // create new custom element
    const el = document.createElement(tag);
    el.dataset.widgetKey = key;
    el.setAttribute('label', label);
    el.setAttribute('name', label);
    if (opts.id) el.id = opts.id;
    if (opts.class) el.className = opts.class;

    if (type === 'slider') {
      el.setAttribute('min', opts.min ?? 0);
      el.setAttribute('max', opts.max ?? 100);
      el.setAttribute('step', opts.step ?? 1);
      el.setAttribute('value', val);
    } else if (type === 'dropdown') {
      el.setAttribute('options', (opts.options || []).join(','));
      el.setAttribute('value', val);
    } else if (type === 'checkbox') {
      if (val) el.setAttribute('checked', '');
    } else if (type === 'text') {
      el.setAttribute('value', val);
    }

    // event handling: reactive vs callback
    el.addEventListener('input', () => {
      cell._inputs[key] = el.value;
      const cb = cell._callbacks[key];
      if (cb.onInput) { cb.onInput(el.value); }
      else if (!cb.onChange) {
        clearTimeout(cell._inputTimer);
        const delay = type === 'text' ? 300 : type === 'slider' ? 80 : 0;
        if (delay) cell._inputTimer = setTimeout(() => runDAG([cell.id]), delay);
        else runDAG([cell.id]);
      }
    });
    el.addEventListener('change', () => {
      const cb = cell._callbacks[key];
      if (cb.onChange) cb.onChange(el.value);
    });

    widgetEl.appendChild(el);
    cell._inputs[key] = el.value;
    return cell._inputs[key];
  };

  const slider = (label, defaultVal = 50, opts = {}) => mkInput(label, 'slider', defaultVal, opts);
  const dropdown = (label, options, defaultVal, opts = {}) => mkInput(label, 'dropdown', defaultVal || options[0], { ...opts, options });
  const checkbox = (label, defaultVal = false, opts = {}) => mkInput(label, 'checkbox', defaultVal, opts);
  const textInput = (label, defaultVal = '', opts = {}) => mkInput(label, 'text', defaultVal, opts);

  // import cache — shared across all cells
  if (!window._importCache) window._importCache = {};
  if (!window._installedModules) window._installedModules = {}; // url -> { source, cellId }

  const load = async (url) => {
    // virtual modules
    if (url === '@std') return std;
    if (url === '@python') return python;
    if (url === '@python/this') { display(zenOfPython()); return python; }

    // fs: scheme — load from notebook filesystem
    if (url.startsWith('fs:')) {
      const fsPath = url.slice(3);
      if (!window._importCache[url]) {
        const source = await fsRead(fsPath, 'text');
        const blob = new Blob([source], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        window._importCache[url] = await import(blobUrl);
      }
      return window._importCache[url];
    }

    // @atra/<name> — atra library binary distributions
    // if pre-installed (via /// module: directive or install()), the existing
    // _installedModules[url] check below handles it. this fallback covers
    // development mode where the file is available at a relative path.
    if (url.startsWith('@atra/')) {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const name = url.slice(6);
        const mod = await import('./ext/atra/lib/' + name + '.js');
        window._importCache[url] = mod;
        return mod;
      }
      // fall through to normal _importCache / _installedModules handling below
    }

    // @sheet — xlsx IO library (dev-mode fallback)
    if (url === '@sheet') {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const mod = await import('./ext/sheet/index.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    // @calque — spreadsheet language (dev-mode fallback)
    if (url === '@calque') {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const mod = await import('./ext/calque/index.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    // @spinifex — web GIS (dev-mode fallback)
    if (url === '@spinifex') {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const mod = await import('./ext/spinifex/index.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    // @plan — project management (dev-mode fallback)
    if (url === '@plan') {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const mod = await import('./ext/plan/index.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    // @gcu/adder — Python interpreter (dev-mode fallback)
    if (url === '@gcu/adder') {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const mod = await import('./ext/adder/index.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    // @gcu/plot — Canvas 2D plotting (dev-mode fallback)
    if (url === '@gcu/plot') {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const mod = await import('./ext/plot/index.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    // @gcu/sadpan — lightweight dataframe (dev-mode fallback)
    if (url === '@gcu/sadpan') {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const mod = await import('./ext/sadpan/index.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    // @gcu/soft — English keyword language (dev-mode fallback)
    if (url === '@gcu/soft') {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const mod = await import('./ext/soft/index.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    if (window._importCache[url]) return window._importCache[url];

    // binary assets — return blob URL
    if (window._installedModules[url]?.binary) {
      const blobUrl = await decodeBinary(window._installedModules[url]);
      window._importCache[url] = blobUrl;
      return blobUrl;
    }

    const langsBefore = window._taggedLanguages ? Object.keys(window._taggedLanguages).length : 0;

    let mod;
    // check installed (offline) modules first
    if (window._installedModules[url]) {
      const entry = window._installedModules[url];
      let src;
      if (typeof entry === 'object' && entry.compressed && !entry.binary) {
        src = await decompressText(entry.source);
      } else {
        src = typeof entry === 'string' ? entry : entry.source;
      }
      // resolve root-relative paths for legacy saved modules
      try { src = resolveModulePaths(src, url); } catch {}
      const blob = new Blob([src], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      mod = await import(blobUrl);
    } else {
      mod = await import(url);
    }
    window._importCache[url] = mod;

    // if the module registered new tagged languages, re-highlight all code cells
    const langsAfter = window._taggedLanguages ? Object.keys(window._taggedLanguages).length : 0;
    if (langsAfter > langsBefore) {
      refreshTaggedLanguages();
    }

    return mod;
  };

  // resolve root-relative paths in module source so blob URLs work
  const resolveModulePaths = (source, responseUrl) => {
    const origin = new URL(responseUrl).origin;
    return source.replace(/(from\s+["'])(\/[^"']+)(["'])/g, '$1' + origin + '$2$3')
                 .replace(/(import\s*\(["'])(\/[^"']+)(["']\))/g, '$1' + origin + '$2$3')
                 .replace(/(export\s+\*\s+from\s+["'])(\/[^"']+)(["'])/g, '$1' + origin + '$2$3')
                 .replace(/(export\s*\{[^}]*\}\s*from\s+["'])(\/[^"']+)(["'])/g, '$1' + origin + '$2$3');
  };

  const install = async (url) => {
    // @atra/<name> — resolve to CDN URL, store under virtual key
    if (url.startsWith('@atra/')) {
      const name = url.slice(6);
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/atra/lib/' + name + '.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // @sheet — xlsx IO library
    if (url === '@sheet') {
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/sheet/index.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // @calque — spreadsheet language
    if (url === '@calque') {
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/calque/index.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // @spinifex — web GIS
    if (url === '@spinifex') {
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/spinifex/index.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // @plan — project management
    if (url === '@plan') {
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/plan/index.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // @gcu/adder — Python extension
    if (url === '@gcu/adder') {
      const baseUrl = __AUDITABLE_PAGES_URL__ + '/ext/adder/';
      const resp = await fetch(baseUrl + 'index.js');
      if (!resp.ok) throw new Error(`Failed to fetch adder: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed @gcu/adder (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // @gcu/plot — Canvas 2D plotting
    if (url === '@gcu/plot') {
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/plot/index.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // @gcu/sadpan — lightweight dataframe
    if (url === '@gcu/sadpan') {
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/sadpan/index.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // @gcu/soft — English keyword language
    if (url === '@gcu/soft') {
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/soft/index.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
      syncModules();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB → ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }
    // normalize: add ?bundle for esm.sh if not present
    let bundleUrl = url;
    if (bundleUrl.includes('esm.sh') && !bundleUrl.includes('?bundle') && !bundleUrl.includes('&bundle')) {
      bundleUrl += (bundleUrl.includes('?') ? '&' : '?') + 'bundle';
    }
    // fetch source
    const resp = await fetch(bundleUrl);
    if (!resp.ok) throw new Error(`Failed to fetch ${bundleUrl}: ${resp.status}`);
    let source = await resp.text();
    // resolve root-relative paths to absolute so blob URLs work
    source = resolveModulePaths(source, resp.url);
    // store under original url with cell reference (compressed for persistent storage)
    const compressedSrc = await compressText(source);
    window._installedModules[url] = { source: compressedSrc, compressed: true, cellId: cell.id };
    syncModules();
    // also load it into cache
    const blob = new Blob([source], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const mod = await import(blobUrl);
    window._importCache[url] = mod;
    display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB \u2192 ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
    return mod;
  };

  const installBinary = async (url, opts = {}) => {
    const compress = opts.compress !== false;
    // if already installed, decode and return blob URL
    if (window._installedModules[url]?.binary) {
      return decodeBinary(window._installedModules[url]);
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
    const contentType = resp.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    const buf = await resp.arrayBuffer();
    const raw = new Uint8Array(buf);
    let stored, isCompressed = false;
    if (compress) {
      const cs = new CompressionStream('gzip');
      const stream = new Blob([raw]).stream().pipeThrough(cs);
      const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
      stored = uint8ToBase64(compressed);
      isCompressed = true;
    } else {
      stored = uint8ToBase64(raw);
    }
    window._installedModules[url] = { source: stored, cellId: cell.id, binary: true, compressed: isCompressed, type: contentType };
    syncModules();
    const ratio = isCompressed ? ` \u2192 ${(stored.length / 1024).toFixed(1)} KB compressed` : '';
    display(`installed binary ${url} (${(buf.byteLength / 1024).toFixed(1)} KB${ratio})`);
    return URL.createObjectURL(new Blob([raw], { type: contentType }));
  };

  // ── file read helper (shared by upload and drop) ──
  const readFile = (file, as) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    if (as === 'arrayBuffer') reader.readAsArrayBuffer(file);
    else if (as === 'dataURL') reader.readAsDataURL(file);
    else reader.readAsText(file);
  });

  // ── MIME guess from filename extension ──
  const guessMime = (name) => {
    const ext = (name || '').split('.').pop().toLowerCase();
    const map = { csv: 'text/csv', json: 'application/json', txt: 'text/plain',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf',
      html: 'text/html', xml: 'application/xml', wasm: 'application/wasm' };
    return map[ext] || 'application/octet-stream';
  };

  // ── ui.download — output-only download button ──
  const download = (label, data, filename, opts = {}) => {
    const type = opts.type || guessMime(filename);
    let blob;
    if (data instanceof Blob) blob = data;
    else if (data instanceof ArrayBuffer || data instanceof Uint8Array) blob = new Blob([data], { type });
    else if (typeof data === 'string') blob = new Blob([data], { type });
    else blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    invalidation.then(() => URL.revokeObjectURL(url));

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.textContent = label;
    a.style.cssText = 'display:inline-block;padding:6px 14px;background:var(--accent);color:#111;border-radius:3px;text-decoration:none;font-weight:600;font-family:var(--mono);font-size:12px;cursor:pointer;';
    outputEl.appendChild(a);
    return a;
  };

  // ── ui.upload — file picker input widget ──
  const upload = (label, opts = {}) => {
    const key = label;
    usedWidgets.add(key);
    cell._callbacks[key] = { onChange: opts.onChange };

    const existing = widgetEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (existing) return cell._inputs[key] ?? null;

    const wrap = document.createElement('span');
    wrap.dataset.widgetKey = key;
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px;color:var(--fg-dim);';

    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'min-width:80px;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--fg-dim);';
    wrap.appendChild(lbl);

    const btn = document.createElement('button');
    btn.textContent = 'choose file';
    btn.style.cssText = 'padding:3px 10px;background:var(--bg2);border:1px solid var(--border);color:var(--fg-bright);font-family:var(--mono);font-size:11px;cursor:pointer;border-radius:2px;';
    wrap.appendChild(btn);

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-size:11px;color:var(--fg-dim);';
    wrap.appendChild(nameSpan);

    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (opts.accept) input.accept = opts.accept;
    wrap.appendChild(input);

    btn.onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const data = await readFile(file, opts.as || 'text');
      const result = { name: file.name, data, size: file.size, type: file.type };
      cell._inputs[key] = result;
      nameSpan.textContent = file.name;
      btn.textContent = file.name;
      const cb = cell._callbacks[key];
      if (cb?.onChange) cb.onChange(result);
      else runDAG([cell.id]);
    };

    widgetEl.appendChild(wrap);
    cell._inputs[key] = cell._inputs[key] ?? null;
    return cell._inputs[key];
  };

  // ── ui.drop — drop zone + file picker input widget ──
  const drop = (label, opts = {}) => {
    const key = label;
    usedWidgets.add(key);
    cell._callbacks[key] = { onChange: opts.onChange };

    const existing = widgetEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (existing) return cell._inputs[key] ?? null;

    const zone = document.createElement('div');
    zone.dataset.widgetKey = key;
    zone.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:12px 16px;border:2px dashed var(--border-hi);border-radius:4px;color:var(--fg-dim);font-family:var(--mono);font-size:11px;cursor:pointer;min-height:48px;transition:border-color 0.15s;';
    zone.textContent = label;

    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (opts.accept) input.accept = opts.accept;
    zone.appendChild(input);

    const handleFile = async (file) => {
      const data = await readFile(file, opts.as || 'text');
      const result = { name: file.name, data, size: file.size, type: file.type };
      cell._inputs[key] = result;
      zone.textContent = file.name;
      zone.style.borderColor = 'var(--accent)';
      zone.appendChild(input);
      const cb = cell._callbacks[key];
      if (cb?.onChange) cb.onChange(result);
      else runDAG([cell.id]);
    };

    zone.onclick = () => input.click();
    input.onchange = () => { if (input.files[0]) handleFile(input.files[0]); };

    zone.ondragover = (e) => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; };
    zone.ondragleave = () => { zone.style.borderColor = cell._inputs[key] ? 'var(--accent)' : 'var(--border-hi)'; };
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.style.borderColor = 'var(--border-hi)';
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    };

    widgetEl.appendChild(zone);
    cell._inputs[key] = cell._inputs[key] ?? null;
    return cell._inputs[key];
  };

  // ui object — constructed per-cell (closes over cell context)
  const ui = { display, print: display, html: displayHtml, canvas, table, slider, dropdown, checkbox, textInput, download, upload, drop };

  // tagged template builtins
  const md = taggedTemplate('md');
  const html = taggedTemplate('html');
  const css = taggedTemplate('css');

  // workshop builtin — slide-out side panel with navigable pages
  const workshop = (pages, opts) => {
    const key = '__workshop__';
    usedWidgets.add(key);
    const useOverlay = !!(opts && opts.overlay);

    // persist page index across re-runs
    if (cell._inputs[key] === undefined) cell._inputs[key] = 0;
    let currentPage = cell._inputs[key];

    // get or create panel DOM
    let panel = document.getElementById('workshopPanel');
    let overlay = document.getElementById('workshopOverlay');
    if (!panel) {
      overlay = document.createElement('div');
      overlay.id = 'workshopOverlay';
      overlay.className = 'workshop-overlay';
      overlay.onclick = () => toggleWorkshop(false);
      document.body.appendChild(overlay);

      panel = document.createElement('div');
      panel.id = 'workshopPanel';
      panel.className = 'workshop-panel';
      document.body.appendChild(panel);
    }

    // side tab attached to the panel edge
    let toggleBtn = document.getElementById('workshopToggle');
    if (!toggleBtn) {
      toggleBtn = document.createElement('button');
      toggleBtn.id = 'workshopToggle';
      toggleBtn.className = 'workshop-tab';
      toggleBtn.title = 'toggle workshop panel';
      toggleBtn.textContent = 'workshop';
      document.body.appendChild(toggleBtn);
      toggleBtn.onclick = () => toggleWorkshop();
    }

    function toggleWorkshop(show) {
      const isOpen = panel.classList.contains('open');
      const shouldOpen = show !== undefined ? show : !isOpen;
      panel.classList.toggle('open', shouldOpen);
      if (useOverlay) overlay.classList.toggle('visible', shouldOpen);
    }

    function renderPage(idx) {
      idx = Math.max(0, Math.min(idx, pages.length - 1));
      currentPage = idx;
      cell._inputs[key] = idx;
      const page = pages[idx];

      panel.innerHTML = '';

      // header with close button
      const header = document.createElement('div');
      header.className = 'workshop-header';
      const title = document.createElement('span');
      title.className = 'workshop-title';
      title.textContent = page.title || `Page ${idx + 1}`;
      header.appendChild(title);
      const closeBtn = document.createElement('button');
      closeBtn.className = 'workshop-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.onclick = () => toggleWorkshop(false);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      // content
      const body = document.createElement('div');
      body.className = 'workshop-body';
      if (page.content instanceof Element) {
        body.appendChild(page.content);
      } else if (page.content instanceof TaggedContent) {
        if (page.content.type === 'md') {
          body.innerHTML = renderMd(page.content.content);
        } else if (page.content.type === 'css') {
          const pre = document.createElement('pre');
          pre.textContent = page.content.content;
          body.appendChild(pre);
        } else {
          body.innerHTML = page.content.content;
        }
      } else {
        body.textContent = String(page.content ?? '');
      }
      panel.appendChild(body);

      // progress pips
      const pips = document.createElement('div');
      pips.className = 'workshop-pips';
      for (let i = 0; i < pages.length; i++) {
        const pip = document.createElement('span');
        pip.className = 'workshop-pip' + (i === idx ? ' active' : '') + (i < idx ? ' done' : '');
        pip.onclick = () => navigate(i);
        pips.appendChild(pip);
      }
      panel.appendChild(pips);

      // nav buttons
      const nav = document.createElement('div');
      nav.className = 'workshop-nav';
      if (idx > 0) {
        const prev = document.createElement('button');
        prev.textContent = '\u2190 prev';
        prev.onclick = () => navigate(idx - 1);
        nav.appendChild(prev);
      }
      const spacer = document.createElement('span');
      spacer.style.flex = '1';
      nav.appendChild(spacer);
      const counter = document.createElement('span');
      counter.className = 'workshop-counter';
      counter.textContent = `${idx + 1} / ${pages.length}`;
      nav.appendChild(counter);
      if (idx < pages.length - 1) {
        const next = document.createElement('button');
        next.className = 'workshop-next';
        next.textContent = 'next \u2192';
        if (page.canAdvance && !page.canAdvance()) {
          next.disabled = true;
          next.title = 'complete the task to continue';
        }
        next.onclick = () => navigate(idx + 1);
        nav.appendChild(next);
      }
      panel.appendChild(nav);

      // fire onEnter
      if (page.onEnter) page.onEnter();
    }

    function navigate(idx) {
      const prevPage = pages[currentPage];
      if (prevPage?.onLeave) prevPage.onLeave();
      renderPage(idx);
    }

    // store re-check function for canAdvance gating
    cell._workshopRecheck = () => {
      const page = pages[currentPage];
      if (!page?.canAdvance) return;
      const nextBtn = panel.querySelector('.workshop-next');
      if (nextBtn) {
        nextBtn.disabled = !page.canAdvance();
      }
    };

    renderPage(currentPage);

    // auto-open on first creation
    if (!panel.classList.contains('open') && !cell._workshopShown) {
      toggleWorkshop(true);
      cell._workshopShown = true;
    }

    // store cleanup so deleteCell can tear down workshop DOM
    cell._workshopCleanup = () => {
      panel.remove();
      overlay.remove();
      toggleBtn.remove();
      cell._workshopRecheck = null;
    };
    // on re-run, just clear the recheck — DOM is reused by ID
    invalidation.then(() => {
      cell._workshopRecheck = null;
    });

    return { goto: navigate, toggle: toggleWorkshop, recheck: cell._workshopRecheck };
  };

  // ── worker / workerPool — offload pure computation to Web Workers ──

  const worker = (fn) => {
    const src = `"use strict";\nconst __fn__ = ${fn.toString()};\nonmessage = async (e) => {\n  try {\n    const result = await __fn__(...e.data.args);\n    const transfer = [];\n    if (result instanceof ArrayBuffer) transfer.push(result);\n    else if (result?.buffer instanceof ArrayBuffer) transfer.push(result.buffer);\n    postMessage({ result }, transfer);\n  } catch (err) { postMessage({ error: err.message }); }\n};`;
    const blob = new Blob([src], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    invalidation.then(() => w.terminate());

    const call = (...args) => new Promise((resolve, reject) => {
      w.onmessage = (e) => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
      w.onerror = (e) => reject(new Error(e.message));
      const transfer = [];
      for (const a of args) {
        if (a instanceof ArrayBuffer) transfer.push(a);
        else if (a?.buffer instanceof ArrayBuffer) transfer.push(a.buffer);
      }
      w.postMessage({ args }, transfer);
    });
    call.terminate = () => w.terminate();
    return call;
  };

  const workerPool = (fn, n = navigator.hardwareConcurrency || 4) => {
    const workers = Array.from({ length: n }, () => worker(fn));
    const free = [...workers];
    const queue = [];

    const dispatch = () => {
      while (queue.length && free.length) {
        const { args, resolve, reject } = queue.shift();
        const w = free.shift();
        w(...args).then(
          r => { free.push(w); resolve(r); dispatch(); },
          e => { free.push(w); reject(e); dispatch(); }
        );
      }
    };

    const pool = (...args) => new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject });
      dispatch();
    });
    pool.map = (arr, ...extra) => Promise.all(arr.map(item => pool(item, ...extra)));
    pool.terminate = () => workers.forEach(w => w.terminate());
    return pool;
  };

  // notebook API — programmatic notebook control
  const notebook = {
    fs: createNotebookFs(),
    get cells() { return S.cells.map(c => ({ id: c.id, type: c.type, code: c.code })); },
    get scope() { return { ...S.scope }; },
    addCell: (type, code, afterId) => addCell(type, code, afterId),
    scrollTo: (id) => {
      const c = S.cells.find(c => c.id === id);
      if (c?.el) c.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    focus: (id) => {
      const c = S.cells.find(c => c.id === id);
      if (c?.el) {
        c.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const editor = getEditor(id);
        if (editor) editor.focus();
        else { const ta = c.el.querySelector('textarea'); if (ta) ta.focus(); }
      }
    },
    collapse: (id) => {
      const c = S.cells.find(c => c.id === id);
      if (c) { c.collapsed = true; if (c.el) c.el.classList.add('collapsed'); }
    },
    expand: (id) => {
      const c = S.cells.find(c => c.id === id);
      if (c) { c.collapsed = false; if (c.el) c.el.classList.remove('collapsed'); }
    },
    run: (ids) => runDAG(Array.isArray(ids) ? ids : [ids], true),
  };

  const vfs = window._notebookVFS || undefined;
  const sr = { signal, computed, effect, batch, h, each, render };

  const ctx = { ui, std, sr, load, install, installBinary, invalidation, display, print: display,
           md, html, css, workshop, notebook, worker, workerPool, vfs, usedWidgets, outputEl, widgetEl };

  // run cell context hooks (e.g. sr.state persistence)
  for (const hook of (window._cellContextHooks || [])) hook.setup(cell, ctx);

  return ctx;
}

export async function execCell(cell) {
  const ctx = _createCellContext(cell);
  const { ui, std, sr, load, install, installBinary, invalidation, display, print: print_,
          md, html, css, workshop, notebook, worker, workerPool, vfs,
          usedWidgets, outputEl, widgetEl } = ctx;

  const scopeKeys = cell.uses ? [...cell.uses].filter(k => !INJECTED_NAMES.includes(k)).sort() : [];
  const defNames = cell.defines ? [...cell.defines].sort().join(', ') : '';
  const cacheKey = cellCacheKey(scopeKeys, defNames, cell.code);

  try {
    let fn;
    if (cell._cacheKey === cacheKey && cell._cachedFn) {
      fn = cell._cachedFn;
    } else {
      fn = compileCellCode(cell.code, scopeKeys, defNames, cell.id, parseCellName(cell.code));
      cell._cachedFn = fn;
      cell._cacheKey = cacheKey;
    }

    const scopeVals = scopeKeys.map(k => S.scope[k]);
    const injectedVals = [ui, std, sr, load, install, installBinary, invalidation, display, display,
      md, html, css, workshop, notebook, worker, workerPool, vfs];
    const result = await fn(...scopeVals, ...injectedVals);

    // store result for DAG caching (scope update delegated to executeDAG)
    if (result && typeof result === 'object') {
      cell._lastResult = result;
    }

    cell.error = null;
    cell.el.classList.remove('stale', 'error');
    cell.el.classList.add('fresh');
    setTimeout(() => cell.el.classList.remove('fresh'), 800);

    // remove widgets no longer referenced by code
    for (const w of widgetEl.querySelectorAll('[data-widget-key]')) {
      if (!usedWidgets.has(w.dataset.widgetKey)) {
        delete cell._inputs[w.dataset.widgetKey];
        delete cell._callbacks[w.dataset.widgetKey];
        w.remove();
      }
    }

    return { defines: cell._lastResult || {}, error: null };
  } catch (e) {
    const line = cellErrorLine(e, cell.id);
    const lineInfo = line > 0 ? ` (line ${line})` : '';
    cell.error = e.message;
    outputEl.textContent = e.message + lineInfo;
    outputEl.className = 'cell-output error';
    cell.el.classList.remove('stale', 'fresh');
    cell.el.classList.add('error');
    return { defines: {}, error: e };
  }
}

let _dagGen = 0;

export async function runDAG(dirtyIds, force = false) {
  const gen = ++_dagGen;
  buildDAG();
  const isAutorun = S.autorun && !force;
  const runSet = new Set(topoSort(dirtyIds));

  if (window._dagStart) window._dagStart();

  S.scope = {};

  const result = await executeDAG(S.cells, dirtyIds, runSet, S.scope, {
    isAutorun,

    onExecCode: async (cell) => {
      if (window._beforeExec) window._beforeExec(cell);
      return execCell(cell);
    },

    onExecHtml: (cell) => renderHtmlCell(cell),
    onExecMd: (cell) => renderMdCell(cell),

    onExecPlugin: async (cell) => {
      const handler = _ctGetHandler(cell.type);
      if (!handler) return null;

      const upstream = {};
      if (cell.uses) {
        for (const name of cell.uses) {
          if (S.scope[name] !== undefined) upstream[name] = S.scope[name];
        }
      }
      cell._ctx = _createCellContext(cell);

      try {
        const result = await handler.execute(cell.code, upstream, cell);
        if (result && result.defines) {
          cell._lastResult = result.defines;
        }
        if (result && result.output !== undefined) {
          _ctRenderOutput(cell, result.output);
        }
        cell.error = null;
        cell.el.classList.remove('stale', 'error');
        cell.el.classList.add('fresh');
        setTimeout(() => cell.el.classList.remove('fresh'), 800);

        if (cell._ctx.usedWidgets) {
          const widgetEl = cell._ctx.widgetEl;
          for (const w of widgetEl.querySelectorAll('[data-widget-key]')) {
            if (!cell._ctx.usedWidgets.has(w.dataset.widgetKey)) {
              delete cell._inputs[w.dataset.widgetKey];
              delete cell._callbacks[w.dataset.widgetKey];
              w.remove();
            }
          }
        }
        return { defines: cell._lastResult || {}, error: null };
      } catch (e) {
        cell.error = e.message;
        const outputEl = cell._ctx?.outputEl || cell.el.querySelector('.cell-output');
        if (outputEl) {
          outputEl.textContent = e.message;
          outputEl.className = 'cell-output error';
        }
        cell.el.classList.remove('stale', 'fresh');
        cell.el.classList.add('error');
        return { defines: {}, error: e };
      }
    },

    onCellStatus: (cell, status) => {
      if (status === 'stale') {
        cell.el.classList.remove('fresh');
        cell.el.classList.add('stale');
      } else if (status === 'blocked') {
        const outputEl = cell.el.querySelector('.cell-output');
        if (outputEl && !cell.error) {
          outputEl.textContent = 'blocked by upstream error';
          outputEl.className = 'cell-output error';
        }
        cell.el.classList.remove('stale', 'fresh');
        cell.el.classList.add('error');
      }
    },

    checkGeneration: () => _dagGen === gen,

    onAfterExec: (cell, i) => {
      if (window._afterExec && !isAutorun) return window._afterExec(cell, i);
      return -1;
    },
  });

  if (result.aborted) return;

  updateStatus();

  for (const c of S.cells) {
    if (c._workshopRecheck) c._workshopRecheck();
  }

  if (window._mcpNotifyExecComplete) window._mcpNotifyExecComplete();
}

export async function runAll() {
  const ids = S.cells.filter(c =>
    c.type === 'md' || (_ctIsExecutable(c.type) && !c._fallback)
  ).map(c => c.id);
  if (ids.length === 0) return;
  await runDAG(ids, true);
  setMsg('ran all cells', 'ok');
}

// late import to avoid circular dependency at module load time
import { updateStatus } from './ui.js';
