// scitra.stats.gaussian_kde — 1D KDE

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gaussian_kde } from '../ext/scitra/src/stats/kde.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── basic API ────────────────────────────────────────────────────────

test('gaussian_kde: requires ≥ 2 points', () => {
  assert.throws(() => gaussian_kde([1]));
});

test('gaussian_kde: pdf integrates to ≈1', () => {
  const data = [];
  for (let i = 0; i < 200; i++) {
    // Mix of two normals
    const u1 = Math.random() || 1e-12;
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    data.push(i < 100 ? r : r + 5);
  }
  const k = gaussian_kde(data);
  // Trapezoidal integration over a wide grid
  const lo = -10, hi = 15;
  const N = 1000;
  const dx = (hi - lo) / N;
  const xs = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) xs[i] = lo + i * dx;
  const pdf = k.pdf(xs);
  let area = 0;
  for (let i = 0; i < N; i++) area += 0.5 * (pdf[i] + pdf[i + 1]) * dx;
  assert.ok(Math.abs(area - 1) < 1e-3, `pdf integral = ${area}`);
});

test('gaussian_kde: pdf is non-negative', () => {
  const k = gaussian_kde([1, 2, 3, 4, 5]);
  for (const x of [-100, 0, 3, 100]) {
    assert.ok(k.pdf(x) >= 0);
  }
});

test('gaussian_kde: scott vs silverman bandwidth differ', () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const a = gaussian_kde(data, { bw_method: 'scott' });
  const b = gaussian_kde(data, { bw_method: 'silverman' });
  assert.notEqual(a.bandwidth, b.bandwidth);
});

test('gaussian_kde: scott matches scipy formula factor = n^(-1/5)', () => {
  const data = [1, 2, 3, 4, 5];
  const k = gaussian_kde(data, { bw_method: 'scott' });
  assert.ok(close(k.factor, Math.pow(5, -1 / 5), 1e-12));
});

test('gaussian_kde: silverman matches (n*3/4)^(-1/5)', () => {
  const data = [1, 2, 3, 4, 5];
  const k = gaussian_kde(data, { bw_method: 'silverman' });
  assert.ok(close(k.factor, Math.pow(5 * 3 / 4, -1 / 5), 1e-12));
});

test('gaussian_kde: numeric bw_method sets factor directly', () => {
  const data = [1, 2, 3, 4, 5];
  const k = gaussian_kde(data, { bw_method: 0.5 });
  assert.equal(k.factor, 0.5);
});

test('gaussian_kde: bandwidth = factor * sigma', () => {
  const data = [1, 2, 3, 4, 5];
  // unweighted std with ddof=1: sqrt(2.5) ≈ 1.5811
  const sigma = Math.sqrt(2.5);
  const k = gaussian_kde(data, { bw_method: 0.5 });
  assert.ok(close(k.bandwidth, 0.5 * sigma, 1e-9));
});

// ── pdf shape ────────────────────────────────────────────────────────

test('gaussian_kde: peak near data point for narrow bandwidth', () => {
  // Single mode at 0
  const data = new Float64Array(100);
  for (let i = 0; i < 100; i++) data[i] = 0.01 * (i - 50);  // tight cluster
  const k = gaussian_kde(data);
  const at0 = k.pdf(0);
  const at1 = k.pdf(1);
  const at5 = k.pdf(5);
  assert.ok(at0 > at1, `at0=${at0} should be > at1=${at1}`);
  assert.ok(at1 > at5);
});

test('gaussian_kde: cdf is monotone in (0, 1]', () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const k = gaussian_kde(data);
  const xs = [-10, 0, 5, 10, 20];
  let prev = 0;
  for (const x of xs) {
    const c = k.cdf(x);
    assert.ok(c >= prev - 1e-12, `cdf not monotone at x=${x}`);
    assert.ok(c >= 0 && c <= 1 + 1e-9);
    prev = c;
  }
});

test('gaussian_kde: cdf at far-right ≈ 1', () => {
  const k = gaussian_kde([1, 2, 3, 4, 5]);
  assert.ok(close(k.cdf(1000), 1, 1e-6));
});

test('gaussian_kde: cdf at far-left ≈ 0', () => {
  const k = gaussian_kde([1, 2, 3, 4, 5]);
  assert.ok(close(k.cdf(-1000), 0, 1e-6));
});

// ── weighted ─────────────────────────────────────────────────────────

test('gaussian_kde: equal weights match unweighted', () => {
  const data = [1, 2, 3, 4, 5];
  const a = gaussian_kde(data);
  const b = gaussian_kde(data, { weights: [1, 1, 1, 1, 1] });
  for (const x of [0, 2.5, 5]) {
    assert.ok(close(a.pdf(x), b.pdf(x), 1e-9));
  }
});

test('gaussian_kde: heavy weight on one sample biases pdf toward it', () => {
  const data = [0, 5, 10];
  const w = [1, 100, 1];
  const k = gaussian_kde(data, { weights: w });
  const p0 = k.pdf(0);
  const p5 = k.pdf(5);
  const p10 = k.pdf(10);
  assert.ok(p5 > p0);
  assert.ok(p5 > p10);
});

// ── resample ─────────────────────────────────────────────────────────

test('gaussian_kde: resample is deterministic with seed', () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8];
  const k = gaussian_kde(data);
  const a = k.resample(50, { random_state: 42 });
  const b = k.resample(50, { random_state: 42 });
  for (let i = 0; i < 50; i++) assert.equal(a[i], b[i]);
});

test('gaussian_kde: resample sample mean approximates data mean', () => {
  const data = [10, 20, 30, 40, 50];
  const k = gaussian_kde(data);
  const samples = k.resample(50_000, { random_state: 1 });
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i];
  const mean = s / samples.length;
  // Data mean is 30; KDE preserves it (kernel symmetric).
  assert.ok(Math.abs(mean - 30) < 1, `resample mean = ${mean}`);
});

// ── vectorized input ─────────────────────────────────────────────────

test('gaussian_kde: pdf accepts array', () => {
  const k = gaussian_kde([1, 2, 3]);
  const out = k.pdf([0, 1, 2, 3, 4]);
  assert.equal(out.length, 5);
  for (let i = 0; i < 5; i++) assert.ok(out[i] >= 0);
});

test('gaussian_kde: pdf accepts scalar → number', () => {
  const k = gaussian_kde([1, 2, 3]);
  const out = k.pdf(2);
  assert.equal(typeof out, 'number');
});

test('gaussian_kde: evaluate is alias for pdf', () => {
  const k = gaussian_kde([1, 2, 3]);
  assert.equal(k.evaluate(2), k.pdf(2));
});
