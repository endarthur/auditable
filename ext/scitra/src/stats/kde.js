// 1D Gaussian kernel density estimation.
//
// Mirrors scipy.stats.gaussian_kde for univariate data. v0.1 ships 1D only;
// multivariate is on the roadmap (~50 LOC for diagonal bandwidth).
//
// Bandwidth selection:
//   'scott'      h = n^(-1/5) * sigma             [scipy default]
//   'silverman'  h = (n*3/4)^(-1/5) * sigma       [Silverman's rule of thumb]
//   <number>     fixed bandwidth in data units (sigma * factor for scipy parity)
//   <function>   custom bandwidth callable: fn(kde) → factor  (scipy parity)
//
// In scipy parity mode, the bandwidth is `factor * sigma` where `factor`
// comes from one of the rules above. We follow that convention so that
// passing 'scott' or 'silverman' here produces identical numbers.

import { ndtri } from '../util/special.js';

function _toF64(x) {
  if (x instanceof Float64Array) return x;
  if (x && x.data instanceof Float64Array) return x.data;
  if (Array.isArray(x) || ArrayBuffer.isView(x)) return Float64Array.from(x);
  throw new TypeError('expected array, Float64Array, or ndarray');
}

function _stdDev(xs, weights) {
  const n = xs.length;
  if (!weights) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[i];
    const m = s / n;
    let ss = 0;
    for (let i = 0; i < n; i++) { const d = xs[i] - m; ss += d * d; }
    return Math.sqrt(ss / (n - 1));  // ddof=1, matches scipy
  }
  let sw = 0, sx = 0;
  for (let i = 0; i < n; i++) { sw += weights[i]; sx += weights[i] * xs[i]; }
  const m = sx / sw;
  let ss = 0, sw2 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    ss += weights[i] * d * d;
    sw2 += weights[i] * weights[i];
  }
  // Bessel-style correction for weighted variance (matches scipy's _neff
  // adjustment with reliability weights).
  const neff = (sw * sw) / sw2;
  return Math.sqrt(ss / sw * neff / (neff - 1));
}

const _NORM_CONST_1D = 1 / Math.sqrt(2 * Math.PI);

export function gaussian_kde(dataset, opts = {}) {
  const xs = _toF64(dataset);
  const n = xs.length;
  if (n < 2) {
    throw new Error('gaussian_kde requires at least 2 data points');
  }
  const weights = opts.weights ? _toF64(opts.weights) : null;
  if (weights) {
    if (weights.length !== n) throw new RangeError('weights length mismatch');
    let sum = 0;
    for (let i = 0; i < n; i++) sum += weights[i];
    if (sum === 0) throw new Error('weights sum to zero');
    // Normalize weights to sum to 1 (scipy convention).
    const norm = 1 / sum;
    const w2 = new Float64Array(n);
    for (let i = 0; i < n; i++) w2[i] = weights[i] * norm;
    return _build(xs, w2, opts);
  }
  return _build(xs, null, opts);
}

function _build(xs, weights, opts) {
  const n = xs.length;
  // Effective sample size: n for unweighted, 1/sum(w²) for weighted (after
  // weights have been normalized to sum to 1). Matches scipy's neff.
  let neff = n;
  if (weights) {
    let s2 = 0;
    for (let i = 0; i < n; i++) s2 += weights[i] * weights[i];
    neff = 1 / s2;
  }

  const sigma = _stdDev(xs, weights);
  const bwMethod = opts.bw_method ?? 'scott';
  let factor;
  if (bwMethod === 'scott') {
    factor = Math.pow(neff, -1 / 5);
  } else if (bwMethod === 'silverman') {
    factor = Math.pow(neff * 3 / 4, -1 / 5);
  } else if (typeof bwMethod === 'number') {
    factor = bwMethod;  // fixed scalar factor (sigma multiplier)
  } else if (typeof bwMethod === 'function') {
    factor = bwMethod({ n, neff, sigma, dataset: xs });
  } else {
    throw new Error(`unknown bw_method: ${bwMethod}`);
  }
  const h = factor * sigma;
  if (!(h > 0)) throw new Error('bandwidth resolved to non-positive value');

  // Precompute reciprocal for hot loops.
  const inv2h2 = 1 / (2 * h * h);
  const norm = _NORM_CONST_1D / h;

  function pdf(points) {
    if (typeof points === 'number') return _pdfOne(points);
    const pa = _toF64(points);
    const out = new Float64Array(pa.length);
    for (let i = 0; i < pa.length; i++) out[i] = _pdfOne(pa[i]);
    return out;
  }

  function _pdfOne(x) {
    let s = 0;
    if (weights) {
      for (let i = 0; i < n; i++) {
        const d = x - xs[i];
        s += weights[i] * Math.exp(-d * d * inv2h2);
      }
      return norm * s;
    }
    for (let i = 0; i < n; i++) {
      const d = x - xs[i];
      s += Math.exp(-d * d * inv2h2);
    }
    return (norm / n) * s;
  }

  // logpdf — implemented as log(pdf) for v0.1. Numerically stable
  // log-sum-exp can land in v0.2 if a use case demands it.
  function logpdf(points) {
    const p = pdf(points);
    if (typeof p === 'number') return Math.log(p);
    const out = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = Math.log(p[i]);
    return out;
  }

  // CDF via trapezoidal rule on a fine grid covering ±5h around the data.
  function cdf(points) {
    if (typeof points === 'number') return _cdfOne(points);
    const pa = _toF64(points);
    const out = new Float64Array(pa.length);
    for (let i = 0; i < pa.length; i++) out[i] = _cdfOne(pa[i]);
    return out;
  }

  function _cdfOne(x) {
    // Closed form: each kernel is a normal CDF; sum the contributions.
    // CDF_i(x) = Φ((x - xs[i]) / h)
    let s = 0;
    if (weights) {
      for (let i = 0; i < n; i++) s += weights[i] * _Phi((x - xs[i]) / h);
      return s;
    }
    for (let i = 0; i < n; i++) s += _Phi((x - xs[i]) / h);
    return s / n;
  }

  function resample(size, opts2 = {}) {
    const m = size ?? n;
    const out = new Float64Array(m);
    const rng = opts2.random_state !== undefined
      ? _mulberry32(opts2.random_state)
      : Math.random;
    // Sample-with-replacement-then-jitter — Marsaglia polar for the gaussian.
    let cached = NaN;
    const norm01 = () => {
      if (!Number.isNaN(cached)) { const v = cached; cached = NaN; return v; }
      let u, v, s;
      do {
        u = 2 * rng() - 1;
        v = 2 * rng() - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const f = Math.sqrt(-2 * Math.log(s) / s);
      cached = v * f;
      return u * f;
    };
    if (weights) {
      // Build cumulative for weighted sampling
      const cum = new Float64Array(n);
      let c = 0;
      for (let i = 0; i < n; i++) { c += weights[i]; cum[i] = c; }
      for (let k = 0; k < m; k++) {
        const r = rng() * c;
        // Binary search for insertion
        let lo = 0, hi = n;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] < r) lo = mid + 1; else hi = mid;
        }
        out[k] = xs[Math.min(lo, n - 1)] + h * norm01();
      }
    } else {
      for (let k = 0; k < m; k++) {
        const i = Math.floor(rng() * n);
        out[k] = xs[Math.min(i, n - 1)] + h * norm01();
      }
    }
    return out;
  }

  return {
    pdf,
    logpdf,
    cdf,
    resample,
    evaluate: pdf,        // scipy alias
    factor,               // bandwidth factor
    bandwidth: h,         // bandwidth in data units (sigma * factor)
    n,
    neff,
    dataset: xs,
    weights,
  };
}

// Standard normal CDF — uses our local erf approximation. Accuracy ~1.5e-7
// is fine for KDE work (the kernel sum dominates error budget anyway).
function _Phi(z) {
  return 0.5 * (1 + _erfApprox(z / Math.SQRT2));
}

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

// mulberry32 for deterministic resample. Inlined to avoid pulling random.js
// circularly through this module's public surface.
function _mulberry32(seed) {
  let s = (seed | 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Suppress unused import warning in some bundlers — ndtri may be useful
// in a future quantile() addition.
void ndtri;
