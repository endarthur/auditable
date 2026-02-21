import { S } from './state.js';
import { buildDAG, isManual, isNorun, isHidden, parseCellName, parseOutputId, parseOutputClass } from './dag.js';
import { setMsg } from './ui.js';

// ── EXECUTION ──

export function renderHtmlCell(cell) {
  const viewEl = cell.el.querySelector('.cell-html-view');
  const outputEl = cell.el.querySelector('.cell-output');
  if (!viewEl) return;
  if (outputEl) { outputEl.textContent = ''; outputEl.className = 'cell-output'; }

  const scopeKeys = Object.keys(S.scope);
  const scopeVals = scopeKeys.map(k => S.scope[k]);

  let rendered = cell.code.replace(/\$\{([^}]+)\}/g, (match, expr) => {
    try {
      const fn = new Function(...scopeKeys, '"use strict"; return (' + expr + ')');
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
  const outputEl = cell.el.querySelector('.cell-output');
  const widgetEl = cell.el.querySelector('.cell-widgets');
  outputEl.textContent = '';
  outputEl.className = 'cell-output';
  const outClass = parseOutputClass(cell.code);
  if (outClass) outputEl.classList.add(...outClass.split(/\s+/));
  const outId = parseOutputId(cell.code);
  outputEl.id = outId || '';
  cell.el.classList.toggle('present-hidden', isHidden(cell.code));
  cell.error = null;

  // track which widgets are used this run
  const usedWidgets = new Set();

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

  // canvas helper
  const canvas = (w = 400, h = 300) => {
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

  const mkInput = (label, type, defaultVal, opts = {}) => {
    const key = label;
    const prev = cell._inputs[key];
    let val = prev !== undefined ? prev : defaultVal;
    usedWidgets.add(key);

    // check if widget DOM already exists
    const existing = widgetEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (existing) {
      // just return current value, DOM stays
      cell._inputs[key] = type === 'slider' ? parseFloat(val)
                         : type === 'checkbox' ? !!val
                         : val;
      return cell._inputs[key];
    }

    // create new widget
    const wrap = document.createElement('div');
    wrap.dataset.widgetKey = key;
    wrap.className = 'cell-widget';

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
        clearTimeout(cell._inputTimer);
        cell._inputTimer = setTimeout(() => runDAG([cell.id], true), 80);
      };
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
        runDAG([cell.id], true);
      };
      wrap.appendChild(input);
    } else if (type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!val;
      input.onchange = () => {
        cell._inputs[key] = input.checked;
        runDAG([cell.id], true);
      };
      wrap.appendChild(input);
    } else if (type === 'text') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = val;
      input.oninput = () => {
        cell._inputs[key] = input.value;
        clearTimeout(cell._inputTimer);
        cell._inputTimer = setTimeout(() => runDAG([cell.id], true), 300);
      };
      wrap.appendChild(input);
    }

    widgetEl.appendChild(wrap);
    cell._inputs[key] = type === 'slider' ? parseFloat(val)
                       : type === 'checkbox' ? !!val
                       : val;
    return cell._inputs[key];
  };

  const slider = (label, defaultVal = 50, opts = {}) => mkInput(label, 'slider', defaultVal, opts);
  const dropdown = (label, options, defaultVal) => mkInput(label, 'dropdown', defaultVal || options[0], { options });
  const checkbox = (label, defaultVal = false) => mkInput(label, 'checkbox', defaultVal);
  const textInput = (label, defaultVal = '') => mkInput(label, 'text', defaultVal);

  // execute with shared scope
  const scopeKeys = Object.keys(S.scope);
  const scopeVals = scopeKeys.map(k => S.scope[k]);

  // import cache — shared across all cells
  if (!window._importCache) window._importCache = {};
  if (!window._installedModules) window._installedModules = {}; // url -> { source, cellId }

  const load = async (url) => {
    if (window._importCache[url]) return window._importCache[url];
    // check installed (offline) modules first
    if (window._installedModules[url]) {
      const entry = window._installedModules[url];
      const src = typeof entry === 'string' ? entry : entry.source;
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

  const install = async (url) => {
    // normalize: add ?bundle for esm.sh if not present
    let bundleUrl = url;
    if (bundleUrl.includes('esm.sh') && !bundleUrl.includes('?bundle') && !bundleUrl.includes('&bundle')) {
      bundleUrl += (bundleUrl.includes('?') ? '&' : '?') + 'bundle';
    }
    // fetch source
    const resp = await fetch(bundleUrl);
    if (!resp.ok) throw new Error(`Failed to fetch ${bundleUrl}: ${resp.status}`);
    const source = await resp.text();
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

  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

  try {
    const cellName = parseCellName(cell.code);
    const slug = cellName ? '-' + cellName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : '';
    const fn = new AsyncFunction(
      ...scopeKeys,
      'display', 'canvas', 'table',
      'slider', 'dropdown', 'checkbox', 'textInput',
      'load', 'install',
      `"use strict";\n${cell.code}\n\n` +
      `return { ${[...cell.defines].join(', ')} };\n` +
      `//# sourceURL=auditable://cell-${cell.id}${slug}.js`
    );

    const result = await fn(...scopeVals, display, canvas, table,
                      slider, dropdown, checkbox, textInput,
                      load, install);

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

  // rebuild scope from scratch in document order
  S.scope = {};
  for (const cell of S.cells) {
    if (cell.type === 'html') {
      renderHtmlCell(cell);
      continue;
    }
    if (cell.type !== 'code') continue;

    // skip norun cells always (unless explicitly triggered by clicking run on the cell)
    if (isNorun(cell.code) && !dirtyIds.includes(cell.id)) continue;

    // skip manual cells unless force (Run All) or explicitly triggered
    if (!force && isManual(cell.code) && !dirtyIds.includes(cell.id)) {
      // keep existing scope contributions if previously run
      if (cell._lastResult) {
        for (const [k, v] of Object.entries(cell._lastResult)) {
          if (v !== undefined) S.scope[k] = v;
        }
      }
      cell.el.classList.add('stale');
      continue;
    }

    await execCell(cell);
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
