// natra f32 dispatch — array creation + matmul/dot route to alpack s* kernels.
//
// v0.2.0 minimum viable surface: array(), zeros() with dtype option, matmul
// and dot that pick sgemm/sdot based on input dtype. Other ops throw a clear
// error on f32 inputs (deferred to v0.2.x).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { natra } from '../ext/natra/index.js';

const close = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;
const close64 = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('array(data, { dtype: "f32" }) creates a Float32-backed array', async () => {
  const ctx = await natra({ pages: 256 });
  const a = ctx.array([1.5, 2.5, 3.5, 4.5], { dtype: 'f32' });
  assert.equal(a.dtype, 'f32');
  assert.equal(a.itemsize, 4);
  assert.equal(a.nbytes, 16);
  assert.deepEqual(a.shape, [4]);
});

test('array() default dtype is f64 (backwards-compat)', async () => {
  const ctx = await natra({ pages: 256 });
  const a = ctx.array([1, 2, 3]);
  assert.equal(a.dtype, 'f64');
  assert.equal(a.itemsize, 8);
});

test('zeros(shape, { dtype: "f32" }) allocates f32 zeros', async () => {
  const ctx = await natra({ pages: 256 });
  const z = ctx.zeros([3, 3], { dtype: 'f32' });
  assert.equal(z.dtype, 'f32');
  assert.equal(z.nbytes, 36);
  // Read back values
  const f32 = new Float32Array(z.memory.buffer, z.ptr, 9);
  for (let i = 0; i < 9; i++) assert.equal(f32[i], 0);
});

test('matmul dispatches to sgemm for f32 inputs', async () => {
  const ctx = await natra({ pages: 256 });
  const A = ctx.array([[1, 2], [3, 4]], { dtype: 'f32' });
  const B = ctx.array([[5, 6], [7, 8]], { dtype: 'f32' });
  // [[1,2],[3,4]] × [[5,6],[7,8]] = [[19,22],[43,50]]
  const C = ctx.scope(s => {
    const r = s.matmul(A, B);
    return r;
  });
  assert.equal(C.dtype, 'f32');
  assert.deepEqual(C.shape, [2, 2]);
  const data = new Float32Array(C.memory.buffer, C.ptr, 4);
  assert.ok(close(data[0], 19));
  assert.ok(close(data[1], 22));
  assert.ok(close(data[2], 43));
  assert.ok(close(data[3], 50));
});

test('matmul dispatches to dgemm for f64 (unchanged)', async () => {
  const ctx = await natra({ pages: 256 });
  const A = ctx.array([[1, 2], [3, 4]]);
  const B = ctx.array([[5, 6], [7, 8]]);
  const C = ctx.scope(s => s.matmul(A, B));
  assert.equal(C.dtype, 'f64');
  const data = new Float64Array(C.memory.buffer, C.ptr, 4);
  assert.ok(close64(data[0], 19));
  assert.ok(close64(data[3], 50));
});

test('matmul throws on dtype mismatch (no auto-upcast)', async () => {
  const ctx = await natra({ pages: 256 });
  const A = ctx.array([[1, 2], [3, 4]], { dtype: 'f32' });
  const B = ctx.array([[5, 6], [7, 8]]);  // f64
  assert.throws(() => ctx.scope(s => s.matmul(A, B)), /dtype mismatch/);
});

test('dot dispatches to sdot for f32', async () => {
  const ctx = await natra({ pages: 256 });
  const a = ctx.array([1, 2, 3, 4], { dtype: 'f32' });
  const b = ctx.array([5, 6, 7, 8], { dtype: 'f32' });
  // dot = 1*5 + 2*6 + 3*7 + 4*8 = 70
  const r = ctx.scope(s => s.dot(a, b));
  assert.ok(close(r, 70));
});

test('dot dispatches to ddot for f64', async () => {
  const ctx = await natra({ pages: 256 });
  const a = ctx.array([1, 2, 3, 4]);
  const b = ctx.array([5, 6, 7, 8]);
  const r = ctx.scope(s => s.dot(a, b));
  assert.ok(close64(r, 70));
});

test('add throws clear error on f32 inputs (not yet implemented)', async () => {
  const ctx = await natra({ pages: 256 });
  const a = ctx.array([1, 2, 3], { dtype: 'f32' });
  const b = ctx.array([4, 5, 6], { dtype: 'f32' });
  assert.throws(
    () => ctx.scope(s => s.add(a, b)),
    /f32 inputs not yet supported/,
  );
});

test('matmul performance: 100×100 f32 vs f64 (sanity check that sgemm is faster)', async () => {
  const ctx = await natra({ pages: 1024 });
  const N = 100;
  const Adata = new Array(N).fill(0).map((_, i) =>
    new Array(N).fill(0).map((_, j) => Math.sin(i * N + j)));
  const Bdata = new Array(N).fill(0).map((_, i) =>
    new Array(N).fill(0).map((_, j) => Math.cos(i * N + j)));
  const A_f32 = ctx.array(Adata, { dtype: 'f32' });
  const B_f32 = ctx.array(Bdata, { dtype: 'f32' });
  const A_f64 = ctx.array(Adata);
  const B_f64 = ctx.array(Bdata);
  // Warm up
  for (let i = 0; i < 3; i++) ctx.scope(s => { s.matmul(A_f32, B_f32); });
  for (let i = 0; i < 3; i++) ctx.scope(s => { s.matmul(A_f64, B_f64); });
  // Best-of-trials: a single timed block loses to one scheduler hiccup on a
  // shared CI runner; the MIN across interleaved trials is what the code can
  // actually do, so noise spikes can't flip the comparison.
  const trial = (Am, Bm) => {
    const t = performance.now();
    for (let i = 0; i < 10; i++) ctx.scope(s => { s.matmul(Am, Bm); });
    return performance.now() - t;
  };
  let t32 = Infinity, t64 = Infinity;
  for (let k = 0; k < 5; k++) {
    t32 = Math.min(t32, trial(A_f32, B_f32));
    t64 = Math.min(t64, trial(A_f64, B_f64));
  }
  // f32 should be roughly 2× faster than f64 at this size (4-lane vs 2-lane SIMD)
  // Allow some variance — just check f32 is meaningfully faster
  console.log(`  100×100 matmul (best of 5×10): f32=${(t32/10).toFixed(3)}ms, f64=${(t64/10).toFixed(3)}ms`);
  assert.ok(t32 < t64 * 0.85, `expected f32 to be < 85% of f64 time, got f32=${t32}ms f64=${t64}ms`);
});
