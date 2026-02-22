import { S } from './state.js';
import { buildDAG, topoSort, isManual, isNorun, isHidden, parseCellName, parseOutputId, parseOutputClass } from './dag.js';
import { setMsg } from './ui.js';
import { std } from './stdlib.js';
import { python, zenOfPython } from './python.js';

// ── EXECUTION ──

export function renderHtmlCell(cell) {
  const viewEl = cell.el.querySelector('.cell-html-view');
  const outputEl = cell.el.querySelector('.cell-output');
  if (!viewEl) return;
  if (outputEl) { outputEl.textContent = ''; outputEl.className = 'cell-output'; }

  // use only variables this cell references for stable function signatures
  const scopeKeys = cell.uses ? [...cell.uses].sort() : [];
  const scopeVals = scopeKeys.map(k => S.scope[k]);

  // cache compiled template functions per expression
  if (!cell._tplCache) cell._tplCache = {};
  const scopeSig = scopeKeys.join(',');
  if (cell._tplScopeSig !== scopeSig) {
    cell._tplCache = {};  // scope signature changed, invalidate all
    cell._tplScopeSig = scopeSig;
  }

  let rendered = cell.code.replace(/\$\{([^}]+)\}/g, (match, expr) => {
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

  viewEl.innerHTML = rendered;
  cell.el.classList.remove('stale', 'error');
  cell.el.classList.add('fresh');
  setTimeout(() => cell.el.classList.remove('fresh'), 800);
}

export async function execCell(cell) {
  // fire invalidation promise from previous run (cleanup resources)
  if (cell._invalidate) { cell._invalidate(); cell._invalidate = null; }

  const outputEl = cell.el.querySelector('.cell-output');
  const widgetEl = cell.el.querySelector('.cell-widgets');

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

  // track which widgets are used this run
  const usedWidgets = new Set();
  let canvasIdx = 0;

  // build display function for this cell
  const display = (...args) => {
    for (const arg of args) {
      if (arg instanceof Element) {
        outputEl.appendChild(arg);
      } else if (typeof arg === 'object' && arg !== null) {
        const pre = document.createElement('span');
        try { pre.textContent = JSON.stringify(arg, null, 2); }
        catch { pre.textContent = String(arg); }
        outputEl.appendChild(pre);
        outputEl.appendChild(document.createTextNode('\n'));
      } else {
        outputEl.appendChild(document.createTextNode(String(arg) + '\n'));
      }
    }
  };

  // canvas helper — reuses existing canvas if dimensions match
  const canvas = (w = 400, h = 300) => {
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
  const table = (data, columns) => {
    if (!data || !data.length) return;
    const cols = columns || Object.keys(data[0]);

    // detect numeric columns by scanning first 10 rows
    const isNumCol = {};
    for (const c of cols) {
      let allNum = true;
      const scanRows = data.slice(0, 10);
      for (const row of scanRows) {
        const v = row[c];
        if (v !== null && v !== undefined && typeof v !== 'number') { allNum = false; break; }
      }
      isNumCol[c] = allNum;
    }

    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const c of cols) {
      const th = document.createElement('th');
      th.textContent = c;
      th.style.textAlign = isNumCol[c] ? 'right' : 'left';
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    t.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of data) {
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
    t.appendChild(tbody);
    outputEl.appendChild(t);
  };

  // input widget helpers — persist state and DOM across re-runs
  if (!cell._inputs) cell._inputs = {};
  if (!cell._callbacks) cell._callbacks = {};

  const mkInput = (label, type, defaultVal, opts = {}) => {
    const key = label;
    const prev = cell._inputs[key];
    let val = prev !== undefined ? prev : defaultVal;
    usedWidgets.add(key);
    cell._callbacks[key] = { onInput: opts.onInput, onChange: opts.onChange };

    // check if widget DOM already exists
    const existing = widgetEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (existing) {
      // update id/class in case they changed on re-run
      existing.id = opts.id || '';
      existing.className = 'cell-widget' + (opts.class ? ' ' + opts.class : '');
      // just return current value, DOM stays — callbacks already updated above
      cell._inputs[key] = type === 'slider' ? parseFloat(val)
                         : type === 'checkbox' ? !!val
                         : val;
      return cell._inputs[key];
    }

    // create new widget
    const wrap = document.createElement('div');
    wrap.dataset.widgetKey = key;
    wrap.className = 'cell-widget' + (opts.class ? ' ' + opts.class : '');
    if (opts.id) wrap.id = opts.id;

    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.className = 'cell-widget-label';
    wrap.appendChild(lbl);

    let input;
    if (type === 'slider') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = opts.min ?? 0;
      input.max = opts.max ?? 100;
      input.step = opts.step ?? 1;
      input.value = val;
      const valSpan = document.createElement('span');
      valSpan.textContent = val;
      valSpan.className = 'cell-widget-val';
      input.oninput = () => {
        const n = parseFloat(input.value);
        cell._inputs[key] = n;
        valSpan.textContent = n;
        const cb = cell._callbacks[key];
        if (cb.onInput) { cb.onInput(n); }
        else if (!cb.onChange) { clearTimeout(cell._inputTimer); cell._inputTimer = setTimeout(() => runDAG([cell.id], true), 80); }
      };
      input.onchange = () => { const cb = cell._callbacks[key]; if (cb.onChange) cb.onChange(parseFloat(input.value)); };
      wrap.appendChild(input);
      wrap.appendChild(valSpan);
    } else if (type === 'dropdown') {
      input = document.createElement('select');
      for (const o of (opts.options || [])) {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        if (o === val) opt.selected = true;
        input.appendChild(opt);
      }
      input.onchange = () => {
        cell._inputs[key] = input.value;
        const cb = cell._callbacks[key];
        if (cb.onInput || cb.onChange) {
          if (cb.onInput) cb.onInput(input.value);
          if (cb.onChange) cb.onChange(input.value);
        } else { runDAG([cell.id], true); }
      };
      wrap.appendChild(input);
    } else if (type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!val;
      input.onchange = () => {
        cell._inputs[key] = input.checked;
        const cb = cell._callbacks[key];
        if (cb.onInput || cb.onChange) {
          if (cb.onInput) cb.onInput(input.checked);
          if (cb.onChange) cb.onChange(input.checked);
        } else { runDAG([cell.id], true); }
      };
      wrap.appendChild(input);
    } else if (type === 'text') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = val;
      input.oninput = () => {
        cell._inputs[key] = input.value;
        const cb = cell._callbacks[key];
        if (cb.onInput) { cb.onInput(input.value); }
        else if (!cb.onChange) { clearTimeout(cell._inputTimer); cell._inputTimer = setTimeout(() => runDAG([cell.id], true), 300); }
      };
      input.onchange = () => { const cb = cell._callbacks[key]; if (cb.onChange) cb.onChange(input.value); };
      wrap.appendChild(input);
    }

    widgetEl.appendChild(wrap);
    cell._inputs[key] = type === 'slider' ? parseFloat(val)
                       : type === 'checkbox' ? !!val
                       : val;
    return cell._inputs[key];
  };

  const slider = (label, defaultVal = 50, opts = {}) => mkInput(label, 'slider', defaultVal, opts);
  const dropdown = (label, options, defaultVal, opts = {}) => mkInput(label, 'dropdown', defaultVal || options[0], { ...opts, options });
  const checkbox = (label, defaultVal = false, opts = {}) => mkInput(label, 'checkbox', defaultVal, opts);
  const textInput = (label, defaultVal = '', opts = {}) => mkInput(label, 'text', defaultVal, opts);

  // execute with scoped parameters (only what this cell uses, for stable V8 JIT)
  // filter out injected names — they're per-cell params, not scope-propagated
  const _injected = ['ui', 'std', 'load', 'install', 'invalidation', 'print'];
  const scopeKeys = cell.uses ? [...cell.uses].filter(k => !_injected.includes(k)).sort() : [];
  const defNames = cell.defines ? [...cell.defines].sort().join(', ') : '';

  // import cache — shared across all cells
  if (!window._importCache) window._importCache = {};
  if (!window._installedModules) window._installedModules = {}; // url -> { source, cellId }

  const load = async (url) => {
    // virtual modules
    if (url === '@std') return std;
    if (url === '@python') return python;
    if (url === '@python/this') { display(zenOfPython()); return python; }
    if (window._importCache[url]) return window._importCache[url];
    // check installed (offline) modules first
    if (window._installedModules[url]) {
      const entry = window._installedModules[url];
      let src = typeof entry === 'string' ? entry : entry.source;
      // resolve root-relative paths for legacy saved modules
      try { src = resolveModulePaths(src, url); } catch {}
      const blob = new Blob([src], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[url] = mod;
      return mod;
    }
    const mod = await import(url);
    window._importCache[url] = mod;
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
    // store under original url with cell reference
    window._installedModules[url] = { source, cellId: cell.id };
    // also load it into cache
    const blob = new Blob([source], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const mod = await import(blobUrl);
    window._importCache[url] = mod;
    display(`installed ${url} (${(source.length / 1024).toFixed(1)} KB)`);
    return mod;
  };

  // ui object — constructed per-cell (closes over cell context)
  const ui = { display, print: display, canvas, table, slider, dropdown, checkbox, textInput };

  // function caching — reuse compiled function if code/uses/defines unchanged
  const cacheKey = scopeKeys.join(',') + '|' + defNames + '|' + cell.code;

  try {
    let fn;
    if (cell._cacheKey === cacheKey && cell._cachedFn) {
      fn = cell._cachedFn;
    } else {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const cellName = parseCellName(cell.code);
      const slug = cellName ? '-' + cellName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : '';
      fn = new AsyncFunction(
        ...scopeKeys,
        'ui', 'std', 'load', 'install', 'invalidation', 'print',
        `"use strict";\n${cell.code}\n\n` +
        `return { ${defNames} };\n` +
        `//# sourceURL=auditable://cell-${cell.id}${slug}.js`
      );
      cell._cachedFn = fn;
      cell._cacheKey = cacheKey;
    }

    const scopeVals = scopeKeys.map(k => S.scope[k]);
    const result = await fn(...scopeVals, ui, std, load, install, invalidation, display);

    // update scope with defined variables
    if (result && typeof result === 'object') {
      cell._lastResult = result;
      for (const [k, v] of Object.entries(result)) {
        if (v !== undefined) S.scope[k] = v;
      }
    }

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

  } catch (e) {
    cell.error = e.message;
    outputEl.textContent = e.message;
    outputEl.className = 'cell-output error';
    cell.el.classList.remove('stale', 'fresh');
    cell.el.classList.add('error');
  }
}

export async function runDAG(dirtyIds, force = false) {
  buildDAG();
  const isAutorun = S.autorun && !force;

  // determine which cells need execution via topo sort
  const runSet = new Set(topoSort(dirtyIds));

  if (window._dagStart) window._dagStart();

  // rebuild scope in document order, only executing cells in runSet
  S.scope = {};
  const poisoned = new Set(); // variable names defined by errored cells
  for (let i = 0; i < S.cells.length; i++) {
    const cell = S.cells[i];

    if (cell.type === 'html') {
      if (runSet.has(cell.id)) {
        // check if any used variable is poisoned
        if (cell.uses && [...cell.uses].some(n => poisoned.has(n))) {
          cell.el.classList.remove('fresh');
          cell.el.classList.add('stale');
        } else {
          renderHtmlCell(cell);
        }
      }
      continue;
    }
    if (cell.type !== 'code') continue;

    // skip norun cells (unless explicitly triggered)
    if (isNorun(cell.code) && !dirtyIds.includes(cell.id)) {
      if (cell._lastResult) {
        for (const [k, v] of Object.entries(cell._lastResult)) {
          if (v !== undefined) S.scope[k] = v;
        }
      }
      continue;
    }

    // skip manual cells unless force or explicitly triggered
    if (!force && isManual(cell.code) && !dirtyIds.includes(cell.id)) {
      if (cell._lastResult) {
        for (const [k, v] of Object.entries(cell._lastResult)) {
          if (v !== undefined) S.scope[k] = v;
        }
      }
      cell.el.classList.add('stale');
      continue;
    }

    // not in run set — restore cached results, skip execution
    if (!runSet.has(cell.id)) {
      if (cell._lastResult) {
        for (const [k, v] of Object.entries(cell._lastResult)) {
          if (v !== undefined) S.scope[k] = v;
        }
      }
      continue;
    }

    // error isolation: if any upstream dependency is poisoned, skip this cell
    if (cell.uses && cell.uses.size > 0) {
      let blocked = false;
      for (const name of cell.uses) {
        if (poisoned.has(name)) { blocked = true; break; }
      }
      if (blocked) {
        const outputEl = cell.el.querySelector('.cell-output');
        if (outputEl && !cell.error) {
          outputEl.textContent = 'blocked by upstream error';
          outputEl.className = 'cell-output error';
        }
        cell.el.classList.remove('stale', 'fresh');
        cell.el.classList.add('error');
        // poison our own defines so downstream also blocks
        if (cell.defines) for (const name of cell.defines) poisoned.add(name);
        continue;
      }
    }

    // value-equality gating: if this cell is a downstream dependent (not directly
    // dirty) and all its input values are unchanged, skip re-execution entirely
    if (!dirtyIds.includes(cell.id) && cell._lastResult && cell.uses && cell.uses.size > 0) {
      let inputsChanged = false;
      for (const name of cell.uses) {
        if (S.scope[name] !== cell._prevInputs?.[name]) { inputsChanged = true; break; }
      }
      if (!inputsChanged) {
        // inputs identical — restore previous results, skip execution
        for (const [k, v] of Object.entries(cell._lastResult)) {
          if (v !== undefined) S.scope[k] = v;
        }
        continue;
      }
    }

    if (window._beforeExec) window._beforeExec(cell);
    await execCell(cell);

    // if the cell errored, poison its defines
    if (cell.error) {
      if (cell.defines) for (const name of cell.defines) poisoned.add(name);
    }

    // snapshot input values for future equality checks
    if (cell.uses) {
      cell._prevInputs = {};
      for (const name of cell.uses) cell._prevInputs[name] = S.scope[name];
    }

    if (window._afterExec && !isAutorun) {
      const jump = window._afterExec(cell, i);
      if (jump >= 0) { i = jump - 1; continue; }
    }
  }

  updateStatus();
}

export async function runAll() {
  const ids = S.cells.filter(c => c.type === 'code' || c.type === 'html').map(c => c.id);
  if (ids.length === 0) return;
  await runDAG(ids, true);
  setMsg('ran all cells', 'ok');
}

// late import to avoid circular dependency at module load time
import { updateStatus } from './ui.js';
