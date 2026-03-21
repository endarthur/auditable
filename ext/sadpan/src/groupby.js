// groupby.js — GroupBy (split-apply-combine via Map)

import { Table } from './table.js';

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

export { GroupBy };
