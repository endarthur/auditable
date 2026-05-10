// Weighted descriptive statistics.
//
// All functions accept (x, w?, opts?) where w defaults to uniform.
// NaN handling is opt-in via opts.nan: 'omit' (default) | 'propagate' | 'raise'.
//
// Weights are interpreted as frequency weights — the effective sample
// size is sum(w), and ddof reduces that for unbiased variance. This
// matches numpy.cov(weights=...) and scipy.stats.DescrStatsW conventions.
//
// Inputs duck-type natra/vec ndarrays via `.data`.

function _toF64(x) {
  if (x instanceof Float64Array) return x;
  if (x && x.data instanceof Float64Array) return x.data;
  if (Array.isArray(x) || ArrayBuffer.isView(x)) return Float64Array.from(x);
  throw new TypeError('expected array, Float64Array, or ndarray');
}

// Drop-NaN: returns aligned (x', w') where any NaN in x[i] OR w[i] removes
// the pair. For 'propagate', returns null. For 'raise', throws.
function _handleNaN(x, w, mode) {
  if (mode === 'propagate') {
    for (let i = 0; i < x.length; i++) {
      if (Number.isNaN(x[i]) || (w && Number.isNaN(w[i]))) return null;
    }
    return { x, w };
  }
  if (mode === 'raise') {
    for (let i = 0; i < x.length; i++) {
      if (Number.isNaN(x[i]) || (w && Number.isNaN(w[i]))) {
        throw new Error('NaN in input (mode = "raise")');
      }
    }
    return { x, w };
  }
  // 'omit' — filter aligned NaNs.
  const keep = new Uint8Array(x.length);
  let nKeep = 0;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isNaN(x[i]) && (!w || !Number.isNaN(w[i]))) {
      keep[i] = 1; nKeep++;
    }
  }
  if (nKeep === x.length) return { x, w };
  const xc = new Float64Array(nKeep);
  const wc = w ? new Float64Array(nKeep) : null;
  for (let i = 0, k = 0; i < x.length; i++) {
    if (keep[i]) {
      xc[k] = x[i];
      if (wc) wc[k] = w[i];
      k++;
    }
  }
  return { x: xc, w: wc };
}

function _prep(x, w, opts) {
  const nan = (opts && opts.nan) || 'omit';
  const xa = _toF64(x);
  let wa = null;
  if (w !== undefined && w !== null) {
    wa = _toF64(w);
    if (wa.length !== xa.length) {
      throw new RangeError(`weight length ${wa.length} != value length ${xa.length}`);
    }
  }
  return _handleNaN(xa, wa, nan);
}

// ── moments ─────────────────────────────────────────────────────────

export function weighted_mean(x, w, opts) {
  const r = _prep(x, w, opts);
  if (!r) return NaN;
  const xa = r.x, wa = r.w;
  const n = xa.length;
  if (n === 0) return NaN;
  if (!wa) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xa[i];
    return s / n;
  }
  let sx = 0, sw = 0;
  for (let i = 0; i < n; i++) { sx += wa[i] * xa[i]; sw += wa[i]; }
  if (sw === 0) return NaN;
  return sx / sw;
}

export function weighted_var(x, w, opts) {
  const ddof = (opts && opts.ddof !== undefined) ? opts.ddof : 1;
  const r = _prep(x, w, opts);
  if (!r) return NaN;
  const xa = r.x, wa = r.w;
  const n = xa.length;
  if (n === 0) return NaN;
  if (!wa) {
    if (n - ddof <= 0) return NaN;
    let s = 0;
    for (let i = 0; i < n; i++) s += xa[i];
    const m = s / n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = xa[i] - m;
      ss += d * d;
    }
    return ss / (n - ddof);
  }
  // Weighted with frequency-weight semantics.
  let sx = 0, sw = 0;
  for (let i = 0; i < n; i++) { sx += wa[i] * xa[i]; sw += wa[i]; }
  if (sw === 0) return NaN;
  const m = sx / sw;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = xa[i] - m;
    ss += wa[i] * d * d;
  }
  if (sw - ddof <= 0) return NaN;
  return ss / (sw - ddof);
}

export function weighted_std(x, w, opts) {
  return Math.sqrt(weighted_var(x, w, opts));
}

// ── percentile / median ─────────────────────────────────────────────
//
// q is in [0, 100] to match numpy/scipy convention. Pass an array for
// multiple quantiles in one pass.
//
// Methods:
//   'linear' (default) — interpolate between adjacent values.
//   'lower'            — pick value at cum_w just below q.
//   'higher'           — pick value at cum_w just above q.

function _percentileSingle(xs, ws, qFrac, method) {
  const n = xs.length;
  let totalW = 0;
  for (let i = 0; i < n; i++) totalW += ws[i];
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => xs[a] - xs[b]);
  // Plotting position: midpoint of cumulative weight. For uniform weights
  // this reduces to (k + 0.5) / n — the "Hazen" rule, matching numpy's
  // 'midpoint'-style behaviour on odd-length samples (median lands on the
  // middle element exactly).
  const pp = new Float64Array(n);
  let cum = 0;
  for (let k = 0; k < n; k++) {
    pp[k] = (cum + 0.5 * ws[idx[k]]) / totalW;
    cum += ws[idx[k]];
  }
  if (n === 1) return xs[idx[0]];
  if (qFrac <= pp[0]) return xs[idx[0]];
  if (qFrac >= pp[n - 1]) return xs[idx[n - 1]];
  // Binary search for bracketing pair where pp[lo] <= qFrac < pp[lo+1].
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pp[mid] <= qFrac) lo = mid; else hi = mid;
  }
  if (method === 'lower') return xs[idx[lo]];
  if (method === 'higher') return xs[idx[lo + 1]];
  const dp = pp[lo + 1] - pp[lo];
  if (dp === 0) return xs[idx[lo]];
  const t = (qFrac - pp[lo]) / dp;
  return xs[idx[lo]] + t * (xs[idx[lo + 1]] - xs[idx[lo]]);
}

export function weighted_percentile(x, w, q, opts) {
  const method = (opts && opts.method) || 'linear';
  const r = _prep(x, w, opts);
  if (!r) {
    if (typeof q === 'number') return NaN;
    return new Float64Array(q.length).fill(NaN);
  }
  const xa = r.x;
  const wa = r.w || (() => { const u = new Float64Array(xa.length); u.fill(1); return u; })();
  if (xa.length === 0) {
    if (typeof q === 'number') return NaN;
    return new Float64Array(q.length).fill(NaN);
  }
  if (typeof q === 'number') {
    return _percentileSingle(xa, wa, q / 100, method);
  }
  const qa = _toF64(q);
  const out = new Float64Array(qa.length);
  for (let i = 0; i < qa.length; i++) {
    out[i] = _percentileSingle(xa, wa, qa[i] / 100, method);
  }
  return out;
}

export function weighted_median(x, w, opts) {
  return weighted_percentile(x, w, 50, opts);
}

// ── ECDF ────────────────────────────────────────────────────────────
//
// Returns { x_sorted, F } where F is the cumulative weight up to and
// including each sorted x. F[i] is the fraction of total weight at or
// below x_sorted[i]; values are in (0, 1].

export function ecdf(x, w, opts) {
  const r = _prep(x, w, opts);
  if (!r) return { x_sorted: new Float64Array(0), F: new Float64Array(0) };
  const xa = r.x;
  const wa = r.w;
  const n = xa.length;
  if (n === 0) return { x_sorted: new Float64Array(0), F: new Float64Array(0) };
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => xa[a] - xa[b]);
  const x_sorted = new Float64Array(n);
  const F = new Float64Array(n);
  let totalW = 0;
  if (wa) {
    for (let i = 0; i < n; i++) totalW += wa[i];
  } else {
    totalW = n;
  }
  let cum = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    x_sorted[k] = xa[i];
    cum += wa ? wa[i] : 1;
    F[k] = cum / totalW;
  }
  return { x_sorted, F };
}

// ── histogram ───────────────────────────────────────────────────────

export function histogram(x, opts = {}) {
  const xa = _toF64(x);
  const wa = opts.weights ? _toF64(opts.weights) : null;
  if (wa && wa.length !== xa.length) {
    throw new RangeError('weights length must match x length');
  }
  const nan = opts.nan || 'omit';
  const r = _handleNaN(xa, wa, nan);
  if (!r) {
    return { counts: new Float64Array(0), edges: new Float64Array(0) };
  }
  const xs = r.x;
  const ws = r.w;
  const n = xs.length;

  let lo, hi;
  if (opts.range) {
    [lo, hi] = opts.range;
  } else {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < lo) lo = xs[i];
      if (xs[i] > hi) hi = xs[i];
    }
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
  }
  const nbins = opts.bins ?? 10;
  const edges = new Float64Array(nbins + 1);
  const step = (hi - lo) / nbins;
  for (let k = 0; k <= nbins; k++) edges[k] = lo + k * step;

  const counts = new Float64Array(nbins);
  for (let i = 0; i < n; i++) {
    const v = xs[i];
    if (v < lo || v > hi) continue;
    let bin = Math.floor((v - lo) / step);
    if (bin === nbins) bin = nbins - 1;  // include right edge
    counts[bin] += ws ? ws[i] : 1;
  }
  if (opts.density) {
    let total = 0;
    for (let k = 0; k < nbins; k++) total += counts[k];
    if (total > 0) {
      const norm = 1 / (total * step);
      for (let k = 0; k < nbins; k++) counts[k] *= norm;
    }
  }
  return { counts, edges };
}

// ── higher moments ──────────────────────────────────────────────────
//
// Returns { mean, var, skewness, kurtosis } where kurtosis is the
// excess kurtosis (Pearson — fisher=true convention; subtracts 3).

export function moments(x, opts) {
  const r = _prep(x, null, opts);
  if (!r) return { mean: NaN, var: NaN, skewness: NaN, kurtosis: NaN };
  const xa = r.x;
  const n = xa.length;
  if (n === 0) return { mean: NaN, var: NaN, skewness: NaN, kurtosis: NaN };
  let s = 0;
  for (let i = 0; i < n; i++) s += xa[i];
  const m = s / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = xa[i] - m;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const std = Math.sqrt(m2);
  return {
    mean: m,
    var: m2,
    skewness: std === 0 ? 0 : m3 / (std * std * std),
    kurtosis: m2 === 0 ? 0 : m4 / (m2 * m2) - 3,
  };
}
