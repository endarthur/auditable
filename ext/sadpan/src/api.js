// api.js — factories, op helpers, DataFrame wrapper, registration

import { Table } from './table.js';
import { Series, BooleanMask } from './series.js';
import { GroupBy } from './groupby.js';
import { join, semijoin, antijoin } from './join.js';
import { csv, toCSV } from './io.js';
import {
  makeIloc, makeLoc, makeAt, makeIat,
  makeSeriesIloc, makeSeriesLoc, makeSeriesAt, makeSeriesIat,
  _RangeIndex, _Index,
} from './accessors.js';

// ── plt lookup ──
//
// `df.plot(...)` proxies to plt without taking a hard dep on @gcu/plot.
// We probe window._auditableExtensions['plt'] (the adder extension slot)
// and fall back to window._importCache for direct module instances.
function _findPlt() {
  if (typeof window === 'undefined') return null;
  if (window._auditableExtensions?.plt) return window._auditableExtensions.plt;
  if (window._importCache) {
    for (const mod of Object.values(window._importCache)) {
      if (mod && typeof mod.subplots === 'function' && typeof mod.plot === 'function') return mod;
    }
  }
  return null;
}

// ── html helpers ──

function _escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _fmtNum(v) { return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, ''); }

// ── factories ──

function table(columns) {
  return new Table(columns);
}

function from(rows) {
  if (!rows || rows.length === 0) return new Table({}, []);
  const names = Object.keys(rows[0]);
  const columns = {};
  for (const n of names) columns[n] = [];
  for (const row of rows) {
    for (const n of names) columns[n].push(row[n] !== undefined ? row[n] : null);
  }
  return new Table(columns, names);
}

function series(values, name) {
  return new Series(values, name);
}

function concat(...tables) {
  if (tables.length === 0) return new Table({}, []);
  if (tables.length === 1 && Array.isArray(tables[0])) tables = tables[0];
  return tables[0].concat(...tables.slice(1));
}

function merge(left, right, on, opts) {
  return join(left, right, on, opts);
}

// ── op helpers ──

const op = {
  sum: (arr) => { let s = 0; for (const v of arr) if (v != null) s += v; return s; },
  mean: (arr) => { let s = 0, n = 0; for (const v of arr) if (v != null) { s += v; n++; } return n ? s / n : NaN; },
  median: (arr) => {
    const sorted = arr.filter(v => v != null).sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return NaN;
    return n % 2 ? sorted[n >> 1] : (sorted[(n >> 1) - 1] + sorted[n >> 1]) / 2;
  },
  min: (arr) => { let m = Infinity; for (const v of arr) if (v != null && v < m) m = v; return m === Infinity ? NaN : m; },
  max: (arr) => { let m = -Infinity; for (const v of arr) if (v != null && v > m) m = v; return m === -Infinity ? NaN : m; },
  std: (arr) => {
    const m = op.mean(arr);
    let s = 0, n = 0;
    for (const v of arr) if (v != null) { s += (v - m) ** 2; n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
  },
  variance: (arr) => {
    const m = op.mean(arr);
    let s = 0, n = 0;
    for (const v of arr) if (v != null) { s += (v - m) ** 2; n++; }
    return n > 1 ? s / (n - 1) : 0;
  },
  count: (arr) => { let n = 0; for (const v of arr) if (v != null) n++; return n; },
  first: (arr) => arr.length > 0 ? arr[0] : null,
  last: (arr) => arr.length > 0 ? arr[arr.length - 1] : null,
  quantile: (arr, p) => {
    const sorted = arr.filter(v => v != null).sort((a, b) => a - b);
    if (sorted.length === 0) return NaN;
    const i = p * (sorted.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  },
};

// ── DataFrame wrapper (for adder pandas API) ──

class DataFrame {
  constructor(data, columns, _index) {
    // pandas signature: DataFrame(data=None, index=None, columns=None, ...)
    // Adder calls it as:
    //   pd.DataFrame({...})                            → positional dict
    //   pd.DataFrame([{}, {}])                         → list of records
    //   pd.DataFrame(data=arr, columns=[...])          → kwargs only
    //   pd.DataFrame(arr, columns=[...])               → mixed
    // adder lands kwargs as a trailing {_kw: true, …} obj — could be in
    // any param slot depending on how the user typed it.
    let kw = null;
    for (const arg of [data, columns, _index]) {
      if (arg && typeof arg === 'object' && arg._kw) { kw = arg; break; }
    }
    if (kw) {
      data = kw.data !== undefined ? kw.data : data;
      columns = kw.columns !== undefined ? kw.columns : columns;
    }
    // Pull data out of natra ndarray / Float64Array with shape
    if (data && Array.isArray(data.shape) && data.shape.length === 2) {
      const nrows = data.shape[0];
      const ncols = data.shape[1];
      // Get a flat row-major Float64Array view (or null for unsupported)
      let flat = null;
      if (data instanceof Float64Array) flat = data;
      else if (data.data instanceof Float64Array) flat = data.data;
      else if (data._nd && data._arr) {
        // natra wrapper — read from WASM arena
        const a = data._arr;
        if (a.memory && a.memory.buffer && a.dtype === 'f64' && typeof a.ptr === 'number') {
          flat = new Float64Array(a.memory.buffer, a.ptr, nrows * ncols);
        } else if (a.data instanceof Float64Array) {
          flat = a.data;
        }
      } else if (typeof data.tolist === 'function') {
        // Last-resort: nested array via tolist
        const rows = data.tolist();
        if (Array.isArray(rows) && Array.isArray(rows[0])) {
          flat = new Float64Array(nrows * ncols);
          for (let i = 0; i < nrows; i++) {
            for (let j = 0; j < ncols; j++) flat[i * ncols + j] = rows[i][j];
          }
        }
      }
      if (flat) {
        const names = Array.isArray(columns) && columns.length === ncols
          ? columns.slice()
          : Array.from({ length: ncols }, (_, i) => String(i));
        const cols = {};
        for (let j = 0; j < ncols; j++) {
          const col = new Array(nrows);
          for (let i = 0; i < nrows; i++) col[i] = flat[i * ncols + j];
          cols[names[j]] = col;
        }
        this._tbl = new Table(cols, names);
        this.__adderClass__ = 'DataFrame';
        return;
      }
    }
    if (!data) this._tbl = new Table({}, []);
    else if (data instanceof Table) this._tbl = data;
    else if (Array.isArray(data)) this._tbl = from(data);
    else if (typeof data === 'object') this._tbl = table(data);
    // If columns is provided (and we built from a dict), rename to honor it.
    if (Array.isArray(columns) && data && !Array.isArray(data)
        && !(data instanceof Table)
        && Object.keys(data).length === columns.length) {
      const oldNames = this._tbl.columnNames();
      const map = {};
      for (let i = 0; i < columns.length; i++) map[oldNames[i]] = columns[i];
      this._tbl = this._tbl.rename(map);
    }
    this.__adderClass__ = 'DataFrame';
  }

  // dunders for adder
  __getitem__(key) {
    if (typeof key === 'string') return new WrapperSeries(this._tbl.array(key), key);
    if (Array.isArray(key)) return new DataFrame(this._tbl.select(...key));
    if (key instanceof BooleanMask) {
      const idx = [];
      for (let i = 0; i < key._values.length; i++) if (key._values[i]) idx.push(i);
      return new DataFrame(this._tbl._take(idx));
    }
    if (key && key._slice) {
      const start = key.lower || 0;
      const end = key.upper != null ? key.upper : this._tbl.numRows();
      return new DataFrame(this._tbl.slice(start, end));
    }
    return new WrapperSeries(this._tbl.array(key), key);
  }

  __setitem__(key, value) {
    if (value instanceof Series) value = value._values;
    // Coerce any iterable that isn't a JS Array (TypedArray, natra
    // ndarray, etc.) to a plain Array via Array.from. Scalars and
    // strings broadcast to fill every row. Without the coercion, a
    // natra-backed Series passed in would land as the WHOLE object
    // repeated nrows times — every cell rendering as [object Object].
    if (value != null
        && typeof value !== 'string'
        && typeof value[Symbol.iterator] === 'function') {
      if (!Array.isArray(value)) value = Array.from(value);
    } else {
      value = new Array(this._tbl.numRows()).fill(value);
    }
    this._tbl = this._tbl.assign({ [key]: value });
  }

  __len__() { return this._tbl.numRows(); }
  __contains__(key) { return this._tbl.columnNames().includes(key); }
  __repr__() { return this._tbl.print(10); }
  __str__() { return this._tbl.print(10); }

  _repr_html_() {
    const names = this._tbl.columnNames();
    const n = this._tbl.numRows();
    const maxRows = 20;
    const show = Math.min(n, maxRows);
    let html = '<table style="border-collapse:collapse;font-family:var(--mono,monospace);font-size:12px">';
    html += '<tr>' + names.map(c => `<th style="padding:3px 8px;border-bottom:2px solid var(--fg-dim,#666);text-align:left">${_escHtml(c)}</th>`).join('') + '</tr>';
    for (let i = 0; i < show; i++) {
      html += '<tr>' + names.map(c => {
        const v = this._tbl._columns[c][i];
        const align = typeof v === 'number' ? 'right' : 'left';
        const text = v == null ? '' : typeof v === 'number' ? _fmtNum(v) : _escHtml(String(v));
        return `<td style="padding:2px 8px;border-bottom:1px solid var(--bg-cell,#333);text-align:${align}">${text}</td>`;
      }).join('') + '</tr>';
    }
    html += '</table>';
    if (n > maxRows) html += `<div style="font-size:11px;color:var(--fg-dim,#888);margin-top:4px">\u2026 ${n} rows \u00d7 ${names.length} columns</div>`;
    else html += `<div style="font-size:11px;color:var(--fg-dim,#888);margin-top:4px">${n} rows \u00d7 ${names.length} columns</div>`;
    return html;
  }
  [Symbol.iterator]() { return this._tbl.columnNames()[Symbol.iterator](); }

  // properties (JS getters — work in both JS and adder)
  get shape() { return [this._tbl.numRows(), this._tbl.numCols()]; }
  get columns() { return this._tbl.columnNames(); }
  get ndim() { return 2; }
  get size() { return this._tbl.numRows() * this._tbl.numCols(); }
  get empty() { return this._tbl.numRows() === 0; }
  get dtypes() {
    // Best-effort dtype inference per column from the first non-null
    // sample — matches pandas's `df.dtypes` quick scan well enough
    // for `df.dtypes` printouts. Returns a Series of dtype strings.
    const names = this._tbl.columnNames();
    const types = names.map(c => {
      const arr = this._tbl.array(c);
      for (const v of arr) {
        if (v == null) continue;
        if (typeof v === 'number') return Number.isInteger(v) ? 'int64' : 'float64';
        if (typeof v === 'boolean') return 'bool';
        return 'object';
      }
      return 'object';
    });
    return new WrapperSeries(types, 'dtype');
  }
  get index() {
    if (!this._index) this._index = new _RangeIndex(this._tbl.numRows());
    return this._index;
  }
  // pandas exposes `.values` AND `.to_numpy()` (the latter is the
  // preferred name post-1.0). Same data shape: 2D nested list when
  // columns mix types, flat-typed otherwise. Returning a JS array of
  // arrays keeps consumers (natra.array, plt, sklearn) happy.
  get values() { return this._toNested(); }
  to_numpy(opts) {
    // opts.dtype / opts.copy are matplotlib-side hints; not honored here.
    return this._toNested();
  }
  _toNested() {
    const tbl = this._tbl;
    const names = tbl.columnNames();
    const nrows = tbl.numRows();
    const rows = new Array(nrows);
    for (let i = 0; i < nrows; i++) {
      const r = new Array(names.length);
      for (let j = 0; j < names.length; j++) r[j] = tbl._columns[names[j]][i];
      rows[i] = r;
    }
    return new _NumpyLikeArray2D(rows, names.length);
  }
  // pandas-shape indexers — lazy single-instance per DataFrame.
  get iloc() { if (!this._iloc) this._iloc = makeIloc(this); return this._iloc; }
  get loc()  { if (!this._loc)  this._loc  = makeLoc(this);  return this._loc;  }
  get at()   { if (!this._at)   this._at   = makeAt(this);   return this._at;   }
  get iat()  { if (!this._iat)  this._iat  = makeIat(this);  return this._iat;  }

  // Construction helpers used by the indexers — kept on the DataFrame
  // so the accessors don't need to import api.js (would be circular).
  _makeSeriesLike(values, indexLabels, name) {
    const s = new WrapperSeries(values, name || null);
    if (indexLabels) s._index = new _Index(indexLabels);
    return s;
  }
  _makeFrameLike(columns, names) {
    return new DataFrame(new Table(columns, names));
  }

  // Minimal `.plot()` — proxies to plt when available. Real matplotlib's
  // df.plot has dozens of kwargs (kind, ax, x, y, secondary_y, …); we
  // cover the common shapes (x=col, y=col, kind='line'|'scatter'|'bar')
  // and let users drop to plt directly for anything else.
  plot(opts) {
    const kw = (opts && opts._kw) ? opts : (opts || {});
    const kind = kw.kind || 'line';
    const xCol = kw.x;
    const yCol = kw.y;
    const plt = _findPlt();
    if (!plt) throw new Error('plt extension not loaded — call load("@gcu/plot") first');

    const tbl = this._tbl;
    const x = xCol ? tbl.array(xCol) : Array.from({ length: tbl.numRows() }, (_, i) => i);

    if (kind === 'scatter') {
      if (!yCol) throw new Error("df.plot(kind='scatter') requires y=");
      return plt.scatter(x, tbl.array(yCol), kw);
    }
    if (kind === 'bar') {
      const cols = yCol ? (Array.isArray(yCol) ? yCol : [yCol]) : tbl.columnNames().filter(n => n !== xCol);
      // Single bar series only for now — matplotlib's grouped bar is fiddly.
      return plt.bar(x, tbl.array(cols[0]), kw);
    }
    if (kind === 'hist') {
      const cols = yCol ? (Array.isArray(yCol) ? yCol : [yCol]) : tbl.columnNames();
      return plt.hist(tbl.array(cols[0]), kw);
    }
    // default: line plot — one column or many
    const cols = yCol ? (Array.isArray(yCol) ? yCol : [yCol]) : tbl.columnNames().filter(n => n !== xCol);
    if (cols.length === 1) return plt.plot(x, tbl.array(cols[0]), kw);
    // multiple columns → add each as a separate trace on a shared axes
    const sub = plt.subplots();
    const ax = sub.ax || sub[1];
    for (const c of cols) ax.plot(x, tbl.array(c), { ...kw, label: c });
    return (sub.fig || sub[0]).show();
  }

  // methods
  head(n) {
    if (n && typeof n === 'object' && n._kw) n = n.n;
    if (n == null) n = 5;
    return new DataFrame(this._tbl.slice(0, n));
  }
  tail(n) {
    if (n && typeof n === 'object' && n._kw) n = n.n;
    if (n == null) n = 5;
    return new DataFrame(this._tbl.slice(-n));
  }

  sort_values(by, opts) {
    let ascending = true;
    if (opts && opts._kw) ascending = opts.ascending !== false;
    else if (opts !== undefined) ascending = opts !== false;
    if (typeof by === 'string') by = [by];
    if (ascending) return new DataFrame(this._tbl.orderby(...by));
    return new DataFrame(this._tbl.orderby(...by.map(b => ({ [b]: 'desc' }))));
  }

  assign(cols) {
    // support both JS object and adder kwargs
    if (cols && cols._kw) {
      const { _kw, ...rest } = cols;
      cols = rest;
    }
    let tbl = this._tbl;
    for (const [k, v] of Object.entries(cols)) {
      let arr = v;
      if (typeof v === 'function') {
        const df = new DataFrame(tbl);
        arr = v(df);
      }
      if (arr instanceof Series) arr = arr._values;
      if (!Array.isArray(arr)) arr = new Array(tbl.numRows()).fill(arr);
      tbl = tbl.assign({ [k]: arr });
    }
    return new DataFrame(tbl);
  }

  groupby(by) {
    if (typeof by === 'string') by = [by];
    return new WrapperGroupBy(this._tbl.groupby(...by), by);
  }

  merge(right, opts) {
    let on = null, how = 'inner';
    if (opts && opts._kw) { on = opts.on; how = opts.how || 'inner'; }
    else if (typeof opts === 'string') { on = opts; }
    else if (opts) { on = opts.on; how = opts.how || 'inner'; }
    return new DataFrame(join(this._tbl, right._tbl, on, { how }));
  }

  semijoin(right, opts) {
    let on = null;
    if (opts && opts._kw) on = opts.on;
    else if (typeof opts === 'string') on = opts;
    else if (opts) on = opts.on;
    return new DataFrame(semijoin(this._tbl, right._tbl, on));
  }

  antijoin(right, opts) {
    let on = null;
    if (opts && opts._kw) on = opts.on;
    else if (typeof opts === 'string') on = opts;
    else if (opts) on = opts.on;
    return new DataFrame(antijoin(this._tbl, right._tbl, on));
  }

  filter(fn) { return new DataFrame(this._tbl.filter(fn)); }

  drop_duplicates(opts) {
    let subset = null;
    if (opts && opts._kw) subset = opts.subset;
    else if (opts) subset = opts.subset || opts;
    if (subset) return new DataFrame(this._tbl.dedupe(...(Array.isArray(subset) ? subset : [subset])));
    return new DataFrame(this._tbl.dedupe());
  }

  sample(opts) {
    let n = null, frac = null;
    if (opts && opts._kw) { n = opts.n; frac = opts.frac; }
    else if (typeof opts === 'number') n = opts;
    if (frac != null) n = Math.max(1, Math.floor(this._tbl.numRows() * frac));
    return new DataFrame(this._tbl.sample(n || 1));
  }

  dropna(opts) {
    let subset = null;
    if (opts && opts._kw) subset = opts.subset;
    const cols = subset || this._tbl.columnNames();
    return new DataFrame(this._tbl.filter((row) => {
      for (const c of cols) { const v = row[c]; if (v == null || v !== v) return false; }
      return true;
    }));
  }

  fillna(value) {
    const cols = {};
    for (const c of this._tbl.columnNames()) {
      const arr = this._tbl.array(c);
      cols[c] = arr.map(v => (v == null || v !== v) ? value : v);
    }
    return new DataFrame(table(cols));
  }

  select(...cols) { return new DataFrame(this._tbl.select(...cols)); }

  drop(labels, opts) {
    // pandas signatures we support:
    //   df.drop('col')                    → axis=1 default (columns)
    //   df.drop(['c1','c2'])
    //   df.drop('col', axis=1)
    //   df.drop(columns=['c1','c2'])      → infers axis=1
    //   df.drop(3, axis=0)                → drop row by label (RangeIndex → position)
    //   df.drop(index=[0,1])              → infers axis=0
    let axis = 1;
    let toRemove = labels;
    // Adder kwargs may arrive as the first arg (drop(columns=...)) or
    // as a trailing arg (drop('col', axis=1)).
    const kw = (opts && opts._kw) ? opts
             : (labels && typeof labels === 'object' && labels._kw) ? labels
             : null;
    if (kw) {
      if (kw.axis != null) axis = kw.axis;
      if (kw.columns != null) { axis = 1; toRemove = kw.columns; }
      else if (kw.index != null) { axis = 0; toRemove = kw.index; }
      else if (kw === labels && kw.labels != null) { toRemove = kw.labels; }
    }

    if (axis === 0) {
      // Drop rows. With default RangeIndex (labels 0..n-1) labels and
      // positions coincide; for custom indices we'd look up via _index.
      const rows = new Set(Array.isArray(toRemove) ? toRemove : [toRemove]);
      const keep = [];
      for (let i = 0; i < this._tbl.numRows(); i++) {
        if (!rows.has(i)) keep.push(i);
      }
      return new DataFrame(this._tbl._take(keep));
    }
    // axis === 1 — drop columns
    const cols = Array.isArray(toRemove) ? toRemove : [toRemove];
    return new DataFrame(this._tbl.drop(...cols));
  }

  rename(opts) {
    let columns = null;
    if (opts && opts._kw) columns = opts.columns;
    else columns = opts;
    return new DataFrame(this._tbl.rename(columns));
  }

  describe() {
    const numCols = this._tbl.columnNames().filter(n => {
      const arr = this._tbl.array(n);
      return arr.some(v => typeof v === 'number');
    });
    const stats = { stat: ['count', 'mean', 'std', 'min', '25%', '50%', '75%', 'max'] };
    for (const col of numCols) {
      const arr = this._tbl.array(col).filter(v => v != null && typeof v === 'number');
      stats[col] = [
        arr.length,
        op.mean(arr),
        op.std(arr),
        op.min(arr),
        op.quantile(arr, 0.25),
        op.quantile(arr, 0.5),
        op.quantile(arr, 0.75),
        op.max(arr),
      ];
    }
    return new DataFrame(table(stats));
  }

  apply(fn) {
    const result = {};
    for (const c of this._tbl.columnNames()) {
      result[c] = fn(new WrapperSeries(this._tbl.array(c), c));
    }
    return result;
  }

  pipe(fn, ...args) { return fn(this, ...args); }
  copy(opts) {
    // pandas's `deep` defaults to True; we always deep-copy because our
    // Table stores plain arrays per column and shallow-sharing them is
    // a footgun (mutations leak between "copies"). The `deep` kwarg is
    // accepted but ignored.
    const cols = {};
    for (const n of this._tbl.columnNames()) cols[n] = this._tbl.array(n).slice();
    return new DataFrame(new Table(cols, this._tbl.columnNames()));
  }
  to_records() { return this._tbl.objects(); }
  to_dict(orient) {
    if (orient === 'records') return this.to_records();
    const result = {};
    for (const c of this._tbl.columnNames()) result[c] = this._tbl.array(c).slice();
    return result;
  }
  // pandas signatures:
  //   df.to_csv()                  → return CSV text (sync)
  //   df.to_csv("path.csv")        → write to VFS, return Promise<null>
  //   df.to_csv("path.csv", sep=';', index=False) → as above with kwargs
  //   df.to_csv(sep=';')           → return CSV text with custom sep
  // Relative paths land under /home/nb/ (the notebook's home mount);
  // absolute paths (starting with /) are passed through verbatim.
  to_csv(pathOrOpts, opts) {
    let path = null;
    let kw = {};
    if (pathOrOpts != null && typeof pathOrOpts === 'object' && pathOrOpts._kw) {
      kw = pathOrOpts;
    } else {
      path = pathOrOpts;
      if (opts && opts._kw) kw = opts;
    }
    const text = this._tbl.toCSV(kw);
    if (path == null || path === '') return text;
    if (typeof path !== 'string') {
      throw new TypeError(`to_csv: expected path string, got ${typeof path}`);
    }
    if (typeof window === 'undefined' || !window._notebookVFS) {
      throw new Error('to_csv: VFS not available (no window._notebookVFS)');
    }
    const abs = path.startsWith('/') ? path : '/home/nb/' + path;
    return window._notebookVFS.writeFile(abs, text).then(() => null);
  }

  // Transpose — swap rows and columns. Column names become the row
  // index (we don't have a real index yet, so they map to integer-
  // labelled columns 0..nrows-1; the ORIGINAL column names get
  // collected and exposed via the result's `.index`). pandas's
  // df.T is the same operation.
  transpose() {
    const tbl = this._tbl;
    const names = tbl.columnNames();
    const nrows = tbl.numRows();
    const newColNames = [];
    for (let i = 0; i < nrows; i++) newColNames.push(String(i));
    const newCols = {};
    for (let i = 0; i < nrows; i++) {
      newCols[newColNames[i]] = names.map(n => tbl._columns[n][i]);
    }
    const out = new DataFrame(new Table(newCols, newColNames));
    out._index = new _Index(names);
    return out;
  }
  get T() { return this.transpose(); }

  // pandas internal — return a DataFrame with only the numeric columns.
  // sklearn / pandas code uses this to filter object / string columns
  // before fitting; pandas itself uses it for many built-in reductions.
  _get_numeric_data() {
    const numCols = this._tbl.columnNames().filter(n => {
      const arr = this._tbl.array(n);
      return arr.some(v => typeof v === 'number');
    });
    return new DataFrame(this._tbl.select(...numCols));
  }

  // pandas.DataFrame.corr(method='pearson') — pairwise Pearson
  // correlation between numeric columns. Returns a DataFrame indexed
  // by column name with the correlation matrix.
  corr(opts) {
    const _method = (opts && opts._kw && opts.method) || (typeof opts === 'string' ? opts : 'pearson');
    if (_method !== 'pearson') throw new Error('df.corr: only pearson is supported');
    // Numeric-only columns
    const numCols = this._tbl.columnNames().filter(n => {
      const arr = this._tbl.array(n);
      return arr.some(v => typeof v === 'number');
    });
    const colArrs = numCols.map(n => this._tbl.array(n).map(v => typeof v === 'number' ? v : NaN));
    const n = colArrs.length;
    // Pairwise Pearson r — n×n grid.
    const _r = (a, b) => {
      let sa = 0, sb = 0, k = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] === a[i] && b[i] === b[i]) { sa += a[i]; sb += b[i]; k++; }
      }
      if (k === 0) return NaN;
      const ma = sa / k, mb = sb / k;
      let num = 0, da2 = 0, db2 = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] === a[i] && b[i] === b[i]) {
          const da = a[i] - ma, db = b[i] - mb;
          num += da * db; da2 += da * da; db2 += db * db;
        }
      }
      return num / Math.sqrt(da2 * db2);
    };
    const cols = {};
    for (let i = 0; i < n; i++) {
      const colName = numCols[i];
      cols[colName] = [];
      for (let j = 0; j < n; j++) cols[colName].push(i === j ? 1 : _r(colArrs[i], colArrs[j]));
    }
    const out = new DataFrame(new Table(cols, numCols));
    out._index = new _Index(numCols);
    return out;
  }

  // pandas null detection — `isnull()` and `notna()` return a same-shape
  // DataFrame of booleans. `isnull().sum()` then yields per-column counts
  // (Series), and `.sum().sum()` reduces to a scalar.
  isnull() {
    const cols = {};
    for (const c of this._tbl.columnNames()) {
      cols[c] = this._tbl.array(c).map(v => v == null || (typeof v === 'number' && v !== v));
    }
    return new DataFrame(new Table(cols, this._tbl.columnNames()));
  }
  isna() { return this.isnull(); }
  notnull() {
    const cols = {};
    for (const c of this._tbl.columnNames()) {
      cols[c] = this._tbl.array(c).map(v => !(v == null || (typeof v === 'number' && v !== v)));
    }
    return new DataFrame(new Table(cols, this._tbl.columnNames()));
  }
  notna() { return this.notnull(); }

  // sum / mean / min / max / count along axis. axis=0 (default) reduces
  // each column → Series indexed by column name; axis=1 reduces each row
  // → Series of length nrows. Matches pandas default behavior.
  sum(axis) {
    if (axis && axis._kw) axis = axis.axis;
    axis = axis == null ? 0 : axis;
    if (axis === 0) {
      const out = [];
      for (const c of this._tbl.columnNames()) {
        out.push(this._tbl.array(c).reduce((s, v) => s + (v != null && typeof v !== 'boolean' ? v : v === true ? 1 : 0), 0));
      }
      const s = new WrapperSeries(out, null);
      s._index = new _Index(this._tbl.columnNames());
      return s;
    }
    if (axis === 1) {
      const out = [];
      const names = this._tbl.columnNames();
      for (let i = 0; i < this._tbl.numRows(); i++) {
        let s = 0;
        for (const c of names) {
          const v = this._tbl._columns[c][i];
          s += v != null && typeof v !== 'boolean' ? v : v === true ? 1 : 0;
        }
        out.push(s);
      }
      return new WrapperSeries(out, null);
    }
    throw new Error(`unsupported axis: ${axis}`);
  }
  mean(axis) {
    if (axis && axis._kw) axis = axis.axis;
    axis = axis == null ? 0 : axis;
    if (axis === 0) {
      const out = [];
      for (const c of this._tbl.columnNames()) {
        const arr = this._tbl.array(c);
        const nums = arr.filter(v => v != null && typeof v === 'number');
        out.push(nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : NaN);
      }
      const s = new WrapperSeries(out, null);
      s._index = new _Index(this._tbl.columnNames());
      return s;
    }
    throw new Error(`unsupported axis: ${axis}`);
  }
}

// ── _NumpyLikeArray2D — minimal numpy.ndarray stand-in for DataFrame.values
//                       / DataFrame.to_numpy() output ──
//
// Returns from df.values / df.to_numpy(). Provides the `.shape`, `.ndim`,
// `.size`, `.dtype` attributes that pandas's values/to_numpy promise (so
// downstream `arr.shape[0]` works) plus integer-position __getitem__ /
// __setitem__ that handle both single-axis and 2D tuple subscripts.
//
// Not a real ndarray — for proper numpy ops, callers should still pass
// this to `np.array(...)` to convert. We're matching the duck-shape for
// the common print-and-inspect patterns in scientific notebooks.

class _NumpyLikeArray2D {
  constructor(rows, ncols) {
    this._rows = rows;
    this.shape = [rows.length, ncols];
    this.ndim = 2;
    this.size = rows.length * ncols;
    this.dtype = 'object';
    // Python-side `type(x)` reads __adderClass__ from adder's
    // pyTypeName helper; without it every JS class shows as 'object'.
    this.__adderClass__ = 'ndarray';
    // Flat row-major Float64 view so learn / natra / scitra's input
    // dispatchers recognize this as a numpy-ndarray-shape object (they
    // check for `.data instanceof Float64Array && .shape`). Without it
    // these libraries fall through to "named-columns object" and treat
    // `_rows` as a feature name, which fails validation.
    let allNumeric = true;
    for (const row of rows) {
      for (const v of row) { if (typeof v !== 'number') { allNumeric = false; break; } }
      if (!allNumeric) break;
    }
    if (allNumeric) {
      const flat = new Float64Array(rows.length * ncols);
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < ncols; j++) flat[i * ncols + j] = rows[i][j];
      }
      // Hide internal _rows from key-iteration so sklearn-style probing
      // doesn't see it as a feature column.
      Object.defineProperty(this, '_rows', { value: rows, enumerable: false });
      Object.defineProperty(this, 'data', { value: flat, enumerable: false });
    }
  }

  __getitem__(key) {
    const nrows = this._rows.length;
    const ncols = this.shape[1];
    if (Array.isArray(key) && key.length === 2) {
      const [rk, ck] = key;
      // scalar [i, j] — return the cell
      if (typeof rk === 'number' && typeof ck === 'number') {
        const r = rk < 0 ? nrows + rk : rk;
        const c = ck < 0 ? ncols + ck : ck;
        return this._rows[r][c];
      }
      // scalar row + slice/list col → row vector
      if (typeof rk === 'number' && ck && ck._slice) {
        const r = rk < 0 ? nrows + rk : rk;
        const lo = ck.lower != null ? ck.lower : 0;
        const hi = ck.upper != null ? Math.min(ck.upper, ncols) : ncols;
        return this._rows[r].slice(lo, hi);
      }
      // slice row + scalar col → column vector
      if (rk && rk._slice && typeof ck === 'number') {
        const lo = rk.lower != null ? rk.lower : 0;
        const hi = rk.upper != null ? Math.min(rk.upper, nrows) : nrows;
        const c = ck < 0 ? ncols + ck : ck;
        const out = [];
        for (let i = lo; i < hi; i++) out.push(this._rows[i][c]);
        return out;
      }
      // slice row + slice col → 2D sub-array
      if (rk && rk._slice && ck && ck._slice) {
        const r0 = rk.lower != null ? rk.lower : 0;
        const r1 = rk.upper != null ? Math.min(rk.upper, nrows) : nrows;
        const c0 = ck.lower != null ? ck.lower : 0;
        const c1 = ck.upper != null ? Math.min(ck.upper, ncols) : ncols;
        const out = [];
        for (let i = r0; i < r1; i++) out.push(this._rows[i].slice(c0, c1));
        return new _NumpyLikeArray2D(out, c1 - c0);
      }
      throw new Error('unsupported tuple subscript shape on numpy-like array');
    }
    if (typeof key === 'number') {
      return this._rows[key < 0 ? nrows + key : key];
    }
    if (key && key._slice) {
      const lo = key.lower != null ? key.lower : 0;
      const hi = key.upper != null ? Math.min(key.upper, nrows) : nrows;
      const out = this._rows.slice(lo, hi);
      return new _NumpyLikeArray2D(out, ncols);
    }
    throw new Error(`unsupported key type on numpy-like array: ${typeof key}`);
  }

  __setitem__(key, value) {
    if (Array.isArray(key) && key.length === 2 && typeof key[0] === 'number' && typeof key[1] === 'number') {
      const r = key[0] < 0 ? this._rows.length + key[0] : key[0];
      const c = key[1] < 0 ? this.shape[1] + key[1] : key[1];
      this._rows[r][c] = value;
      return;
    }
    throw new Error('unsupported setitem on numpy-like array');
  }

  __len__() { return this._rows.length; }
  *[Symbol.iterator]() { yield* this._rows; }
  tolist() { return this._rows.map(r => r.slice()); }
  __repr__() { return `array(${JSON.stringify(this._rows.slice(0, 5))}${this._rows.length > 5 ? ', ...' : ''})`; }
  __str__() { return this.__repr__(); }
  toString() { return this.__repr__(); }
}

// ── WrapperSeries — extends Series with pandas-shape API ──
//
// Indexers and properties (.iloc / .loc / .at / .iat / .index / .size /
// .ndim / .to_numpy) live on the wrapper rather than the base Series
// so the bare query-style Series stays minimal. plot() also routes
// here via _findPlt.

class WrapperSeries extends Series {
  constructor(values, name) { super(values, name); }
  sort_values(ascending = true) { return this.sort(ascending); }
  value_counts() { return this.valueCounts(); }

  get ndim() { return 1; }
  get size() { return this._values.length; }
  get empty() { return this._values.length === 0; }
  get dtype() {
    for (const v of this._values) {
      if (v == null) continue;
      if (typeof v === 'number') return Number.isInteger(v) ? 'int64' : 'float64';
      if (typeof v === 'boolean') return 'bool';
      return 'object';
    }
    return 'object';
  }
  get shape() { return [this._values.length]; }
  get index() {
    if (!this._index) this._index = new _RangeIndex(this._values.length);
    return this._index;
  }
  to_numpy(_opts) { return this._values.slice(); }

  get iloc() { if (!this._iloc) this._iloc = makeSeriesIloc(this); return this._iloc; }
  get loc()  { if (!this._loc)  this._loc  = makeSeriesLoc(this);  return this._loc;  }
  get at()   { if (!this._at)   this._at   = makeSeriesAt(this);   return this._at;   }
  get iat()  { if (!this._iat)  this._iat  = makeSeriesIat(this);  return this._iat;  }

  // Used by Series-side indexers when projecting a sub-Series.
  _makeLike(values) { return new WrapperSeries(values, this._name); }

  // pandas-shape __getitem__ — supports:
  //   s[i]                 → scalar by position (default RangeIndex)
  //   s[label]             → scalar by label (custom Index)
  //   s[slice]             → sub-Series
  //   s[boolean_mask]      → filtered sub-Series
  //   s[[i1, i2, ...]]     → fancy indexing → sub-Series
  __getitem__(key) {
    if (key instanceof BooleanMask) {
      const out = [];
      for (let i = 0; i < this._values.length; i++) if (key._values[i]) out.push(this._values[i]);
      return this._makeLike(out);
    }
    if (key && key._slice) return this.iloc.__getitem__(key);
    if (Array.isArray(key)) return this.iloc.__getitem__(key);
    if (this._index && this._index._isRangeIndex !== true && typeof key !== 'number') {
      // Custom-indexed series: lookup by label
      return this.loc.__getitem__(key);
    }
    return this._values[key < 0 ? this._values.length + key : key];
  }

  __setitem__(key, value) {
    if (key && key._slice) return this.iloc.__setitem__(key, value);
    if (Array.isArray(key)) return this.iloc.__setitem__(key, value);
    if (this._index && this._index._isRangeIndex !== true && typeof key !== 'number') {
      return this.loc.__setitem__(key, value);
    }
    this._values[key < 0 ? this._values.length + key : key] = value;
  }

  plot(opts) {
    const kw = (opts && opts._kw) ? opts : (opts || {});
    const plt = _findPlt();
    if (!plt) throw new Error('plt extension not loaded — call load("@gcu/plot") first');
    const x = this._index && this._index._isRangeIndex !== true
      ? this._index.tolist()
      : Array.from({ length: this._values.length }, (_, i) => i);
    const kind = kw.kind || 'line';
    if (kind === 'bar') return plt.bar(x, this._values, kw);
    if (kind === 'hist') return plt.hist(this._values, kw);
    if (kind === 'scatter') return plt.scatter(x, this._values, kw);
    return plt.plot(x, this._values, kw);
  }
}

// ── WrapperGroupBy ──

class WrapperGroupBy {
  constructor(groupby, keys) {
    this._gb = groupby;
    this._keys = keys;
  }

  agg(exprs) {
    // map string aggregation names to op functions
    const mapped = {};
    for (const [name, fn] of Object.entries(exprs)) {
      mapped[name] = typeof fn === 'function' ? fn : op[fn];
    }
    return new DataFrame(this._gb.rollup(mapped));
  }

  mean() {
    const t = this._gb._table;
    const numCols = t.columnNames().filter(n => !this._keys.includes(n));
    const exprs = {};
    for (const c of numCols) exprs[c] = op.mean;
    return new DataFrame(this._gb.rollup(exprs));
  }

  sum() {
    const t = this._gb._table;
    const numCols = t.columnNames().filter(n => !this._keys.includes(n));
    const exprs = {};
    for (const c of numCols) exprs[c] = op.sum;
    return new DataFrame(this._gb.rollup(exprs));
  }

  count() { return new DataFrame(this._gb.count()); }
}

// ── top-level wrapper functions ──

// pandas.read_csv accepts a path/URL/file-like and reads the CSV text.
// Conditionally async — returns a Promise only when we actually need
// to fetch (http/https URL) or read VFS (absolute path). Inline CSV
// text returns a DataFrame synchronously so existing JS callers don't
// need to await. Adder users always await and get the right thing
// either way.
function read_csv(source, opts) {
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return (async () => {
        const resp = await fetch(trimmed);
        if (!resp.ok) throw new Error(`read_csv: HTTP ${resp.status} fetching ${trimmed}`);
        return new DataFrame(csv(await resp.text(), opts));
      })();
    }
    if (trimmed.startsWith('/') && typeof window !== 'undefined' && window._notebookVFS) {
      return (async () => {
        const text = await window._notebookVFS.readFile(trimmed, 'text');
        return new DataFrame(csv(text, opts));
      })();
    }
    // Bare filename — looks like a file path, not CSV text. Treat as
    // a VFS lookup under /home/nb/. Heuristic: single line, no commas
    // / tabs / semicolons, ends with a CSV-ish extension. Otherwise
    // assume the user passed inline CSV text and let csv() parse it.
    if (!trimmed.includes('\n') && !trimmed.includes(',')
        && !trimmed.includes('\t') && !trimmed.includes(';')
        && /\.(csv|tsv|txt)$/i.test(trimmed)
        && typeof window !== 'undefined' && window._notebookVFS) {
      return (async () => {
        const abs = '/home/nb/' + trimmed;
        try {
          const text = await window._notebookVFS.readFile(abs, 'text');
          return new DataFrame(csv(text, opts));
        } catch (e) {
          throw new Error(`read_csv: could not read '${trimmed}' from ${abs} — drop the file into the notebook's filesystem first`);
        }
      })();
    }
  }
  return new DataFrame(csv(source, opts));
}

function where(mask, a, b) {
  if (!(mask instanceof BooleanMask)) return mask ? a : b;
  return new Series(mask._values.map((v, i) => {
    const av = a instanceof Series ? a._values[i] : a;
    const bv = b instanceof Series ? b._values[i] : b;
    return v ? av : bv;
  }));
}

// ── registration ──

// pandas.plotting submodule — used as `import pandas.plotting as pd_plot`.
// Currently exposes scatter_matrix (pairwise scatter + diagonal hist),
// the only one Pyrcz-style notebooks reach for in practice.
const plotting = {
  scatter_matrix(df, opts) {
    const kw = (opts && opts._kw) ? opts : (opts || {});
    const plt = _findPlt();
    if (!plt) throw new Error('scatter_matrix: plt not loaded — call load("@gcu/plot") first');
    if (!df || !df._tbl) throw new Error('scatter_matrix: expected a DataFrame');
    const numCols = df._tbl.columnNames().filter(n => {
      const a = df._tbl.array(n);
      return a.some(v => typeof v === 'number');
    });
    const n = numCols.length;
    const sub = plt.subplots(n, n, { figsize: kw.figsize });
    const axes = sub.axes || (Array.isArray(sub) ? sub[1] : []);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const ax = Array.isArray(axes[i]) ? axes[i][j] : axes[i * n + j];
        if (!ax) continue;
        if (i === j) ax.hist(df._tbl.array(numCols[i]), { color: kw.color || '#4488ff' });
        else ax.scatter(df._tbl.array(numCols[j]), df._tbl.array(numCols[i]),
          { alpha: kw.alpha, color: kw.color || '#4488ff' });
      }
    }
    return (sub.fig || sub[0]).show();
  },
};

const sadpanModule = {
  // JS API
  table, from, csv, series, concat, merge, semijoin, antijoin, op,
  Table, Series, BooleanMask, GroupBy,
  // DataFrame wrapper API (for adder)
  DataFrame, read_csv, where, WrapperSeries, WrapperGroupBy,
  // pandas.plotting submodule
  plotting,
  // pandas-shape constants and helpers
  NaN: Number.NaN,
  NA: Number.NaN,   // pandas's NA marker — same scalar value for our purposes
  Index: _Index,
  RangeIndex: _RangeIndex,
  // pd.isna / pd.notna helpers
  isna: (v) => v == null || (typeof v === 'number' && v !== v),
  notna: (v) => !(v == null || (typeof v === 'number' && v !== v)),
};

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/sadpan',
      version: '0.1.0',
      description: 'Column-oriented dataframe library',
      exports: { sadpan: sadpanModule },
    });
  } else {
    if (!window._auditableExtensions) window._auditableExtensions = {};
    window._auditableExtensions['sadpan'] = sadpanModule;
  }
}

export { table, from, csv, series, concat, merge, semijoin, antijoin, op, Table, Series, BooleanMask, GroupBy, DataFrame, read_csv, where };
