// @gcu/learn tree test suite — DecisionTreeClassifier + DecisionTreeRegressor.
//
// Coverage:
//   - basic fit/predict on canonical separable data
//   - degenerate cases (single class, single sample, all-equal X)
//   - hyperparameter behavior (max_depth, min_samples_leaf, max_features)
//   - predict_proba sums to 1
//   - feature_importances_ shape + sum
//   - dump/load round-trip preserves predictions exactly
//   - cross_val_score end-to-end through KFold
//   - check_estimator passes for both estimators

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionTreeClassifier, DecisionTreeRegressor,
  check_estimator, dump, load,
  cross_val_score, KFold, SpatialKFold,
  accuracy_score, r2_score, mean_squared_error,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-12) => Math.abs(a - b) < tol;

// ────────────────────────────────────────────────────────────────────
// DecisionTreeClassifier
// ────────────────────────────────────────────────────────────────────

describe('DecisionTreeClassifier', () => {
  test('fits a perfectly separable 2-class problem', () => {
    // Two clusters in 2D: class 0 around (0,0), class 1 around (10,10).
    const X = [
      [0, 0], [1, 0], [0, 1], [1, 1],
      [10, 10], [11, 10], [10, 11], [11, 11],
    ];
    const y = [0, 0, 0, 0, 1, 1, 1, 1];
    const clf = new DecisionTreeClassifier();
    clf.fit(X, y);
    const yhat = clf.predict(X);
    for (let i = 0; i < y.length; i++) assert.equal(yhat[i], y[i]);
    assert.equal(clf.classes_.length, 2);
    assert.equal(clf.n_classes_, 2);
    assert.equal(clf.n_features_in_, 2);
  });

  test('handles 3-class separable data', () => {
    const X = [];
    const y = [];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 5; i++) {
        X.push([c * 10 + i * 0.1, c * 10 + i * 0.1]);
        y.push(c);
      }
    }
    const clf = new DecisionTreeClassifier();
    clf.fit(X, y);
    const yhat = clf.predict(X);
    for (let i = 0; i < y.length; i++) assert.equal(yhat[i], y[i]);
    assert.equal(clf.n_classes_, 3);
  });

  test('predict_proba rows sum to 1', () => {
    const X = [
      [0, 0], [1, 1], [2, 2], [3, 3],
      [10, 10], [11, 11], [12, 12], [13, 13],
    ];
    const y = [0, 0, 0, 0, 1, 1, 1, 1];
    const clf = new DecisionTreeClassifier().fit(X, y);
    const P = clf.predict_proba(X);
    assert.deepEqual(P.shape, [8, 2]);
    for (let i = 0; i < 8; i++) {
      const sum = P[i * 2] + P[i * 2 + 1];
      assert.ok(close(sum, 1, 1e-12), `row ${i} sums to ${sum}`);
    }
  });

  test('predict_proba reflects leaf class counts', () => {
    // Force a single-leaf tree by max_depth=0.
    const X = [[0, 0], [1, 1], [2, 2], [3, 3]];
    const y = [0, 0, 1, 1];
    const clf = new DecisionTreeClassifier({ max_depth: 0 }).fit(X, y);
    const P = clf.predict_proba(X);
    // All samples in the same leaf → same probabilities = [0.5, 0.5].
    for (let i = 0; i < 4; i++) {
      assert.ok(close(P[i * 2], 0.5));
      assert.ok(close(P[i * 2 + 1], 0.5));
    }
  });

  test('max_depth caps tree depth', () => {
    const X = [];
    const y = [];
    for (let i = 0; i < 100; i++) {
      X.push([i / 10, i % 7]);
      y.push(i % 4);
    }
    const clf = new DecisionTreeClassifier({ max_depth: 3 }).fit(X, y);
    assert.ok(clf.tree_.max_depth <= 3,
      `tree depth ${clf.tree_.max_depth} should be ≤ 3`);
  });

  test('single-sample fit is a leaf', () => {
    const clf = new DecisionTreeClassifier().fit([[1, 2]], [0]);
    assert.equal(clf.tree_.node_count, 1);
    assert.equal(clf.tree_.children_left[0], -1);
  });

  test('single-class fit is a leaf', () => {
    const X = [[0, 0], [1, 1], [2, 2], [3, 3]];
    const y = [5, 5, 5, 5];
    const clf = new DecisionTreeClassifier().fit(X, y);
    // Should be a single-node tree (impurity already 0).
    assert.equal(clf.tree_.node_count, 1);
    assert.equal(clf.predict([[10, 10]])[0], 5);
  });

  test('all-equal X collapses to root leaf', () => {
    const X = [[1, 1], [1, 1], [1, 1], [1, 1]];
    const y = [0, 1, 0, 1];
    const clf = new DecisionTreeClassifier().fit(X, y);
    // No feature can split → single root leaf.
    assert.equal(clf.tree_.node_count, 1);
  });

  test('feature_importances_ sums to 1 (for non-trivial trees)', () => {
    const X = [];
    const y = [];
    for (let i = 0; i < 20; i++) {
      X.push([i * 0.1, (i * 0.7) % 3, Math.sin(i)]);
      y.push(i % 2);
    }
    const clf = new DecisionTreeClassifier().fit(X, y);
    let total = 0;
    for (const v of clf.feature_importances_) total += v;
    assert.ok(close(total, 1, 1e-10), `feature_importances_ sums to ${total}`);
    assert.equal(clf.feature_importances_.length, 3);
  });

  test('predict raises on n_features mismatch', () => {
    const clf = new DecisionTreeClassifier().fit([[1, 2], [3, 4]], [0, 1]);
    assert.throws(() => clf.predict([[1, 2, 3]]), /3 features.*fitted with 2/);
  });

  test('unsupported criterion raises', () => {
    assert.throws(
      () => new DecisionTreeClassifier({ criterion: 'entropy' }).fit([[0]], [0]),
      /'entropy' not supported in v0.1/);
  });
});

// ────────────────────────────────────────────────────────────────────
// DecisionTreeRegressor
// ────────────────────────────────────────────────────────────────────

describe('DecisionTreeRegressor', () => {
  test('fits a piecewise-constant signal exactly', () => {
    // y = 0 for x in [0,5), y = 10 for x in [5,10).
    const X = [];
    const y = [];
    for (let i = 0; i < 5; i++) { X.push([i]); y.push(0); }
    for (let i = 5; i < 10; i++) { X.push([i]); y.push(10); }
    const reg = new DecisionTreeRegressor().fit(X, y);
    const yhat = reg.predict(X);
    for (let i = 0; i < 10; i++) {
      assert.ok(close(yhat[i], y[i]),
        `at i=${i}: predicted ${yhat[i]} expected ${y[i]}`);
    }
  });

  test('predicts leaf mean for unseen X', () => {
    const X = [[0], [1], [2], [3]];
    const y = [1, 2, 3, 4];
    const reg = new DecisionTreeRegressor({ max_depth: 0 }).fit(X, y);
    // max_depth=0 → single leaf, predicts mean of y = 2.5.
    assert.ok(close(reg.predict([[100]])[0], 2.5));
  });

  test('R²=1 on a target that matches a feature monotonically', () => {
    const X = [];
    const y = [];
    for (let i = 0; i < 20; i++) {
      X.push([i, i * 2, i * 3]);
      y.push(i);
    }
    const reg = new DecisionTreeRegressor().fit(X, y);
    const r2 = r2_score(y, reg.predict(X));
    assert.ok(close(r2, 1, 1e-10));
  });

  test('min_samples_leaf enforced', () => {
    const X = [];
    const y = [];
    for (let i = 0; i < 20; i++) { X.push([i]); y.push(i); }
    const reg = new DecisionTreeRegressor({ min_samples_leaf: 5 }).fit(X, y);
    // No leaf should have fewer than 5 samples.
    for (let n = 0; n < reg.tree_.node_count; n++) {
      if (reg.tree_.children_left[n] === -1) {
        assert.ok(reg.tree_.n_node_samples[n] >= 5,
          `leaf ${n} has ${reg.tree_.n_node_samples[n]} samples`);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// max_features
// ────────────────────────────────────────────────────────────────────

describe('max_features', () => {
  test("'sqrt' picks floor(sqrt(m)) features per node", () => {
    const X = [];
    const y = [];
    for (let i = 0; i < 30; i++) {
      X.push([i, i * 2, Math.sin(i), Math.cos(i), (i * 7) % 11, (i * 3) % 5,
              (i * 11) % 13, (i * 17) % 19, (i * 5) % 7]);
      y.push(i % 2);
    }
    // m=9, sqrt → 3. Just assert it fits without error.
    const clf = new DecisionTreeClassifier({ max_features: 'sqrt',
                                              random_state: 42 }).fit(X, y);
    assert.ok(clf.tree_.node_count > 0);
  });

  test('integer max_features works', () => {
    const X = Array.from({ length: 30 }, (_, i) =>
      Array.from({ length: 5 }, (_, j) => (i * (j + 1)) % 7));
    const y = Array.from({ length: 30 }, (_, i) => i % 3);
    const clf = new DecisionTreeClassifier({ max_features: 2,
                                              random_state: 1 }).fit(X, y);
    assert.ok(clf.tree_.node_count > 0);
  });

  test('reproducibility under random_state', () => {
    const X = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => Math.sin(i + j)));
    const y = Array.from({ length: 40 }, (_, i) => i % 3);
    const a = new DecisionTreeClassifier({ max_features: 'sqrt', random_state: 7 })
      .fit(X, y).predict(X);
    const b = new DecisionTreeClassifier({ max_features: 'sqrt', random_state: 7 })
      .fit(X, y).predict(X);
    assert.deepEqual(Array.from(a), Array.from(b));
  });
});

// ────────────────────────────────────────────────────────────────────
// dump / load round-trip
// ────────────────────────────────────────────────────────────────────

describe('tree dump/load', () => {
  test('classifier predictions match after round-trip', () => {
    const X = Array.from({ length: 30 }, (_, i) => [i / 10, (i * 0.7) % 3]);
    const y = Array.from({ length: 30 }, (_, i) => i % 3);
    const clf = new DecisionTreeClassifier({ max_depth: 4 }).fit(X, y);
    const pred_before = Array.from(clf.predict(X));
    const proba_before = Array.from(clf.predict_proba(X));

    const json = dump(clf);
    assert.equal(json.class, 'DecisionTreeClassifier');
    assert.equal(json.module, '@gcu/learn.tree');
    const clf2 = load(json);

    assert.deepEqual(Array.from(clf2.predict(X)), pred_before);
    assert.deepEqual(Array.from(clf2.predict_proba(X)), proba_before);
  });

  test('regressor predictions match after round-trip', () => {
    const X = Array.from({ length: 30 }, (_, i) => [i / 10, Math.sin(i)]);
    const y = Array.from({ length: 30 }, (_, i) => i * 0.3 + Math.cos(i));
    const reg = new DecisionTreeRegressor({ max_depth: 5 }).fit(X, y);
    const before = Array.from(reg.predict(X));

    const reg2 = load(dump(reg));
    assert.deepEqual(Array.from(reg2.predict(X)), before);
  });

  test('JSON-string round-trip preserves predictions', () => {
    const clf = new DecisionTreeClassifier()
      .fit([[0, 0], [1, 1], [10, 10], [11, 11]], [0, 0, 1, 1]);
    const text = JSON.stringify(dump(clf));
    const clf2 = load(text);
    assert.deepEqual(Array.from(clf2.predict([[0.5, 0.5], [10.5, 10.5]])),
                     [0, 1]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration with cross_val_score
// ────────────────────────────────────────────────────────────────────

describe('tree + cross_val_score', () => {
  test('classifier scores under KFold', () => {
    // 60 samples, 3 classes, separable.
    const X = [];
    const y = [];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 20; i++) {
        X.push([c * 5 + Math.random() * 0.1, c * 5 + Math.random() * 0.1]);
        y.push(c);
      }
    }
    const scores = cross_val_score(
      new DecisionTreeClassifier({ random_state: 0 }),
      X, y,
      { cv: new KFold({ n_splits: 5, shuffle: true, random_state: 1 }) },
    );
    assert.equal(scores.length, 5);
    // Should average reasonably high on this easy problem.
    let mean = 0; for (const s of scores) mean += s;
    mean /= scores.length;
    assert.ok(mean > 0.7, `expected mean accuracy > 0.7, got ${mean}`);
  });

  test('regressor scores under SpatialKFold with buffer', () => {
    // 30 samples on a line; target is x with noise.
    const X = [], y = [], xyz = [];
    for (let i = 0; i < 30; i++) {
      X.push([i / 3, Math.sin(i)]);
      y.push(i / 3);
      xyz.push([i]);
    }
    const out = cross_val_score(
      new DecisionTreeRegressor({ max_depth: 5 }),
      X, y,
      {
        cv: new SpatialKFold({ n_splits: 3, exclusion_radius: 1.5,
                               shuffle: false }),
        scoring: (est, X, y) => mean_squared_error(y, est.predict(X)),
        split_opts: { xyz: { data: Float64Array.from(xyz.flat()), shape: [30, 1] } },
      },
    );
    assert.equal(out.length, 3);
    for (const s of out) assert.ok(Number.isFinite(s));
  });
});

// ────────────────────────────────────────────────────────────────────
// check_estimator
// ────────────────────────────────────────────────────────────────────

describe('check_estimator parity', () => {
  test('passes for DecisionTreeClassifier', () => {
    const errs = check_estimator(DecisionTreeClassifier, { collect: true });
    assert.deepEqual(errs, [], `unexpected violations:\n  ${errs.join('\n  ')}`);
  });

  test('passes for DecisionTreeRegressor', () => {
    const errs = check_estimator(DecisionTreeRegressor, { collect: true });
    assert.deepEqual(errs, [], `unexpected violations:\n  ${errs.join('\n  ')}`);
  });
});
