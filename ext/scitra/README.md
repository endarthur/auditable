# @gcu/scitra

**scipy-shaped scientific computing primitives for the browser.** Statistical distributions, KDE, spatial indices, optimization, special functions, RNG — all pure JS + atra-compiled Wasm kernels where it pays.

Companion to [@gcu/natra](https://www.npmjs.com/package/@gcu/natra) (numpy-shape arrays) and [@gcu/line](https://www.npmjs.com/package/@gcu/line) (BLAS-shape linear algebra). Where natra is "arrays" and line is "matrix factorizations," scitra is the higher-level statistical / spatial / optimisation primitives that real-world geoscience code reaches for.

Part of [Auditable](https://github.com/gentropic/auditable). Architecture, scoring rationale, and module reference at [SPEC.md](./SPEC.md).

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/scitra @gcu/natra @gcu/line
```

`@gcu/natra` and `@gcu/line` are peer deps; you can install only the bits you exercise.

## Usage

```js
import { stats, spatial, optimize } from '@gcu/scitra';

// Distributions — pdf/cdf/ppf/rvs/fit, scipy-shaped.
stats.norm.cdf(1.96);                  // ≈ 0.975
stats.norm.ppf(0.975);                 // ≈ 1.959

// Weighted descriptives + normal-score transform.
stats.percentile([1, 2, 3, 4, 5], 0.5);
stats.normal_score_transform(grades, { weights });

// Kernel density estimate.
const kde = stats.gaussian_kde(samples);
kde.evaluate(query_points);

// Spatial — KD-tree with anisotropic search, distance matrices.
const tree = new spatial.KDTree(points);
tree.queryRadius([0, 0, 0], { r: 100, anisotropy: [1, 1, 0.5] });

// Optimization — least squares + curve fitting.
const { params, residuals } = optimize.least_squares(A, b);
optimize.curve_fit(model, x, y, initialGuess);
```

## What's implemented

| Module | Scope |
|---|---|
| `stats` | Distributions (`norm`, `lognorm`, `t`), descriptives (mean / var / percentile / ECDF), KDE, normal-score transform, weighted statistics |
| `spatial` | KD-tree (anisotropic, octant constraints), distance matrices (`cdist`, `pdist`, `squareform`) |
| `optimize` | `least_squares`, `curve_fit` (Levenberg-Marquardt) |
| `special` | `erf`, `erfc`, `erfinv`, `ndtri`, `lgamma`, `gamma`, `lbeta` |
| `random` | `mulberry32`, normal samplers |

Per-module sub-path imports work: `@gcu/scitra/stats`, `@gcu/scitra/spatial`, etc.

## Backend

`scitra.setBackend(natra)` swaps in [@gcu/natra](https://www.npmjs.com/package/@gcu/natra) for the matrix-heavy operations (matmul beyond ~256×256, factorizations). Below the threshold (or without a backend), pure-JS paths handle the work — most calls don't need the backend at all.

## What's not supported yet

The SPEC outlines the full scipy-shaped roadmap. Currently in flight: `interpolate`, `integrate`, `ndimage`, `fft`. Open an issue if a specific scipy primitive is blocking you — adding individual functions is usually a few hours of work.

## Status

Pre-1.0. 134 tests at last count. Ships inside Auditable for geoscientific notebook code; usable standalone anywhere ESM runs.

## License

MIT.
