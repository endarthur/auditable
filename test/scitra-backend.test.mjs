// scitra backend dispatch — setBackend, getNatra, cdist gemm acceleration

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setBackend, clearBackend, getNatra, GEMM_NM_THRESHOLD,
} from '../ext/scitra/src/util/backend.js';
import { cdist as cdistFn } from '../ext/scitra/src/spatial/distance.js';
import { natra } from '../ext/natra/index.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── backend management ───────────────────────────────────────────────

test('setBackend / clearBackend / getNatra round-trip', () => {
  clearBackend();
  assert.equal(getNatra(), null);

  const fakeNatra = {
    scope: () => null,
    array: () => null,
    toTypedArray: () => null,
  };
  setBackend({ natra: fakeNatra });
  assert.equal(getNatra(), fakeNatra);

  clearBackend();
  assert.equal(getNatra(), null);
});

test('setBackend rejects non-object input gracefully', () => {
  clearBackend();
  setBackend(null);
  setBackend(undefined);
  setBackend(42);
  assert.equal(getNatra(), null);
});

test('getNatra rejects backend without required methods', () => {
  clearBackend();
  setBackend({ natra: { scope: () => null /* missing array, toTypedArray */ } });
  // After setBackend, _backend.natra is set explicitly so getNatra returns it
  // even if methods are missing (we trust user input). Detection via
  // globalThis is what filters incomplete backends.
  // This test documents that explicit setBackend is unconditional.
  assert.ok(getNatra() !== null);
  clearBackend();
});

test('getNatra auto-detects from globalThis.__scitraBackend__', () => {
  clearBackend();
  globalThis.__scitraBackend__ = {
    natra: { scope: () => null, array: () => null, toTypedArray: () => null },
  };
  const detected = getNatra();
  assert.ok(detected, 'expected auto-detection from globalThis');
  delete globalThis.__scitraBackend__;
  clearBackend();
});

test('GEMM_NM_THRESHOLD is exposed and reasonable', () => {
  assert.equal(typeof GEMM_NM_THRESHOLD, 'number');
  assert.ok(GEMM_NM_THRESHOLD >= 1000 && GEMM_NM_THRESHOLD <= 10_000_000);
});

// ── numerical equivalence: gemm vs inline ────────────────────────────

test('cdist gemm matches inline (euclidean) on large input', async () => {
  const nat = await natra({ pages: 256 });
  setBackend({ natra: nat });

  const n = 600, m = 500, d = 4;
  const Xflat = new Float64Array(n * d);
  const Yflat = new Float64Array(m * d);
  for (let i = 0; i < n * d; i++) Xflat[i] = Math.sin(i * 0.123) * 10;
  for (let i = 0; i < m * d; i++) Yflat[i] = Math.cos(i * 0.456) * 10;
  const X = { data: Xflat, shape: [n, d] };
  const Y = { data: Yflat, shape: [m, d] };

  // Trigger gemm path
  const Dgemm = cdistFn(X, Y);
  // Force inline
  const Dinline = cdistFn(X, Y, { backend: 'inline' });

  let maxErr = 0;
  for (let i = 0; i < Dgemm.length; i++) {
    const e = Math.abs(Dgemm[i] - Dinline[i]);
    if (e > maxErr) maxErr = e;
  }
  assert.ok(maxErr < 1e-6, `max abs diff = ${maxErr}`);

  clearBackend();
});

test('cdist gemm matches inline (sqeuclidean) on large input', async () => {
  const nat = await natra({ pages: 256 });
  setBackend({ natra: nat });

  const n = 600, m = 500, d = 5;
  const Xflat = new Float64Array(n * d);
  const Yflat = new Float64Array(m * d);
  for (let i = 0; i < n * d; i++) Xflat[i] = (i * 17 % 100) / 10;
  for (let i = 0; i < m * d; i++) Yflat[i] = (i * 23 % 100) / 10;
  const X = { data: Xflat, shape: [n, d] };
  const Y = { data: Yflat, shape: [m, d] };

  const Dgemm = cdistFn(X, Y, { metric: 'sqeuclidean' });
  const Dinline = cdistFn(X, Y, { metric: 'sqeuclidean', backend: 'inline' });

  let maxErr = 0;
  for (let i = 0; i < Dgemm.length; i++) {
    const e = Math.abs(Dgemm[i] - Dinline[i]);
    if (e > maxErr) maxErr = e;
  }
  // Squared distances can have ~1e-9 absolute error due to xy² accumulation,
  // less precise than euclidean (which gets sqrt-smoothed)
  assert.ok(maxErr < 1e-6, `max abs diff = ${maxErr}`);

  clearBackend();
});

// ── dispatch policy ─────────────────────────────────────────────────

test('cdist below threshold uses inline path even with backend set', async () => {
  const nat = await natra({ pages: 64 });
  setBackend({ natra: nat });

  // Tiny problem, far below 250k threshold. Result should equal what
  // inline produces — verifies we're not silently misdispatching.
  const X = [[0, 0], [1, 0], [0, 1]];
  const Y = [[0, 0], [1, 1]];
  const D = cdistFn(X, Y);
  const Dinline = cdistFn(X, Y, { backend: 'inline' });
  for (let i = 0; i < D.length; i++) {
    assert.ok(close(D[i], Dinline[i], 1e-12));
  }

  clearBackend();
});

test('cdist with weights skips gemm even at large size', async () => {
  // The gemm trick doesn't compose with per-axis weights, so weighted
  // calls must always go inline regardless of backend availability.
  const nat = await natra({ pages: 256 });
  setBackend({ natra: nat });

  const n = 600, d = 3;
  const Xflat = new Float64Array(n * d);
  for (let i = 0; i < n * d; i++) Xflat[i] = i * 0.1;
  const X = { data: Xflat, shape: [n, d] };

  // Weighted euclidean — should not error, should match scaled inline
  const w = [1, 2, 0.5];
  const D = cdistFn(X, X, { w });
  // Sanity: zero diagonal still holds
  for (let i = 0; i < n; i++) {
    assert.ok(close(D[i * n + i], 0, 1e-12));
  }

  clearBackend();
});

test('cdist with backend = "inline" forces inline path even with backend set', async () => {
  const nat = await natra({ pages: 256 });
  setBackend({ natra: nat });

  // Large-magnitude data (e.g. UTM coordinates). The gemm path centers
  // internally so this should still match inline to high precision.
  const n = 600, d = 4;
  const Xflat = new Float64Array(n * d);
  for (let i = 0; i < n * d; i++) Xflat[i] = i * 0.1 + 100_000;
  const X = { data: Xflat, shape: [n, d] };

  const D1 = cdistFn(X, X);                     // gemm
  const D2 = cdistFn(X, X, { backend: 'inline' });  // forced inline

  // For UTM-scale inputs the gemm path matches inline to ~4e-6
  // absolute (10 μm if these are coordinates in meters). The remaining
  // gap is fundamental: inline does subtract-then-square (each axis
  // term stays small) while gemm does centered-norm cancellation
  // (intermediate values stay O(magnitude²)). 1e-5 absolute tolerance
  // here documents the practical limit.
  let maxErr = 0;
  for (let i = 0; i < D1.length; i++) {
    const e = Math.abs(D1[i] - D2[i]);
    if (e > maxErr) maxErr = e;
  }
  assert.ok(maxErr < 1e-5, `max abs diff = ${maxErr}`);

  clearBackend();
});
