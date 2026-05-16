// Public API — subplots() factory, quick one-liners, plt extension registration

import { Figure } from './figure.js';
import { getCmap } from './color.js';

export function subplots(nrows, ncols, opts) {
  const nr = nrows || 1;
  const nc = ncols || 1;
  const fig = new Figure(nr, nc, opts);

  if (nr === 1 && nc === 1) {
    // array for adder tuple unpacking, named props for JS destructuring
    return Object.assign([fig, fig.axes[0]], { fig, ax: fig.axes[0] });
  }
  return Object.assign([fig, fig.axes], { fig, axes: fig.axes });
}

// quick one-liners — create figure, add trace, return canvas
function _quick(fn) {
  return function (...args) {
    const { fig, ax } = subplots();
    fn(ax, ...args);
    return fig.show();
  };
}

export const plot = _quick((ax, x, y, fmtOrOpts, opts) => ax.plot(x, y, fmtOrOpts, opts));
export const scatter = _quick((ax, x, y, opts) => ax.scatter(x, y, opts));
export const imshow = _quick((ax, data, nx, ny, opts) => ax.imshow(data, nx, ny, opts));
export const hist = _quick((ax, data, opts) => ax.hist(data, opts));
export const bar = _quick((ax, x, heights, opts) => ax.bar(x, heights, opts));
export const cmap = getCmap;

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

// register as auditable extension for adder `import plt`
if (typeof window !== 'undefined') {
  const _plt = {
    subplots, figure, Figure, cmap, plot, scatter, imshow, hist, bar,
    rc, rcParams, style, show, close,
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
