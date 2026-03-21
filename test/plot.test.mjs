import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// shim document for modules that reference it
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = globalThis;

// --- direct source imports for unit testing ---

// LinearScale
const scaleModule = await import('../ext/plot/src/scale.js');
const { LinearScale } = scaleModule;

// colormaps
const colorModule = await import('../ext/plot/src/color.js');
const { getCmap, cmapRgb } = colorModule;

// format parser
const formatModule = await import('../ext/plot/src/format.js');
const { parseFormat, dashArray } = formatModule;

// Axes
const axesModule = await import('../ext/plot/src/axes.js');
const { Axes } = axesModule;

// Figure
const figureModule = await import('../ext/plot/src/figure.js');
const { Figure } = figureModule;

// API
const apiModule = await import('../ext/plot/src/api.js');
const { subplots, plot: plotFn, scatter: scatterFn, imshow: imshowFn, hist: histFn, bar: barFn, cmap: cmapFn } = apiModule;

// ==================== LinearScale ====================

describe('LinearScale', () => {
  it('transforms domain to range', () => {
    const s = new LinearScale([0, 10], [0, 100]);
    assert.equal(s.transform(0), 0);
    assert.equal(s.transform(10), 100);
    assert.equal(s.transform(5), 50);
  });

  it('handles inverted range', () => {
    const s = new LinearScale([0, 10], [100, 0]);
    assert.equal(s.transform(0), 100);
    assert.equal(s.transform(10), 0);
    assert.equal(s.transform(5), 50);
  });

  it('inverse maps pixel to domain', () => {
    const s = new LinearScale([0, 10], [0, 100]);
    assert.equal(s.inverse(0), 0);
    assert.equal(s.inverse(100), 10);
    assert.equal(s.inverse(50), 5);
  });

  it('roundtrip transform/inverse', () => {
    const s = new LinearScale([2, 8], [50, 300]);
    for (const v of [2, 3.5, 5, 7, 8]) {
      assert.ok(Math.abs(s.inverse(s.transform(v)) - v) < 1e-10);
    }
  });

  it('handles degenerate domain', () => {
    const s = new LinearScale([5, 5], [0, 100]);
    assert.equal(s.transform(5), 50); // midpoint
  });

  it('generates nice ticks', () => {
    const s = new LinearScale([0, 100], [0, 500]);
    const ticks = s.ticks(6);
    assert.ok(ticks.length >= 3);
    assert.ok(ticks[0] >= 0);
    assert.ok(ticks[ticks.length - 1] <= 100);
    // ticks should be evenly spaced
    if (ticks.length > 2) {
      const step = ticks[1] - ticks[0];
      for (let i = 2; i < ticks.length; i++) {
        assert.ok(Math.abs((ticks[i] - ticks[i - 1]) - step) < 1e-8);
      }
    }
  });

  it('tickFormat returns a function', () => {
    const s = new LinearScale([0, 100], [0, 500]);
    const fmt = s.tickFormat();
    assert.equal(typeof fmt, 'function');
    assert.equal(typeof fmt(42), 'string');
  });

  it('tickFormat uses scientific for large values', () => {
    const s = new LinearScale([0, 1e8], [0, 500]);
    const fmt = s.tickFormat();
    assert.ok(fmt(1e7).includes('e'));
  });

  it('tickFormat uses fixed for small ranges', () => {
    const s = new LinearScale([0.1, 0.5], [0, 500]);
    const fmt = s.tickFormat();
    assert.ok(fmt(0.25).includes('.'));
    assert.ok(!fmt(0.25).includes('e'));
  });
});

// ==================== Colormaps ====================

describe('Colormaps', () => {
  it('viridis returns rgb strings', () => {
    const v = getCmap('viridis');
    assert.ok(v(0).startsWith('rgb('));
    assert.ok(v(0.5).startsWith('rgb('));
    assert.ok(v(1).startsWith('rgb('));
  });

  it('viridis(0) is dark purple-blue', () => {
    const rgb = getCmap('viridis')(0);
    const m = rgb.match(/rgb\((\d+),(\d+),(\d+)\)/);
    assert.ok(m);
    const [, r, g, b] = m.map(Number);
    // viridis starts dark: roughly (68, 1, 84)
    assert.ok(r < 150 && g < 50 && b > 30);
  });

  it('viridis(1) is bright green-yellow', () => {
    const rgb = getCmap('viridis')(1);
    const m = rgb.match(/rgb\((\d+),(\d+),(\d+)\)/);
    assert.ok(m);
    const [, r, g, b] = m.map(Number);
    // polynomial approximation: green channel dominant at t=1
    assert.ok(g > 200);
  });

  it('clamps out-of-range values', () => {
    const v = getCmap('viridis');
    assert.equal(v(-1), v(0));
    assert.equal(v(2), v(1));
  });

  it('getCmap returns viridis for unknown name', () => {
    const v = getCmap('nonexistent');
    assert.equal(v(0.5), getCmap('viridis')(0.5));
  });

  it('getCmap passes through functions', () => {
    const fn = (t) => `rgb(${t},0,0)`;
    assert.equal(getCmap(fn), fn);
  });

  it('coolwarm diverges', () => {
    const cw = getCmap('coolwarm');
    const lo = cw(0).match(/rgb\((\d+),(\d+),(\d+)\)/);
    const hi = cw(1).match(/rgb\((\d+),(\d+),(\d+)\)/);
    // coolwarm: blue at 0, red at 1
    assert.ok(Number(lo[3]) > Number(lo[1])); // blue > red at 0
    assert.ok(Number(hi[1]) > Number(hi[3])); // red > blue at 1
  });

  it('turbo exists', () => {
    const t = getCmap('turbo');
    assert.ok(t(0.5).startsWith('rgb('));
  });

  it('cmapRgb convenience function', () => {
    assert.equal(cmapRgb('viridis', 0), getCmap('viridis')(0));
  });
});

// ==================== Format Parser ====================

describe('parseFormat', () => {
  it('parses color only', () => {
    assert.equal(parseFormat('r').color, '#ee4444');
    assert.equal(parseFormat('b').color, '#4488ff');
  });

  it('parses linestyle only', () => {
    assert.equal(parseFormat('-').linestyle, '-');
    assert.equal(parseFormat('--').linestyle, '--');
    assert.equal(parseFormat('-.').linestyle, '-.');
    assert.equal(parseFormat(':').linestyle, ':');
  });

  it('parses marker only', () => {
    assert.equal(parseFormat('o').marker, 'o');
    assert.equal(parseFormat('s').marker, 's');
    assert.equal(parseFormat('^').marker, '^');
    assert.equal(parseFormat('+').marker, '+');
  });

  it('parses color + linestyle', () => {
    const f = parseFormat('r--');
    assert.equal(f.color, '#ee4444');
    assert.equal(f.linestyle, '--');
  });

  it('parses color + linestyle + marker', () => {
    const f = parseFormat('r--o');
    assert.equal(f.color, '#ee4444');
    assert.equal(f.linestyle, '--');
    assert.equal(f.marker, 'o');
  });

  it('parses color + marker (no linestyle)', () => {
    const f = parseFormat('bo');
    assert.equal(f.color, '#4488ff');
    assert.equal(f.marker, 'o');
    assert.equal(f.linestyle, undefined);
  });

  it('parses linestyle + marker', () => {
    const f = parseFormat('-o');
    assert.equal(f.linestyle, '-');
    assert.equal(f.marker, 'o');
    assert.equal(f.color, undefined);
  });

  it('returns empty for null/undefined', () => {
    assert.deepEqual(parseFormat(null), {});
    assert.deepEqual(parseFormat(undefined), {});
  });
});

describe('dashArray', () => {
  it('solid returns empty', () => {
    assert.deepEqual(dashArray('-'), []);
  });

  it('dashed returns [6,4]', () => {
    assert.deepEqual(dashArray('--'), [6, 4]);
  });

  it('dotted returns [2,3]', () => {
    assert.deepEqual(dashArray(':'), [2, 3]);
  });

  it('dashdot returns correct', () => {
    assert.deepEqual(dashArray('-.'), [6, 2, 2, 2]);
  });
});

// ==================== Axes ====================

describe('Axes', () => {
  it('stores line traces', () => {
    const ax = new Axes();
    ax.plot([0, 1], [0, 1]);
    assert.equal(ax._traces.length, 1);
    assert.equal(ax._traces[0].type, 'line');
  });

  it('stores scatter traces', () => {
    const ax = new Axes();
    ax.scatter([0, 1], [0, 1], { c: 'red' });
    assert.equal(ax._traces.length, 1);
    assert.equal(ax._traces[0].type, 'scatter');
  });

  it('stores bar traces', () => {
    const ax = new Axes();
    ax.bar([1, 2, 3], [10, 20, 30]);
    assert.equal(ax._traces.length, 1);
    assert.equal(ax._traces[0].type, 'bar');
  });

  it('stores hist traces', () => {
    const ax = new Axes();
    ax.hist([1, 2, 3, 4, 5], { bins: 3 });
    assert.equal(ax._traces.length, 1);
    assert.equal(ax._traces[0].type, 'hist');
  });

  it('stores imshow traces', () => {
    const ax = new Axes();
    ax.imshow([1, 2, 3, 4], 2, 2, { cmap: 'viridis' });
    assert.equal(ax._traces.length, 1);
    assert.equal(ax._traces[0].type, 'imshow');
    assert.equal(ax._traces[0].nx, 2);
    assert.equal(ax._traces[0].ny, 2);
  });

  it('stores hline and vline', () => {
    const ax = new Axes();
    ax.axhline(5);
    ax.axvline(3);
    assert.equal(ax._traces.length, 2);
    assert.equal(ax._traces[0].type, 'hline');
    assert.equal(ax._traces[1].type, 'vline');
  });

  it('stores text annotations', () => {
    const ax = new Axes();
    ax.text(1, 2, 'hello');
    assert.equal(ax._traces[0].type, 'text');
    assert.equal(ax._traces[0].text, 'hello');
  });

  it('sets title/xlabel/ylabel', () => {
    const ax = new Axes();
    ax.set_title('Title');
    ax.set_xlabel('X');
    ax.set_ylabel('Y');
    assert.equal(ax._title.text, 'Title');
    assert.equal(ax._xlabel.text, 'X');
    assert.equal(ax._ylabel.text, 'Y');
  });

  it('sets xlim/ylim', () => {
    const ax = new Axes();
    ax.set_xlim(0, 100);
    ax.set_ylim(-5, 5);
    assert.deepEqual(ax._xlim, [0, 100]);
    assert.deepEqual(ax._ylim, [-5, 5]);
  });

  it('cycles default colors', () => {
    const ax = new Axes();
    ax.plot([0], [0]);
    ax.plot([0], [0]);
    assert.notEqual(ax._traces[0].opts.color, ax._traces[1].opts.color);
  });

  it('parses format strings in plot()', () => {
    const ax = new Axes();
    ax.plot([0, 1], [0, 1], 'r--o');
    const opts = ax._traces[0].opts;
    assert.equal(opts.color, '#ee4444');
    assert.equal(opts.linestyle, '--');
    assert.equal(opts.marker, 'o');
  });

  it('supports method chaining', () => {
    const ax = new Axes();
    const result = ax.plot([0], [0]).scatter([1], [1]).set_title('T').grid(true);
    assert.equal(result, ax);
    assert.equal(ax._traces.length, 2);
  });

  it('computes data extent for line', () => {
    const ax = new Axes();
    ax.plot([1, 2, 3], [10, 20, 30]);
    const [xlo, xhi] = ax._dataExtent('x');
    const [ylo, yhi] = ax._dataExtent('y');
    // with 5% padding
    assert.ok(xlo < 1);
    assert.ok(xhi > 3);
    assert.ok(ylo < 10);
    assert.ok(yhi > 30);
  });

  it('computes data extent for imshow', () => {
    const ax = new Axes();
    ax.imshow([1, 2, 3, 4, 5, 6], 3, 2);
    const [xlo, xhi] = ax._dataExtent('x');
    const [ylo, yhi] = ax._dataExtent('y');
    assert.equal(xlo, 0);
    assert.equal(xhi, 3);
    assert.equal(ylo, 0);
    assert.equal(yhi, 2);
  });

  it('hist bin computation', () => {
    const ax = new Axes();
    ax.hist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bins: 5 });
    const trace = ax._traces[0];
    const { bins } = ax._computeHistBins(trace);
    assert.equal(bins.length, 6); // 5 bins = 6 edges
    assert.equal(bins[0], 1);
    assert.equal(bins[5], 10);
  });

  it('hist count computation', () => {
    const ax = new Axes();
    ax.hist([1, 2, 3, 4, 5], { bins: [0, 2.5, 5.5] });
    const trace = ax._traces[0];
    const counts = ax._computeHistCounts(trace);
    assert.deepEqual(counts, [2, 3]); // [1,2] and [3,4,5]
  });

  it('barh stores traces', () => {
    const ax = new Axes();
    ax.barh([1, 2, 3], [10, 20, 30]);
    assert.equal(ax._traces[0].type, 'barh');
  });
});

// ==================== Figure ====================

describe('Figure', () => {
  it('creates correct number of axes', () => {
    const fig = new Figure(2, 3);
    assert.equal(fig.axes.length, 6);
    assert.equal(fig.nrows, 2);
    assert.equal(fig.ncols, 3);
  });

  it('uses default figsize', () => {
    const fig = new Figure();
    assert.equal(fig.width, 400);
    assert.equal(fig.height, 300);
  });

  it('respects custom figsize', () => {
    const fig = new Figure(1, 1, { figsize: [800, 600] });
    assert.equal(fig.width, 800);
    assert.equal(fig.height, 600);
  });

  it('suptitle stores text', () => {
    const fig = new Figure();
    fig.suptitle('Main Title');
    assert.equal(fig._suptitle.text, 'Main Title');
  });

  // show() needs a real DOM so we just test it doesn't throw in Node
  it('show returns null without DOM', () => {
    // temporarily remove document
    const origDoc = globalThis.document;
    globalThis.document = undefined;
    const fig = new Figure();
    assert.equal(fig.show(), null);
    globalThis.document = origDoc;
  });
});

// ==================== subplots API ====================

describe('subplots', () => {
  it('1x1 returns { fig, ax }', () => {
    const result = subplots();
    assert.ok(result.fig instanceof Figure);
    assert.ok(result.ax instanceof Axes);
    assert.equal(result.axes, undefined);
  });

  it('1x1 explicit returns { fig, ax }', () => {
    const result = subplots(1, 1);
    assert.ok(result.ax instanceof Axes);
  });

  it('1x2 returns { fig, axes }', () => {
    const result = subplots(1, 2);
    assert.ok(result.fig instanceof Figure);
    assert.ok(Array.isArray(result.axes));
    assert.equal(result.axes.length, 2);
  });

  it('2x2 returns { fig, axes }', () => {
    const result = subplots(2, 2);
    assert.equal(result.axes.length, 4);
  });

  it('passes opts to Figure', () => {
    const result = subplots(1, 1, { figsize: [600, 400] });
    assert.equal(result.fig.width, 600);
    assert.equal(result.fig.height, 400);
  });
});

// ==================== module exports ====================

describe('module exports', () => {
  it('exports subplots', () => {
    assert.equal(typeof subplots, 'function');
  });

  it('exports cmap', () => {
    assert.equal(typeof cmapFn, 'function');
    assert.ok(cmapFn('viridis')(0.5).startsWith('rgb('));
  });

  it('exports quick functions', () => {
    assert.equal(typeof plotFn, 'function');
    assert.equal(typeof scatterFn, 'function');
    assert.equal(typeof imshowFn, 'function');
    assert.equal(typeof histFn, 'function');
    assert.equal(typeof barFn, 'function');
  });
});

// ==================== Extension registration ====================

describe('extension registration', () => {
  it('registers plt on window._auditableExtensions', () => {
    assert.ok(window._auditableExtensions);
    assert.ok(window._auditableExtensions['plt']);
    assert.equal(typeof window._auditableExtensions['plt'].subplots, 'function');
  });
});
