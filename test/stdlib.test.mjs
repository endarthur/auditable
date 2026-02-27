// shim document for state.js import
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { std } from '../src/js/stdlib.js';

const { csv, sum, mean, median, extent, bin, linspace, unique, zip, cross, fmt, include,
        color, colorScale, viridis, magma, inferno, plasma, turbo, palette10 } = std;

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

// ── include ──

describe('include', () => {
  const lib = {
    sources: {
      'a': 'function a',
      'b': 'function b',
      'c': 'function c',
      'd': 'function d',
    },
    deps: {
      'a': [],
      'b': ['a'],
      'c': ['a', 'b'],
      'd': [],
    },
  };

  it('includes a single routine with no deps', () => {
    assert.strictEqual(include(lib, 'a'), 'function a');
  });

  it('resolves direct dependency', () => {
    const result = include(lib, 'b');
    assert.ok(result.includes('function a'));
    assert.ok(result.includes('function b'));
    // a must come before b
    assert.ok(result.indexOf('function a') < result.indexOf('function b'));
  });

  it('resolves transitive dependencies', () => {
    const result = include(lib, 'c');
    assert.ok(result.includes('function a'));
    assert.ok(result.includes('function b'));
    assert.ok(result.includes('function c'));
    assert.ok(result.indexOf('function a') < result.indexOf('function b'));
    assert.ok(result.indexOf('function b') < result.indexOf('function c'));
  });

  it('deduplicates when multiple names share deps', () => {
    const result = include(lib, 'b', 'c');
    // 'a' should appear only once
    const count = result.split('function a').length - 1;
    assert.strictEqual(count, 1);
  });

  it('includes unrelated routines', () => {
    const result = include(lib, 'a', 'd');
    assert.ok(result.includes('function a'));
    assert.ok(result.includes('function d'));
  });

  it('throws on unknown routine', () => {
    assert.throws(() => include(lib, 'z'), /unknown routine 'z'/);
  });

  it('throws on invalid library object', () => {
    assert.throws(() => include({}, 'a'), /expected library with sources and deps/);
  });

  it('resolves across multiple libraries', () => {
    const libA = {
      sources: { 'a.dot': 'function a.dot' },
      deps: { 'a.dot': [] },
    };
    const libB = {
      sources: { 'b.solve': 'function b.solve' },
      deps: { 'b.solve': ['a.dot'] },
    };
    const result = include([libA, libB], 'b.solve');
    assert.ok(result.includes('function a.dot'));
    assert.ok(result.includes('function b.solve'));
    assert.ok(result.indexOf('function a.dot') < result.indexOf('function b.solve'));
  });

  it('single lib still works (backward compat)', () => {
    assert.strictEqual(include(lib, 'd'), 'function d');
  });
});

// ── colormaps ──

describe('colormaps', () => {
  for (const [name, fn] of [['viridis', viridis], ['magma', magma], ['inferno', inferno], ['plasma', plasma], ['turbo', turbo]]) {
    it(`${name} returns rgb() string`, () => {
      const result = fn(0.5);
      assert.match(result, /^rgb\(\d+,\d+,\d+\)$/);
    });

    it(`${name} clamps below 0`, () => {
      assert.strictEqual(fn(-1), fn(0));
    });

    it(`${name} clamps above 1`, () => {
      assert.strictEqual(fn(2), fn(1));
    });

    it(`${name} endpoints are valid`, () => {
      assert.match(fn(0), /^rgb\(\d+,\d+,\d+\)$/);
      assert.match(fn(1), /^rgb\(\d+,\d+,\d+\)$/);
    });
  }

  it('viridis(0) is dark purple-ish', () => {
    // viridis starts at approximately rgb(68,1,84)
    const m = viridis(0).match(/rgb\((\d+),(\d+),(\d+)\)/);
    assert.ok(+m[1] < 100); // R low
    assert.ok(+m[3] > 50);  // B moderate
  });

  it('viridis(1) is bright green-yellow', () => {
    const m = viridis(1).match(/rgb\((\d+),(\d+),(\d+)\)/);
    assert.ok(+m[2] > 200); // G high
    assert.ok(+m[3] < 50);  // B low
  });
});

// ── color parsing ──

describe('color parsing', () => {
  it('parses #rgb', () => {
    const c = color('#f00');
    assert.strictEqual(c.r, 255);
    assert.strictEqual(c.g, 0);
    assert.strictEqual(c.b, 0);
    assert.strictEqual(c.a, 1);
  });

  it('parses #rrggbb', () => {
    const c = color('#ff8000');
    assert.strictEqual(c.r, 255);
    assert.strictEqual(c.g, 128);
    assert.strictEqual(c.b, 0);
  });

  it('parses #rrggbbaa', () => {
    const c = color('#ff000080');
    assert.strictEqual(c.r, 255);
    assert.ok(Math.abs(c.a - 128/255) < 0.01);
  });

  it('parses #rgba', () => {
    const c = color('#f008');
    assert.strictEqual(c.r, 255);
    assert.strictEqual(c.g, 0);
    assert.strictEqual(c.b, 0);
    assert.ok(Math.abs(c.a - 0x88/255) < 0.01);
  });

  it('parses rgb()', () => {
    const c = color('rgb(10,20,30)');
    assert.strictEqual(c.r, 10);
    assert.strictEqual(c.g, 20);
    assert.strictEqual(c.b, 30);
  });

  it('parses rgba()', () => {
    const c = color('rgba(10,20,30,0.5)');
    assert.strictEqual(c.a, 0.5);
  });

  it('parses hsl()', () => {
    const c = color('hsl(0,100%,50%)');
    assert.strictEqual(c.r, 255);
    assert.strictEqual(c.g, 0);
    assert.strictEqual(c.b, 0);
  });

  it('parses hsla()', () => {
    const c = color('hsla(120,100%,50%,0.7)');
    assert.strictEqual(c.g, 255);
    assert.strictEqual(c.a, 0.7);
  });

  it('parses array', () => {
    const c = color([100, 150, 200]);
    assert.strictEqual(c.r, 100);
    assert.strictEqual(c.g, 150);
    assert.strictEqual(c.b, 200);
    assert.strictEqual(c.a, 1);
  });

  it('clones color object', () => {
    const c1 = color('#ff0000');
    const c2 = color(c1);
    assert.strictEqual(c2.r, 255);
    assert.strictEqual(c2.g, 0);
    assert.strictEqual(c2.b, 0);
  });

  it('throws on invalid input', () => {
    assert.throws(() => color('not-a-color'));
    assert.throws(() => color(42));
  });
});

// ── color output ──

describe('color output', () => {
  it('.css() returns rgb()', () => {
    assert.strictEqual(color('#ff0000').css(), 'rgb(255,0,0)');
  });

  it('.css() returns rgba() when alpha < 1', () => {
    assert.strictEqual(color('rgba(255,0,0,0.5)').css(), 'rgba(255,0,0,0.5)');
  });

  it('.hex() returns #rrggbb', () => {
    assert.strictEqual(color('rgb(255,128,0)').hex(), '#ff8000');
  });

  it('.toString() same as .css()', () => {
    const c = color('#00ff00');
    assert.strictEqual(c.toString(), c.css());
  });
});

// ── color conversions ──

describe('color conversions', () => {
  it('.hsl() red -> h:0, s:100, l:50', () => {
    const h = color('#ff0000').hsl();
    assert.strictEqual(h.h, 0);
    assert.strictEqual(h.s, 100);
    assert.strictEqual(h.l, 50);
  });

  it('.hsl() green -> h:120', () => {
    const h = color('#00ff00').hsl();
    assert.strictEqual(h.h, 120);
  });

  it('.oklab() white -> L close to 1, a,b close to 0', () => {
    const lab = color('#ffffff').oklab();
    assert.ok(Math.abs(lab.L - 1) < 0.01);
    assert.ok(Math.abs(lab.a) < 0.01);
    assert.ok(Math.abs(lab.b) < 0.01);
  });

  it('.oklab() black -> L close to 0', () => {
    const lab = color('#000000').oklab();
    assert.ok(Math.abs(lab.L) < 0.01);
  });

  it('.oklch() returns L, C, h', () => {
    const lch = color('#ff0000').oklch();
    assert.ok('L' in lch);
    assert.ok('C' in lch);
    assert.ok('h' in lch);
    assert.ok(lch.C > 0); // red is chromatic
  });

  it('.linear() returns 0-1 range', () => {
    const lin = color('#ffffff').linear();
    assert.ok(Math.abs(lin.r - 1) < 0.01);
    assert.ok(Math.abs(lin.g - 1) < 0.01);
    assert.ok(Math.abs(lin.b - 1) < 0.01);
  });

  it('.linear() black is 0', () => {
    const lin = color('#000000').linear();
    assert.ok(Math.abs(lin.r) < 0.001);
  });
});

// ── color manipulation ──

describe('color manipulation', () => {
  it('.lighten() increases L', () => {
    const c = color('#808080');
    const lighter = c.lighten(0.1);
    assert.ok(lighter.oklab().L > c.oklab().L);
  });

  it('.darken() decreases L', () => {
    const c = color('#808080');
    const darker = c.darken(0.1);
    assert.ok(darker.oklab().L < c.oklab().L);
  });

  it('.mix() midpoint', () => {
    const c = color('#000000').mix('#ffffff', 0.5);
    // midpoint in OKLAB should be roughly medium gray
    assert.ok(c.r > 50 && c.r < 200);
  });

  it('.mix() accepts color string', () => {
    const c = color('#ff0000').mix('#0000ff');
    assert.ok(c.r > 0 || c.b > 0);
  });

  it('.rotate() shifts hue', () => {
    const c = color('#ff0000');
    const rotated = c.rotate(120);
    // rotating red 120 degrees should move toward green
    assert.ok(rotated.g > rotated.r || rotated.b > rotated.r);
  });

  it('.alpha() sets alpha', () => {
    const c = color('#ff0000').alpha(0.5);
    assert.strictEqual(c.a, 0.5);
    assert.strictEqual(c.r, 255);
  });

  it('.saturate() increases chroma', () => {
    const c = color('#996666');
    const sat = c.saturate(0.05);
    assert.ok(sat.oklch().C > c.oklch().C - 0.001);
  });

  it('.desaturate() decreases chroma', () => {
    const c = color('#ff0000');
    const desat = c.desaturate(0.05);
    assert.ok(desat.oklch().C < c.oklch().C + 0.001);
  });

  it('manipulation returns new object', () => {
    const c = color('#ff0000');
    const c2 = c.lighten(0.1);
    assert.notStrictEqual(c, c2);
    assert.strictEqual(c.r, 255); // original unchanged
  });
});

// ── color immutability ──

describe('color immutability', () => {
  it('is frozen', () => {
    const c = color('#ff0000');
    assert.ok(Object.isFrozen(c));
  });

  it('assignment does not change value', () => {
    const c = color('#ff0000');
    try { c.r = 0; } catch {}
    assert.strictEqual(c.r, 255);
  });
});

// ── colorScale ──

describe('colorScale', () => {
  it('endpoints map correctly', () => {
    const scale = colorScale([0, 1], ['#000000', '#ffffff']);
    assert.match(scale(0), /^rgb/);
    assert.match(scale(1), /^rgb/);
  });

  it('midpoint interpolates', () => {
    const scale = colorScale([0, 1], ['#000000', '#ffffff']);
    const mid = scale(0.5);
    const m = mid.match(/\d+/g).map(Number);
    // should be roughly gray
    assert.ok(m[0] > 50 && m[0] < 200);
  });

  it('diverging with 3 stops', () => {
    const scale = colorScale([0, 0.5, 1], ['#0000ff', '#ffffff', '#ff0000']);
    // at midpoint should be close to white
    const mid = scale(0.5);
    const m = mid.match(/\d+/g).map(Number);
    assert.ok(m[0] > 200); // R high at white
    assert.ok(m[1] > 200); // G high at white
  });

  it('colormap function passthrough', () => {
    const scale = colorScale([0, 100], viridis);
    assert.strictEqual(scale(0), viridis(0));
    assert.strictEqual(scale(100), viridis(1));
    assert.strictEqual(scale(50), viridis(0.5));
  });

  it('clamps out-of-range values', () => {
    const scale = colorScale([0, 1], ['#000000', '#ffffff']);
    assert.strictEqual(scale(-1), scale(0));
    assert.strictEqual(scale(2), scale(1));
  });

  it('throws on mismatched lengths', () => {
    assert.throws(() => colorScale([0, 1], ['#000', '#fff', '#f00']));
  });
});

// ── palette10 ──

describe('palette10', () => {
  it('has 10 entries', () => {
    assert.strictEqual(palette10.length, 10);
  });

  it('all valid hex', () => {
    for (const c of palette10) {
      assert.match(c, /^#[0-9a-f]{6}$/);
    }
  });

  it('all unique', () => {
    assert.strictEqual(new Set(palette10).size, 10);
  });
});
