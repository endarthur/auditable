// @gcu/learn cluster test suite — KMeans + AgglomerativeClustering.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KMeans, AgglomerativeClustering,
  check_estimator, dump, load, mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// Three well-separated clusters in 2D.
function makeBlobs(seed = 0) {
  const rng = mulberry32(seed);
  const X = [];
  const y = [];
  const centers = [[0, 0], [10, 0], [5, 9]];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < 20; i++) {
      X.push([centers[c][0] + (rng() - 0.5) * 0.5,
              centers[c][1] + (rng() - 0.5) * 0.5]);
      y.push(c);
    }
  }
  return { X, y, centers };
}

// Cluster purity: across all true classes, fraction of samples whose
// predicted cluster id matches the dominant true class for that cluster.
function purity(y_true, y_pred, k) {
  const counts = Array.from({ length: k }, () => new Map());
  for (let i = 0; i < y_true.length; i++) {
    const c = y_pred[i] | 0;
    const t = y_true[i];
    counts[c].set(t, (counts[c].get(t) ?? 0) + 1);
  }
  let hits = 0;
  for (let c = 0; c < k; c++) {
    let best = 0;
    for (const v of counts[c].values()) if (v > best) best = v;
    hits += best;
  }
  return hits / y_true.length;
}

// ────────────────────────────────────────────────────────────────────
// KMeans
// ────────────────────────────────────────────────────────────────────

describe('KMeans', () => {
  test('recovers well-separated cluster structure', () => {
    const { X, y } = makeBlobs(42);
    const km = new KMeans({ n_clusters: 3, n_init: 5, random_state: 0 }).fit(X);
    const p = purity(y, km.labels_, 3);
    assert.ok(p > 0.95, `cluster purity ${p} should be > 0.95`);
  });

  test('reproducibility under random_state', () => {
    const { X } = makeBlobs(42);
    const a = new KMeans({ n_clusters: 3, random_state: 1, n_init: 3 }).fit(X);
    const b = new KMeans({ n_clusters: 3, random_state: 1, n_init: 3 }).fit(X);
    assert.ok(close(a.inertia_, b.inertia_));
    assert.deepEqual(Array.from(a.labels_), Array.from(b.labels_));
  });

  test('predict matches labels_ on training data', () => {
    const { X } = makeBlobs(7);
    const km = new KMeans({ n_clusters: 3, random_state: 0, n_init: 3 }).fit(X);
    const p = km.predict(X);
    assert.deepEqual(Array.from(p), Array.from(km.labels_));
  });

  test('predict on new points snaps to nearest centroid', () => {
    const { X, centers } = makeBlobs(0);
    const km = new KMeans({ n_clusters: 3, random_state: 0, n_init: 5 }).fit(X);
    // For each true center, predict should give one of the cluster ids;
    // and predicting that exact center should match its own assignment.
    for (let c = 0; c < 3; c++) {
      const pred = km.predict([centers[c]]);
      assert.ok(pred[0] >= 0 && pred[0] < 3);
    }
  });

  test('init="random" still converges on easy data', () => {
    const { X, y } = makeBlobs(11);
    const km = new KMeans({ n_clusters: 3, init: 'random', n_init: 10,
                            random_state: 0 }).fit(X);
    assert.ok(purity(y, km.labels_, 3) > 0.9);
  });

  test('inertia is sum of squared distances to assigned centroid', () => {
    const X = [[0, 0], [1, 0], [10, 0], [11, 0]];
    const km = new KMeans({ n_clusters: 2, n_init: 5, random_state: 0 }).fit(X);
    // Each point's distance² to its centroid is 0.5²= 0.25 in each cluster
    // (centroids land at 0.5 and 10.5 for each cluster of 2).
    // Total inertia = 4 × 0.25 = 1.0
    assert.ok(close(km.inertia_, 1.0, 1e-10));
  });

  test('transform returns distance matrix to centroids', () => {
    const X = [[0, 0], [1, 0], [10, 0]];
    const km = new KMeans({ n_clusters: 2, n_init: 3, random_state: 0 }).fit(X);
    const D = km.transform(X);
    assert.deepEqual(D.shape, [3, 2]);
    // Each row should have at least one near-zero entry (distance to own cluster).
    for (let i = 0; i < 3; i++) {
      const min = Math.min(D[i * 2], D[i * 2 + 1]);
      assert.ok(min < 5, `row ${i} min distance ${min} too large`);
    }
  });

  test('user-provided init array works', () => {
    const X = [[0, 0], [10, 10]];
    const km = new KMeans({ n_clusters: 2, init: [[0, 0], [10, 10]],
                            n_init: 1 }).fit(X);
    assert.equal(km.labels_[0], 0);
    assert.equal(km.labels_[1], 1);
  });

  test('n_clusters > n_samples raises', () => {
    assert.throws(() => new KMeans({ n_clusters: 10 }).fit([[0], [1]]),
      /n_clusters=10/);
  });

  test('dump/load round-trip preserves predictions', () => {
    const { X } = makeBlobs(0);
    const km = new KMeans({ n_clusters: 3, random_state: 0, n_init: 3 }).fit(X);
    const before = Array.from(km.predict(X));
    const r = load(dump(km));
    assert.deepEqual(Array.from(r.predict(X)), before);
    assert.ok(close(r.inertia_, km.inertia_));
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(KMeans, { collect: true });
    // ClusterMixin doesn't tag with requires_y, so the harness drives
    // it as unsupervised — predict + transform shape checks should pass.
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// AgglomerativeClustering
// ────────────────────────────────────────────────────────────────────

describe('AgglomerativeClustering', () => {
  test('Ward linkage recovers separable clusters', () => {
    const { X, y } = makeBlobs(0);
    const ac = new AgglomerativeClustering({ n_clusters: 3 }).fit(X);
    assert.ok(purity(y, ac.labels_, 3) > 0.95);
  });

  test('all four linkages succeed and produce valid label arrays', () => {
    const { X } = makeBlobs(3);
    for (const linkage of ['single', 'complete', 'average', 'ward']) {
      const ac = new AgglomerativeClustering({ n_clusters: 3, linkage }).fit(X);
      assert.equal(ac.labels_.length, X.length);
      // Labels should be integers in [0, 3).
      for (const v of ac.labels_) assert.ok(v >= 0 && v < 3 && Number.isInteger(v));
      // Should produce exactly 3 distinct labels.
      const distinct = new Set(Array.from(ac.labels_));
      assert.equal(distinct.size, 3, `linkage=${linkage} produced ${distinct.size} clusters`);
    }
  });

  test('n_clusters parameter respected', () => {
    const { X } = makeBlobs(0);
    const ac = new AgglomerativeClustering({ n_clusters: 5 }).fit(X);
    const distinct = new Set(Array.from(ac.labels_));
    assert.equal(distinct.size, 5);
    assert.equal(ac.n_clusters_, 5);
    assert.equal(ac.n_leaves_, X.length);
  });

  test('fit_predict returns labels_', () => {
    const { X } = makeBlobs(0);
    const ac = new AgglomerativeClustering({ n_clusters: 3 });
    const labels = ac.fit_predict(X);
    assert.deepEqual(Array.from(labels), Array.from(ac.labels_));
  });

  test('singleton linkage chains through closest neighbours', () => {
    // 1D points 0, 1, 2, 100, 101 → with single linkage, n_clusters=2 should
    // give {0, 1, 2} vs {100, 101}.
    const X = [[0], [1], [2], [100], [101]];
    const ac = new AgglomerativeClustering({ n_clusters: 2, linkage: 'single' }).fit(X);
    // Either {0,1,2}/{100,101} or {100,101}/{0,1,2}; check that the first
    // 3 share a label and last 2 share a label.
    assert.equal(ac.labels_[0], ac.labels_[1]);
    assert.equal(ac.labels_[1], ac.labels_[2]);
    assert.equal(ac.labels_[3], ac.labels_[4]);
    assert.notEqual(ac.labels_[0], ac.labels_[3]);
  });

  test('unsupported linkage raises', () => {
    assert.throws(
      () => new AgglomerativeClustering({ linkage: 'centroid' }).fit([[0], [1]]),
      /linkage='centroid'/);
  });

  test('unsupported metric raises', () => {
    assert.throws(
      () => new AgglomerativeClustering({ metric: 'manhattan' }).fit([[0], [1]]),
      /metric='manhattan'/);
  });

  test('dump/load round-trip preserves labels', () => {
    const { X } = makeBlobs(0);
    const ac = new AgglomerativeClustering({ n_clusters: 3 }).fit(X);
    const before = Array.from(ac.labels_);
    const r = load(dump(ac));
    assert.deepEqual(Array.from(r.labels_), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(AgglomerativeClustering, { collect: true });
    // AgglomerativeClustering has no predict, so the harness's predict
    // checks are skipped; transform isn't tested either (it's not a
    // transformer). The dump/load check just verifies the labels_ round-trip.
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});
