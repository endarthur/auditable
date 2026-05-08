// UI builtins: display, canvas, table, and the input widget factories
// (slider, dropdown, checkbox, textInput). All hang off ui.* in the
// cell context.

import { TaggedContent } from '../engine.js';
import { renderMd } from '../markdown.js';

const _TAG_MAP = {
  slider: 'audit-slider',
  dropdown: 'audit-dropdown',
  checkbox: 'audit-checkbox',
  text: 'audit-text-input',
};

export function makeUi(cell, ctx, runDAG) {
  const { outputEl, widgetEl, prevCanvases, usedWidgets, invalidation } = ctx;

  // Stale guard — when invalidation fires, prevent old closures from mutating DOM
  let _stale = false;
  invalidation.then(() => { _stale = true; });

  let canvasIdx = 0;

  // display: appends to outputEl, dispatching by argument shape.
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

  // canvas: reuses existing canvas if dimensions match (smooth re-runs).
  const canvas = (w = 400, h = 300) => {
    if (_stale) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
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

  // table: render an array-of-objects with optional sortable + filter chrome.
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

    let filterInput;
    if (filter) {
      filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.placeholder = 'Filter…';
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
          if (sortCol === c) label += sortAsc ? ' ▴' : ' ▾';
        }
        th.textContent = label;
        if (sortable) th.addEventListener('click', () => {
          if (sortCol === c) sortAsc = !sortAsc;
          else { sortCol = c; sortAsc = true; }
          renderHead(); renderBody();
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

  // mkInput: shared widget creation/reuse path (slider, dropdown, checkbox, text).
  if (!cell._inputs) cell._inputs = {};
  if (!cell._callbacks) cell._callbacks = {};

  const mkInput = (label, type, defaultVal, opts = {}) => {
    const key = label;
    const prev = cell._inputs[key];
    let val = prev !== undefined ? prev : defaultVal;
    usedWidgets.add(key);
    cell._callbacks[key] = { onInput: opts.onInput, onChange: opts.onChange };

    const tag = _TAG_MAP[type];

    const existing = widgetEl.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (existing) {
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

  return { display, displayHtml, canvas, table, slider, dropdown, checkbox, textInput };
}
