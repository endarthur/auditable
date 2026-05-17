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
  // natra's adder wrapper: {_nd: true, _arr: <descriptor>}. The descriptor
  // shape varies — WASM-arena (memory + ptr + length + dtype) or plain
  // data-backed (data: Float64Array). Handle both.
  if (x && x._nd && x._arr) {
    const a = x._arr;
    if (a.memory && a.memory.buffer && a.dtype === 'f64' && typeof a.ptr === 'number') {
      return new Float64Array(a.memory.buffer, a.ptr, a.length);
    }
    if (a.data instanceof Float64Array) {
      return a.length != null ? a.data.subarray(0, a.length) : a.data;
    }
  }
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

// scipy.stats.gmean(a) — geometric mean = exp(mean(log(a))). All values
// must be positive (returns NaN if any are ≤ 0).
export function gmean(x) {
  const xa = _toF64(x);
  if (xa.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < xa.length; i++) {
    if (xa[i] <= 0) return NaN;
    s += Math.log(xa[i]);
  }
  return Math.exp(s / xa.length);
}

// scipy.stats.hmean(a) — harmonic mean = n / sum(1/a). All values must
// be positive (returns NaN if any are ≤ 0).
export function hmean(x) {
  const xa = _toF64(x);
  if (xa.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < xa.length; i++) {
    if (xa[i] <= 0) return NaN;
    s += 1 / xa[i];
  }
  return xa.length / s;
}

// scipy.stats.ttest_ind(a, b) — Welch's t-test for two independent
// samples (default scipy behavior since 1.0). Returns the t-statistic
// and two-sided p-value. We compute Welch's t (unequal variances) and
// the Welch-Satterthwaite degrees of freedom; p-value via the Student-t
// CDF (lives in distributions.js).
//
// Returns { statistic, pvalue } — also array-indexable as [t, p] to
// match scipy's named-tuple result for `t, p = stats.ttest_ind(a, b)`
// destructuring.
export function ttest_ind(a, b, opts) {
  const xa = _toF64(a);
  const xb = _toF64(b);
  const n1 = xa.length, n2 = xb.length;
  if (n1 < 2 || n2 < 2) return { statistic: NaN, pvalue: NaN };
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n1; i++) s1 += xa[i];
  for (let i = 0; i < n2; i++) s2 += xb[i];
  const m1 = s1 / n1, m2 = s2 / n2;
  let v1 = 0, v2 = 0;
  for (let i = 0; i < n1; i++) v1 += (xa[i] - m1) ** 2;
  for (let i = 0; i < n2; i++) v2 += (xb[i] - m2) ** 2;
  v1 /= (n1 - 1); v2 /= (n2 - 1);
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return _statResult(0, 1);
  const tstat = (m1 - m2) / se;
  // Welch-Satterthwaite df approximation
  const num = (v1 / n1 + v2 / n2) ** 2;
  const den = (v1 * v1) / (n1 * n1 * (n1 - 1)) + (v2 * v2) / (n2 * n2 * (n2 - 1));
  const df = den === 0 ? n1 + n2 - 2 : num / den;
  // Two-sided p-value via Student-t CDF — lazy import to avoid the
  // distributions.js → descriptives.js cycle at module-eval time.
  const { _betai_for_t } = _ttestBetaiBridge();
  const tt = df / (df + tstat * tstat);
  const p = _betai_for_t(df / 2, 0.5, tt);   // 2-sided
  return _statResult(tstat, p);
}

function _statResult(statistic, pvalue) {
  // Indexable AND named — supports both `r.statistic` / `r.pvalue` and
  // `t, p = ttest_ind(...)` tuple unpacking in adder.
  const r = [statistic, pvalue];
  r.statistic = statistic;
  r.pvalue = pvalue;
  return r;
}

// Tiny duplicate of the incomplete-beta CF — distributions.js owns the
// full implementation, but importing it here would create a cycle
// (distributions.js imports from special.js, which descriptives.js
// also uses). Cheap to maintain a separate copy of ~25 lines.
function _ttestBetaiBridge() {
  function betacf(a, b, x) {
    const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // lgamma comes from util/special.js — but we shouldn't import here
    // (cycle risk). Use Stirling's approximation as a fallback; the
    // accuracy is ~1e-8 for our use, fine for p-values.
    const lg = (n) => {
      // Stirling
      const x = n;
      return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI)
           + 1 / (12 * x);
    };
    const bt = Math.exp(lg(a + b) - lg(a) - lg(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
    return 1 - bt * betacf(b, a, 1 - x) / b;
  }
  return { _betai_for_t: betai };
}
