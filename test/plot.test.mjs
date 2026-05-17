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

  it('2x2 returns nested 2D axes array (matches matplotlib)', () => {
    // Matplotlib: subplots(R, C) with R>1 AND C>1 returns a nested
    // (rows × cols) array so adder code can destructure literally:
    //   f, ((a, b), (c, d)) = plt.subplots(2, 2)
    const result = subplots(2, 2);
    assert.equal(result.axes.length, 2);
    assert.equal(result.axes[0].length, 2);
    assert.equal(result.axes[1].length, 2);
    // Underlying figure still has all four axes flat in fig.axes
    assert.equal(result.fig.axes.length, 4);
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

// ==================== Margin overrides & figure gap ====================

describe('axes margin override', () => {
  it('honors _margins when set (uniform-grid pattern)', () => {
    // Two cells with very different decorations should produce the SAME
    // plot area when both pin the same _margins. Sanity-test via the
    // background fillRect — `fillRect(plotX, plotY, plotW, plotH)`.
    function _captureBg(ax) {
      const captured = [];
      const ctx = {
        _fillStyle: null,
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {}, fill() {}, clip() {}, rect() {}, arc() {}, fillText() {},
        strokeRect() {}, measureText() { return { width: 0 }; },
        setLineDash() {}, translate() {}, rotate() {},
        get fillStyle() { return this._fillStyle; },
        set fillStyle(v) { this._fillStyle = v; },
        fillRect(x, y, w, h) { if (captured.length === 0) captured.push({ x, y, w, h }); },
        get globalAlpha() { return 1; }, set globalAlpha(_) {},
      };
      ax._render(ctx, { x: 0, y: 0, w: 200, h: 200 });
      return captured[0];
    }
    const a = new Axes();
    a.plot([0, 1, 2], [0, 1, 4]);
    a.set_xlabel('x'); a.set_ylabel('y'); // would expand margins
    a._margins = { left: 50, right: 4, top: 4, bottom: 36 };
    const b = new Axes();
    b.plot([0, 1, 2], [0, 1, 4]);
    b._hideXTicks = true; b._hideYTicks = true; // would shrink margins
    b._margins = { left: 50, right: 4, top: 4, bottom: 36 };
    const ra = _captureBg(a);
    const rb = _captureBg(b);
    assert.deepEqual({ x: rb.x, y: rb.y, w: rb.w, h: rb.h },
                     { x: ra.x, y: ra.y, w: ra.w, h: ra.h });
  });
});

describe('figure gap override', () => {
  it('opts.gap overrides default inter-subplot gap', () => {
    const f = new Figure(1, 2, { gap: 2 });
    assert.equal(f._gapX, 2);
    assert.equal(f._gapY, 2);
  });
  it('opts.wspace/hspace override independently', () => {
    const f = new Figure(2, 2, { wspace: 4, hspace: 8 });
    assert.equal(f._gapX, 4);
    assert.equal(f._gapY, 8);
  });
  it('defaults to 10', () => {
    const f = new Figure(2, 2);
    assert.equal(f._gapX, 10);
    assert.equal(f._gapY, 10);
  });
});

describe('figure-level edge labels', () => {
  it("rowLabels / colLabels default null (no gutter reserved)", () => {
    const f = new Figure(2, 2);
    assert.equal(f._rowLabels, null);
    assert.equal(f._colLabels, null);
  });
});

describe('matshow aspect=equal shrinks plot rect to square', () => {
  // The old behavior expanded the data range to fit the plot rect,
  // which painted bg stripes through the data area. The new behavior
  // shrinks the plot rect so cells render as squares.
  it('square data + non-square cell → square plot rect', () => {
    const ax = new Axes();
    ax.imshow(new Float64Array([1, 2, 3, 4]), 2, 2);
    // Capture first plot-area fillRect (the bgcolor fill).
    const captured = [];
    const ctx = {
      _fillStyle: null,
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() {}, fill() {}, clip() {}, rect() {}, arc() {}, fillText() {},
      strokeRect() {}, measureText() { return { width: 0 }; },
      setLineDash() {}, translate() {}, rotate() {},
      get fillStyle() { return this._fillStyle; },
      set fillStyle(v) { this._fillStyle = v; },
      fillRect(x, y, w, h) { if (captured.length === 0) captured.push({ x, y, w, h }); },
      get globalAlpha() { return 1; }, set globalAlpha(_) {},
    };
    // 300x200 cell with square 2x2 data — plot rect should be square,
    // not stretched to fill the 300x200 minus margins.
    ax._render(ctx, { x: 0, y: 0, w: 300, h: 200 });
    const r = captured[0];
    // After margins (42 left, 12 right, 8 top, 26 bottom):
    // available rect = 246 × 166. Square = 166 × 166.
    assert.equal(r.w, r.h, 'plot rect should be square');
  });
});

// ==================== Series-shaped input coercion ====================

describe('scatter/plot/bar accept Series-shaped inputs', () => {
  // A sadpan WrapperSeries has no .length — it only iterates via
  // Symbol.iterator. The renderer reads .length and indexes [i], so
  // without coercion at trace ingress the dot loop did nothing.
  function fakeSeries(values) {
    // Mimic the surface of sadpan WrapperSeries that _toArr cares
    // about: iterable, no .length, not a TypedArray.
    return {
      [Symbol.iterator]() { return values[Symbol.iterator](); },
    };
  }
  it('scatter coerces iterable-without-length to array', () => {
    const ax = new Axes();
    const series = fakeSeries([1, 2, 3, 4]);
    ax.scatter(series, series);
    const trace = ax._traces[0];
    assert.ok(Array.isArray(trace.x));
    assert.equal(trace.x.length, 4);
    assert.equal(trace.y[3], 4);
  });
  it('plot coerces iterable-without-length', () => {
    const ax = new Axes();
    ax.plot(fakeSeries([10, 20]), fakeSeries([1, 2]));
    const trace = ax._traces[0];
    assert.equal(trace.x.length, 2);
    assert.equal(trace.x[0], 10);
  });
  it('bar coerces iterable-without-length', () => {
    const ax = new Axes();
    ax.bar(fakeSeries([0, 1, 2]), fakeSeries([5, 4, 3]));
    const trace = ax._traces[0];
    assert.equal(trace.heights[1], 4);
  });
  it('scatter still accepts plain JS arrays', () => {
    const ax = new Axes();
    ax.scatter([1, 2, 3], [4, 5, 6]);
    assert.equal(ax._traces[0].x.length, 3);
  });
  it('edgecolors plural alias resolves to edgecolor', () => {
    const ax = new Axes();
    ax.scatter([1], [1], { edgecolors: 'black' });
    assert.equal(ax._traces[0].opts.edgecolor, 'black');
  });
});

// ==================== plt.colorbar ====================

describe('plt.colorbar', () => {
  it('sets _colorbar on the axes returned from ax.matshow', () => {
    // ax.matshow returns the axes (for chaining); plt.colorbar(im)
    // recognizes this and toggles _colorbar on that axes.
    const { ax } = apiModule.subplots();
    const im = ax.matshow([[1, 2], [3, 4]]);
    apiModule.colorbar(im);
    assert.equal(ax._colorbar, true);
  });

  it("honors opts.ax kwarg", () => {
    const { ax: a1 } = apiModule.subplots();
    const { ax: a2 } = apiModule.subplots();
    a2.imshow(new Float64Array([1, 2, 3, 4]), 2, 2);
    apiModule.colorbar(null, { ax: a2 });
    assert.equal(a2._colorbar, true);
    assert.equal(a1._colorbar, false);
  });

  it('falls back to current axes when im is missing', () => {
    const { ax } = apiModule.subplots();
    ax.imshow(new Float64Array([1, 2, 3, 4]), 2, 2);
    apiModule.colorbar();
    assert.equal(ax._colorbar, true);
  });
});

// ==================== Style palette ====================

const styleModule = await import('../ext/plot/src/style.js');
const { _style, setStyle } = styleModule;

describe('style palette', () => {
  it('starts dark (auditable-native)', () => {
    // Reset in case earlier tests mutated. Default is dark.
    setStyle('dark_background');
    assert.equal(_style.bgcolor, '#1a1a1a');
    assert.equal(_style.textColor, '#ccc');
  });

  it("style.use('default') switches to a light palette", () => {
    setStyle('default');
    assert.equal(_style.bgcolor, '#ffffff');
    assert.equal(_style.textColor, '#333333');
    // restore for following tests
    setStyle('dark_background');
  });

  it("style.use('classic') is treated as light", () => {
    setStyle('classic');
    assert.equal(_style.bgcolor, '#ffffff');
    setStyle('dark_background');
  });

  it('unknown style names leave the palette alone', () => {
    setStyle('default');
    setStyle('some-unknown-style');
    assert.equal(_style.bgcolor, '#ffffff'); // unchanged
    setStyle('dark_background');
  });

  it('Axes._render reads from the shared palette by default', () => {
    setStyle('default');
    const ax = new Axes();
    ax.plot([0, 1, 2], [0, 1, 4]);
    // Render to a stub ctx that captures the bg fillStyle.
    let bgFill = null;
    const ctx = {
      _fillStyle: null,
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() {}, fill() {}, clip() {}, rect() {}, arc() {}, fillText() {},
      strokeRect() {}, measureText() { return { width: 0 }; },
      setLineDash() {},
      get fillStyle() { return this._fillStyle; },
      set fillStyle(v) {
        // First fillRect call paints the plot bg; capture the fill set
        // immediately before. Simpler: capture every set; assert at end.
        this._fillStyle = v;
      },
      fillRect(x, y, w, h) {
        if (bgFill === null) bgFill = this._fillStyle;
      },
    };
    ax._render(ctx, { x: 0, y: 0, w: 100, h: 100 });
    assert.equal(bgFill, '#ffffff'); // light palette
    setStyle('dark_background');
  });
});
