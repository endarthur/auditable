// @gcu/learn mixture test suite — GaussianMixture (full covariance).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GaussianMixture,
  check_estimator, dump, load,
  mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// 3 well-separated 2D Gaussian blobs (n_per per cluster).
function makeBlobs(n_per = 30, seed = 0) {
  const rng = mulberry32(seed);
  const X = [];
  const centers = [[0, 0], [10, 0], [5, 9]];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n_per; i++) {
      X.push([centers[c][0] + (rng() - 0.5) * 1.0,
              centers[c][1] + (rng() - 0.5) * 1.0]);
    }
  }
  return { X, centers };
}

// Cluster purity: fraction matching dominant true label per predicted cluster.
function purity(true_labels, pred_labels, k) {
  const counts = Array.from({ length: k }, () => new Map());
  for (let i = 0; i < true_labels.length; i++) {
    const c = pred_labels[i] | 0;
    const t = true_labels[i];
    counts[c].set(t, (counts[c].get(t) ?? 0) + 1);
  }
  let hits = 0;
  for (let c = 0; c < k; c++) {
    let best = 0;
    for (const v of counts[c].values()) if (v > best) best = v;
    hits += best;
  }
  return hits / true_labels.length;
}

// ────────────────────────────────────────────────────────────────────
// Basic correctness
// ────────────────────────────────────────────────────────────────────

describe('GaussianMixture', () => {
  test('recovers cluster structure on separable blobs', () => {
    const { X, centers } = makeBlobs(30, 0);
    const true_labels = [];
    for (let c = 0; c < 3; c++) for (let i = 0; i < 30; i++) true_labels.push(c);
    const gmm = new GaussianMixture({
      n_components: 3, random_state: 1, n_init: 5,
    }).fit(X);
    const pred = gmm.predict(X);
    assert.ok(purity(true_labels, pred, 3) > 0.95);
    // Each fitted mean should be close to one of the true centers.
    for (let c = 0; c < 3; c++) {
      const my_mean = [gmm.means_[c * 2], gmm.means_[c * 2 + 1]];
      let min_d = Infinity;
      for (const ctr of centers) {
        const d = Math.hypot(my_mean[0] - ctr[0], my_mean[1] - ctr[1]);
        if (d < min_d) min_d = d;
      }
      assert.ok(min_d < 1, `mean ${my_mean} too far from any true center (min_d=${min_d})`);
    }
  });

  test('weights_ sums to 1', () => {
    const { X } = makeBlobs(30, 1);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 2 }).fit(X);
    let s = 0; for (const w of gmm.weights_) s += w;
    assert.ok(close(s, 1, 1e-10), `weights sum to ${s}`);
  });

  test('predict_proba rows sum to 1', () => {
    const { X } = makeBlobs(20, 2);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 3 }).fit(X);
    const P = gmm.predict_proba(X);
    for (let i = 0; i < P.shape[0]; i++) {
      let s = 0; for (let c = 0; c < 3; c++) s += P[i * 3 + c];
      assert.ok(close(s, 1, 1e-8), `row ${i} sums to ${s}`);
    }
  });

  test('covariances_ are SPD matrices (Cholesky succeeds)', () => {
    const { X } = makeBlobs(30, 4);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 4 }).fit(X);
    for (const cov of gmm.covariances_) {
      // Symmetry.
      assert.ok(close(cov[1], cov[2], 1e-12), `cov asymmetric`);
      // Positive determinant (necessary for PD on 2x2).
      const det = cov[0] * cov[3] - cov[1] * cov[2];
      assert.ok(det > 0, `non-positive determinant ${det}`);
    }
  });

  test('precisions_cholesky_ has correct shape', () => {
    const { X } = makeBlobs(20, 5);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 5 }).fit(X);
    assert.equal(gmm.precisions_cholesky_.length, 3);
    for (const U of gmm.precisions_cholesky_) {
      assert.equal(U.length, 4);  // 2x2
    }
  });

  test('converges quickly on easy data', () => {
    const { X } = makeBlobs(30, 6);
    const gmm = new GaussianMixture({
      n_components: 3, random_state: 1, n_init: 5, max_iter: 100,
    }).fit(X);
    assert.ok(gmm.converged_);
    assert.ok(gmm.n_iter_ < 50, `n_iter=${gmm.n_iter_}`);
  });

  test('reproducibility under random_state', () => {
    const { X } = makeBlobs(20, 7);
    const a = new GaussianMixture({ n_components: 3, random_state: 42, n_init: 3 }).fit(X);
    const b = new GaussianMixture({ n_components: 3, random_state: 42, n_init: 3 }).fit(X);
    assert.ok(close(a.lower_bound_, b.lower_bound_));
    assert.deepEqual(Array.from(a.predict(X)), Array.from(b.predict(X)));
  });

  test('score_samples returns log-density per sample', () => {
    const { X } = makeBlobs(20, 8);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 8, n_init: 3 }).fit(X);
    const ll = gmm.score_samples(X);
    assert.equal(ll.length, X.length);
    for (const v of ll) assert.ok(Number.isFinite(v));
  });

  test('score returns mean log-likelihood', () => {
    const { X } = makeBlobs(20, 9);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 9 }).fit(X);
    const s = gmm.score(X);
    assert.ok(Number.isFinite(s));
    assert.ok(close(s, gmm.lower_bound_, 1e-10));
  });

  test('fit_predict returns labels', () => {
    const { X } = makeBlobs(15, 10);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 10 });
    const labels = gmm.fit_predict(X);
    assert.equal(labels.length, X.length);
  });

  test('unsupported covariance_type raises', () => {
    assert.throws(
      () => new GaussianMixture({ n_components: 2, covariance_type: 'diag' }).fit([[0,0],[1,1]]),
      /covariance_type='diag' not supported/);
  });

  test('n_components > n_samples raises', () => {
    assert.throws(
      () => new GaussianMixture({ n_components: 5 }).fit([[0,0],[1,1]]),
      /n_components=5/);
  });
});

// ────────────────────────────────────────────────────────────────────
// dump / load round-trip
// ────────────────────────────────────────────────────────────────────

describe('GaussianMixture dump/load', () => {
  test('round-trip preserves predict_proba exactly', () => {
    const { X } = makeBlobs(20, 11);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 11, n_init: 3 }).fit(X);
    const before = Array.from(gmm.predict_proba(X));
    const r = load(dump(gmm));
    assert.deepEqual(Array.from(r.predict_proba(X)), before);
  });

  test('JSON-string round-trip works', () => {
    const { X } = makeBlobs(15, 12);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 12 }).fit(X);
    const text = JSON.stringify(dump(gmm));
    const r = load(text);
    assert.deepEqual(Array.from(r.predict(X)), Array.from(gmm.predict(X)));
  });
});

// ────────────────────────────────────────────────────────────────────
// check_estimator
// ────────────────────────────────────────────────────────────────────

describe('check_estimator (GaussianMixture)', () => {
  test('passes', () => {
    const errs = check_estimator(GaussianMixture, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});
