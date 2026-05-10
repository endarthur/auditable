// scitra.stats.descriptives — weighted moments, percentile, ecdf, histogram

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  weighted_mean, weighted_var, weighted_std,
  weighted_percentile, weighted_median,
  ecdf, histogram, moments,
} from '../ext/scitra/src/stats/descriptives.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── weighted_mean ───────────────────────────────────────────────────

test('weighted_mean: unweighted equals arithmetic mean', () => {
  assert.equal(weighted_mean([1, 2, 3, 4, 5]), 3);
  assert.equal(weighted_mean([10]), 10);
});

test('weighted_mean: with weights', () => {
  // 1*1 + 2*2 + 3*3 = 14, sum_w = 6 → 14/6 ≈ 2.333
  assert.ok(close(weighted_mean([1, 2, 3], [1, 2, 3]), 14 / 6));
});

test('weighted_mean: zero weights → NaN', () => {
  assert.ok(Number.isNaN(weighted_mean([1, 2, 3], [0, 0, 0])));
});

test('weighted_mean: NaN omit (default)', () => {
  // Drops NaNs; mean of [1, 3] = 2
  assert.equal(weighted_mean([1, NaN, 3]), 2);
});

test('weighted_mean: NaN propagate', () => {
  assert.ok(Number.isNaN(weighted_mean([1, NaN, 3], null, { nan: 'propagate' })));
});

test('weighted_mean: NaN raise', () => {
  assert.throws(() => weighted_mean([1, NaN, 3], null, { nan: 'raise' }));
});

// ── weighted_var / weighted_std ─────────────────────────────────────

test('weighted_var: unweighted, ddof=1 (default)', () => {
  // Population variance of [1,2,3,4,5] = 2.5; sample variance (ddof=1) = 2.5
  // mean=3, deviations²: 4,1,0,1,4 → sum=10, /4 = 2.5
  assert.ok(close(weighted_var([1, 2, 3, 4, 5]), 2.5, 1e-12));
});

test('weighted_var: ddof=0 (population)', () => {
  // sum=10, /5 = 2
  assert.ok(close(weighted_var([1, 2, 3, 4, 5], null, { ddof: 0 }), 2, 1e-12));
});

test('weighted_std: sqrt of var', () => {
  const v = weighted_var([1, 2, 3, 4, 5], null, { ddof: 0 });
  assert.ok(close(weighted_std([1, 2, 3, 4, 5], null, { ddof: 0 }), Math.sqrt(v), 1e-12));
});

test('weighted_var: with frequency weights matches expanded sample', () => {
  // [1, 2, 3] with weights [2, 1, 2] should equal var of [1, 1, 2, 3, 3]
  // mean = 10/5 = 2
  // sum_sq = (1-2)²·2 + (2-2)²·1 + (3-2)²·2 = 2+0+2 = 4
  // sw = 5, ddof=1 → 4/4 = 1.0
  const v = weighted_var([1, 2, 3], [2, 1, 2]);
  assert.ok(close(v, 1.0, 1e-12));
});

// ── percentile / median ─────────────────────────────────────────────

test('weighted_percentile: q=50 unweighted is median', () => {
  // [1,2,3,4,5] median = 3
  assert.ok(close(weighted_percentile([1, 2, 3, 4, 5], null, 50), 3, 1e-9));
});

test('weighted_percentile: q=0 returns min, q=100 returns max', () => {
  // Note: q=0 is at zero cumulative, returns first element by linear interp
  // (we treat target=0 specially via the cum===0 branch)
  const xs = [3, 1, 4, 1, 5, 9, 2, 6];
  assert.ok(close(weighted_percentile(xs, null, 0), 1, 1e-9));
  assert.ok(close(weighted_percentile(xs, null, 100), 9, 1e-9));
});

test('weighted_percentile: array of q', () => {
  const xs = [1, 2, 3, 4, 5];
  const out = weighted_percentile(xs, null, [0, 25, 50, 75, 100]);
  assert.equal(out.length, 5);
  assert.ok(close(out[0], 1));
  assert.ok(close(out[2], 3));  // median
  assert.ok(close(out[4], 5));
});

test('weighted_percentile: lower / higher methods', () => {
  // [10, 20, 30, 40] even-length: q=50 falls between elements
  // pp = 0.125, 0.375, 0.625, 0.875 → target=0.5 sits between pp[1] and pp[2]
  // 'lower' = 20, 'higher' = 30, 'linear' = 25
  const xs = [10, 20, 30, 40];
  assert.equal(weighted_percentile(xs, null, 50, { method: 'lower' }), 20);
  assert.equal(weighted_percentile(xs, null, 50, { method: 'higher' }), 30);
  assert.ok(close(weighted_percentile(xs, null, 50), 25, 1e-9));
});

test('weighted_median equals weighted_percentile at 50', () => {
  const xs = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
  assert.equal(weighted_median(xs), weighted_percentile(xs, null, 50));
});

test('weighted_median: with weights matches expanded sample', () => {
  // Weighted [1,2,3] with weights [2,1,2] → expanded [1,1,2,3,3]
  // median = 2
  const m = weighted_median([1, 2, 3], [2, 1, 2]);
  assert.ok(close(m, 2, 1e-9));
});

// ── ecdf ────────────────────────────────────────────────────────────

test('ecdf: unweighted, sorted output', () => {
  const { x_sorted, F } = ecdf([3, 1, 2]);
  assert.deepEqual(Array.from(x_sorted), [1, 2, 3]);
  // F = [1/3, 2/3, 1]
  assert.ok(close(F[0], 1 / 3, 1e-9));
  assert.ok(close(F[1], 2 / 3, 1e-9));
  assert.ok(close(F[2], 1, 1e-9));
});

test('ecdf: F is monotone in (0, 1]', () => {
  const xs = Array.from({ length: 100 }, () => Math.random());
  const { F } = ecdf(xs);
  for (let i = 0; i < F.length; i++) {
    assert.ok(F[i] > 0 && F[i] <= 1 + 1e-12);
  }
  for (let i = 1; i < F.length; i++) {
    assert.ok(F[i] >= F[i - 1] - 1e-12);
  }
});

test('ecdf: weighted', () => {
  const { x_sorted, F } = ecdf([1, 2, 3], [1, 2, 1]);
  assert.deepEqual(Array.from(x_sorted), [1, 2, 3]);
  // total weight 4, cumulative 1, 3, 4 → F = 0.25, 0.75, 1
  assert.ok(close(F[0], 0.25));
  assert.ok(close(F[1], 0.75));
  assert.ok(close(F[2], 1));
});

// ── histogram ───────────────────────────────────────────────────────

test('histogram: counts and edges', () => {
  // 10 samples in [0, 10), 5 bins → each bin counts 2
  const xs = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5];
  const { counts, edges } = histogram(xs, { bins: 5, range: [0, 10] });
  assert.equal(edges.length, 6);
  assert.equal(counts.length, 5);
  for (let i = 0; i < 5; i++) assert.equal(counts[i], 2);
});

test('histogram: density normalization', () => {
  // Uniform bins should give density = 1 / range_width
  const xs = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 100);  // 0..10
  const { counts } = histogram(xs, { bins: 10, range: [0, 10], density: true });
  // sum(counts * width) should be 1
  let area = 0;
  for (let i = 0; i < counts.length; i++) area += counts[i] * 1;  // width = 1
  assert.ok(close(area, 1, 1e-9));
});

test('histogram: weighted', () => {
  const xs = [0.5, 1.5, 2.5];
  const ws = [1, 2, 4];
  const { counts } = histogram(xs, { bins: 3, range: [0, 3], weights: ws });
  assert.equal(counts[0], 1);
  assert.equal(counts[1], 2);
  assert.equal(counts[2], 4);
});

// ── moments ─────────────────────────────────────────────────────────

test('moments: known values for symmetric data', () => {
  // [-2, -1, 0, 1, 2]: mean=0, var=2, skewness=0, kurtosis<0 (platykurtic)
  const m = moments([-2, -1, 0, 1, 2]);
  assert.ok(close(m.mean, 0, 1e-12));
  assert.ok(close(m.var, 2, 1e-12));
  assert.ok(close(m.skewness, 0, 1e-12));
  assert.ok(m.kurtosis < 0);  // discrete uniform is platykurtic
});

test('moments: skewness sign for right-skewed data', () => {
  // Right-skewed: a few large outliers
  const xs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 100];
  const m = moments(xs);
  assert.ok(m.skewness > 0);
});

test('moments: from large normal sample → kurtosis ≈ 0', () => {
  // Large normal sample: skewness and excess kurtosis should be small.
  // mulberry32 + Box-Muller from random.js, but we're not importing that here;
  // use Math.random and a soft tolerance.
  const N = 20_000;
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i += 2) {
    const u1 = Math.random() || 1e-12;
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    xs[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < N) xs[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  const m = moments(xs);
  assert.ok(Math.abs(m.skewness) < 0.1, `skewness = ${m.skewness}`);
  assert.ok(Math.abs(m.kurtosis) < 0.2, `kurtosis = ${m.kurtosis}`);
});

// ── duck-typing on natra/vec-like inputs ─────────────────────────────

test('weighted_mean: accepts ndarray-like { data }', () => {
  const fake = { data: new Float64Array([1, 2, 3, 4, 5]) };
  assert.equal(weighted_mean(fake), 3);
});
