// Public API — subplots() factory, quick one-liners, plt extension registration

import { Figure } from './figure.js';
import { getCmap } from './color.js';

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
  const nr = nrows || 1;
  const nc = ncols || 1;
  const fig = new Figure(nr, nc, opts);

  if (nr === 1 && nc === 1) {
    _setCurrent(fig, fig.axes[0]);
    // array for adder tuple unpacking, named props for JS destructuring
    return Object.assign([fig, fig.axes[0]], { fig, ax: fig.axes[0] });
  }
  _setCurrent(fig, fig.axes[0]);
  return Object.assign([fig, fig.axes], { fig, axes: fig.axes });
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
// plt.style.use(name) — no-op
export const style = { use(_name) { /* no-op */ }, available: [] };
// plt.figure(...) — return a fresh Figure (matplotlib's figure() takes
// figsize=(w,h) and other kwargs; we accept and ignore unsupported ones).
export function figure(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  return new Figure(1, 1, o);
}
// plt.show() — matplotlib renders all pending figures. In auditable, each
// Figure's .show() returns its canvas explicitly, so there's nothing pending.
// No-op keeps notebooks that end cells with `plt.show()` from erroring.
export function show() { /* no-op */ }
// plt.close(fig?) — close a figure (matplotlib reclaims its handle).
// We hold no figure registry, so no-op.
export function close(_fig) { /* no-op */ }

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

// register as auditable extension for adder `import plt`
if (typeof window !== 'undefined') {
  const _plt = {
    subplots, figure, Figure, cmap, plot, scatter, imshow, hist, bar,
    rc, rcParams, style, show, close,
    gca, gcf, xlabel, ylabel, title, xlim, ylim, xscale, yscale,
    legend, grid, vlines, hlines, axhline, axvline, text,
    subplots_adjust, tight_layout, savefig, clf, cla,
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
