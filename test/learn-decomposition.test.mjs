// @gcu/learn decomposition test suite — PCA via line's SVD.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PCA, KMeans,
  Pipeline, make_pipeline,
  StandardScaler,
  check_estimator, dump, load,
  mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// Build n samples from 2 latent axes embedded in 4 dims, with noise on
// 2 trailing dims. The first two principal components should recover
// the latent axes; the rest should explain near-zero variance.
function makeLatent(n = 50, seed = 0) {
  const rng = mulberry32(seed);
  const X = [];
  for (let i = 0; i < n; i++) {
    const t1 = rng() * 10;
    const t2 = rng() * 5;
    const noise1 = (rng() - 0.5) * 0.01;
    const noise2 = (rng() - 0.5) * 0.01;
    X.push([t1, 2 * t1, t2, t2 + noise1 + noise2]);
  }
  return X;
}

// ────────────────────────────────────────────────────────────────────
// PCA basic shape contract
// ────────────────────────────────────────────────────────────────────

describe('PCA', () => {
  test('default n_components = min(n_samples, n_features)', () => {
    const X = [[1, 2, 3], [4, 5, 6], [7, 8, 10], [11, 12, 14]];
    const pca = new PCA().fit(X);
    assert.equal(pca.n_components_, 3);  // min(4, 3)
    assert.deepEqual(pca.components_.shape, [3, 3]);
  });

  test('n_components caps to k_max', () => {
    const X = [[1, 2], [3, 4], [5, 6]];
    const pca = new PCA({ n_components: 99 }).fit(X);
    assert.equal(pca.n_components_, 2);  // m=2
  });

  test('components are sorted by explained variance (descending)', () => {
    const X = makeLatent(50, 0);
    const pca = new PCA().fit(X);
    for (let c = 1; c < pca.n_components_; c++) {
      assert.ok(pca.explained_variance_[c - 1] >= pca.explained_variance_[c],
        `EV not descending at index ${c}: ${pca.explained_variance_[c - 1]} < ${pca.explained_variance_[c]}`);
    }
  });

  test('explained_variance_ratio_ sums to 1 when keeping all components', () => {
    const X = makeLatent(50, 0);
    const pca = new PCA().fit(X);
    let total = 0;
    for (const v of pca.explained_variance_ratio_) total += v;
    assert.ok(close(total, 1, 1e-10), `ratios sum to ${total}`);
  });

  test('explained_variance_ratio_ sums to <1 with truncation', () => {
    const X = makeLatent(50, 0);
    const pca = new PCA({ n_components: 2 }).fit(X);
    let total = 0;
    for (const v of pca.explained_variance_ratio_) total += v;
    assert.ok(total < 1, `ratios sum to ${total} should be < 1`);
    assert.ok(total > 0.99,
      `top 2 components on near-rank-2 data should explain >99% (got ${total})`);
  });

  test('components are orthonormal (rows have unit norm + mutual orthogonality)', () => {
    const X = makeLatent(50, 1);
    const pca = new PCA().fit(X);
    const k = pca.n_components_;
    const m = pca.n_features_in_;
    for (let a = 0; a < k; a++) {
      let na = 0;
      for (let j = 0; j < m; j++) na += pca.components_[a * m + j] ** 2;
      assert.ok(close(na, 1, 1e-10), `component ${a} norm² = ${na}`);
      for (let b = a + 1; b < k; b++) {
        let dot = 0;
        for (let j = 0; j < m; j++)
          dot += pca.components_[a * m + j] * pca.components_[b * m + j];
        assert.ok(close(dot, 0, 1e-10), `comp ${a}·${b} = ${dot}`);
      }
    }
  });

  test('inverse_transform recovers original when keeping all components', () => {
    const X = [[1, 2, 3], [4, 5, 6], [7, 8, 10]];
    const pca = new PCA().fit(X);
    const Z = pca.transform(X);
    const back = pca.inverse_transform(Z);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        assert.ok(close(back[i * 3 + j], X[i][j], 1e-10),
          `[${i},${j}] = ${back[i * 3 + j]} vs ${X[i][j]}`);
      }
    }
  });

  test('inverse_transform on truncated PCA reconstructs approximately', () => {
    const X = makeLatent(50, 7);
    const pca = new PCA({ n_components: 2 }).fit(X);
    const Z = pca.transform(X);
    const back = pca.inverse_transform(Z);
    let mse = 0;
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 4; j++) {
        const d = X[i][j] - back[i * 4 + j];
        mse += d * d;
      }
    }
    mse /= 50 * 4;
    assert.ok(mse < 0.01, `reconstruction MSE ${mse} too large`);
  });

  test('whiten=true produces unit-variance components', () => {
    // Use n_components=2 to skip the near-zero-variance noise components
    // — whitening can't make those unit-variance because dividing by
    // ~0 just gives 0 (or worse, NaN).
    const X = makeLatent(50, 0);
    const pca = new PCA({ n_components: 2, whiten: true }).fit(X);
    const Z = pca.transform(X);
    const k = pca.n_components_;
    for (let c = 0; c < k; c++) {
      let mean = 0; for (let i = 0; i < 50; i++) mean += Z[i * k + c]; mean /= 50;
      let var_ = 0; for (let i = 0; i < 50; i++) {
        const d = Z[i * k + c] - mean; var_ += d * d;
      }
      var_ /= 50;
      // After whitening, transformed columns should have ~unit variance.
      // Sample variance with population divisor; tolerance accounts for
      // the (n-1)/n bias factor in the whitening normalization.
      assert.ok(Math.abs(var_ - (49 / 50)) < 0.05,
        `component ${c} variance ${var_} should be ~1`);
    }
  });

  test('sign convention: max-magnitude entry positive', () => {
    const X = makeLatent(50, 3);
    const pca = new PCA().fit(X);
    const k = pca.n_components_;
    const m = pca.n_features_in_;
    for (let c = 0; c < k; c++) {
      let max_idx = 0, max_mag = 0;
      for (let j = 0; j < m; j++) {
        const a = Math.abs(pca.components_[c * m + j]);
        if (a > max_mag) { max_mag = a; max_idx = j; }
      }
      assert.ok(pca.components_[c * m + max_idx] > 0,
        `component ${c} max-magnitude entry should be positive`);
    }
  });

  test('singular_values_ is sorted descending and matches sqrt of EV', () => {
    const X = makeLatent(50, 0);
    const pca = new PCA().fit(X);
    for (let c = 1; c < pca.n_components_; c++) {
      assert.ok(pca.singular_values_[c - 1] >= pca.singular_values_[c]);
    }
    // EV = s² / (n-1) → s = sqrt(EV * (n-1))
    for (let c = 0; c < pca.n_components_; c++) {
      const expected = Math.sqrt(pca.explained_variance_[c] * (pca.n_samples_ - 1));
      assert.ok(close(pca.singular_values_[c], expected, 1e-8));
    }
  });

  test('predict raises on n_features mismatch', () => {
    const pca = new PCA().fit([[1, 2], [3, 4]]);
    assert.throws(() => pca.transform([[1, 2, 3]]),
      /3 features.*fitted with 2/);
  });

  test('n_samples=1 raises (no variance)', () => {
    assert.throws(() => new PCA().fit([[1, 2, 3]]), /n_samples=1.*>= 2/);
  });
});

// ────────────────────────────────────────────────────────────────────
// dump/load round-trip
// ────────────────────────────────────────────────────────────────────

describe('PCA dump/load', () => {
  test('round-trip preserves transform output', () => {
    const X = makeLatent(30, 5);
    const pca = new PCA({ n_components: 2 }).fit(X);
    const before = Array.from(pca.transform(X));
    const r = load(dump(pca));
    assert.deepEqual(Array.from(r.transform(X)), before);
  });

  test('whiten state preserved across round-trip', () => {
    const X = makeLatent(30, 5);
    const pca = new PCA({ n_components: 2, whiten: true }).fit(X);
    const before = Array.from(pca.transform(X));
    const r = load(dump(pca));
    assert.equal(r.whiten, true);
    assert.deepEqual(Array.from(r.transform(X)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// Pipeline integration
// ────────────────────────────────────────────────────────────────────

describe('PCA + Pipeline', () => {
  test('StandardScaler → PCA → KMeans converges on a separable dataset', () => {
    // Two clusters embedded in 5D.
    const X = [];
    for (let i = 0; i < 20; i++) {
      X.push([Math.random() + 0, Math.random() + 0, Math.random() + 0,
              Math.random() + 0, Math.random() + 0]);
    }
    for (let i = 0; i < 20; i++) {
      X.push([Math.random() + 5, Math.random() + 5, Math.random() + 5,
              Math.random() + 5, Math.random() + 5]);
    }
    const pipe = make_pipeline(
      new StandardScaler(),
      new PCA({ n_components: 2 }),
      new KMeans({ n_clusters: 2, n_init: 5, random_state: 0 }),
    );
    pipe.fit(X);
    // The inertia should be far less than for random clustering.
    assert.ok(pipe.named_steps['kmeans'].inertia_ < 100,
      `expected low inertia, got ${pipe.named_steps['kmeans'].inertia_}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// check_estimator
// ────────────────────────────────────────────────────────────────────

describe('check_estimator (PCA)', () => {
  test('passes', () => {
    const errs = check_estimator(PCA, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});
