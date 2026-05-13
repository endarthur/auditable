// @gcu/learn neighbors test suite — KNeighborsClassifier + Regressor.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNeighborsClassifier, KNeighborsRegressor,
  check_estimator, dump, load,
  Pipeline, StandardScaler,
  accuracy_score, r2_score,
  mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// ────────────────────────────────────────────────────────────────────
// KNeighborsClassifier
// ────────────────────────────────────────────────────────────────────

describe('KNeighborsClassifier', () => {
  test('1-NN reproduces training labels exactly on training data', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11]];
    const y = [0, 0, 1, 1];
    const knn = new KNeighborsClassifier({ n_neighbors: 1 }).fit(X, y);
    const yhat = knn.predict(X);
    assert.deepEqual(Array.from(yhat), y);
  });

  test('k=3 majority vote on separable 3-class data', () => {
    // 3 well-separated blobs; KNN with k=3 should recover all labels.
    const rng = mulberry32(0);
    const X = [];
    const y = [];
    const centers = [[0, 0], [10, 0], [5, 9]];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 10; i++) {
        X.push([centers[c][0] + (rng() - 0.5) * 0.5,
                centers[c][1] + (rng() - 0.5) * 0.5]);
        y.push(c);
      }
    }
    const knn = new KNeighborsClassifier({ n_neighbors: 3 }).fit(X, y);
    assert.equal(accuracy_score(y, knn.predict(X)), 1);
  });

  test('predict_proba rows sum to 1', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11]];
    const y = [0, 0, 1, 1];
    const knn = new KNeighborsClassifier({ n_neighbors: 2 }).fit(X, y);
    const P = knn.predict_proba(X);
    for (let i = 0; i < 4; i++) {
      const s = P[i * 2] + P[i * 2 + 1];
      assert.ok(close(s, 1, 1e-12));
    }
  });

  test('weights="distance" gives more weight to closer neighbors', () => {
    const X = [[0], [1], [10]];
    const y = [0, 0, 1];
    // For a query at x=2, distances are [2, 1, 8]. Closer neighbors should win.
    const u = new KNeighborsClassifier({ n_neighbors: 3, weights: 'uniform' }).fit(X, y);
    const d = new KNeighborsClassifier({ n_neighbors: 3, weights: 'distance' }).fit(X, y);
    // Uniform: 2/3 vote for class 0 → predicts 0.
    assert.equal(u.predict([[2]])[0], 0);
    // Distance-weighted: same bias to 0 (closer points are class 0).
    assert.equal(d.predict([[2]])[0], 0);
    // Distance variant should give higher confidence in class 0 (lower P(class 1)).
    const Pu = u.predict_proba([[2]]);
    const Pd = d.predict_proba([[2]]);
    assert.ok(Pd[1] < Pu[1], `distance proba P(1)=${Pd[1]} should be < uniform P(1)=${Pu[1]}`);
  });

  test('classes_ stored sorted', () => {
    const knn = new KNeighborsClassifier({ n_neighbors: 1 }).fit(
      [[0], [1], [10]], [5, 2, 8]);
    assert.deepEqual(Array.from(knn.classes_), [2, 5, 8]);
  });

  test('predict raises on n_features mismatch', () => {
    const knn = new KNeighborsClassifier({ n_neighbors: 1 }).fit(
      [[0, 0], [1, 1]], [0, 1]);
    assert.throws(() => knn.predict([[1]]), /1 features.*fitted with 2/);
  });

  test('dump/load round-trip rebuilds KDTree and preserves predictions', () => {
    const X = [[0, 0], [1, 1], [2, 2], [10, 10], [11, 11], [12, 12]];
    const y = [0, 0, 0, 1, 1, 1];
    const knn = new KNeighborsClassifier({ n_neighbors: 3 }).fit(X, y);
    const before = Array.from(knn.predict(X));
    const proba_before = Array.from(knn.predict_proba(X));
    const r = load(dump(knn));
    assert.ok(r._kdtree != null, 'KDTree should be rebuilt on load');
    assert.deepEqual(Array.from(r.predict(X)), before);
    assert.deepEqual(Array.from(r.predict_proba(X)), proba_before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(KNeighborsClassifier, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// KNeighborsRegressor
// ────────────────────────────────────────────────────────────────────

describe('KNeighborsRegressor', () => {
  test('predicts mean of neighbor targets (uniform)', () => {
    const X = [[0], [1], [2], [3], [4]];
    const y = [0, 10, 20, 30, 40];
    const knr = new KNeighborsRegressor({ n_neighbors: 2 }).fit(X, y);
    // Query x=1.5: 2 nearest are x=1, x=2 → mean of (10, 20) = 15.
    assert.equal(knr.predict([[1.5]])[0], 15);
  });

  test('1-NN reproduces training values exactly', () => {
    const X = [[0], [1], [2], [3]];
    const y = [10, 20, 30, 40];
    const knr = new KNeighborsRegressor({ n_neighbors: 1 }).fit(X, y);
    assert.deepEqual(Array.from(knr.predict(X)), y);
  });

  test('weights="distance" gives more influence to closer neighbors', () => {
    const X = [[0], [1], [10]];
    const y = [0, 0, 100];
    const u = new KNeighborsRegressor({ n_neighbors: 3, weights: 'uniform' }).fit(X, y);
    const d = new KNeighborsRegressor({ n_neighbors: 3, weights: 'distance' }).fit(X, y);
    // For query x=0.5: uniform mean = (0 + 0 + 100) / 3 ≈ 33.3
    // Distance-weighted: weights ∝ 1/dist, the close 0/0 dominate → much smaller.
    const yu = u.predict([[0.5]])[0];
    const yd = d.predict([[0.5]])[0];
    assert.ok(yd < yu, `distance-weighted ${yd} should be < uniform ${yu}`);
    // Math: dists=[0.5,0.5,9.5], weights=[2,2,1/9.5] → ~2.56. Should be small.
    assert.ok(yd < 5, `distance-weighted should be near 0, got ${yd}`);
  });

  test('high R² on a near-monotonic dataset', () => {
    const rng = mulberry32(7);
    const X = []; const y = [];
    for (let i = 0; i < 30; i++) {
      const x = i * 0.1;
      X.push([x]);
      y.push(2 * x + (rng() - 0.5) * 0.05);
    }
    const knr = new KNeighborsRegressor({ n_neighbors: 3 }).fit(X, y);
    const r2 = r2_score(y, knr.predict(X));
    assert.ok(r2 > 0.95, `R² ${r2} should be > 0.95`);
  });

  test('dump/load round-trip preserves predictions', () => {
    const X = [[0], [1], [2], [3], [4]];
    const y = [0, 10, 20, 30, 40];
    const knr = new KNeighborsRegressor({ n_neighbors: 2 }).fit(X, y);
    const before = Array.from(knr.predict(X));
    const r = load(dump(knr));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(KNeighborsRegressor, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// Pipeline integration
// ────────────────────────────────────────────────────────────────────

describe('KNN + Pipeline', () => {
  test('StandardScaler → KNeighborsClassifier on separable data', () => {
    // Features on different scales — scaling matters for KNN.
    const X = [
      [0, 1000], [0.1, 1010], [0.2, 990],
      [1, 0], [1.1, 10], [1.2, -10],
    ];
    const y = [0, 0, 0, 1, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['knn', new KNeighborsClassifier({ n_neighbors: 3 })],
      ],
    });
    pipe.fit(X, y);
    assert.equal(accuracy_score(y, pipe.predict(X)), 1);
  });

  test('Full pipeline dump/load preserves predictions', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11]];
    const y = [0, 0, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['knn', new KNeighborsClassifier({ n_neighbors: 1 })],
      ],
    });
    pipe.fit(X, y);
    const before = Array.from(pipe.predict(X));
    const r = load(dump(pipe));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });
});
