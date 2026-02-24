// ── STDLIB ──
// Bundled standard library for notebook work.
// Module-level — no per-cell state needed.

// ── Provider Registry ──

const _providers = { file: null, download: null };

export function registerProvider(name, fn) {
  if (name in _providers) _providers[name] = fn;
}

// ── Data ──

function csv(text, opts = {}) {
  const sep = opts.separator || ',';
  const typed = !!opts.typed;
  const lines = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row = [];
    while (i < len) {
      if (text[i] === '"') {
        // quoted field
        i++;
        let field = '';
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else { i++; break; }
          } else { field += text[i]; i++; }
        }
        row.push(field);
        if (text[i] === sep) i++;
        else if (text[i] === '\r') { i++; if (text[i] === '\n') i++; break; }
        else if (text[i] === '\n') { i++; break; }
        else if (i >= len) break;
      } else {
        // unquoted field
        let field = '';
        while (i < len && text[i] !== sep && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i]; i++;
        }
        row.push(field);
        if (text[i] === sep) i++;
        else if (text[i] === '\r') { i++; if (text[i] === '\n') i++; break; }
        else if (text[i] === '\n') { i++; break; }
        else break;
      }
    }
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) lines.push(row);
  }

  if (lines.length < 2) return [];
  const headers = lines[0];
  const result = [];
  for (let r = 1; r < lines.length; r++) {
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      let val = lines[r][c] !== undefined ? lines[r][c] : '';
      if (typed) {
        const num = Number(val);
        if (val !== '' && !isNaN(num)) val = num;
        else if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (val === '') val = null;
      }
      obj[headers[c]] = val;
    }
    result.push(obj);
  }
  return result;
}

async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetchJSON: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// ── Math / Stats ──

function _acc(arr, fn) {
  return fn ? arr.map(fn) : arr;
}

function sum(arr, fn) {
  const vals = _acc(arr, fn);
  let s = 0;
  for (let i = 0; i < vals.length; i++) s += vals[i];
  return s;
}

function mean(arr, fn) {
  if (!arr.length) return NaN;
  return sum(arr, fn) / arr.length;
}

function median(arr, fn) {
  const vals = _acc(arr, fn).slice().sort((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return NaN;
  if (n % 2 === 1) return vals[(n - 1) / 2];
  return (vals[n / 2 - 1] + vals[n / 2]) / 2;
}

function extent(arr, fn) {
  const vals = _acc(arr, fn);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] < lo) lo = vals[i];
    if (vals[i] > hi) hi = vals[i];
  }
  return [lo, hi];
}

function bin(arr, n = 10, fn) {
  const vals = _acc(arr, fn);
  const [lo, hi] = extent(vals);
  const range = hi - lo || 1;
  const step = range / n;
  const bins = [];
  for (let i = 0; i < n; i++) {
    bins.push({ x0: lo + i * step, x1: lo + (i + 1) * step, values: [] });
  }
  for (const v of vals) {
    let idx = Math.floor((v - lo) / step);
    if (idx >= n) idx = n - 1;
    if (idx < 0) idx = 0;
    bins[idx].values.push(v);
  }
  return bins;
}

function linspace(start, stop, n) {
  if (n < 2) return n === 1 ? [start] : [];
  const result = new Array(n);
  const step = (stop - start) / (n - 1);
  for (let i = 0; i < n; i++) result[i] = start + i * step;
  result[n - 1] = stop; // exact endpoint
  return result;
}

// ── Array ──

function unique(arr, fn) {
  if (!fn) return [...new Set(arr)];
  const seen = new Set();
  const result = [];
  for (const item of arr) {
    const key = fn(item);
    if (!seen.has(key)) { seen.add(key); result.push(item); }
  }
  return result;
}

function zip(...arrays) {
  const len = Math.min(...arrays.map(a => a.length));
  const result = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = arrays.map(a => a[i]);
  }
  return result;
}

function cross(...arrays) {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const sub = cross(...rest);
  const result = [];
  for (const item of first) {
    for (const tail of sub) {
      result.push([item, ...tail]);
    }
  }
  return result;
}

// ── DOM / IO ──

async function file(accept) {
  if (_providers.file) return _providers.file(accept);
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) { reject(new Error('no file selected')); return; }
      const text = await f.text();
      resolve({ name: f.name, text, size: f.size });
    };
    input.click();
  });
}

function download(data, filename, mimeType) {
  if (_providers.download) return _providers.download(data, filename, mimeType);
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const mime = mimeType || (typeof data === 'string' ? 'text/plain' : 'application/json');
  const blob = new Blob([str], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function el(tag, attrs, ...children) {
  const elem = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') {
        Object.assign(elem.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        elem.addEventListener(k.slice(2), v);
      } else {
        elem.setAttribute(k, v);
      }
    }
  } else if (attrs != null) {
    // attrs is actually a child
    children.unshift(attrs);
  }
  for (const child of children) {
    if (child instanceof Node) elem.appendChild(child);
    else if (child != null) elem.appendChild(document.createTextNode(String(child)));
  }
  return elem;
}

async function copy(text) {
  await navigator.clipboard.writeText(text);
}

function fmt(number, opts = {}) {
  const { decimals, prefix, suffix } = opts;
  let s = decimals != null ? number.toFixed(decimals)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(number);
  if (prefix) s = prefix + s;
  if (suffix) s = s + suffix;
  return s;
}

// ── Source inclusion with dependency resolution ──

function include(libs, ...names) {
  // accept single library or array of libraries
  const list = Array.isArray(libs) && libs[0] && libs[0].sources ? libs : [libs];
  // merge all libraries into unified sources + deps
  const sources = {}, deps = {};
  for (const lib of list) {
    if (!lib || !lib.sources || !lib.deps)
      throw new Error('include: expected library with sources and deps');
    Object.assign(sources, lib.sources);
    Object.assign(deps, lib.deps);
  }
  const needed = new Set();
  function walk(name) {
    if (needed.has(name)) return;
    if (!sources[name]) throw new Error(`include: unknown routine '${name}'`);
    needed.add(name);
    for (const dep of deps[name] || []) walk(dep);
  }
  names.forEach(walk);
  // topological sort: deps before dependents
  const sorted = [];
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of deps[name] || []) visit(dep);
    sorted.push(name);
  }
  needed.forEach(visit);
  return sorted.map(n => sources[n]).join('\n\n');
}

// ── Export ──

export const std = {
  csv, fetchJSON,
  sum, mean, median, extent, bin, linspace,
  unique, zip, cross,
  file, download, el, copy, fmt,
  include,
};
