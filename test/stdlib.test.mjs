// shim document for state.js import
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { std } from '../src/js/stdlib.js';

const { csv, sum, mean, median, extent, bin, linspace, unique, zip, cross, fmt } = std;

// ── csv ──

describe('csv', () => {
  it('parses basic CSV', () => {
    const result = csv('a,b\n1,2\n3,4\n');
    assert.deepStrictEqual(result, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('parses with typed option', () => {
    const result = csv('a,b\n1,2\n3,4', { typed: true });
    assert.deepStrictEqual(result, [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
  });

  it('handles quoted fields', () => {
    const result = csv('name,value\n"hello, world",42\n');
    assert.deepStrictEqual(result, [{ name: 'hello, world', value: '42' }]);
  });

  it('handles escaped quotes', () => {
    const result = csv('a\n"he said ""hi"""\n');
    assert.deepStrictEqual(result, [{ a: 'he said "hi"' }]);
  });

  it('handles custom separator', () => {
    const result = csv('a\tb\n1\t2', { separator: '\t' });
    assert.deepStrictEqual(result, [{ a: '1', b: '2' }]);
  });

  it('returns empty array for header-only', () => {
    assert.deepStrictEqual(csv('a,b\n'), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepStrictEqual(csv(''), []);
  });

  it('typed coerces booleans and null', () => {
    const result = csv('a,b,c\ntrue,false,', { typed: true });
    assert.deepStrictEqual(result, [{ a: true, b: false, c: null }]);
  });

  it('handles CRLF line endings', () => {
    const result = csv('a,b\r\n1,2\r\n3,4\r\n');
    assert.deepStrictEqual(result, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });
});

// ── sum ──

describe('sum', () => {
  it('sums numbers', () => {
    assert.strictEqual(sum([1, 2, 3]), 6);
  });

  it('sums with accessor', () => {
    assert.strictEqual(sum([{ v: 1 }, { v: 2 }, { v: 3 }], d => d.v), 6);
  });

  it('returns 0 for empty array', () => {
    assert.strictEqual(sum([]), 0);
  });
});

// ── mean ──

describe('mean', () => {
  it('computes mean', () => {
    assert.strictEqual(mean([1, 2, 3]), 2);
  });

  it('returns NaN for empty array', () => {
    assert.ok(Number.isNaN(mean([])));
  });

  it('works with accessor', () => {
    assert.strictEqual(mean([{ v: 10 }, { v: 20 }], d => d.v), 15);
  });
});

// ── median ──

describe('median', () => {
  it('odd count', () => {
    assert.strictEqual(median([3, 1, 2]), 2);
  });

  it('even count', () => {
    assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  });

  it('single element', () => {
    assert.strictEqual(median([5]), 5);
  });

  it('returns NaN for empty', () => {
    assert.ok(Number.isNaN(median([])));
  });
});

// ── extent ──

describe('extent', () => {
  it('finds min and max', () => {
    assert.deepStrictEqual(extent([3, 1, 4, 1, 5, 9]), [1, 9]);
  });

  it('works with accessor', () => {
    assert.deepStrictEqual(extent([{ v: 5 }, { v: 2 }, { v: 8 }], d => d.v), [2, 8]);
  });
});

// ── bin ──

describe('bin', () => {
  it('creates correct number of bins', () => {
    const result = bin([1, 2, 3, 4, 5], 5);
    assert.strictEqual(result.length, 5);
  });

  it('each bin has x0, x1, values', () => {
    const result = bin([1, 2, 3], 2);
    assert.ok('x0' in result[0]);
    assert.ok('x1' in result[0]);
    assert.ok(Array.isArray(result[0].values));
  });

  it('default 10 bins', () => {
    const result = bin([1, 2, 3, 4, 5]);
    assert.strictEqual(result.length, 10);
  });

  it('all values accounted for', () => {
    const data = [1, 2, 3, 4, 5];
    const result = bin(data, 3);
    const total = result.reduce((s, b) => s + b.values.length, 0);
    assert.strictEqual(total, data.length);
  });
});

// ── linspace ──

describe('linspace', () => {
  it('generates correct number of points', () => {
    const result = linspace(0, 1, 5);
    assert.strictEqual(result.length, 5);
  });

  it('endpoints are exact', () => {
    const result = linspace(0, 1, 5);
    assert.strictEqual(result[0], 0);
    assert.strictEqual(result[4], 1);
  });

  it('evenly spaced', () => {
    const result = linspace(0, 1, 5);
    assert.deepStrictEqual(result, [0, 0.25, 0.5, 0.75, 1]);
  });

  it('single point returns start', () => {
    assert.deepStrictEqual(linspace(5, 10, 1), [5]);
  });

  it('n=0 returns empty', () => {
    assert.deepStrictEqual(linspace(0, 1, 0), []);
  });

  it('n=2 returns endpoints', () => {
    assert.deepStrictEqual(linspace(0, 10, 2), [0, 10]);
  });
});

// ── unique ──

describe('unique', () => {
  it('removes duplicates', () => {
    assert.deepStrictEqual(unique([1, 2, 2, 3, 1]), [1, 2, 3]);
  });

  it('works with key function', () => {
    const data = [{ id: 1, name: 'a' }, { id: 1, name: 'b' }, { id: 2, name: 'c' }];
    const result = unique(data, d => d.id);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, 'a');
    assert.strictEqual(result[1].name, 'c');
  });
});

// ── zip ──

describe('zip', () => {
  it('zips two arrays', () => {
    assert.deepStrictEqual(zip([1, 2, 3], ['a', 'b', 'c']), [[1, 'a'], [2, 'b'], [3, 'c']]);
  });

  it('truncates to shortest', () => {
    assert.deepStrictEqual(zip([1, 2], ['a', 'b', 'c']), [[1, 'a'], [2, 'b']]);
  });

  it('zips three arrays', () => {
    assert.deepStrictEqual(zip([1], [2], [3]), [[1, 2, 3]]);
  });
});

// ── cross ──

describe('cross', () => {
  it('cartesian product of two arrays', () => {
    assert.deepStrictEqual(cross([1, 2], ['a', 'b']), [[1, 'a'], [1, 'b'], [2, 'a'], [2, 'b']]);
  });

  it('single array returns wrapped elements', () => {
    assert.deepStrictEqual(cross([1, 2, 3]), [[1], [2], [3]]);
  });

  it('empty input returns single empty tuple', () => {
    assert.deepStrictEqual(cross(), [[]]);
  });
});

// ── fmt ──

describe('fmt', () => {
  it('formats with decimals', () => {
    assert.strictEqual(fmt(3.14159, { decimals: 2 }), '3.14');
  });

  it('adds prefix and suffix', () => {
    assert.strictEqual(fmt(42, { prefix: '$', suffix: ' USD' }), '$42 USD');
  });

  it('works with no options', () => {
    const result = fmt(1234);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('1'));
  });
});
