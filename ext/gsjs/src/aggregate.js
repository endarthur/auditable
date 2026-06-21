// @gcu/gsjs — CPU aggregations over realized block estimates.
//
// All bandwidth-bound reductions over the realized estimates. Every one masks
// by status: only STATUS.OK blocks contribute (no -999 / NaN sentinels to
// filter). Pure JS — this is the default backend AND the oracle a future
// WebGPU aggregation kernel validates against (see backend.js).
//
// These are the "cheap, frequently-changing" tail of the pipeline (binning /
// cutoffs are live-slider targets); the expensive stages (search, solve) sit
// upstream and cache. Spec: spec_inbox/gsjs-SPEC.md §"Aggregations".

import { STATUS } from './realize.js';

// Decompose a row-major block index into integer ijk (matches kt3d's layout:
// index = iz*nx*ny + iy*nx + ix).
function ijk(index, nx, ny) {
  const ix = index % nx;
  const iy = ((index - ix) / nx) % ny;
  const iz = (index - ix - iy * nx) / (nx * ny);
  return [ix, iy, iz];
}

// sum / mean / min / max over estimated blocks.
export function stats(est, status) {
  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < est.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    const v = est[i];
    n++; sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { n, sum, mean: n ? sum / n : NaN, min: n ? min : NaN, max: n ? max : NaN };
}

// Fixed-bin histogram. Bin edges are predetermined (min/max/nbins) so live
// updates reuse the same bins; auto-ranged from the data when omitted.
export function histogram(est, status, opts = {}) {
  const nbins = opts.nbins || 50;
  let { min, max } = opts;
  if (min == null || max == null) {
    const s = stats(est, status);
    if (min == null) min = s.min;
    if (max == null) max = s.max;
  }
  const counts = new Int32Array(nbins);
  const span = max - min;
  const scale = span > 0 ? nbins / span : 0;
  let n = 0;
  for (let i = 0; i < est.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    let b = scale ? Math.floor((est[i] - min) * scale) : 0;
    if (b < 0) b = 0; else if (b >= nbins) b = nbins - 1;
    counts[b]++; n++;
  }
  const edges = new Float64Array(nbins + 1);
  for (let k = 0; k <= nbins; k++) edges[k] = min + (span * k) / nbins;
  return { edges, counts, n, min, max };
}

// Swath plot: mean estimate (and count) per slice along one axis — the standard
// check that the estimate reproduces the data trend. `geom` is either a kriging
// result's `geom` ({ grid } for full-grid runs → one slice per grid layer, or
// { coords } for target runs → binned across the coordinate range). The kriging
// result carries `geom` directly, so call swath(est, r.status, r.geom, {axis}).
export function swath(est, status, geom, opts = {}) {
  const axis = opts.axis || 'x';
  const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;

  // Full grid, no override → exact per-layer (centres = layer coordinates).
  if (geom.grid && !opts.nbins) {
    const g = geom.grid;
    const { nx, ny } = g;
    const dim = ai === 0 ? g.nx : ai === 1 ? g.ny : g.nz;
    const mn = ai === 0 ? g.xmn : ai === 1 ? g.ymn : g.zmn;
    const siz = ai === 0 ? g.xsiz : ai === 1 ? g.ysiz : g.zsiz;
    const sum = new Float64Array(dim), count = new Int32Array(dim);
    for (let i = 0; i < est.length; i++) {
      if (status[i] !== STATUS.OK) continue;
      sum[ijk(i, nx, ny)[ai]] += est[i]; count[ijk(i, nx, ny)[ai]]++;
    }
    const centers = new Float64Array(dim), mean = new Float64Array(dim);
    for (let k = 0; k < dim; k++) { centers[k] = mn + k * siz; mean[k] = count[k] ? sum[k] / count[k] : NaN; }
    return { axis, centers, mean, count };
  }

  // Arbitrary targets → bin across the coordinate range.
  const coords = geom.coords;
  if (!coords) throw new Error('gsjs.swath: geom needs { grid } or { coords }');
  const nbins = opts.nbins || 20;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < est.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    const c = coords[i * 3 + ai];
    if (c < lo) lo = c; if (c > hi) hi = c;
  }
  const span = hi - lo, scale = span > 0 ? nbins / span : 0;
  const sum = new Float64Array(nbins), count = new Int32Array(nbins);
  for (let i = 0; i < est.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    let b = scale ? Math.floor((coords[i * 3 + ai] - lo) * scale) : 0;
    if (b < 0) b = 0; else if (b >= nbins) b = nbins - 1;
    sum[b] += est[i]; count[b]++;
  }
  const centers = new Float64Array(nbins), mean = new Float64Array(nbins);
  for (let k = 0; k < nbins; k++) { centers[k] = lo + span * (k + 0.5) / nbins; mean[k] = count[k] ? sum[k] / count[k] : NaN; }
  return { axis, centers, mean, count };
}

// Grade–tonnage curve: for each cutoff, the tonnage, contained metal, and mean
// grade of all OK blocks at or above it. Exact (CPU can afford the O(n·ncut)
// pass — the histogram-derived approximation is a GPU concern). blockTonnage is
// per-block mass (volume × density); default 1 → tonnage is block count.
export function gradeTonnage(est, status, opts = {}) {
  const cutoffs = opts.cutoffs || [0];
  const t = opts.blockTonnage != null ? opts.blockTonnage : 1;
  const tonnage = new Float64Array(cutoffs.length);
  const metal = new Float64Array(cutoffs.length);
  const grade = new Float64Array(cutoffs.length);
  for (let c = 0; c < cutoffs.length; c++) {
    const cut = cutoffs[c];
    let ton = 0, met = 0;
    for (let i = 0; i < est.length; i++) {
      if (status[i] !== STATUS.OK) continue;
      if (est[i] >= cut) { ton += t; met += est[i] * t; }
    }
    tonnage[c] = ton;
    metal[c] = met;
    grade[c] = ton > 0 ? met / ton : NaN;
  }
  return { cutoffs: Float64Array.from(cutoffs), tonnage, metal, grade };
}
