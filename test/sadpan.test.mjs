import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── shim DOM for adder import chain ──
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => ({
    tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
    innerHTML: '', textContent: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  }),
  createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
};
globalThis.window = globalThis;
globalThis.CSS = { escape: s => s };

const {
  table, from, csv, series, concat, merge, semijoin, antijoin, op,
  Table, Series, BooleanMask, GroupBy, DataFrame, read_csv, where,
} = await import('../ext/sadpan/index.js');

// ── Table creation ──

describe('Table creation', () => {
  it('from column dict', () => {
    const t = table({ x: [1, 2, 3], y: [4, 5, 6] });
    assert.equal(t.numRows(), 3);
    assert.equal(t.numCols(), 2);
    assert.deepStrictEqual(t.columnNames(), ['x', 'y']);
  });

  it('from row array', () => {
    const t = from([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    assert.equal(t.numRows(), 2);
    assert.deepStrictEqual(t.array('a'), [1, 3]);
  });

  it('empty table', () => {
    const t = table({});
    assert.equal(t.numRows(), 0);
    assert.equal(t.numCols(), 0);
  });
});

// ── Table inspection ──

describe('Table inspection', () => {
  const t = table({ x: [1, 2, 3], y: ['a', 'b', 'c'] });

  it('objects', () => {
    const rows = t.objects();
    assert.equal(rows.length, 3);
    assert.deepStrictEqual(rows[0], { x: 1, y: 'a' });
  });

  it('print', () => {
    const out = t.print(2);
    assert.ok(out.includes('x\ty'));
    assert.ok(out.includes('1\ta'));
  });

  it('array', () => {
    assert.deepStrictEqual(t.array('x'), [1, 2, 3]);
  });
});

// ── Table selection ──

describe('Table selection', () => {
  const t = table({ x: [1, 2], y: [3, 4], z: [5, 6] });

  it('select', () => {
    const s = t.select('x', 'z');
    assert.deepStrictEqual(s.columnNames(), ['x', 'z']);
    assert.equal(s.numCols(), 2);
  });

  it('drop', () => {
    const d = t.drop('y');
    assert.deepStrictEqual(d.columnNames(), ['x', 'z']);
  });

  it('rename', () => {
    const r = t.rename({ x: 'a', y: 'b' });
    assert.deepStrictEqual(r.columnNames(), ['a', 'b', 'z']);
    assert.deepStrictEqual(r.array('a'), [1, 2]);
  });
});

// ── Table filtering ──

describe('Table filtering', () => {
  const t = table({ x: [1, 2, 3, 4, 5], y: ['a', 'b', 'c', 'd', 'e'] });

  it('filter', () => {
    const f = t.filter(row => row.x > 3);
    assert.equal(f.numRows(), 2);
    assert.deepStrictEqual(f.array('x'), [4, 5]);
  });

  it('slice', () => {
    const s = t.slice(1, 3);
    assert.equal(s.numRows(), 2);
    assert.deepStrictEqual(s.array('x'), [2, 3]);
  });

  it('slice negative', () => {
    const s = t.slice(-2);
    assert.equal(s.numRows(), 2);
    assert.deepStrictEqual(s.array('x'), [4, 5]);
  });

  it('dedupe', () => {
    const t2 = table({ x: [1, 1, 2, 2, 3], y: ['a', 'a', 'b', 'c', 'c'] });
    assert.equal(t2.dedupe('x').numRows(), 3);
    assert.equal(t2.dedupe('y').numRows(), 3);
    assert.equal(t2.dedupe().numRows(), 4);
  });

  it('sample', () => {
    const s = t.sample(3);
    assert.equal(s.numRows(), 3);
  });
});

// ── Table sorting ──

describe('Table sorting', () => {
  const t = table({ x: [3, 1, 2], y: ['c', 'a', 'b'] });

  it('orderby asc', () => {
    const s = t.orderby('x');
    assert.deepStrictEqual(s.array('x'), [1, 2, 3]);
  });

  it('orderby desc', () => {
    const s = t.orderby({ x: 'desc' });
    assert.deepStrictEqual(s.array('x'), [3, 2, 1]);
  });
});

// ── Table derivation ──

describe('Table derivation', () => {
  const t = table({ x: [1, 2, 3] });

  it('assign', () => {
    const a = t.assign({ y: [4, 5, 6] });
    assert.deepStrictEqual(a.columnNames(), ['x', 'y']);
    assert.deepStrictEqual(a.array('y'), [4, 5, 6]);
  });

  it('derive', () => {
    const d = t.derive({ x2: (row) => row.x * 2 });
    assert.deepStrictEqual(d.array('x2'), [2, 4, 6]);
  });
});

// ── Table aggregation ──

describe('Table aggregation', () => {
  const t = table({ x: [1, 2, 3, 4] });

  it('rollup', () => {
    const r = t.rollup({ x: op.sum });
    assert.equal(r.numRows(), 1);
    assert.deepStrictEqual(r.array('x'), [10]);
  });
});

// ── GroupBy ──

describe('GroupBy', () => {
  const t = table({ lith: ['BIF', 'BIF', 'ITA', 'ITA'], fe: [60, 62, 55, 58], au: [0.1, 0.2, 0.3, 0.4] });

  it('rollup', () => {
    const g = t.groupby('lith').rollup({ fe: op.mean, au: op.sum });
    assert.equal(g.numRows(), 2);
    const rows = g.objects();
    const bif = rows.find(r => r.lith === 'BIF');
    assert.equal(bif.fe, 61);
    assert.ok(Math.abs(bif.au - 0.3) < 1e-10);
  });

  it('count', () => {
    const g = t.groupby('lith').count();
    assert.equal(g.numRows(), 2);
    const rows = g.objects();
    assert.equal(rows.find(r => r.lith === 'BIF').count, 2);
  });
});

// ── Join ──

describe('Join', () => {
  const left = table({ id: [1, 2, 3], x: [10, 20, 30] });
  const right = table({ id: [2, 3, 4], y: [200, 300, 400] });

  it('inner join', () => {
    const j = left.join(right, 'id');
    assert.equal(j.numRows(), 2);
    assert.deepStrictEqual(j.array('id'), [2, 3]);
    assert.deepStrictEqual(j.array('y'), [200, 300]);
  });

  it('left join', () => {
    const j = left.join_left(right, 'id');
    assert.equal(j.numRows(), 3);
    assert.deepStrictEqual(j.array('id'), [1, 2, 3]);
    assert.equal(j.array('y')[0], null);
  });

  it('right join', () => {
    const j = left.join_right(right, 'id');
    assert.equal(j.numRows(), 3);
  });

  it('full join', () => {
    const j = left.join_full(right, 'id');
    assert.equal(j.numRows(), 4);
  });

  it('semijoin', () => {
    const j = semijoin(left, right, 'id');
    assert.equal(j.numRows(), 2);
    assert.deepStrictEqual(j.array('id'), [2, 3]);
  });

  it('antijoin', () => {
    const j = antijoin(left, right, 'id');
    assert.equal(j.numRows(), 1);
    assert.deepStrictEqual(j.array('id'), [1]);
  });

  it('join with different keys', () => {
    const l = table({ lid: [1, 2, 3], x: [10, 20, 30] });
    const r = table({ rid: [2, 3, 4], y: [200, 300, 400] });
    const j = merge(l, r, ['lid', 'rid']);
    assert.equal(j.numRows(), 2);
  });
});

// ── CSV ──

describe('CSV', () => {
  it('parse with header', () => {
    const t = csv('x,y\n1,a\n2,b\n3,c');
    assert.equal(t.numRows(), 3);
    assert.deepStrictEqual(t.array('x'), [1, 2, 3]);
    assert.deepStrictEqual(t.array('y'), ['a', 'b', 'c']);
  });

  it('parse without header', () => {
    const t = csv('1,a\n2,b', { header: false });
    assert.deepStrictEqual(t.columnNames(), ['col0', 'col1']);
  });

  it('parse with separator', () => {
    const t = csv('x\ty\n1\ta', { sep: '\t' });
    assert.equal(t.numRows(), 1);
  });

  it('round-trip', () => {
    const t = table({ x: [1, 2], y: ['a', 'b'] });
    const text = t.toCSV();
    const t2 = csv(text);
    assert.deepStrictEqual(t2.array('x'), [1, 2]);
    assert.deepStrictEqual(t2.array('y'), ['a', 'b']);
  });

  it('null values', () => {
    const t = csv('x,y\n1,\n,b');
    assert.equal(t.array('x')[1], null);
    assert.equal(t.array('y')[0], null);
  });

  it('quoted header', () => {
    const t = csv('"x","y"\n1,2');
    assert.deepStrictEqual(t.columnNames(), ['x', 'y']);
  });
});

// ── Series ──

describe('Series', () => {
  it('sum/mean/median', () => {
    const s = series([1, 2, 3, 4, 5]);
    assert.equal(s.sum(), 15);
    assert.equal(s.mean(), 3);
    assert.equal(s.median(), 3);
  });

  it('std', () => {
    const s = series([2, 4, 4, 4, 5, 5, 7, 9]);
    // sample std (n-1) ≈ 2.138
    assert.ok(Math.abs(s.std() - 2.138) < 0.01);
  });

  it('min/max', () => {
    const s = series([3, 1, 4, 1, 5]);
    assert.equal(s.min(), 1);
    assert.equal(s.max(), 5);
  });

  it('unique/nunique', () => {
    const s = series([1, 2, 2, 3, 3, 3]);
    assert.equal(s.nunique(), 3);
    assert.deepStrictEqual(s.unique(), [1, 2, 3]);
  });

  it('map', () => {
    const s = series([1, 2, 3]).map(v => v * 10);
    assert.deepStrictEqual(s._values, [10, 20, 30]);
  });

  it('cumsum', () => {
    const s = series([1, 2, 3]).cumsum();
    assert.deepStrictEqual(s._values, [1, 3, 6]);
  });

  it('diff', () => {
    const s = series([1, 3, 6]).diff();
    assert.equal(s._values[0], null);
    assert.equal(s._values[1], 2);
    assert.equal(s._values[2], 3);
  });

  it('clip', () => {
    const s = series([1, 5, 10]).clip(2, 8);
    assert.deepStrictEqual(s._values, [2, 5, 8]);
  });

  it('iterator', () => {
    const s = series([1, 2, 3]);
    const arr = [...s];
    assert.deepStrictEqual(arr, [1, 2, 3]);
  });

  it('null handling in sum/mean', () => {
    const s = series([1, null, 3]);
    assert.equal(s.sum(), 4);
    assert.equal(s.mean(), 2);
    assert.equal(s.count(), 2);
  });
});

// ── Series dunders ──

describe('Series dunders', () => {
  it('add', () => {
    const a = series([1, 2, 3]);
    const b = a.__add__(10);
    assert.deepStrictEqual(b._values, [11, 12, 13]);
  });

  it('add series', () => {
    const a = series([1, 2, 3]);
    const b = series([10, 20, 30]);
    const c = a.__add__(b);
    assert.deepStrictEqual(c._values, [11, 22, 33]);
  });

  it('gt returns BooleanMask', () => {
    const s = series([1, 5, 3]);
    const m = s.__gt__(2);
    assert.ok(m instanceof BooleanMask);
    assert.deepStrictEqual(m._values, [false, true, true]);
  });

  it('eq returns BooleanMask', () => {
    const m = series([1, 2, 1]).__eq__(1);
    assert.deepStrictEqual(m._values, [true, false, true]);
  });

  it('ne returns BooleanMask', () => {
    const m = series([1, 2, 1]).__ne__(1);
    assert.deepStrictEqual(m._values, [false, true, false]);
  });

  it('neg', () => {
    const s = series([1, -2, 3]).__neg__();
    assert.deepStrictEqual(s._values, [-1, 2, -3]);
  });

  it('truediv', () => {
    const s = series([10, 20, 30]).__truediv__(10);
    assert.deepStrictEqual(s._values, [1, 2, 3]);
  });
});

// ── BooleanMask ──

describe('BooleanMask', () => {
  it('and', () => {
    const a = new BooleanMask([true, false, true]);
    const b = new BooleanMask([true, true, false]);
    const c = a.__and__(b);
    assert.deepStrictEqual(c._values, [true, false, false]);
  });

  it('or', () => {
    const a = new BooleanMask([true, false, false]);
    const b = new BooleanMask([false, false, true]);
    assert.deepStrictEqual(a.__or__(b)._values, [true, false, true]);
  });

  it('invert', () => {
    const a = new BooleanMask([true, false, true]);
    assert.deepStrictEqual(a.__invert__()._values, [false, true, false]);
  });
});

// ── op helpers ──

describe('op helpers', () => {
  it('sum', () => assert.equal(op.sum([1, 2, 3]), 6));
  it('mean', () => assert.equal(op.mean([2, 4]), 3));
  it('median', () => assert.equal(op.median([1, 3, 5]), 3));
  it('min', () => assert.equal(op.min([3, 1, 2]), 1));
  it('max', () => assert.equal(op.max([3, 1, 2]), 3));
  it('count', () => assert.equal(op.count([1, null, 3]), 2));
  it('first', () => assert.equal(op.first([5, 6, 7]), 5));
  it('last', () => assert.equal(op.last([5, 6, 7]), 7));
  it('quantile', () => assert.equal(op.quantile([1, 2, 3, 4, 5], 0.5), 3));
  it('std', () => assert.ok(op.std([2, 4, 4, 4, 5, 5, 7, 9]) > 0));
  it('variance', () => assert.ok(op.variance([2, 4, 4, 4, 5, 5, 7, 9]) > 0));
});

// ── DataFrame wrapper ──

describe('DataFrame', () => {
  it('from column dict', () => {
    const df = new DataFrame({ x: [1, 2, 3], y: [4, 5, 6] });
    assert.deepStrictEqual(df.shape, [3, 2]);
    assert.deepStrictEqual(df.columns, ['x', 'y']);
  });

  it('from row array', () => {
    const df = new DataFrame([{ a: 1 }, { a: 2 }]);
    assert.equal(df.shape[0], 2);
  });

  it('__getitem__ string returns Series', () => {
    const df = new DataFrame({ x: [1, 2, 3] });
    const s = df.__getitem__('x');
    assert.ok(s instanceof Series);
    assert.deepStrictEqual(s._values, [1, 2, 3]);
  });

  it('__getitem__ list returns DataFrame', () => {
    const df = new DataFrame({ x: [1], y: [2], z: [3] });
    const sub = df.__getitem__(['x', 'z']);
    assert.ok(sub instanceof DataFrame);
    assert.deepStrictEqual(sub.columns, ['x', 'z']);
  });

  it('__getitem__ BooleanMask filters', () => {
    const df = new DataFrame({ x: [1, 2, 3, 4] });
    const mask = new BooleanMask([false, true, false, true]);
    const filtered = df.__getitem__(mask);
    assert.equal(filtered.shape[0], 2);
    assert.deepStrictEqual(filtered.__getitem__('x')._values, [2, 4]);
  });

  it('__getitem__ slice', () => {
    const df = new DataFrame({ x: [1, 2, 3, 4, 5] });
    const sliced = df.__getitem__({ _slice: true, lower: 1, upper: 3 });
    assert.equal(sliced.shape[0], 2);
  });

  it('__setitem__', () => {
    const df = new DataFrame({ x: [1, 2, 3] });
    df.__setitem__('y', [4, 5, 6]);
    assert.deepStrictEqual(df.columns, ['x', 'y']);
    assert.deepStrictEqual(df.__getitem__('y')._values, [4, 5, 6]);
  });

  it('__setitem__ scalar broadcast', () => {
    const df = new DataFrame({ x: [1, 2, 3] });
    df.__setitem__('flag', 'yes');
    assert.deepStrictEqual(df.__getitem__('flag')._values, ['yes', 'yes', 'yes']);
  });

  it('__len__', () => {
    assert.equal(new DataFrame({ x: [1, 2] }).__len__(), 2);
  });

  it('__contains__', () => {
    const df = new DataFrame({ x: [1], y: [2] });
    assert.ok(df.__contains__('x'));
    assert.ok(!df.__contains__('z'));
  });

  it('head/tail', () => {
    const df = new DataFrame({ x: [1, 2, 3, 4, 5] });
    assert.equal(df.head(2).shape[0], 2);
    assert.equal(df.tail(2).shape[0], 2);
  });

  it('sort_values asc', () => {
    const df = new DataFrame({ x: [3, 1, 2] });
    const s = df.sort_values('x');
    assert.deepStrictEqual(s.__getitem__('x')._values, [1, 2, 3]);
  });

  it('sort_values desc', () => {
    const df = new DataFrame({ x: [3, 1, 2] });
    const s = df.sort_values('x', false);
    assert.deepStrictEqual(s.__getitem__('x')._values, [3, 2, 1]);
  });

  it('drop_duplicates', () => {
    const df = new DataFrame({ x: [1, 1, 2], y: [1, 1, 2] });
    assert.equal(df.drop_duplicates().shape[0], 2);
  });

  it('dropna', () => {
    const df = new DataFrame({ x: [1, null, 3], y: [4, 5, 6] });
    assert.equal(df.dropna().shape[0], 2);
  });

  it('fillna', () => {
    const df = new DataFrame({ x: [1, null, 3] });
    assert.deepStrictEqual(df.fillna(0).__getitem__('x')._values, [1, 0, 3]);
  });

  it('describe', () => {
    const df = new DataFrame({ x: [1, 2, 3, 4], y: ['a', 'b', 'c', 'd'] });
    const desc = df.describe();
    assert.ok(desc.columns.includes('x'));
    assert.ok(desc.columns.includes('stat'));
  });

  it('to_records', () => {
    const df = new DataFrame({ x: [1, 2] });
    const rows = df.to_records();
    assert.deepStrictEqual(rows, [{ x: 1 }, { x: 2 }]);
  });

  it('to_dict', () => {
    const df = new DataFrame({ x: [1, 2] });
    const d = df.to_dict('list');
    assert.deepStrictEqual(d, { x: [1, 2] });
  });

  it('to_csv', () => {
    const df = new DataFrame({ x: [1, 2], y: ['a', 'b'] });
    const text = df.to_csv();
    assert.ok(text.includes('x,y'));
    assert.ok(text.includes('1,a'));
  });

  it('copy', () => {
    const df = new DataFrame({ x: [1, 2] });
    const cp = df.copy();
    assert.deepStrictEqual(cp.shape, df.shape);
  });

  it('pipe', () => {
    const df = new DataFrame({ x: [1, 2, 3] });
    const result = df.pipe(d => d.head(2));
    assert.equal(result.shape[0], 2);
  });

  it('select/drop/rename', () => {
    const df = new DataFrame({ x: [1], y: [2], z: [3] });
    assert.deepStrictEqual(df.select('x', 'z').columns, ['x', 'z']);
    assert.deepStrictEqual(df.drop(['y']).columns, ['x', 'z']);
    assert.deepStrictEqual(df.rename({ x: 'a' }).columns, ['a', 'y', 'z']);
  });
});

// ── DataFrame groupby wrapper ──

describe('DataFrame groupby', () => {
  const df = new DataFrame({ lith: ['BIF', 'BIF', 'ITA'], fe: [60, 62, 55] });

  it('agg', () => {
    const g = df.groupby('lith').agg({ fe: 'mean' });
    assert.equal(g.shape[0], 2);
  });

  it('mean', () => {
    const g = df.groupby('lith').mean();
    assert.equal(g.shape[0], 2);
  });

  it('count', () => {
    const g = df.groupby('lith').count();
    assert.equal(g.shape[0], 2);
  });

  it('sum', () => {
    const g = df.groupby('lith').sum();
    assert.equal(g.shape[0], 2);
  });
});

// ── DataFrame merge wrapper ──

describe('DataFrame merge', () => {
  it('inner merge', () => {
    const left = new DataFrame({ id: [1, 2, 3], x: [10, 20, 30] });
    const right = new DataFrame({ id: [2, 3, 4], y: [200, 300, 400] });
    const j = left.merge(right, { on: 'id', how: 'inner' });
    assert.equal(j.shape[0], 2);
  });
});

// ── read_csv ──

describe('read_csv', () => {
  it('returns DataFrame', () => {
    const df = read_csv('x,y\n1,a\n2,b');
    assert.ok(df instanceof DataFrame);
    assert.deepStrictEqual(df.shape, [2, 2]);
  });
});

// ── where ──

describe('where', () => {
  it('mask-based where', () => {
    const mask = new BooleanMask([true, false, true]);
    const result = where(mask, 'yes', 'no');
    assert.deepStrictEqual(result._values, ['yes', 'no', 'yes']);
  });

  it('scalar where', () => {
    assert.equal(where(true, 'a', 'b'), 'a');
    assert.equal(where(false, 'a', 'b'), 'b');
  });
});

// ── concat ──

describe('concat', () => {
  it('vertical stack', () => {
    const a = table({ x: [1, 2] });
    const b = table({ x: [3, 4] });
    const c = concat(a, b);
    assert.equal(c.numRows(), 4);
    assert.deepStrictEqual(c.array('x'), [1, 2, 3, 4]);
  });
});

// ── Table reshape ──

describe('Table reshape', () => {
  it('pivot', () => {
    const t = table({
      region: ['A', 'A', 'B', 'B'],
      lith: ['BIF', 'ITA', 'BIF', 'ITA'],
      fe: [60, 50, 62, 48],
    });
    const p = t.pivot(['region', 'lith'], ['fe'], op.mean);
    assert.equal(p.numRows(), 2);
    assert.ok(p.columnNames().includes('BIF'));
    assert.ok(p.columnNames().includes('ITA'));
  });

  it('fold', () => {
    const t = table({ id: [1, 2], fe: [60, 62], au: [0.1, 0.2] });
    const f = t.fold(['fe', 'au']);
    assert.equal(f.numRows(), 4);
    assert.ok(f.columnNames().includes('key'));
    assert.ok(f.columnNames().includes('value'));
  });
});

// ── Table toJSON ──

describe('Table export', () => {
  it('toJSON rows', () => {
    const t = table({ x: [1, 2] });
    const j = t.toJSON('rows');
    assert.deepStrictEqual(j, [{ x: 1 }, { x: 2 }]);
  });

  it('toJSON columns', () => {
    const t = table({ x: [1, 2] });
    const j = t.toJSON('columns');
    assert.deepStrictEqual(j, { x: [1, 2] });
  });
});

// ── Series extras ──

describe('Series extra methods', () => {
  it('isna', () => {
    const s = series([1, null, 3]);
    assert.deepStrictEqual(s.isna()._values, [false, true, false]);
  });

  it('notna', () => {
    const s = series([1, null, 3]);
    assert.deepStrictEqual(s.notna()._values, [true, false, true]);
  });

  it('isin', () => {
    const s = series([1, 2, 3, 4]);
    assert.deepStrictEqual(s.isin([2, 4])._values, [false, true, false, true]);
  });

  it('valueCounts', () => {
    const s = series([1, 2, 2, 3, 3, 3]);
    const vc = s.valueCounts();
    assert.equal(vc.get(3), 3);
    assert.equal(vc.get(1), 1);
  });

  it('sort', () => {
    const s = series([3, 1, 2]).sort();
    assert.deepStrictEqual(s._values, [1, 2, 3]);
  });

  it('sort descending', () => {
    const s = series([3, 1, 2]).sort(false);
    assert.deepStrictEqual(s._values, [3, 2, 1]);
  });

  it('abs/log/exp/sqrt', () => {
    const s = series([-1, 4, 9]);
    assert.deepStrictEqual(s.abs()._values, [1, 4, 9]);
    assert.ok(Math.abs(s.abs().log()._values[1] - Math.log(4)) < 1e-10);
    assert.ok(Math.abs(s.abs().sqrt()._values[2] - 3) < 1e-10);
  });

  it('round', () => {
    const s = series([1.234, 5.678]).round(1);
    assert.deepStrictEqual(s._values, [1.2, 5.7]);
  });
});
