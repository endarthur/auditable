// table.js — Table class (column-oriented store)

import { Series, BooleanMask } from './series.js';

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

export { Table };
