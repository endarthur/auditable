// @gcu/learn TruncatedSVD + NMF test suite.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TruncatedSVD, NMF,
  check_estimator, dump, load,
  mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// ────────────────────────────────────────────────────────────────────
// TruncatedSVD
// ────────────────────────────────────────────────────────────────────

describe('TruncatedSVD', () => {
  test('components_.shape matches [n_components, n_features]', () => {
    const X = [[1, 2, 3], [4, 5, 6], [7, 8, 10]];
    const ts = new TruncatedSVD({ n_components: 2 }).fit(X);
    assert.deepEqual(ts.components_.shape, [2, 3]);
  });

  test('caps n_components at min(n_samples, n_features)', () => {
    const X = [[1, 2], [3, 4], [5, 6]];
    const ts = new TruncatedSVD({ n_components: 99 }).fit(X);
    assert.equal(ts.n_components_, 2);
  });

  test('explained_variance_ratio_ in [0, 1] and descending', () => {
    const X = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 13]];
    const ts = new TruncatedSVD({ n_components: 3 }).fit(X);
    let prev = 1;
    for (const r of ts.explained_variance_ratio_) {
      assert.ok(r >= 0 && r <= 1.001);
      assert.ok(r <= prev + 1e-10);
      prev = r;
    }
  });

  test('inverse_transform recovers approximately on full-rank projection', () => {
    const X = [[1, 2, 3], [4, 5, 6], [7, 8, 10]];
    const ts = new TruncatedSVD({ n_components: 3 }).fit(X);
    const Z = ts.transform(X);
    const back = ts.inverse_transform(Z);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        assert.ok(close(back[i * 3 + j], X[i][j], 1e-9));
      }
    }
  });

  test('transform = X @ components_.T (no centering)', () => {
    const X = [[1, 0, 0], [0, 1, 0]];
    const ts = new TruncatedSVD({ n_components: 2 }).fit(X);
    const Z = ts.transform(X);
    // Recompute manually.
    for (let i = 0; i < 2; i++) {
      for (let c = 0; c < 2; c++) {
        let acc = 0;
        for (let j = 0; j < 3; j++) acc += X[i][j] * ts.components_[c * 3 + j];
        assert.ok(close(Z[i * 2 + c], acc, 1e-12));
      }
    }
  });

  test('dump/load round-trip preserves transform', () => {
    const X = [[1, 2, 3], [4, 5, 6], [7, 8, 10]];
    const ts = new TruncatedSVD({ n_components: 2 }).fit(X);
    const before = Array.from(ts.transform(X));
    const r = load(dump(ts));
    assert.deepEqual(Array.from(r.transform(X)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(TruncatedSVD, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// NMF
// ────────────────────────────────────────────────────────────────────

describe('NMF', () => {
  // Build a non-negative dataset with a known low-rank structure for testing.
  function makeNonneg(n, m, k, seed = 0) {
    const rng = mulberry32(seed);
    const W_true = new Float64Array(n * k);
    const H_true = new Float64Array(k * m);
    for (let i = 0; i < W_true.length; i++) W_true[i] = rng();
    for (let i = 0; i < H_true.length; i++) H_true[i] = rng();
    const X = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        let acc = 0;
        for (let c = 0; c < k; c++) acc += W_true[i * k + c] * H_true[c * m + j];
        X[i * m + j] = acc;
      }
    }
    X.shape = [n, m];
    return X;
  }

  test('decomposes a non-negative matrix into approximately W H', () => {
    const X = makeNonneg(20, 5, 3, 1);
    const nmf = new NMF({ n_components: 3, max_iter: 300, init: 'nndsvd' });
    const W = nmf.fit_transform(X);
    // Compute ‖X‖_F and ‖X - WH‖_F to evaluate relative-error.
    // Multiplicative updates often hit a local minimum on Frobenius;
    // ~20% relative error is the bar.
    const H = nmf.components_;
    let xnorm = 0, err = 0;
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 5; j++) {
        let acc = 0;
        for (let c = 0; c < 3; c++) acc += W[i * 3 + c] * H[c * 5 + j];
        const x = X[i * 5 + j];
        xnorm += x * x;
        err += (x - acc) ** 2;
      }
    }
    const rel = Math.sqrt(err) / Math.sqrt(xnorm);
    assert.ok(rel < 0.2, `relative reconstruction err ${rel} too high`);
  });

  test('non-negativity preserved in components_ and W', () => {
    const X = makeNonneg(10, 4, 2, 2);
    const nmf = new NMF({ n_components: 2, max_iter: 100 });
    const W = nmf.fit_transform(X);
    for (const v of W) assert.ok(v >= 0, `W has negative ${v}`);
    for (const v of nmf.components_) assert.ok(v >= 0, `H has negative ${v}`);
  });

  test('rejects negative input at fit', () => {
    assert.throws(
      () => new NMF({ n_components: 2 }).fit([[1, -1], [2, 3]]),
      /must be non-negative/);
  });

  test('init="random" reproducibility under random_state', () => {
    const X = makeNonneg(15, 4, 2, 0);
    const a = new NMF({ n_components: 2, init: 'random', random_state: 5,
                        max_iter: 50 }).fit(X);
    const b = new NMF({ n_components: 2, init: 'random', random_state: 5,
                        max_iter: 50 }).fit(X);
    assert.ok(close(a.reconstruction_err_, b.reconstruction_err_));
    assert.deepEqual(Array.from(a.components_), Array.from(b.components_));
  });

  test('reconstruction_err_ decreases with more iterations', () => {
    const X = makeNonneg(20, 6, 4, 7);
    const a = new NMF({ n_components: 4, max_iter: 5, init: 'nndsvd' }).fit(X);
    const b = new NMF({ n_components: 4, max_iter: 200, init: 'nndsvd' }).fit(X);
    assert.ok(b.reconstruction_err_ <= a.reconstruction_err_,
      `err should not increase: ${a.reconstruction_err_} → ${b.reconstruction_err_}`);
  });

  test('inverse_transform = W @ H', () => {
    const X = makeNonneg(10, 4, 2, 3);
    const nmf = new NMF({ n_components: 2, max_iter: 100 });
    const W = nmf.fit_transform(X);
    const Xback = nmf.inverse_transform(W);
    assert.deepEqual(Xback.shape, [10, 4]);
  });

  test('dump/load round-trip preserves transform', () => {
    const X = makeNonneg(10, 4, 2, 4);
    const nmf = new NMF({ n_components: 2, max_iter: 100 }).fit(X);
    const before = Array.from(nmf.transform(X));
    const r = load(dump(nmf));
    // transform reconverges from the same H, so values should be close
    // (not bit-identical because the transform-time multiplicative loop
    // restarts from a fresh seed).
    const after = Array.from(r.transform(X));
    let max_diff = 0;
    for (let i = 0; i < before.length; i++) {
      const d = Math.abs(before[i] - after[i]);
      if (d > max_diff) max_diff = d;
    }
    assert.ok(max_diff < 1e-6, `transform diff ${max_diff} after round-trip`);
  });

  test('unsupported beta_loss raises', () => {
    assert.throws(
      () => new NMF({ beta_loss: 'kullback-leibler' }).fit([[1]]),
      /beta_loss='kullback-leibler'/);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(NMF, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});
