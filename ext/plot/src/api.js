// Public API — subplots() factory, quick one-liners, plt extension registration

import { Figure } from './figure.js';
import { getCmap } from './color.js';
import { setStyle } from './style.js';

// matplotlib stateful interface — plt.xlabel/.ylim/.legend/etc. all
// operate on a global "current axes". subplots() and the _quick()
// wrappers update it. Cells running in sequence share the same
// _currentAx so a stateful sequence like
//   plt.hist(...)        # creates an axes, becomes current
//   plt.xlabel('x')      # sets xlabel on that axes
//   plt.vlines(...)      # adds vertical lines to that axes
// works the same as matplotlib.
let _currentFig = null;
let _currentAx = null;

function _setCurrent(fig, ax) { _currentFig = fig; _currentAx = ax; return ax; }

export function subplots(nrows, ncols, opts) {
  // Adder kwarg shapes that arrive here:
  //   plt.subplots()                          → ()
  //   plt.subplots(2, 3)                      → (2, 3)
  //   plt.subplots(figsize=(8,6))             → ({_kw, figsize}) — kwargs in arg 0
  //   plt.subplots(2, 3, figsize=(8,6))       → (2, 3, {_kw, figsize})
  //   plt.subplots(2, 3, sharex=True)         → (2, 3, {_kw, sharex})
  if (nrows && typeof nrows === 'object' && nrows._kw) {
    opts = nrows; nrows = undefined; ncols = undefined;
  } else if (ncols && typeof ncols === 'object' && ncols._kw) {
    opts = ncols; ncols = undefined;
  }
  const nr = nrows || 1;
  const nc = ncols || 1;
  const fig = new Figure(nr, nc, opts);

  if (nr === 1 && nc === 1) {
    _setCurrent(fig, fig.axes[0]);
    // array for adder tuple unpacking, named props for JS destructuring
    return Object.assign([fig, fig.axes[0]], { fig, ax: fig.axes[0] });
  }
  _setCurrent(fig, fig.axes[0]);
  // matplotlib's subplots returns axes as:
  //   nrows=1, ncols=K → flat 1D array [ax1, …, axK]
  //   nrows=R, ncols=1 → flat 1D array [ax1, …, axR]
  //   nrows=R, ncols=K → nested 2D array [[ax1,…,axK], [ax(K+1),…], …]
  // Adder code often destructures the 2D shape literally:
  //   f, ((a, b), (c, d), (e, f)) = plt.subplots(3, 2)
  // so flat-only would break those notebooks.
  let axesShape;
  if (nr === 1 || nc === 1) {
    axesShape = fig.axes.slice();
  } else {
    axesShape = [];
    for (let r = 0; r < nr; r++) {
      const row = [];
      for (let c = 0; c < nc; c++) row.push(fig.axes[r * nc + c]);
      axesShape.push(row);
    }
  }
  return Object.assign([fig, axesShape], { fig, axes: axesShape });
}

// quick one-liners — create figure, add trace, return canvas
function _quick(fn) {
  return function (...args) {
    const { fig, ax } = subplots();
    fn(ax, ...args);
    _setCurrent(fig, ax);
    return fig.show();
  };
}

export const plot = _quick((ax, x, y, fmtOrOpts, opts) => ax.plot(x, y, fmtOrOpts, opts));
export const scatter = _quick((ax, x, y, opts) => ax.scatter(x, y, opts));
export const imshow = _quick((ax, data, nx, ny, opts) => ax.imshow(data, nx, ny, opts));
export const bar = _quick((ax, x, heights, opts) => ax.bar(x, heights, opts));
export const cmap = getCmap;
// matplotlib's matshow renders a 2D matrix as an image with no axes
// inversion — effectively imshow with origin='upper'. We alias for
// the common df.corr().matshow pattern.
export const matshow = _quick((ax, data, nx, ny, opts) => ax.imshow(data, nx, ny, opts));

// plt.hist — matplotlib returns (counts, edges, patches). Adder cells
// destructure as `n, bins, patches = plt.hist(...)` or index as
// `result = plt.hist(...); n = result[0]`. We return an array-like
// with both index access and named getters (.counts/.edges/.canvas)
// so JS-side use is also ergonomic.
export function hist(data, opts) {
  const { fig, ax } = subplots();
  ax.hist(data, opts);
  // Compute the actual counts + edges that the trace will render with,
  // so the caller sees real values matching the drawn bars.
  const trace = ax._traces[ax._traces.length - 1];
  const { bins: edges } = ax._computeHistBins(trace);
  const counts = ax._computeHistCounts(trace);
  const canvas = fig.show();
  return Object.assign([counts, edges, canvas], {
    counts, edges, canvas,
  });
}

// matplotlib parity stubs — these are no-ops today but nearly every
// Jupyter notebook calls them at the top of cell 1 to configure global
// style. Stubbing keeps the import path running so notebooks proceed
// to the real plotting calls; actual rcParams threading through Figure
// construction is on the ROADMAP.
//
// plt.rc(group, **kwargs) — `plt.rc('font', size=14)`
export function rc(_group, _opts) { /* no-op */ }
// plt.rcParams — dict-like assignable bag. `plt.rcParams['figure.figsize'] = (8, 6)`
export const rcParams = {};
rcParams.update = function (obj) {
  if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) rcParams[k] = obj[k];
};
// plt.style.use(name) — switches the shared palette. Auditable-native
// default is dark; `plt.style.use('default')` (or 'classic' / a few
// common matplotlib-style names) flips to a light palette. Notebooks
// loaded from a .ipynb through @gcu/ipynb get this call injected
// automatically after `import matplotlib.pyplot as plt`.
export const style = {
  use(name) { setStyle(name); },
  available: ['default', 'classic', 'matplotlib', 'dark_background',
              'seaborn', 'seaborn-whitegrid', 'ggplot', 'bmh'],
};
// plt.figure(...) — return a fresh Figure (matplotlib's figure() takes
// figsize=(w,h) and other kwargs; we accept and ignore unsupported ones).
export function figure(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  return new Figure(1, 1, o);
}
// plt.show() — renders the current figure to a canvas and returns it.
// When `plt.show()` is the last expression of an adder cell, adder's
// display path picks up the canvas (via nodeType check) and renders.
// Matplotlib's pyplot also renders implicitly after each cell in
// %matplotlib inline; for now we require an explicit `plt.show()` as
// the trailing statement.
export function show() {
  if (!_currentFig) return null;
  return _currentFig.show();
}
// plt.close(fig?) — close a figure (matplotlib reclaims its handle).
// We hold no figure registry, so no-op.
export function close(_fig) { /* no-op */ }

// plt.subplot(nrows, ncols, index) — matplotlib's per-axes shortcut.
// Also accepts the 3-digit form `plt.subplot(311)` (sugar for 3,1,1).
// Returns the indexed axes and sets it as current. Distinct from
// `subplots(nrows, ncols)` which returns the full grid.
export function subplot(...args) {
  let nrows, ncols, index;
  if (args.length === 1 && typeof args[0] === 'number' && args[0] >= 111 && args[0] < 1000) {
    const n = args[0];
    nrows = Math.floor(n / 100);
    ncols = Math.floor((n / 10) % 10);
    index = n % 10;
  } else {
    nrows = args[0] || 1;
    ncols = args[1] || 1;
    index = args[2] || 1;
  }
  const sub = subplots(nrows, ncols);
  const ax = (sub.axes && sub.axes.length) ? sub.axes[index - 1] : sub.ax;
  _setCurrent(sub.fig, ax);
  return ax;
}

// plt.cm — matplotlib's colormap namespace. Each public name is a
// colormap function `(t in [0,1]) → 'rgb(r,g,b)'`. Notebooks reference
// these as `cmap = plt.cm.viridis`. We mirror the names we have in
// getCmap; unknown / dunder access returns undefined so adder's
// attribute probing (__adderClass__, __iter__, etc.) doesn't get
// fooled into thinking every name is a cmap.
const _CMAP_NAMES = [
  'viridis', 'coolwarm', 'turbo',
  'plasma', 'inferno', 'magma', 'cividis',
  'jet', 'gray', 'Greys', 'hot', 'cool',
  'spring', 'summer', 'autumn', 'winter',
  'viridis_r', 'plasma_r', 'inferno_r', 'magma_r', 'jet_r', 'gray_r',
];
export const cm = {};
for (const n of _CMAP_NAMES) {
  Object.defineProperty(cm, n, {
    get() { return getCmap(n); },
    enumerable: true,
  });
}
cm.get_cmap = getCmap;

// matplotlib stateful interface — module-level helpers that delegate to
// the current axes. Each lazily creates an axes if none exists yet, so
// `plt.title("x")` as the very first call still works (matches mpl).
function _ax() {
  if (!_currentAx) subplots();
  return _currentAx;
}
export function gca() { return _ax(); }
export function gcf() { if (!_currentFig) subplots(); return _currentFig; }
export function xlabel(text, opts) { _ax().set_xlabel(text, opts); }
export function ylabel(text, opts) { _ax().set_ylabel(text, opts); }
export function title(text, opts) { _ax().set_title(text, opts); }
export function xlim(lo, hi) { _ax().set_xlim(lo, hi); }
export function ylim(lo, hi) { _ax().set_ylim(lo, hi); }
export function xscale(scale) { _ax().set_xscale(scale); }
export function yscale(scale) { _ax().set_yscale(scale); }
export function legend(opts) { _ax().legend(opts); }
export function grid(on, opts) { _ax().grid(on, opts); }
export function vlines(x, ymin, ymax, opts) { _ax().vlines(x, ymin, ymax, opts); }
export function hlines(y, xmin, xmax, opts) { _ax().hlines(y, xmin, xmax, opts); }
export function axhline(y, opts) { _ax().axhline(y, opts); }
export function axvline(x, opts) { _ax().axvline(x, opts); }
export function text(x, y, s, opts) { _ax().text(x, y, s, opts); }
// matplotlib subplots_adjust controls figure margins (left/right/top/bottom/wspace/hspace).
// Canvas layout isn't margin-driven the same way; accept and discard.
export function subplots_adjust(_opts) { /* no-op */ }
export function tight_layout(_opts) { /* no-op */ }
export function savefig(filename) { return _currentFig && _currentFig.savefig(filename); }
export function clf() { _currentFig = null; _currentAx = null; }
export function cla() { _currentAx = null; }

// matplotlib's plt.xticks(ticks, labels) / yticks set tick positions
// and labels on the current axes. Our scale.ticks() drives ticks
// automatically — we accept and discard these calls (visual result
// uses our auto-ticks) so notebooks that call them don't error out.
// Real custom-tick support is on the ROADMAP.
export function xticks(_ticks, _labels) { /* no-op; ROADMAPed */ }
export function yticks(_ticks, _labels) { /* no-op; ROADMAPed */ }

// plt.colorbar(im, ax=None, **kwargs) — attach a colorbar to the axes
// that holds `im`. matplotlib's `im` is an AxesImage; since our
// ax.matshow/.imshow return the Axes itself (for chaining), `im` will
// usually BE the axes. We accept:
//   - an opts.ax kwarg pointing at a specific Axes
//   - any object with a `.colorbar` method (an Axes)
//   - any object with `.axes` pointing at an Axes (matplotlib-shape)
//   - falls back to the current axes
// Returns the axes (matplotlib returns a Colorbar object, but no
// caller in the GCU stack uses it as anything other than a side-
// effect call).
export function colorbar(im, opts) {
  // Adder kwargs land in the trailing arg; pull `ax` out.
  let ax = null;
  if (opts && typeof opts === 'object' && opts.ax) ax = opts.ax;
  else if (im && typeof im === 'object' && typeof im.colorbar === 'function') ax = im;
  else if (im && im.axes && typeof im.axes.colorbar === 'function') ax = im.axes;
  else ax = _ax();
  ax.colorbar(opts && typeof opts === 'object' ? opts : {});
  return ax;
}
// plt.suptitle — sets the figure-level title above all subplots.
// Delegates to the current figure's suptitle method.
export function suptitle(text, opts) {
  const fig = gcf();
  return fig && fig.suptitle ? fig.suptitle(text, opts) : null;
}

// register as auditable extension for adder `import plt`
if (typeof window !== 'undefined') {
  const _plt = {
    subplots, subplot, figure, Figure, cmap, cm, plot, scatter, imshow, matshow, hist, bar,
    rc, rcParams, style, show, close,
    gca, gcf, xlabel, ylabel, title, xlim, ylim, xscale, yscale,
    legend, grid, vlines, hlines, axhline, axvline, text,
    subplots_adjust, tight_layout, savefig, clf, cla,
    xticks, yticks, colorbar, suptitle,
  };
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/plot',
      version: '0.1.0',
      description: 'Canvas 2D plotting library \u2014 line, scatter, bar, hist, imshow',
      pluginUrl: '@gcu/plot',
      exports: { plt: _plt },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions['plt'] = _plt;
    if (window._auditablePlugins) {
      window._auditablePlugins.set('@gcu/plot', { description: 'Canvas 2D plotting library \u2014 line, scatter, bar, hist, imshow' });
    }
  }
}
