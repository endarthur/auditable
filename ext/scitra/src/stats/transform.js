// Statistical transforms — normal score, Box-Cox, Yeo-Johnson.
//
// normal_score_transform converts samples to standard-normal scores by
// rank → plotting position → inverse normal CDF. The shape (tie handling,
// plotting position, tail extrapolation, BDL replacement) follows GSLIB
// conventions used in mining geology, parameterized via opts.
//
// Returns { y, table, inverse } where:
//   y         — Float64Array of standard-normal scores aligned with input
//   table     — { x_sorted, y_sorted, w_sorted } the lookup used internally
//   inverse   — callable that maps standard-normal scores back to the
//               original-units distribution (for backtransforming
//               simulation results)

import { ndtri } from '../util/special.js';
import { makeRng } from '../util/random.js';

function _toF64(x) {
  if (x instanceof Float64Array) return x;
  if (x && x.data instanceof Float64Array) return x.data;
  if (Array.isArray(x) || ArrayBuffer.isView(x)) return Float64Array.from(x);
  throw new TypeError('expected array, Float64Array, or ndarray');
}

// Plotting positions: rank i (1-indexed) of n becomes a probability p in (0, 1).
// Standard formulas, all of shape (i - a) / (n + 1 - 2a) for some a:
//   hazen   a = 0.5  → (i - 0.5) / n        [mining default]
//   blom    a = 3/8  → (i - 3/8) / (n + 1/4)
//   tukey   a = 1/3  → (i - 1/3) / (n + 1/3)
//   weibull a = 0    → i / (n + 1)
const _PLOT_POS_A = { hazen: 0.5, blom: 0.375, tukey: 1/3, weibull: 0 };

function _plottingPosition(i, n, name) {
  const a = _PLOT_POS_A[name];
  if (a === undefined) throw new Error(`unknown plot_pos: ${name}`);
  return (i + 1 - a) / (n + 1 - 2 * a);  // i is 0-indexed → use i+1
}

// Tail extrapolation models for the inverse table at p < F[0] or p > F[n-1].
// Returns the extrapolated value in original units.
function _extrapTail(p, F, vals, model, opts) {
  const lower = p < F[0];
  if (model === 'linear') {
    // Linear in p → x via local slope at the endpoint.
    if (lower) {
      // Slope between (F[0], vals[0]) and (F[1], vals[1])
      if (F.length < 2) return vals[0];
      const slope = (vals[1] - vals[0]) / (F[1] - F[0]);
      // Extrapolate to p, but clip to a user-supplied minimum.
      const xMin = opts.tail_min ?? -Infinity;
      const x = vals[0] + slope * (p - F[0]);
      return Math.max(x, xMin);
    } else {
      const n = F.length;
      if (n < 2) return vals[n - 1];
      const slope = (vals[n - 1] - vals[n - 2]) / (F[n - 1] - F[n - 2]);
      const xMax = opts.tail_max ?? Infinity;
      const x = vals[n - 1] + slope * (p - F[n - 1]);
      return Math.min(x, xMax);
    }
  }
  if (model === 'power') {
    // Heavy-tail extrapolation: x ∝ -log(1-p)^α for upper tail. Rare in
    // mining; supported with a user-supplied alpha (default 1.5).
    const alpha = opts.tail_alpha ?? 1.5;
    if (lower) {
      const xMin = opts.tail_min ?? 0;
      const last = vals[0];
      const lastP = F[0];
      const ratio = (-Math.log(1 - p)) / (-Math.log(1 - lastP));
      return xMin + (last - xMin) * Math.pow(ratio, 1 / alpha);
    } else {
      const xMax = opts.tail_max ?? Infinity;
      const n = F.length;
      const last = vals[n - 1];
      const lastP = F[n - 1];
      // Scaled tail decay
      const ratio = (-Math.log(1 - p)) / (-Math.log(1 - lastP));
      const x = last + (xMax - last) * (1 - 1 / Math.pow(ratio, 1 / alpha));
      return Math.min(Math.max(x, last), xMax);
    }
  }
  if (model === 'hyperbolic') {
    // Hyperbolic tail (Krige-Roby style for heavily-skewed assay data).
    // Implemented as a special case of power with alpha=1 unless overridden.
    return _extrapTail(p, F, vals, 'power',
      { ...opts, tail_alpha: opts.tail_alpha ?? 1.0 });
  }
  if (lower) return vals[0];
  return vals[F.length - 1];
}

// Tie handling — resolves duplicate x values when assigning ranks.
//   midpoint — all duplicates get the average rank (default; matches
//              GSLIB and most published kriging code)
//   jitter   — add a tiny random nudge to break ties
//   random   — randomize the order within tied groups
function _resolveTies(xs, mode, rng) {
  const n = xs.length;
  // Stable sort indices by xs.
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => xs[a] - xs[b]);
  if (mode === 'jitter') {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = xs[i] + (rng() - 0.5) * 1e-12;
    }
    // Re-sort with jitter applied.
    idx.sort((a, b) => out[a] - out[b]);
    return idx;
  }
  if (mode === 'random') {
    // Group consecutive ties, shuffle each group.
    let i = 0;
    while (i < n) {
      let j = i + 1;
      while (j < n && xs[idx[j]] === xs[idx[i]]) j++;
      // Fisher-Yates shuffle of idx[i..j)
      for (let k = j - 1; k > i; k--) {
        const r = i + Math.floor(rng() * (k - i + 1));
        const t = idx[k]; idx[k] = idx[r]; idx[r] = t;
      }
      i = j;
    }
    return idx;
  }
  // 'midpoint' — return idx as-is, ranks computed via averaging below
  return idx;
}

// Average ranks for ties: each tied group gets the same rank, equal to
// the average of the ranks they would have received.
function _averageRanks(idx, xs) {
  const n = idx.length;
  const ranks = new Float64Array(n);  // ranks aligned to idx-order, 0-indexed
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && xs[idx[j]] === xs[idx[i]]) j++;
    // average rank of group [i, j) in 0-indexed is (i + j - 1) / 2
    const avg = (i + j - 1) / 2;
    for (let k = i; k < j; k++) ranks[k] = avg;
    i = j;
  }
  return ranks;
}

export function normal_score_transform(x, opts = {}) {
  const xa = _toF64(x);
  const w = opts.weights ? _toF64(opts.weights) : null;
  if (w && w.length !== xa.length) {
    throw new RangeError('weights length must match x length');
  }
  const tieMode = opts.tie || 'midpoint';
  const plotPos = opts.plot_pos || 'hazen';
  const tail = opts.tail || 'linear';
  const rng = makeRng(opts.random_state ?? null);

  // BDL (below-detection-limit) handling — replace values <= bdl.value with
  // either bdl.value/2 or bdl.value*fraction, before transform. Matches
  // GSLIB's BDL convention.
  let xs = xa;
  if (opts.bdl && opts.bdl.value !== undefined) {
    const v = opts.bdl.value;
    const replace = opts.bdl.replace || 'half';
    const replacement =
      replace === 'half' ? v / 2 :
      replace === 'fraction' ? v * (opts.bdl.fraction ?? 0.5) :
      replace;
    xs = new Float64Array(xa.length);
    for (let i = 0; i < xa.length; i++) {
      xs[i] = xa[i] <= v ? replacement : xa[i];
    }
  }

  // Sort indices, handle ties
  const idx = _resolveTies(xs, tieMode, rng);
  const n = xs.length;

  // Compute weighted plotting positions if weights given, else uniform.
  const F = new Float64Array(n);
  if (w) {
    let totalW = 0;
    for (let i = 0; i < n; i++) totalW += w[i];
    let cum = 0;
    for (let k = 0; k < n; k++) {
      // midpoint of k-th sample's weight contribution
      const wi = w[idx[k]];
      cum += wi;
      F[k] = (cum - 0.5 * wi) / totalW;  // hazen-like for weighted
    }
  } else {
    if (tieMode === 'midpoint') {
      // Average-rank-based plotting positions
      const ranks = _averageRanks(idx, xs);
      for (let k = 0; k < n; k++) {
        F[k] = _plottingPosition(ranks[k], n, plotPos);
      }
    } else {
      for (let k = 0; k < n; k++) {
        F[k] = _plottingPosition(k, n, plotPos);
      }
    }
  }

  // Build forward result: y[i] = ndtri(F at sorted-position-of-i)
  const y = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    y[idx[k]] = ndtri(F[k]);
  }

  // Build the lookup table for inverse: x_sorted ↔ F (and its derived y).
  const x_sorted = new Float64Array(n);
  const y_sorted = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    x_sorted[k] = xs[idx[k]];
    y_sorted[k] = ndtri(F[k]);
  }

  const inverse = (yQuery) => {
    if (typeof yQuery === 'number') return _invOne(yQuery, x_sorted, y_sorted, F, tail, opts);
    const ya = _toF64(yQuery);
    const out = new Float64Array(ya.length);
    for (let i = 0; i < ya.length; i++) {
      out[i] = _invOne(ya[i], x_sorted, y_sorted, F, tail, opts);
    }
    return out;
  };

  return {
    y,
    table: { x_sorted, y_sorted, F },
    inverse,
  };
}

// Inverse a single y: convert to p via Φ, look up in F, interpolate x_sorted.
function _invOne(yq, x_sorted, y_sorted, F, tail, opts) {
  const n = x_sorted.length;
  if (n === 0) return NaN;
  // Convert y to p (cdf of standard normal) — but it's faster to find by
  // y_sorted directly since that's monotone.
  // Find first y_sorted[k] >= yq
  let lo = 0, hi = n - 1;
  // Exact-endpoint cases bypass tail extrapolation (otherwise the local
  // erf approximation would inject ~1.5e-7 of error into clean roundtrips).
  if (yq === y_sorted[0]) return x_sorted[0];
  if (yq === y_sorted[n - 1]) return x_sorted[n - 1];
  if (yq < y_sorted[0]) {
    const p = 0.5 * (1 + _erfApprox(yq / Math.SQRT2));
    return _extrapTail(p, F, x_sorted, tail, opts);
  }
  if (yq > y_sorted[n - 1]) {
    const p = 0.5 * (1 + _erfApprox(yq / Math.SQRT2));
    return _extrapTail(p, F, x_sorted, tail, opts);
  }
  // Binary search for the bracketing pair
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (y_sorted[mid] <= yq) lo = mid; else hi = mid;
  }
  // Linear interpolate in (y_sorted[lo], y_sorted[lo+1])
  const dy = y_sorted[lo + 1] - y_sorted[lo];
  if (dy === 0) return x_sorted[lo];
  const t = (yq - y_sorted[lo]) / dy;
  return x_sorted[lo] + t * (x_sorted[lo + 1] - x_sorted[lo]);
}

// Local copy of erf (we don't want a circular import on special.js by way
// of distributions; this is fine here since we just need the standard form
// for the rare extrapolation lookup).
function _erfApprox(x) {
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y = 1.0 - (((((
        1.061405429  * t
      - 1.453152027) * t
      + 1.421413741) * t
      - 0.284496736) * t
      + 0.254829592) * t) * Math.exp(-ax * ax);
  return sign * y;
}
