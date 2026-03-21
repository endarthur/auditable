// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/sadpan/src/  Build: node ext/sadpan/build.js
// @gcu/sadpan — Lightweight dataframe library for Auditable
// Column-oriented store, verb methods, pandas-style wrapper.

// -- series.js --

// series.js — Series + BooleanMask

class BooleanMask {
  constructor(values) { this._values = values; }
  __and__(other) { return new BooleanMask(this._values.map((v, i) => v && other._values[i])); }
  __or__(other) { return new BooleanMask(this._values.map((v, i) => v || other._values[i])); }
  __invert__() { return new BooleanMask(this._values.map(v => !v)); }
  __len__() { return this._values.length; }
  __bool__() { return this._values.some(v => v); }
  get length() { return this._values.length; }
}

class Series {
  constructor(values, name) {
    this._values = values;
    this._name = name || null;
  }
  get values() { return this._values; }
  get name() { return this._name; }

  // aggregation
  sum() { let s = 0; for (const v of this._values) if (v != null) s += v; return s; }
  mean() { let s = 0, n = 0; for (const v of this._values) if (v != null) { s += v; n++; } return n ? s / n : NaN; }
  median() {
    const sorted = this._values.filter(v => v != null).sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return NaN;
    return n % 2 ? sorted[n >> 1] : (sorted[(n >> 1) - 1] + sorted[n >> 1]) / 2;
  }
  std() {
    const m = this.mean();
    let s = 0, n = 0;
    for (const v of this._values) if (v != null) { s += (v - m) ** 2; n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
  }
  variance() {
    const m = this.mean();
    let s = 0, n = 0;
    for (const v of this._values) if (v != null) { s += (v - m) ** 2; n++; }
    return n > 1 ? s / (n - 1) : 0;
  }
  min() { let m = Infinity; for (const v of this._values) if (v != null && v < m) m = v; return m === Infinity ? NaN : m; }
  max() { let m = -Infinity; for (const v of this._values) if (v != null && v > m) m = v; return m === -Infinity ? NaN : m; }
  count() { let n = 0; for (const v of this._values) if (v != null) n++; return n; }

  // inspection
  unique() { return [...new Set(this._values)]; }
  nunique() { return new Set(this._values).size; }
  valueCounts() {
    const counts = new Map();
    for (const v of this._values) counts.set(v, (counts.get(v) || 0) + 1);
    return counts;
  }

  // transform
  map(fn) { return new Series(this._values.map(fn), this._name); }
  apply(fn) { return new Series(this._values.map(fn), this._name); }
  clip(lo, hi) { return new Series(this._values.map(v => v == null ? v : Math.max(lo, Math.min(hi, v))), this._name); }
  round(n = 0) { const f = 10 ** n; return new Series(this._values.map(v => v == null ? v : Math.round(v * f) / f), this._name); }
  abs() { return new Series(this._values.map(v => v == null ? v : Math.abs(v)), this._name); }
  log() { return new Series(this._values.map(v => v == null ? v : Math.log(v)), this._name); }
  exp() { return new Series(this._values.map(v => v == null ? v : Math.exp(v)), this._name); }
  sqrt() { return new Series(this._values.map(v => v == null ? v : Math.sqrt(v)), this._name); }
  cumsum() {
    let s = 0;
    return new Series(this._values.map(v => { if (v != null) s += v; return s; }), this._name);
  }
  diff() {
    return new Series(this._values.map((v, i) => i === 0 ? null : (v != null && this._values[i - 1] != null ? v - this._values[i - 1] : null)), this._name);
  }
  sort(ascending = true) {
    const sorted = this._values.slice().sort((a, b) => a - b);
    return new Series(ascending ? sorted : sorted.reverse(), this._name);
  }
  isna() { return new BooleanMask(this._values.map(v => v == null || v !== v)); }
  notna() { return new BooleanMask(this._values.map(v => v != null && v === v)); }
  isin(vals) { const s = new Set(vals); return new BooleanMask(this._values.map(v => s.has(v))); }
  astype(type) {
    if (type === 'number' || type === 'float') return new Series(this._values.map(Number), this._name);
    if (type === 'string' || type === 'str') return new Series(this._values.map(String), this._name);
    return this;
  }

  // dunders for adder operator dispatch
  __add__(other) { const ov = other instanceof Series ? other._values : null; return new Series(this._values.map((v, i) => v + (ov ? ov[i] : other)), this._name); }
  __sub__(other) { const ov = other instanceof Series ? other._values : null; return new Series(this._values.map((v, i) => v - (ov ? ov[i] : other)), this._name); }
  __mul__(other) { const ov = other instanceof Series ? other._values : null; return new Series(this._values.map((v, i) => v * (ov ? ov[i] : other)), this._name); }
  __truediv__(other) { const ov = other instanceof Series ? other._values : null; return new Series(this._values.map((v, i) => v / (ov ? ov[i] : other)), this._name); }
  __neg__() { return new Series(this._values.map(v => -v), this._name); }
  __gt__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v > (ov ? ov[i] : other))); }
  __ge__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v >= (ov ? ov[i] : other))); }
  __lt__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v < (ov ? ov[i] : other))); }
  __le__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v <= (ov ? ov[i] : other))); }
  __eq__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v === (ov ? ov[i] : other))); }
  __ne__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v !== (ov ? ov[i] : other))); }
  __len__() { return this._values.length; }

  [Symbol.iterator]() { return this._values[Symbol.iterator](); }
}

// -- table.js --

// table.js — Table class (column-oriented store)


class Table {
  constructor(columns, names) {
    this._columns = columns;
    this._names = names || Object.keys(columns);
    this._nrows = this._names.length > 0 ? columns[this._names[0]].length : 0;
  }

  // --- inspection ---
  numRows() { return this._nrows; }
  numCols() { return this._names.length; }
  columnNames() { return this._names.slice(); }
  array(col) { return this._columns[col]; }

  objects() {
    const rows = [];
    for (let i = 0; i < this._nrows; i++) {
      const row = {};
      for (const n of this._names) row[n] = this._columns[n][i];
      rows.push(row);
    }
    return rows;
  }

  print(n) {
    const rows = this.objects();
    const slice = n != null ? rows.slice(0, n) : rows;
    const header = this._names.join('\t');
    const body = slice.map(r => this._names.map(n => r[n] == null ? '' : String(r[n])).join('\t')).join('\n');
    return header + '\n' + body;
  }

  // --- selection ---
  select(...cols) {
    const c = {};
    for (const n of cols) c[n] = this._columns[n];
    return new Table(c, cols);
  }

  drop(...cols) {
    const s = new Set(cols);
    return this.select(...this._names.filter(n => !s.has(n)));
  }

  rename(map) {
    const c = {}, names = [];
    for (const n of this._names) {
      const nn = map[n] || n;
      c[nn] = this._columns[n];
      names.push(nn);
    }
    return new Table(c, names);
  }

  // --- filtering ---
  filter(fn) {
    const idx = [];
    for (let i = 0; i < this._nrows; i++) {
      const row = {};
      for (const n of this._names) row[n] = this._columns[n][i];
      if (fn(row, i)) idx.push(i);
    }
    return this._take(idx);
  }

  slice(start, end) {
    if (end === undefined) end = this._nrows;
    if (start < 0) start = Math.max(0, this._nrows + start);
    if (end < 0) end = Math.max(0, this._nrows + end);
    const c = {};
    for (const n of this._names) c[n] = this._columns[n].slice(start, end);
    return new Table(c, this._names.slice());
  }

  sample(n) {
    const idx = [];
    const pool = Array.from({ length: this._nrows }, (_, i) => i);
    for (let i = 0; i < Math.min(n, this._nrows); i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      idx.push(pool[i]);
    }
    return this._take(idx);
  }

  dedupe(...cols) {
    if (cols.length === 0) cols = this._names;
    const seen = new Set(), idx = [];
    for (let i = 0; i < this._nrows; i++) {
      const key = cols.map(c => this._columns[c][i]).join('\x00');
      if (!seen.has(key)) { seen.add(key); idx.push(i); }
    }
    return this._take(idx);
  }

  // --- sorting ---
  orderby(...keys) {
    const idx = Array.from({ length: this._nrows }, (_, i) => i);
    idx.sort((a, b) => {
      for (const k of keys) {
        let col, dir = 1;
        if (typeof k === 'string') { col = k; }
        else { col = Object.keys(k)[0]; dir = k[col] === 'desc' ? -1 : 1; }
        const va = this._columns[col][a], vb = this._columns[col][b];
        if (va < vb) return -dir;
        if (va > vb) return dir;
      }
      return 0;
    });
    return this._take(idx);
  }

  // --- derivation ---
  assign(cols) {
    const c = {};
    for (const n of this._names) c[n] = this._columns[n];
    const names = this._names.slice();
    for (const [k, v] of Object.entries(cols)) {
      c[k] = v;
      if (!names.includes(k)) names.push(k);
    }
    return new Table(c, names);
  }

  derive(exprs) {
    const cols = {};
    for (const [name, fn] of Object.entries(exprs)) {
      const arr = new Array(this._nrows);
      for (let i = 0; i < this._nrows; i++) {
        const row = {};
        for (const n of this._names) row[n] = this._columns[n][i];
        arr[i] = fn(row, i);
      }
      cols[name] = arr;
    }
    return this.assign(cols);
  }

  // --- aggregation ---
  rollup(exprs) {
    const c = {}, names = [];
    for (const [name, fn] of Object.entries(exprs)) {
      c[name] = [fn(this._columns[name] || this._collectRows())];
      names.push(name);
    }
    return new Table(c, names);
  }

  groupby(...cols) {
    return new GroupBy(this, cols);
  }

  // --- reshape ---
  pivot(keys, values, agg) {
    if (typeof keys === 'string') keys = [keys];
    if (typeof values === 'string') values = [values];
    // collect unique pivot keys
    const pivotCol = keys[keys.length - 1];
    const rowKeys = keys.slice(0, -1);
    const pivotVals = [...new Set(this._columns[pivotCol])];

    const groups = new Map();
    for (let i = 0; i < this._nrows; i++) {
      const rk = rowKeys.map(k => this._columns[k][i]).join('\x00');
      if (!groups.has(rk)) groups.set(rk, { keyVals: rowKeys.map(k => this._columns[k][i]), buckets: new Map() });
      const g = groups.get(rk);
      const pv = this._columns[pivotCol][i];
      if (!g.buckets.has(pv)) g.buckets.set(pv, {});
      for (const v of values) {
        if (!g.buckets.get(pv)[v]) g.buckets.get(pv)[v] = [];
        g.buckets.get(pv)[v].push(this._columns[v][i]);
      }
    }

    const outCols = {};
    const outNames = [...rowKeys];
    for (const n of rowKeys) outCols[n] = [];
    for (const pv of pivotVals) {
      for (const v of values) {
        const colName = values.length === 1 ? String(pv) : `${v}_${pv}`;
        outNames.push(colName);
        outCols[colName] = [];
      }
    }

    for (const [, g] of groups) {
      for (let ki = 0; ki < rowKeys.length; ki++) outCols[rowKeys[ki]].push(g.keyVals[ki]);
      for (const pv of pivotVals) {
        for (const v of values) {
          const colName = values.length === 1 ? String(pv) : `${v}_${pv}`;
          const arr = g.buckets.get(pv)?.[v];
          outCols[colName].push(arr ? agg(arr) : null);
        }
      }
    }
    return new Table(outCols, outNames);
  }

  fold(cols, opts = {}) {
    const keyName = opts.key || 'key';
    const valueName = opts.value || 'value';
    const keep = this._names.filter(n => !cols.includes(n));
    const outCols = {};
    for (const n of keep) outCols[n] = [];
    outCols[keyName] = [];
    outCols[valueName] = [];

    for (let i = 0; i < this._nrows; i++) {
      for (const col of cols) {
        for (const n of keep) outCols[n].push(this._columns[n][i]);
        outCols[keyName].push(col);
        outCols[valueName].push(this._columns[col][i]);
      }
    }
    return new Table(outCols, [...keep, keyName, valueName]);
  }

  // --- combine ---
  concat(...tables) {
    const c = {};
    for (const n of this._names) {
      c[n] = this._columns[n].slice();
      for (const t of tables) {
        c[n] = c[n].concat(t._columns[n] || new Array(t._nrows).fill(null));
      }
    }
    return new Table(c, this._names.slice());
  }

  join(right, on, opts) { return join(this, right, on, opts); }
  join_left(right, on, opts) { return join(this, right, on, { ...opts, how: 'left' }); }
  join_right(right, on, opts) { return join(this, right, on, { ...opts, how: 'right' }); }
  join_full(right, on, opts) { return join(this, right, on, { ...opts, how: 'full' }); }
  semijoin(right, on) { return semijoin(this, right, on); }
  antijoin(right, on) { return antijoin(this, right, on); }

  // --- export ---
  toCSV(opts = {}) {
    const sep = opts.sep || ',';
    const lines = [this._names.join(sep)];
    for (let i = 0; i < this._nrows; i++) {
      lines.push(this._names.map(n => {
        const v = this._columns[n][i];
        return v == null ? '' : String(v);
      }).join(sep));
    }
    return lines.join('\n');
  }

  toJSON(orient) {
    if (orient === 'columns') {
      const out = {};
      for (const n of this._names) out[n] = this._columns[n].slice();
      return out;
    }
    return this.objects();
  }

  // --- internal ---
  _take(indices) {
    const c = {};
    for (const n of this._names) {
      const src = this._columns[n];
      c[n] = indices.map(i => src[i]);
    }
    return new Table(c, this._names.slice());
  }

  _collectRows() {
    const rows = [];
    for (let i = 0; i < this._nrows; i++) {
      const row = {};
      for (const n of this._names) row[n] = this._columns[n][i];
      rows.push(row);
    }
    return rows;
  }
}

// -- groupby.js --

// groupby.js — GroupBy (split-apply-combine via Map)


class GroupBy {
  constructor(table, keys) {
    this._table = table;
    this._keys = keys;
    this._groups = null;
  }

  _build() {
    if (this._groups) return this._groups;
    const groups = new Map();
    const t = this._table;
    for (let i = 0; i < t._nrows; i++) {
      const gk = this._keys.map(k => t._columns[k][i]).join('\x00');
      if (!groups.has(gk)) groups.set(gk, {
        keyVals: this._keys.map(k => t._columns[k][i]),
        indices: [],
      });
      groups.get(gk).indices.push(i);
    }
    this._groups = groups;
    return groups;
  }

  rollup(exprs) {
    const groups = this._build();
    const t = this._table;
    const cols = {};
    const names = [...this._keys, ...Object.keys(exprs)];
    for (const n of names) cols[n] = [];

    for (const [, g] of groups) {
      for (let ki = 0; ki < this._keys.length; ki++) {
        cols[this._keys[ki]].push(g.keyVals[ki]);
      }
      for (const [name, fn] of Object.entries(exprs)) {
        const srcCol = t._columns[name];
        if (srcCol) {
          cols[name].push(fn(g.indices.map(i => srcCol[i])));
        } else {
          cols[name].push(fn(g.indices.map(i => {
            const row = {};
            for (const n of t._names) row[n] = t._columns[n][i];
            return row;
          })));
        }
      }
    }
    return new Table(cols, names);
  }

  count() {
    return this.rollup({ count: a => a.length });
  }
}

// -- join.js --

// join.js — join / semijoin / antijoin (hash join)


function join(left, right, on, opts = {}) {
  const how = opts.how || 'inner';
  const lkey = Array.isArray(on) ? on[0] : on;
  const rkey = Array.isArray(on) ? on[1] : on;

  // build hash of right table
  const rmap = new Map();
  for (let i = 0; i < right._nrows; i++) {
    const k = right._columns[rkey][i];
    if (!rmap.has(k)) rmap.set(k, []);
    rmap.get(k).push(i);
  }

  const lIdx = [], rIdx = [];
  const rMatched = new Set();
  for (let i = 0; i < left._nrows; i++) {
    const k = left._columns[lkey][i];
    const matches = rmap.get(k);
    if (matches) {
      for (const j of matches) { lIdx.push(i); rIdx.push(j); rMatched.add(j); }
    } else if (how === 'left' || how === 'full') {
      lIdx.push(i); rIdx.push(-1);
    }
  }
  if (how === 'right' || how === 'full') {
    for (let j = 0; j < right._nrows; j++) {
      if (!rMatched.has(j)) {
        lIdx.push(-1); rIdx.push(j);
      }
    }
  }

  // assemble output columns
  const c = {}, names = [];
  for (const n of left._names) {
    c[n] = lIdx.map(i => i >= 0 ? left._columns[n][i] : null);
    names.push(n);
  }
  for (const n of right._names) {
    if (n === rkey && rkey === lkey) continue;
    const out = names.includes(n) ? n + '_r' : n;
    c[out] = rIdx.map(j => j >= 0 ? right._columns[n][j] : null);
    names.push(out);
  }
  return new Table(c, names);
}

function semijoin(left, right, on) {
  const rkey = Array.isArray(on) ? on[1] : on;
  const lkey = Array.isArray(on) ? on[0] : on;
  const rset = new Set(right._columns[rkey]);
  return left.filter(row => rset.has(row[lkey]));
}

function antijoin(left, right, on) {
  const rkey = Array.isArray(on) ? on[1] : on;
  const lkey = Array.isArray(on) ? on[0] : on;
  const rset = new Set(right._columns[rkey]);
  return left.filter(row => !rset.has(row[lkey]));
}

// -- io.js --

// io.js — CSV parse/serialize


function csv(text, opts = {}) {
  const sep = opts.sep || ',';
  const lines = text.trim().split('\n');
  if (lines.length === 0) return new Table({}, []);
  const header = opts.header !== false;
  const names = header
    ? lines[0].split(sep).map(s => s.trim().replace(/^"|"$/g, ''))
    : lines[0].split(sep).map((_, i) => `col${i}`);
  const start = header ? 1 : 0;
  const cols = {};
  for (const n of names) cols[n] = [];

  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(sep);
    for (let j = 0; j < names.length; j++) {
      let v = (vals[j] || '').trim().replace(/^"|"$/g, '');
      const num = Number(v);
      cols[names[j]].push(v === '' ? null : isNaN(num) ? v : num);
    }
  }
  return new Table(cols, names);
}

function toCSV(table, opts = {}) {
  return table.toCSV(opts);
}

// -- api.js --

// api.js — factories, op helpers, DataFrame wrapper, registration






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

export { table, from, csv, series, concat, merge, semijoin, antijoin, op,
  Table, Series, BooleanMask, GroupBy, DataFrame, read_csv, where };
