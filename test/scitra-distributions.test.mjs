// scitra.stats.distributions — Normal, LogNormal
//
// Reference values: hand-computed from closed-form, or generated from
// scipy v1.13 (kept inline as comments for traceability).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { norm, lognorm } from '../ext/scitra/src/stats/distributions.js';
import { erf, erfinv, ndtri } from '../ext/scitra/src/util/special.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-9) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

// ── special functions ───────────────────────────────────────────────

test('erf: known values', () => {
  // erf(0) = 0
  assert.ok(close(erf(0), 0));
  // erf(∞) = 1
  assert.ok(close(erf(100), 1));
  // erf(1) ≈ 0.8427007929 (A&S table)
  assert.ok(close(erf(1), 0.8427007929, 1e-6));
  // erf(0.5) ≈ 0.5204998778
  assert.ok(close(erf(0.5), 0.5204998778, 1e-6));
  // odd: erf(-x) = -erf(x)
  assert.ok(close(erf(-1), -erf(1), 1e-12));
});

test('ndtri: inverse of standard normal CDF', () => {
  // Acklam's algorithm: ~1.15e-9 relative error worst-case.
  // On values ~2 that means ~2-3e-9 absolute. Tolerance set accordingly.
  assert.ok(close(ndtri(0.5), 0, 1e-12));
  assert.ok(close(ndtri(0.975), 1.9599639845400545, 5e-9));
  assert.ok(close(ndtri(0.025), -1.9599639845400545, 5e-9));
  assert.ok(close(ndtri(0.999), 3.0902323061678132, 5e-9));
  // edge cases
  assert.equal(ndtri(0), -Infinity);
  assert.equal(ndtri(1), Infinity);
  assert.ok(Number.isNaN(ndtri(-0.1)));
  assert.ok(Number.isNaN(ndtri(1.1)));
});

test('erfinv: roundtrip with erf (accuracy limited by erf ≈ 1.5e-7)', () => {
  // Near the tails, erf saturates near ±1 and small errors there map to
  // large errors in the inverse. We're lookng for "doesn't blow up".
  for (const x of [-1, -0.5, 0, 0.5, 1]) {
    const y = erf(x);
    const xb = erfinv(y);
    assert.ok(close(x, xb, 1e-5), `erfinv(erf(${x})) = ${xb}`);
  }
  // Direct values (no erf composition):
  assert.ok(close(erfinv(0), 0, 1e-12));
  assert.ok(close(erfinv(0.5), 0.4769362762044698, 1e-7));
});

// ── Normal distribution ──────────────────────────────────────────────

test('norm.pdf: scalar values', () => {
  // φ(0) = 1/√(2π) ≈ 0.3989422804
  assert.ok(close(norm.pdf(0), 0.39894228040143, 1e-12));
  // φ(1) ≈ 0.2419707245
  assert.ok(close(norm.pdf(1), 0.24197072451914, 1e-12));
  // location/scale: norm(loc=2, scale=3).pdf(2) = (1/(3√(2π)))
  assert.ok(close(norm(2, 3).pdf(2), 1 / (3 * Math.sqrt(2 * Math.PI)), 1e-12));
});

test('norm.pdf: vectorized', () => {
  const xs = [-1, 0, 1];
  const ys = norm.pdf(xs);
  const want = [
    0.24197072451914,
    0.39894228040143,
    0.24197072451914,
  ];
  assert.ok(arrClose(ys, want, 1e-12));
});

test('norm.cdf: known values', () => {
  // Φ(0) = 0.5
  assert.ok(close(norm.cdf(0), 0.5, 1e-7));
  // Φ(1) ≈ 0.8413447461
  assert.ok(close(norm.cdf(1), 0.8413447461, 1e-6));
  // Φ(-1) ≈ 0.1586552539
  assert.ok(close(norm.cdf(-1), 0.1586552539, 1e-6));
  // Φ(1.96) ≈ 0.975 (standard z-score)
  assert.ok(close(norm.cdf(1.96), 0.9750021048, 1e-6));
});

test('norm.ppf: known values + roundtrip with cdf', () => {
  assert.ok(close(norm.ppf(0.5), 0, 1e-12));
  assert.ok(close(norm.ppf(0.975), 1.9599639845400545, 5e-9));
  // Roundtrip — accuracy is limited by erf (~1.5e-7), not ndtri.
  for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    const z = norm.ppf(p);
    const p2 = norm.cdf(z);
    assert.ok(close(p, p2, 1e-6), `cdf(ppf(${p})) = ${p2}`);
  }
});

test('norm.sf and isf', () => {
  // sf(x) = 1 - cdf(x)
  for (const x of [-2, 0, 1.5]) {
    const sf = norm.sf(x);
    const cdf = norm.cdf(x);
    assert.ok(close(sf + cdf, 1, 1e-6));
  }
  // isf is inverse of sf
  for (const p of [0.01, 0.5, 0.99]) {
    assert.ok(close(norm.cdf(norm.isf(p)), 1 - p, 1e-6));
  }
});

test('norm.rvs: deterministic with random_state', () => {
  const a = norm.rvs(1000, 0, 1, { random_state: 42 });
  const b = norm.rvs(1000, 0, 1, { random_state: 42 });
  assert.ok(arrClose(a, b, 0));   // bit-identical
  assert.equal(a.length, 1000);
});

test('norm.rvs: sample mean / std approach loc / scale', () => {
  const N = 50_000;
  const a = norm.rvs(N, 5, 2, { random_state: 7 });
  let s = 0;
  for (let i = 0; i < N; i++) s += a[i];
  const mean = s / N;
  let ss = 0;
  for (let i = 0; i < N; i++) ss += (a[i] - mean) ** 2;
  const std = Math.sqrt(ss / N);
  assert.ok(Math.abs(mean - 5) < 0.05, `sample mean = ${mean}, expected ≈5`);
  assert.ok(Math.abs(std - 2) < 0.05, `sample std = ${std}, expected ≈2`);
});

test('norm.fit: recovers known parameters from samples', () => {
  const N = 50_000;
  const samples = norm.rvs(N, 3.5, 1.7, { random_state: 12345 });
  const { loc, scale } = norm.fit(samples);
  assert.ok(Math.abs(loc - 3.5) < 0.05, `fit loc = ${loc}`);
  assert.ok(Math.abs(scale - 1.7) < 0.05, `fit scale = ${scale}`);
});

test('norm: frozen vs functional give same result', () => {
  const d = norm(2, 3);
  for (const x of [-1, 0, 5]) {
    assert.ok(close(d.pdf(x), norm.pdf(x, 2, 3), 1e-15));
    assert.ok(close(d.cdf(x), norm.cdf(x, 2, 3), 1e-15));
  }
  assert.ok(close(d.ppf(0.7), norm.ppf(0.7, 2, 3), 1e-15));
});

test('norm: moments', () => {
  const d = norm(2, 3);
  assert.equal(d.mean(), 2);
  assert.equal(d.median(), 2);
  assert.equal(d.var(), 9);
  assert.equal(d.std(), 3);
});

test('norm: invalid scale throws', () => {
  assert.throws(() => norm(0, 0));
  assert.throws(() => norm(0, -1));
});

// ── LogNormal distribution ───────────────────────────────────────────

test('lognorm.pdf: returns 0 at x ≤ 0', () => {
  assert.equal(lognorm.pdf(-1, 1), 0);
  assert.equal(lognorm.pdf(0, 1), 0);
});

test('lognorm.pdf: known value at x = 1, s = 1', () => {
  // pdf(1) = 1 / (1 * 1 * √(2π)) = 1/√(2π) ≈ 0.39894228040
  assert.ok(close(lognorm.pdf(1, 1), 1 / Math.sqrt(2 * Math.PI), 1e-12));
});

test('lognorm.cdf: known values', () => {
  // For X ~ lognorm(σ=1, scale=1): cdf(1) = Φ(0) = 0.5
  assert.ok(close(lognorm.cdf(1, 1), 0.5, 1e-6));
  // cdf(e) = Φ(1) ≈ 0.8413
  assert.ok(close(lognorm.cdf(Math.E, 1), 0.8413447461, 1e-6));
});

test('lognorm.ppf: roundtrip with cdf', () => {
  const d = lognorm(1.5);
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const x = d.ppf(p);
    const p2 = d.cdf(x);
    assert.ok(close(p, p2, 1e-6), `cdf(ppf(${p})) = ${p2}`);
  }
});

test('lognorm.rvs: deterministic with random_state', () => {
  const a = lognorm.rvs(500, 1, 0, 1, { random_state: 99 });
  const b = lognorm.rvs(500, 1, 0, 1, { random_state: 99 });
  assert.ok(arrClose(a, b, 0));
  // All draws are positive
  for (let i = 0; i < a.length; i++) {
    assert.ok(a[i] > 0);
  }
});

test('lognorm.fit: recovers parameters from samples', () => {
  // Generate from lognorm(s=0.5, scale=10) i.e. underlying normal
  // has μ=ln(10)≈2.302585, σ=0.5
  const N = 50_000;
  const samples = lognorm.rvs(N, 0.5, 0, 10, { random_state: 7 });
  const fit = lognorm.fit(samples);
  assert.ok(Math.abs(fit.s - 0.5) < 0.02, `fit s = ${fit.s}`);
  assert.ok(Math.abs(fit.scale - 10) < 0.5, `fit scale = ${fit.scale}`);
  assert.equal(fit.loc, 0);
});

test('lognorm: moments match closed-form', () => {
  // mean = scale * exp(s²/2),  var = scale² * exp(s²) * (exp(s²) - 1)
  const s = 0.7, scale = 5;
  const d = lognorm(s, 0, scale);
  const expectedMean = scale * Math.exp(0.5 * s * s);
  const expectedVar = scale * scale * Math.exp(s * s) * (Math.exp(s * s) - 1);
  assert.ok(close(d.mean(), expectedMean, 1e-12));
  assert.ok(close(d.var(), expectedVar, 1e-12));
});
