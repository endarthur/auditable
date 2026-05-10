// Reduction tests — sum/mean/max/min/std/var/dot/norm.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  from, range, ones, zeros,
  sum, mean, max, min, std, variance, norm, dot,
} from '../ext/line/src/index.js';

const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-12) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

// ---------- sum ----------

test('sum without axis returns scalar', () => {
  assert.equal(sum(from([1, 2, 3, 4])), 10);
  assert.equal(sum(zeros([5])), 0);
  assert.equal(sum(ones([3, 4])), 12);
});

test('sum with axis on 2D', () => {
  const m = from([[1, 2, 3], [4, 5, 6]]);
  const r0 = sum(m, { axis: 0 });
  assert.deepEqual(r0.shape, [3]);
  assert.deepEqual(Array.from(r0.data), [5, 7, 9]);
  const r1 = sum(m, { axis: 1 });
  assert.deepEqual(r1.shape, [2]);
  assert.deepEqual(Array.from(r1.data), [6, 15]);
});

test('sum with axis on 3D', () => {
  // shape [2,2,2], values 0..7 row-major
  const a = from([0, 1, 2, 3, 4, 5, 6, 7], [2, 2, 2]);
  // axis 0: pair-wise sum across the outer axis → [2,2]
  const r0 = sum(a, { axis: 0 });
  assert.deepEqual(r0.shape, [2, 2]);
  assert.deepEqual(Array.from(r0.data), [4, 6, 8, 10]); // 0+4,1+5,2+6,3+7
  // axis 1
  const r1 = sum(a, { axis: 1 });
  assert.deepEqual(r1.shape, [2, 2]);
  assert.deepEqual(Array.from(r1.data), [2, 4, 10, 12]); // 0+2,1+3 / 4+6,5+7
  // axis 2
  const r2 = sum(a, { axis: 2 });
  assert.deepEqual(r2.shape, [2, 2]);
  assert.deepEqual(Array.from(r2.data), [1, 5, 9, 13]); // 0+1,2+3,4+5,6+7
});

test('sum with negative axis', () => {
  const m = from([[1, 2, 3], [4, 5, 6]]);
  // axis -1 == axis 1
  const r = sum(m, { axis: -1 });
  assert.deepEqual(Array.from(r.data), [6, 15]);
});

// ---------- mean ----------

test('mean without axis', () => {
  assert.equal(mean(from([1, 2, 3, 4, 5])), 3);
  assert.ok(Number.isNaN(mean(zeros([0]))));
});

test('mean with axis', () => {
  const m = from([[1, 2, 3], [4, 5, 6]]);
  const r = mean(m, { axis: 0 });
  assert.deepEqual(Array.from(r.data), [2.5, 3.5, 4.5]);
});

// ---------- max / min ----------

test('max / min without axis', () => {
  const a = from([3, 1, 4, 1, 5, 9, 2, 6]);
  assert.equal(max(a), 9);
  assert.equal(min(a), 1);
});

test('max / min with axis', () => {
  const m = from([[3, 1, 4], [1, 5, 9]]);
  assert.deepEqual(Array.from(max(m, { axis: 0 }).data), [3, 5, 9]);
  assert.deepEqual(Array.from(max(m, { axis: 1 }).data), [4, 9]);
  assert.deepEqual(Array.from(min(m, { axis: 0 }).data), [1, 1, 4]);
  assert.deepEqual(Array.from(min(m, { axis: 1 }).data), [1, 1]);
});

test('max of empty returns -Infinity, min returns +Infinity', () => {
  assert.equal(max(zeros([0])), -Infinity);
  assert.equal(min(zeros([0])), Infinity);
});

// ---------- variance / std ----------

test('variance / std without axis (population)', () => {
  // mean = 3; deviations = [-2,-1,0,1,2]; sumsq = 10; var = 2; std = sqrt(2)
  const a = from([1, 2, 3, 4, 5]);
  assert.ok(close(variance(a), 2));
  assert.ok(close(std(a), Math.sqrt(2)));
});

test('variance with ddof=1 (sample)', () => {
  const a = from([1, 2, 3, 4, 5]);
  // sample variance: sumsq / (n-1) = 10/4 = 2.5
  assert.ok(close(variance(a, { ddof: 1 }), 2.5));
});

test('variance with axis', () => {
  // each row should have its own variance. Row 0: mean=2, var=2/3.
  // Row 1: [10,11,12], mean=11, deviations [-1,0,1], sumsq=2, var=2/3.
  const m = from([[1, 2, 3], [10, 11, 12]]);
  const r = variance(m, { axis: 1 });
  assert.deepEqual(r.shape, [2]);
  assert.ok(close(r.data[0], 2 / 3));
  assert.ok(close(r.data[1], 2 / 3));
});

// ---------- norm ----------

test('norm computes L2 of flattened', () => {
  // sqrt(3^2 + 4^2) = 5
  assert.equal(norm(from([3, 4])), 5);
  // 2D: sqrt(1+4+9+16+25+36) = sqrt(91)
  const m = from([[1, 2, 3], [4, 5, 6]]);
  assert.ok(close(norm(m), Math.sqrt(91)));
  assert.equal(norm(zeros([5])), 0);
});

// ---------- dot ----------

test('dot 1D · 1D returns scalar', () => {
  // [1,2,3] · [4,5,6] = 4+10+18 = 32
  assert.equal(dot(from([1, 2, 3]), from([4, 5, 6])), 32);
  assert.throws(() => dot(from([1, 2]), from([1, 2, 3])), /length mismatch/);
});

test('dot 2D · 1D = matrix-vector', () => {
  const M = from([[1, 2, 3], [4, 5, 6]]);  // 2×3
  const v = from([10, 20, 30]);
  // [1*10+2*20+3*30, 4*10+5*20+6*30] = [140, 320]
  const r = dot(M, v);
  assert.deepEqual(r.shape, [2]);
  assert.deepEqual(Array.from(r.data), [140, 320]);
});

test('dot 1D · 2D = vector-matrix', () => {
  const v = from([1, 2]);
  const M = from([[10, 20, 30], [40, 50, 60]]);  // 2×3
  // row vector × matrix: [1*10+2*40, 1*20+2*50, 1*30+2*60] = [90, 120, 150]
  const r = dot(v, M);
  assert.deepEqual(r.shape, [3]);
  assert.deepEqual(Array.from(r.data), [90, 120, 150]);
});

test('dot 2D · 2D = matmul', () => {
  // [[1,2],[3,4]] × [[5,6],[7,8]] = [[19,22],[43,50]]
  const A = from([[1, 2], [3, 4]]);
  const B = from([[5, 6], [7, 8]]);
  const C = dot(A, B);
  assert.deepEqual(C.shape, [2, 2]);
  assert.deepEqual(Array.from(C.data), [19, 22, 43, 50]);
});

test('dot rejects unsupported ndim', () => {
  // 3D × 2D → not supported in v1
  const a = from([1, 2, 3, 4, 5, 6, 7, 8], [2, 2, 2]);
  const b = from([[1, 2], [3, 4]]);
  assert.throws(() => dot(a, b), /unsupported ndim/);
});

// ---------- regression sanity over a known matrix ----------

test('reduction stack on a 4×4 block', () => {
  const m = from(range(16).toArray(), [4, 4]); // 0..15
  // total sum = 0+1+...+15 = 120
  assert.equal(sum(m), 120);
  // row sums = [0+1+2+3, 4+5+6+7, 8+9+10+11, 12+13+14+15] = [6, 22, 38, 54]
  assert.deepEqual(Array.from(sum(m, { axis: 1 }).data), [6, 22, 38, 54]);
  // col sums = [0+4+8+12, 1+5+9+13, 2+6+10+14, 3+7+11+15] = [24, 28, 32, 36]
  assert.deepEqual(Array.from(sum(m, { axis: 0 }).data), [24, 28, 32, 36]);
});
