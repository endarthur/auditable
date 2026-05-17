// Statistical distributions, scipy-shaped.
//
// Each distribution exposes both:
//   - "frozen" instances:  d = norm(loc, scale); d.pdf(x); d.cdf(x); ...
//   - functional form:     norm.pdf(x, loc, scale)
//
// Inputs (`x`, `samples`) are scalars, JS arrays, or typed arrays. Outputs
// are scalars when inputs are scalars, Float64Array otherwise. natra/vec
// ndarrays are accepted by duck-typing on `.data` (Float64Array view) and
// are returned as plain Float64Array — the caller wraps if they want to
// keep the natra type.

import { erf, ndtri, lgamma } from '../util/special.js';
import { makeNormalSampler, makeRng } from '../util/random.js';

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const SQRT_2 = Math.SQRT2;

// ── helpers ──────────────────────────────────────────────────────────

function _toF64(x) {
  if (typeof x === 'number') return null;            // scalar — caller handles
  if (x instanceof Float64Array) return x;
  if (x && x.data instanceof Float64Array) return x.data;  // natra/vec
  if (Array.isArray(x) || ArrayBuffer.isView(x)) return Float64Array.from(x);
  throw new TypeError('expected number, array, Float64Array, or ndarray');
}

function _vec1(x, fn) {
  if (typeof x === 'number') return fn(x);
  const xa = _toF64(x);
  const out = new Float64Array(xa.length);
  for (let i = 0; i < xa.length; i++) out[i] = fn(xa[i]);
  return out;
}

// ── Normal ───────────────────────────────────────────────────────────

const _normPdf = (x, loc = 0, scale = 1) =>
  Math.exp(-0.5 * ((x - loc) / scale) ** 2) / (scale * SQRT_2PI);

const _normLogPdf = (x, loc = 0, scale = 1) => {
  const z = (x - loc) / scale;
  return -0.5 * z * z - Math.log(scale) - LOG_SQRT_2PI;
};

const _normCdf = (x, loc = 0, scale = 1) =>
  0.5 * (1 + erf((x - loc) / (scale * SQRT_2)));

const _normSf = (x, loc = 0, scale = 1) =>
  0.5 * erf(-(x - loc) / (scale * SQRT_2)) + 0.5;

const _normPpf = (p, loc = 0, scale = 1) => loc + scale * ndtri(p);

const _normIsf = (p, loc = 0, scale = 1) => loc - scale * ndtri(p);

function _normRvs(size, loc = 0, scale = 1, opts = {}) {
  const sampler = makeNormalSampler(opts.random_state ?? null);
  if (typeof size === 'number') {
    const out = new Float64Array(size);
    for (let i = 0; i < size; i++) out[i] = loc + scale * sampler();
    return out;
  }
  // size = undefined → single draw
  return loc + scale * sampler();
}

function _normFit(samples, opts = {}) {
  const xa = _toF64(samples);
  const n = xa.length;
  if (n === 0) throw new RangeError('fit: empty sample');
  let s = 0;
  for (let i = 0; i < n; i++) s += xa[i];
  const mean = s / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = xa[i] - mean;
    ss += d * d;
  }
  // MLE std uses n in the denominator (population, not sample).
  // scipy.stats.norm.fit returns MLE; we match.
  const std = Math.sqrt(ss / n);
  return { loc: mean, scale: std };
}

class _NormFrozen {
  constructor(loc, scale) {
    if (scale <= 0) throw new RangeError('Normal: scale must be > 0');
    this.loc = loc;
    this.scale = scale;
  }
  pdf(x)    { return _vec1(x, v => _normPdf(v, this.loc, this.scale)); }
  logpdf(x) { return _vec1(x, v => _normLogPdf(v, this.loc, this.scale)); }
  cdf(x)    { return _vec1(x, v => _normCdf(v, this.loc, this.scale)); }
  sf(x)     { return _vec1(x, v => _normSf(v, this.loc, this.scale)); }
  ppf(p)    { return _vec1(p, v => _normPpf(v, this.loc, this.scale)); }
  isf(p)    { return _vec1(p, v => _normIsf(v, this.loc, this.scale)); }
  rvs(size, opts) { return _normRvs(size, this.loc, this.scale, opts); }
  mean()     { return this.loc; }
  median()   { return this.loc; }
  var()      { return this.scale * this.scale; }
  std()      { return this.scale; }
  entropy()  { return 0.5 * Math.log(2 * Math.PI * Math.E * this.scale * this.scale); }
}

export function norm(loc = 0, scale = 1) {
  return new _NormFrozen(loc, scale);
}
norm.pdf    = (x, loc, scale) => _vec1(x, v => _normPdf(v, loc ?? 0, scale ?? 1));
norm.logpdf = (x, loc, scale) => _vec1(x, v => _normLogPdf(v, loc ?? 0, scale ?? 1));
norm.cdf    = (x, loc, scale) => _vec1(x, v => _normCdf(v, loc ?? 0, scale ?? 1));
norm.sf     = (x, loc, scale) => _vec1(x, v => _normSf(v, loc ?? 0, scale ?? 1));
norm.ppf    = (p, loc, scale) => _vec1(p, v => _normPpf(v, loc ?? 0, scale ?? 1));
norm.isf    = (p, loc, scale) => _vec1(p, v => _normIsf(v, loc ?? 0, scale ?? 1));
norm.rvs    = (size, loc, scale, opts) => _normRvs(size, loc ?? 0, scale ?? 1, opts);
norm.fit    = (samples, opts) => _normFit(samples, opts);

// ── LogNormal ────────────────────────────────────────────────────────
//
// scipy parameterization: lognorm(s, loc=0, scale=exp(μ)).
//   s     = standard deviation of underlying normal (σ)
//   loc   = location offset (rarely non-zero in practice)
//   scale = exp(μ), the geometric mean of the distribution
//
// log-pdf, ppf etc. derived from Normal via change of variable:
//   X ~ LogNorm(σ, exp(μ)) ⇔ log((X-loc)/scale) ~ Normal(0, σ)

const _lnormPdf = (x, s, loc = 0, scale = 1) => {
  const z = (x - loc) / scale;
  if (z <= 0) return 0;
  const u = Math.log(z);
  return Math.exp(-0.5 * (u / s) ** 2) / (scale * z * s * SQRT_2PI);
};

const _lnormLogPdf = (x, s, loc = 0, scale = 1) => {
  const z = (x - loc) / scale;
  if (z <= 0) return -Infinity;
  const u = Math.log(z);
  return -0.5 * (u / s) ** 2 - Math.log(scale) - Math.log(z) - Math.log(s) - LOG_SQRT_2PI;
};

const _lnormCdf = (x, s, loc = 0, scale = 1) => {
  const z = (x - loc) / scale;
  if (z <= 0) return 0;
  return _normCdf(Math.log(z), 0, s);
};

const _lnormSf = (x, s, loc = 0, scale = 1) => {
  const z = (x - loc) / scale;
  if (z <= 0) return 1;
  return _normSf(Math.log(z), 0, s);
};

const _lnormPpf = (p, s, loc = 0, scale = 1) =>
  loc + scale * Math.exp(_normPpf(p, 0, s));

const _lnormIsf = (p, s, loc = 0, scale = 1) =>
  loc + scale * Math.exp(_normIsf(p, 0, s));

function _lnormRvs(size, s, loc = 0, scale = 1, opts = {}) {
  const sampler = makeNormalSampler(opts.random_state ?? null);
  if (typeof size === 'number') {
    const out = new Float64Array(size);
    for (let i = 0; i < size; i++) out[i] = loc + scale * Math.exp(s * sampler());
    return out;
  }
  return loc + scale * Math.exp(s * sampler());
}

function _lnormFit(samples, opts = {}) {
  // floc default = 0 (most common case: pure log-normal). If caller
  // wants to fix loc != 0 they can pre-shift.
  const floc = opts.floc ?? 0;
  const xa = _toF64(samples);
  const n = xa.length;
  if (n === 0) throw new RangeError('fit: empty sample');
  // Take logs of (x - floc), then fit a Normal.
  const logs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const z = xa[i] - floc;
    if (z <= 0) throw new RangeError('lognorm.fit: all (x - floc) must be > 0');
    logs[i] = Math.log(z);
  }
  const { loc: mu, scale: sigma } = _normFit(logs);
  return { s: sigma, loc: floc, scale: Math.exp(mu) };
}

class _LNormFrozen {
  constructor(s, loc, scale) {
    if (s <= 0) throw new RangeError('LogNormal: s must be > 0');
    if (scale <= 0) throw new RangeError('LogNormal: scale must be > 0');
    this.s = s;
    this.loc = loc;
    this.scale = scale;
  }
  pdf(x)    { return _vec1(x, v => _lnormPdf(v, this.s, this.loc, this.scale)); }
  logpdf(x) { return _vec1(x, v => _lnormLogPdf(v, this.s, this.loc, this.scale)); }
  cdf(x)    { return _vec1(x, v => _lnormCdf(v, this.s, this.loc, this.scale)); }
  sf(x)     { return _vec1(x, v => _lnormSf(v, this.s, this.loc, this.scale)); }
  ppf(p)    { return _vec1(p, v => _lnormPpf(v, this.s, this.loc, this.scale)); }
  isf(p)    { return _vec1(p, v => _lnormIsf(v, this.s, this.loc, this.scale)); }
  rvs(size, opts) { return _lnormRvs(size, this.s, this.loc, this.scale, opts); }
  mean() {
    return this.loc + this.scale * Math.exp(0.5 * this.s * this.s);
  }
  median() {
    return this.loc + this.scale;  // exp(median of underlying normal = 0) = 1
  }
  var() {
    const ss = this.s * this.s;
    return this.scale * this.scale * Math.exp(ss) * (Math.exp(ss) - 1);
  }
  std() {
    return Math.sqrt(this.var());
  }
}

export function lognorm(s, loc = 0, scale = 1) {
  return new _LNormFrozen(s, loc, scale);
}
lognorm.pdf    = (x, s, loc, scale) => _vec1(x, v => _lnormPdf(v, s, loc ?? 0, scale ?? 1));
lognorm.logpdf = (x, s, loc, scale) => _vec1(x, v => _lnormLogPdf(v, s, loc ?? 0, scale ?? 1));
lognorm.cdf    = (x, s, loc, scale) => _vec1(x, v => _lnormCdf(v, s, loc ?? 0, scale ?? 1));
lognorm.sf     = (x, s, loc, scale) => _vec1(x, v => _lnormSf(v, s, loc ?? 0, scale ?? 1));
lognorm.ppf    = (p, s, loc, scale) => _vec1(p, v => _lnormPpf(v, s, loc ?? 0, scale ?? 1));
lognorm.isf    = (p, s, loc, scale) => _vec1(p, v => _lnormIsf(v, s, loc ?? 0, scale ?? 1));
lognorm.rvs    = (size, s, loc, scale, opts) => _lnormRvs(size, s, loc ?? 0, scale ?? 1, opts);
lognorm.fit    = (samples, opts) => _lnormFit(samples, opts);

// ── Student's t-distribution ─────────────────────────────────────────
//
// scipy parameterization: t(df, loc=0, scale=1) — df=degrees of freedom.
//
// pdf and cdf use the regularized incomplete beta function, which we
// implement here via the Lentz-style continued fraction (Numerical
// Recipes §6.4). Accuracy ~1e-10 across the typical df range (1..1e6).
// ppf is bisection on cdf — robust but ~30 iterations per call.

// Continued fraction for the incomplete beta function I_x(a,b).
function _betacf(a, b, x) {
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

// Regularized incomplete beta function I_x(a, b).
function _betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b)
    + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return bt * _betacf(a, b, x) / a;
  return 1 - bt * _betacf(b, a, 1 - x) / b;
}

function _tPdf(x, df, loc, scale) {
  const z = (x - loc) / scale;
  const c = Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2)) / Math.sqrt(df * Math.PI);
  return c * Math.pow(1 + z * z / df, -(df + 1) / 2) / scale;
}
function _tLogPdf(x, df, loc, scale) {
  const z = (x - loc) / scale;
  return lgamma((df + 1) / 2) - lgamma(df / 2)
       - 0.5 * Math.log(df * Math.PI)
       - ((df + 1) / 2) * Math.log(1 + z * z / df)
       - Math.log(scale);
}
function _tCdf(x, df, loc, scale) {
  const z = (x - loc) / scale;
  if (!isFinite(z)) return z > 0 ? 1 : 0;
  const tt = df / (df + z * z);
  const half = 0.5 * _betai(df / 2, 0.5, tt);
  return z >= 0 ? 1 - half : half;
}
function _tSf(x, df, loc, scale) { return 1 - _tCdf(x, df, loc, scale); }

function _tPpf(p, df, loc, scale) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return loc;
  // Symmetric — solve for |z| then sign by direction.
  // Robust bracket [-50, 50] holds well for df ≥ 1.
  let lo = -50, hi = 50;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const c = _tCdf(mid, df, 0, 1);
    if (Math.abs(c - p) < 1e-12) {
      lo = hi = mid; break;
    }
    if (c < p) lo = mid;
    else hi = mid;
  }
  return loc + scale * (lo + hi) / 2;
}
function _tIsf(p, df, loc, scale) { return _tPpf(1 - p, df, loc, scale); }

class _TFrozen {
  constructor(df, loc, scale) {
    this.df = df; this.loc = loc; this.scale = scale;
    this.__adderClass__ = 't_frozen';
  }
  pdf(x)    { return _vec1(x, v => _tPdf(v, this.df, this.loc, this.scale)); }
  logpdf(x) { return _vec1(x, v => _tLogPdf(v, this.df, this.loc, this.scale)); }
  cdf(x)    { return _vec1(x, v => _tCdf(v, this.df, this.loc, this.scale)); }
  sf(x)     { return _vec1(x, v => _tSf(v, this.df, this.loc, this.scale)); }
  ppf(p)    { return _vec1(p, v => _tPpf(v, this.df, this.loc, this.scale)); }
  isf(p)    { return _vec1(p, v => _tIsf(v, this.df, this.loc, this.scale)); }
  mean()    { return this.df > 1 ? this.loc : NaN; }
  median()  { return this.loc; }
  var()     { return this.df > 2 ? this.scale * this.scale * this.df / (this.df - 2) : NaN; }
  std()     { return Math.sqrt(this.var()); }
}

export function t(df, loc = 0, scale = 1) {
  return new _TFrozen(df, loc, scale);
}
t.pdf    = (x, df, loc, scale) => _vec1(x, v => _tPdf(v, df, loc ?? 0, scale ?? 1));
t.logpdf = (x, df, loc, scale) => _vec1(x, v => _tLogPdf(v, df, loc ?? 0, scale ?? 1));
t.cdf    = (x, df, loc, scale) => _vec1(x, v => _tCdf(v, df, loc ?? 0, scale ?? 1));
t.sf     = (x, df, loc, scale) => _vec1(x, v => _tSf(v, df, loc ?? 0, scale ?? 1));
t.ppf    = (p, df, loc, scale) => _vec1(p, v => _tPpf(v, df, loc ?? 0, scale ?? 1));
t.isf    = (p, df, loc, scale) => _vec1(p, v => _tIsf(v, df, loc ?? 0, scale ?? 1));
