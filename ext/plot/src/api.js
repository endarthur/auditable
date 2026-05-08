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

// register as auditable extension for adder `import plt`
if (typeof window !== 'undefined') {
  const _plt = { subplots, Figure, cmap, plot, scatter, imshow, hist, bar };
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
