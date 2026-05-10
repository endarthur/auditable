// Tests for v0.1.1 additions: extended ops, selection, more reductions,
// stack/concat, diag/outer/tril/triu.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NdArray,
  from, range, zeros, ones, eye,
  // unary additions
  asin, acos, atan, floor, ceil, round, sign, isnan, isfinite,
  // binary additions
  atan2, hypot, maximum, minimum,
  eq, ne, lt, le, gt, ge,
  // selection
  where, clip,
  // reductions
  prod, cumsum, cumprod, argmin, argmax, trace,
  // shape
  stack, concat,
  // linalg helpers
  diag, outer, tril, triu, matmul,
} from '../ext/vec/src/index.js';

const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-12) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

// ───────────────────────── Unary additions ─────────────────────────

test('asin / acos / atan', () => {
  assert.ok(arrClose(asin(from([0, 0.5, 1])).data, [0, Math.PI / 6, Math.PI / 2]));
  assert.ok(arrClose(acos(from([1, 0, -1])).data, [0, Math.PI / 2, Math.PI]));
  assert.ok(arrClose(atan(from([0, 1])).data, [0, Math.PI / 4]));
});

test('floor / ceil / round / sign', () => {
  assert.deepEqual(Array.from(floor(from([-1.5, 0.5, 2.7])).data), [-2, 0, 2]);
  assert.deepEqual(Array.from(ceil(from([-1.5, 0.5, 2.3])).data), [-1, 1, 3]);
  assert.deepEqual(Array.from(round(from([-1.5, 0.4, 2.5])).data), [-1, 0, 3]); // banker's round? JS Math.round goes towards +Inf for .5
  assert.deepEqual(Array.from(sign(from([-3, 0, 5])).data), [-1, 0, 1]);
});

test('isnan / isfinite return 0/1 masks', () => {
  const a = from([1, NaN, Infinity, -Infinity, 0]);
  assert.deepEqual(Array.from(isnan(a).data), [0, 1, 0, 0, 0]);
  assert.deepEqual(Array.from(isfinite(a).data), [1, 0, 0, 0, 1]);
});

// ───────────────────────── Binary additions ────────────────────────

test('atan2 — matches Math.atan2 on each element', () => {
  const y = from([1, 0, -1, 0]);
  const x = from([1, 1, 0, -1]);
  const r = atan2(y, x);
  assert.ok(arrClose(r.data, [Math.PI / 4, 0, -Math.PI / 2, Math.PI]));
});

test('atan2 with scalar', () => {
  const y = from([1, -1, 0]);
  const r = atan2(y, 1);
  assert.ok(arrClose(r.data, [Math.atan2(1, 1), Math.atan2(-1, 1), 0]));
});

test('hypot — sqrt(a²+b²)', () => {
  const a = from([3, 5]);
  const b = from([4, 12]);
  assert.ok(arrClose(hypot(a, b).data, [5, 13]));
});

test('maximum / minimum element-wise', () => {
  const a = from([1, 5, 3]);
  const b = from([4, 2, 3]);
  assert.deepEqual(Array.from(maximum(a, b).data), [4, 5, 3]);
  assert.deepEqual(Array.from(minimum(a, b).data), [1, 2, 3]);
});

test('maximum with scalar (broadcasts)', () => {
  const a = from([1, 5, 3, 0]);
  assert.deepEqual(Array.from(maximum(a, 2).data), [2, 5, 3, 2]);
});

test('comparison ops return 0/1 masks', () => {
  const a = from([1, 2, 3]);
  const b = from([2, 2, 2]);
  assert.deepEqual(Array.from(eq(a, b).data), [0, 1, 0]);
  assert.deepEqual(Array.from(ne(a, b).data), [1, 0, 1]);
  assert.deepEqual(Array.from(lt(a, b).data), [1, 0, 0]);
  assert.deepEqual(Array.from(le(a, b).data), [1, 1, 0]);
  assert.deepEqual(Array.from(gt(a, b).data), [0, 0, 1]);
  assert.deepEqual(Array.from(ge(a, b).data), [0, 1, 1]);
});

test('comparison ops broadcast', () => {
  // 1D vec broadcast across rows of 2D
  const m = from([[1, 2, 3], [4, 5, 6]]);
  const v = from([2, 5, 5]);
  assert.deepEqual(Array.from(lt(m, v).data), [1, 1, 1, 0, 0, 0]); // [m<v] elem-wise broadcast
});

// ───────────────────────── Selection ───────────────────────────────

test('where with scalars', () => {
  const cond = from([1, 0, 1, 0]);
  const r = where(cond, 99, -1);
  assert.deepEqual(Array.from(r.data), [99, -1, 99, -1]);
});

test('where with arrays', () => {
  const cond = from([1, 0, 1, 0]);
  const a = from([10, 20, 30, 40]);
  const b = from([100, 200, 300, 400]);
  assert.deepEqual(Array.from(where(cond, a, b).data), [10, 200, 30, 400]);
});

test('where shape mismatch throws', () => {
  const cond = from([1, 0]);
  const a = from([1, 2, 3]);
  assert.throws(() => where(cond, a, 0), /must match/);
});

test('clip clamps to range', () => {
  const a = from([-5, 0, 5, 15, 100]);
  assert.deepEqual(Array.from(clip(a, 0, 10).data), [0, 0, 5, 10, 10]);
});

// ───────────────────────── Reductions ──────────────────────────────

test('prod without axis', () => {
  assert.equal(prod(from([1, 2, 3, 4])), 24);
  assert.equal(prod(from([2, 0, 5])), 0);
});

test('prod with axis', () => {
  const m = from([[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(Array.from(prod(m, { axis: 0 }).data), [4, 10, 18]);
  assert.deepEqual(Array.from(prod(m, { axis: 1 }).data), [6, 120]);
});

test('cumsum 1D', () => {
  assert.deepEqual(Array.from(cumsum(from([1, 2, 3, 4])).data), [1, 3, 6, 10]);
});

test('cumsum without axis flattens', () => {
  // numpy convention: cumsum on 2D with no axis flattens
  const m = from([[1, 2], [3, 4]]);
  const r = cumsum(m);
  assert.deepEqual(r.shape, [4]);
  assert.deepEqual(Array.from(r.data), [1, 3, 6, 10]);
});

test('cumsum with axis', () => {
  const m = from([[1, 2, 3], [4, 5, 6]]);
  const r = cumsum(m, { axis: 0 });
  // cumulative along rows: [[1,2,3],[5,7,9]]
  assert.deepEqual(r.shape, [2, 3]);
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 5, 7, 9]);
  const r1 = cumsum(m, { axis: 1 });
  // cumulative along cols: [[1,3,6],[4,9,15]]
  assert.deepEqual(Array.from(r1.data), [1, 3, 6, 4, 9, 15]);
});

test('cumprod', () => {
  assert.deepEqual(Array.from(cumprod(from([1, 2, 3, 4])).data), [1, 2, 6, 24]);
  const m = from([[1, 2], [3, 4]]);
  const r = cumprod(m, { axis: 1 });
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 12]);
});

test('argmin / argmax without axis', () => {
  const a = from([3, 1, 4, 1, 5, 9, 2, 6]);
  assert.equal(argmin(a), 1); // first occurrence wins (strictly-less)
  assert.equal(argmax(a), 5);
});

test('argmin / argmax with axis', () => {
  const m = from([[3, 1, 4], [1, 5, 9], [2, 6, 0]]);
  assert.deepEqual(Array.from(argmin(m, { axis: 0 }).data), [1, 0, 2]);
  assert.deepEqual(Array.from(argmin(m, { axis: 1 }).data), [1, 0, 2]);
  assert.deepEqual(Array.from(argmax(m, { axis: 0 }).data), [0, 2, 1]);
  assert.deepEqual(Array.from(argmax(m, { axis: 1 }).data), [2, 2, 1]);
});

test('trace', () => {
  // identity: trace = n
  assert.equal(trace(eye(5)), 5);
  // arbitrary
  assert.equal(trace(from([[1, 2, 3], [4, 5, 6], [7, 8, 9]])), 1 + 5 + 9);
  // rectangular: min(rows, cols) entries
  assert.equal(trace(from([[1, 2, 3], [4, 5, 6]])), 1 + 5);
});

// ───────────────────────── Shape: stack / concat ──────────────────

test('concat along axis 0', () => {
  const a = from([[1, 2], [3, 4]]);
  const b = from([[5, 6], [7, 8], [9, 10]]);
  const r = concat([a, b], 0);
  assert.deepEqual(r.shape, [5, 2]);
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('concat along axis 1', () => {
  const a = from([[1, 2], [3, 4]]);
  const b = from([[5, 6, 7], [8, 9, 10]]);
  const r = concat([a, b], 1);
  assert.deepEqual(r.shape, [2, 5]);
  assert.deepEqual(Array.from(r.data), [1, 2, 5, 6, 7, 3, 4, 8, 9, 10]);
});

test('concat: incompatible shapes throw', () => {
  const a = from([[1, 2], [3, 4]]);
  const b = from([[5, 6, 7]]);
  assert.throws(() => concat([a, b], 0), /shape mismatch/);
});

test('stack along axis 0 (new leading axis)', () => {
  const a = from([1, 2, 3]);
  const b = from([4, 5, 6]);
  const r = stack([a, b], 0);
  assert.deepEqual(r.shape, [2, 3]);
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 4, 5, 6]);
});

test('stack along axis 1', () => {
  const a = from([1, 2, 3]);
  const b = from([4, 5, 6]);
  const r = stack([a, b], 1);
  assert.deepEqual(r.shape, [3, 2]);
  // shape [3, 2]: row i has [a[i], b[i]]
  assert.deepEqual(Array.from(r.data), [1, 4, 2, 5, 3, 6]);
});

test('stack 2D arrays into 3D', () => {
  const a = from([[1, 2], [3, 4]]);
  const b = from([[5, 6], [7, 8]]);
  const r = stack([a, b], 0);
  assert.deepEqual(r.shape, [2, 2, 2]);
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// ───────────────────────── linalg helpers ─────────────────────────

test('diag: 1D → 2D diagonal matrix', () => {
  const r = diag(from([1, 2, 3]));
  assert.deepEqual(r.shape, [3, 3]);
  assert.deepEqual(Array.from(r.data), [1, 0, 0, 0, 2, 0, 0, 0, 3]);
});

test('diag: 2D → 1D diagonal extraction', () => {
  const m = from([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.deepEqual(Array.from(diag(m).data), [1, 5, 9]);
});

test('diag with k offset (1D → super/sub diagonal)', () => {
  const r = diag(from([1, 2]), 1); // super-diagonal
  assert.deepEqual(r.shape, [3, 3]);
  // [[0,1,0],[0,0,2],[0,0,0]]
  assert.deepEqual(Array.from(r.data), [0, 1, 0, 0, 0, 2, 0, 0, 0]);
  const rs = diag(from([1, 2]), -1); // sub-diagonal
  // [[0,0,0],[1,0,0],[0,2,0]]
  assert.deepEqual(Array.from(rs.data), [0, 0, 0, 1, 0, 0, 0, 2, 0]);
});

test('diag 2D → super/sub-diagonal extraction', () => {
  const m = from([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.deepEqual(Array.from(diag(m, 1).data), [2, 6]);
  assert.deepEqual(Array.from(diag(m, -1).data), [4, 8]);
});

test('outer product', () => {
  const a = from([1, 2, 3]);
  const b = from([4, 5]);
  const r = outer(a, b);
  assert.deepEqual(r.shape, [3, 2]);
  // row i is a[i] * b: [4,5]*1, [4,5]*2, [4,5]*3
  assert.deepEqual(Array.from(r.data), [4, 5, 8, 10, 12, 15]);
});

test('tril zeros above main diagonal', () => {
  const m = from([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  const r = tril(m);
  assert.deepEqual(Array.from(r.data), [1, 0, 0, 4, 5, 0, 7, 8, 9]);
  // tril with k=1 keeps super-diagonal too
  const r1 = tril(m, 1);
  assert.deepEqual(Array.from(r1.data), [1, 2, 0, 4, 5, 6, 7, 8, 9]);
});

test('triu zeros below main diagonal', () => {
  const m = from([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  const r = triu(m);
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 0, 5, 6, 0, 0, 9]);
  // triu with k=-1 keeps sub-diagonal
  const r1 = triu(m, -1);
  assert.deepEqual(Array.from(r1.data), [1, 2, 3, 4, 5, 6, 0, 8, 9]);
});

test('tril and triu compose: tril + triu(k=1) = original (when no overlap)', () => {
  const m = from([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  // tril(0) keeps i ≥ j, triu(1) keeps j ≥ i + 1; sum = original
  const lower = tril(m, 0);
  const upper = triu(m, 1);
  const reconstructed = new Float64Array(9);
  for (let i = 0; i < 9; i++) reconstructed[i] = lower.data[i] + upper.data[i];
  assert.deepEqual(Array.from(reconstructed), Array.from(m.data));
});

test('diag-based matmul reconstruction (eigen-style)', () => {
  // Build A = V D V^T where V is identity and D is diag([2,3,5]).
  // Result should be diag(2,3,5) again.
  const D = diag(from([2, 3, 5]));
  const V = eye(3);
  const recon = matmul(matmul(V, D), V);
  assert.deepEqual(Array.from(recon.data), [2, 0, 0, 0, 3, 0, 0, 0, 5]);
});
