// @gcu/scitra — adder cell bridge.
//
// Registers as `scitra` under `_auditableExtensions`. Adder cells can
// write scipy-shaped imports after a one-line namespace edit
// (`s/scipy/scitra/`) — the ipynb bridge does the rewrite automatically:
//
//   from scitra.stats import norm
//   from scitra.spatial import KDTree
//   from scitra.spatial.distance import cdist, pdist, squareform
//   from scitra.optimize import least_squares, curve_fit
//   from scitra.special import erf, gamma
//
// adder's import machinery walks the dotted path through namespace
// objects, all of which are plain JS objects on _module — same pattern
// as @gcu/learn's bridge.
//
// No static `import * as _scitra from './index.js'` — in the browser this
// module runs from a blob URL where relative imports don't resolve.
// Mirrors natra/adder.js + learn/adder.js: in browser, pick up the
// bundle from window._importCache; in Node tests, fall back to a
// dynamic relative import.

let _scitra;
if (typeof window !== 'undefined' && window._importCache) {
  _scitra = window._importCache['@gcu/scitra']
    || Object.values(window._importCache).find(m => m && m.stats && m.spatial && m.optimize);
  if (!_scitra) {
    throw new Error('@gcu/scitra not loaded — call load("@gcu/scitra") first');
  }
} else {
  _scitra = await import('./index.js');
}

const _module = {
  // ── submodules (scipy-shape namespaces) ──
  stats: _scitra.stats,
  spatial: _scitra.spatial,
  optimize: _scitra.optimize,
  special: _scitra.special,
  random: _scitra.random,

  // ── top-level conveniences (rarely used directly, but mirror what
  // scitra/index.js re-exports flat for ergonomic JS use) ──
  KDTree: _scitra.KDTree,
  gaussian_kde: _scitra.gaussian_kde,
  curve_fit: _scitra.curve_fit,
  least_squares: _scitra.least_squares,
};

// ── Registration ──
// Auditable's manifest API is preferred; fall back to the legacy slot
// for older runtimes (matches sadpan / learn / natra).
if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/scitra',
      version: '0.1.0',
      description: 'scipy-shaped primitives for adder cells',
      exports: { scitra: _module },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions['scitra'] = _module;
  }
}

export { _module as scitraAdder };
