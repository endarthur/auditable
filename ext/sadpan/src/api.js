// api.js — factories, op helpers, DataFrame wrapper, registration

import { Table } from './table.js';
import { Series, BooleanMask } from './series.js';
import { GroupBy } from './groupby.js';
import { join, semijoin, antijoin } from './join.js';
import { csv, toCSV } from './io.js';

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
  constructor(data) {
    if (!data) this._tbl = new Table({}, []);
    else if (data instanceof Table) this._tbl = data;
    else if (Array.isArray(data)) this._tbl = from(data);
    else if (typeof data === 'object') this._tbl = table(data);
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
    if (!Array.isArray(value)) value = new Array(this._tbl.numRows()).fill(value);
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

  // methods
  head(n = 5) { return new DataFrame(this._tbl.slice(0, n)); }
  tail(n = 5) { return new DataFrame(this._tbl.slice(-n)); }

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

  drop(opts) {
    let columns = null;
    if (opts && opts._kw) columns = opts.columns;
    else if (Array.isArray(opts)) columns = opts;
    else columns = [opts];
    return new DataFrame(this._tbl.drop(...columns));
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
  copy() { return new DataFrame(this._tbl); }
  to_records() { return this._tbl.objects(); }
  to_dict(orient) {
    if (orient === 'records') return this.to_records();
    const result = {};
    for (const c of this._tbl.columnNames()) result[c] = this._tbl.array(c).slice();
    return result;
  }
  to_csv(opts) { return this._tbl.toCSV(opts && opts._kw ? opts : {}); }
}

// ── WrapperSeries — extends Series with extra pandas-style methods ──

class WrapperSeries extends Series {
  constructor(values, name) { super(values, name); }
  sort_values(ascending = true) { return this.sort(ascending); }
  value_counts() { return this.valueCounts(); }
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

function read_csv(text, opts) { return new DataFrame(csv(text, opts)); }

function where(mask, a, b) {
  if (!(mask instanceof BooleanMask)) return mask ? a : b;
  return new Series(mask._values.map((v, i) => {
    const av = a instanceof Series ? a._values[i] : a;
    const bv = b instanceof Series ? b._values[i] : b;
    return v ? av : bv;
  }));
}

// ── registration ──

const sadpanModule = {
  // JS API
  table, from, csv, series, concat, merge, semijoin, antijoin, op,
  Table, Series, BooleanMask, GroupBy,
  // DataFrame wrapper API (for adder)
  DataFrame, read_csv, where, WrapperSeries, WrapperGroupBy,
};

if (typeof window !== 'undefined') {
  if (!window._auditableExtensions) window._auditableExtensions = {};
  window._auditableExtensions['sadpan'] = sadpanModule;
}

export { table, from, csv, series, concat, merge, semijoin, antijoin, op, Table, Series, BooleanMask, GroupBy, DataFrame, read_csv, where };
