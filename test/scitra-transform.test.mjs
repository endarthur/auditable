// scitra.stats.transform — normal score transform

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normal_score_transform } from '../ext/scitra/src/stats/transform.js';
import { ndtri } from '../ext/scitra/src/util/special.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── forward transform ───────────────────────────────────────────────

test('NST: monotone — preserves rank ordering', () => {
  const x = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
  const { y } = normal_score_transform(x, { tie: 'random', random_state: 1 });
  // Sort indices by x and y, check the permutation is the same.
  const idxX = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const idxY = Array.from(y).map((_, i) => i).sort((a, b) => y[a] - y[b]);
  // With tie='random' and the same seeded RNG, the resolved order is stable
  assert.deepEqual(idxX.map(i => Math.round(x[i] * 100) / 100),
                   idxY.map(i => Math.round(x[i] * 100) / 100));
});

test('NST: hazen plotting position for n=5 unique values', () => {
  // For [1,2,3,4,5] unique, no ties, hazen positions are 0.1, 0.3, 0.5, 0.7, 0.9
  // → y values are ndtri of those.
  const { y } = normal_score_transform([1, 2, 3, 4, 5]);
  const want = [0.1, 0.3, 0.5, 0.7, 0.9].map(p => ndtri(p));
  for (let i = 0; i < 5; i++) {
    assert.ok(close(y[i], want[i], 1e-9), `y[${i}] = ${y[i]}, want ${want[i]}`);
  }
});

test('NST: median of forward result is approximately 0', () => {
  // For symmetric input, the median y should be 0 (within plotting position tolerance).
  const N = 1001;  // odd so the middle value is the exact median
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = i;
  const { y } = normal_score_transform(x);
  // Sort y and take the middle
  const sorted = Array.from(y).sort((a, b) => a - b);
  assert.ok(close(sorted[Math.floor(N / 2)], 0, 1e-9));
});

test('NST: ties — midpoint mode gives equal scores', () => {
  // Three duplicates should all get the same score (average rank).
  const { y } = normal_score_transform([1, 2, 2, 2, 3], { tie: 'midpoint' });
  // y[1], y[2], y[3] should all equal — they're tied.
  assert.ok(close(y[1], y[2], 1e-12));
  assert.ok(close(y[2], y[3], 1e-12));
});

test('NST: ties — random mode breaks them differently each time', () => {
  // With different seeds, the order of tied values should differ.
  const a = normal_score_transform([1, 2, 2, 2, 3], { tie: 'random', random_state: 1 });
  const b = normal_score_transform([1, 2, 2, 2, 3], { tie: 'random', random_state: 2 });
  // At least one of the y values for the tied indices should differ.
  let differ = false;
  for (let i = 1; i <= 3; i++) {
    if (!close(a.y[i], b.y[i], 1e-9)) { differ = true; break; }
  }
  assert.ok(differ, 'random tie-breaking gave identical results across seeds');
});

// ── inverse transform ───────────────────────────────────────────────

test('NST: forward then inverse round-trip (interior)', () => {
  // For values strictly within the data range, inverse should recover them.
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const { y, inverse } = normal_score_transform(x);
  const back = inverse(y);
  for (let i = 0; i < x.length; i++) {
    assert.ok(close(back[i], x[i], 1e-9), `inverse[${i}] = ${back[i]}, want ${x[i]}`);
  }
});

test('NST: inverse on scalar input', () => {
  const x = [1, 2, 3, 4, 5];
  const { inverse } = normal_score_transform(x);
  // y=0 → median ≈ 3
  assert.ok(close(inverse(0), 3, 1e-9));
});

test('NST: inverse with linear tail extrapolation', () => {
  const x = [10, 20, 30, 40, 50];
  const { inverse } = normal_score_transform(x, { tail: 'linear' });
  // A very large positive y should extrapolate above 50 (no clip set).
  const v = inverse(5);
  assert.ok(v >= 50, `expected v ≥ 50, got ${v}`);
});

test('NST: inverse with tail_max clip', () => {
  const x = [10, 20, 30, 40, 50];
  const { inverse } = normal_score_transform(x, { tail: 'linear', tail_max: 60 });
  const v = inverse(10);  // far in the upper tail
  assert.ok(v <= 60 + 1e-9, `expected v ≤ 60, got ${v}`);
});

// ── BDL handling ─────────────────────────────────────────────────────

test('NST: BDL replacement with half rule', () => {
  // Values ≤ 0.5 get replaced with 0.25.
  const x = [0.1, 0.3, 0.5, 1, 2, 3];
  const { y, table } = normal_score_transform(x, {
    bdl: { value: 0.5, replace: 'half' },
  });
  // The first three values should all map to the same x_sorted (0.25), so their
  // y scores should all be tied to whatever the 0.25 group gets.
  // Easier to check: smallest unique x_sorted value is 0.25.
  assert.ok(close(table.x_sorted[0], 0.25, 1e-12));
});

// ── weighted ─────────────────────────────────────────────────────────

test('NST: weighted plotting positions', () => {
  // Equal weights should match unweighted (Hazen-style).
  const x = [1, 2, 3, 4, 5];
  const a = normal_score_transform(x);
  const b = normal_score_transform(x, { weights: [1, 1, 1, 1, 1] });
  // Allow tiny numerical difference between formulas
  for (let i = 0; i < 5; i++) {
    assert.ok(close(a.y[i], b.y[i], 1e-9), `i=${i}: ${a.y[i]} vs ${b.y[i]}`);
  }
});

test('NST: heavily-weighted sample dominates', () => {
  // Three samples with weights [1, 100, 1] — the middle one's score should
  // be near zero (it carries most of the mass; its plotting position lands
  // close to the cumulative midpoint).
  const x = [1, 2, 3];
  const w = [1, 100, 1];
  const { y } = normal_score_transform(x, { weights: w });
  // y for the heavy sample should be close to ndtri(0.5) = 0
  assert.ok(Math.abs(y[1]) < 0.1, `heavy sample y = ${y[1]}, want ≈0`);
});

// ── error handling ───────────────────────────────────────────────────

test('NST: weight length mismatch throws', () => {
  assert.throws(() => normal_score_transform([1, 2, 3], { weights: [1, 1] }));
});

test('NST: empty input', () => {
  const { y, table } = normal_score_transform([]);
  assert.equal(y.length, 0);
  assert.equal(table.x_sorted.length, 0);
});
