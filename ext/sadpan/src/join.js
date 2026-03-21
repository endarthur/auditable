// join.js — join / semijoin / antijoin (hash join)

import { Table } from './table.js';

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

export { join, semijoin, antijoin };
