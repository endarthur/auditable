// @gcu/learn GradientBoosting test suite.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GradientBoostingClassifier, GradientBoostingRegressor,
  Pipeline, StandardScaler,
  check_estimator, dump, load,
  accuracy_score, r2_score,
  mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// ────────────────────────────────────────────────────────────────────
// GradientBoostingRegressor
// ────────────────────────────────────────────────────────────────────

describe('GradientBoostingRegressor', () => {
  test('high R² on a smooth nonlinear target', () => {
    const X = []; const y = [];
    for (let i = 0; i < 50; i++) {
      const x = (i - 25) / 5;
      X.push([x]);
      y.push(2 * x + 0.5 * x * x);
    }
    const gbr = new GradientBoostingRegressor({ n_estimators: 50, max_depth: 3,
                                                random_state: 0 }).fit(X, y);
    assert.ok(r2_score(y, gbr.predict(X)) > 0.99);
  });

  test('train_score_ decreases with stages', () => {
    const X = []; const y = [];
    for (let i = 0; i < 30; i++) { X.push([i / 5]); y.push(i / 5); }
    const gbr = new GradientBoostingRegressor({ n_estimators: 20,
                                                random_state: 0 }).fit(X, y);
    // Final train MSE should be much smaller than the first stage's.
    assert.ok(gbr.train_score_[19] < gbr.train_score_[0]);
  });

  test('learning_rate × n_estimators trade-off (lower lr + more iters ≈ same fit)', () => {
    const X = []; const y = [];
    for (let i = 0; i < 40; i++) { const x = i / 5; X.push([x]); y.push(Math.sin(x)); }
    const fast = new GradientBoostingRegressor({ n_estimators: 30, learning_rate: 0.3,
                                                  random_state: 0 }).fit(X, y);
    const slow = new GradientBoostingRegressor({ n_estimators: 100, learning_rate: 0.1,
                                                  random_state: 0 }).fit(X, y);
    // Both should have positive R²; not strict equality but in the same ballpark.
    assert.ok(r2_score(y, fast.predict(X)) > 0.9);
    assert.ok(r2_score(y, slow.predict(X)) > 0.9);
  });

  test('reproducibility under random_state', () => {
    const X = []; const y = [];
    for (let i = 0; i < 30; i++) { X.push([i / 3]); y.push(Math.sin(i / 3)); }
    const a = new GradientBoostingRegressor({ n_estimators: 10, random_state: 42 }).fit(X, y);
    const b = new GradientBoostingRegressor({ n_estimators: 10, random_state: 42 }).fit(X, y);
    assert.deepEqual(Array.from(a.predict(X)), Array.from(b.predict(X)));
  });

  test('init_value_ = mean(y)', () => {
    const y = [1, 2, 3, 4, 5];
    const X = [[0], [1], [2], [3], [4]];
    const gbr = new GradientBoostingRegressor({ n_estimators: 1, learning_rate: 0,
                                                random_state: 0 }).fit(X, y);
    // With learning_rate=0, predict = init_value = mean(y) = 3 for all.
    assert.ok(close(gbr.init_value_, 3));
    for (const v of gbr.predict(X)) assert.ok(close(v, 3));
  });

  test('predict raises on n_features mismatch', () => {
    const gbr = new GradientBoostingRegressor({ n_estimators: 5 }).fit(
      [[1, 2], [3, 4], [5, 6]], [1, 2, 3]);
    assert.throws(() => gbr.predict([[1]]), /1 features.*fitted with 2/);
  });

  test('unsupported loss raises', () => {
    assert.throws(
      () => new GradientBoostingRegressor({ loss: 'absolute_error' }).fit([[0]], [0]),
      /loss='absolute_error' not supported/);
  });

  test('dump/load round-trip preserves predictions exactly', () => {
    const X = []; const y = [];
    for (let i = 0; i < 30; i++) { X.push([i / 5]); y.push(i / 5 + Math.sin(i / 3)); }
    const gbr = new GradientBoostingRegressor({ n_estimators: 10,
                                                random_state: 0 }).fit(X, y);
    const before = Array.from(gbr.predict(X));
    const r = load(dump(gbr));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(GradientBoostingRegressor, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// GradientBoostingClassifier
// ────────────────────────────────────────────────────────────────────

describe('GradientBoostingClassifier', () => {
  test('100% accuracy on separable 3-class data', () => {
    const X = []; const y = [];
    const rng = mulberry32(0);
    const centers = [[0, 0], [10, 0], [5, 9]];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 15; i++) {
        X.push([centers[c][0] + (rng() - 0.5) * 0.5,
                centers[c][1] + (rng() - 0.5) * 0.5]);
        y.push(c);
      }
    }
    const gbc = new GradientBoostingClassifier({ n_estimators: 30, max_depth: 3,
                                                 random_state: 0 }).fit(X, y);
    assert.equal(accuracy_score(y, gbc.predict(X)), 1);
  });

  test('predict_proba rows sum to 1 (multinomial)', () => {
    const X = []; const y = [];
    for (let c = 0; c < 3; c++) for (let i = 0; i < 10; i++) {
      X.push([c * 5, c * 5]); y.push(c);
    }
    const gbc = new GradientBoostingClassifier({ n_estimators: 10,
                                                 random_state: 0 }).fit(X, y);
    const P = gbc.predict_proba(X);
    for (let i = 0; i < P.shape[0]; i++) {
      let s = 0; for (let c = 0; c < 3; c++) s += P[i * 3 + c];
      assert.ok(close(s, 1, 1e-10));
    }
  });

  test('binary classification', () => {
    const X = [[0, 0], [1, 1], [2, 2], [10, 10], [11, 11], [12, 12]];
    const y = [0, 0, 0, 1, 1, 1];
    const gbc = new GradientBoostingClassifier({ n_estimators: 20,
                                                 random_state: 0 }).fit(X, y);
    assert.equal(accuracy_score(y, gbc.predict(X)), 1);
    const P = gbc.predict_proba(X);
    assert.deepEqual(P.shape, [6, 2]);
  });

  test('init_value_ = log-priors per class', () => {
    // y has 2 zeros and 4 ones → priors [1/3, 2/3].
    const X = [[0], [1], [10], [11], [12], [13]];
    const y = [0, 0, 1, 1, 1, 1];
    const gbc = new GradientBoostingClassifier({ n_estimators: 1, learning_rate: 0,
                                                 random_state: 0 }).fit(X, y);
    assert.ok(close(gbc.init_value_[0], Math.log(2 / 6), 1e-10));
    assert.ok(close(gbc.init_value_[1], Math.log(4 / 6), 1e-10));
  });

  test('classes_ stored sorted', () => {
    const gbc = new GradientBoostingClassifier({ n_estimators: 5,
                                                 random_state: 0 }).fit(
      [[0], [1], [2]], [5, 2, 8]);
    assert.deepEqual(Array.from(gbc.classes_), [2, 5, 8]);
  });

  test('dump/load round-trip preserves predictions exactly', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11]];
    const y = [0, 0, 1, 1];
    const gbc = new GradientBoostingClassifier({ n_estimators: 10,
                                                 random_state: 0 }).fit(X, y);
    const before = Array.from(gbc.predict(X));
    const proba_before = Array.from(gbc.predict_proba(X));
    const r = load(dump(gbc));
    assert.deepEqual(Array.from(r.predict(X)), before);
    assert.deepEqual(Array.from(r.predict_proba(X)), proba_before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(GradientBoostingClassifier, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// Pipeline integration
// ────────────────────────────────────────────────────────────────────

describe('GradientBoosting + Pipeline', () => {
  test('StandardScaler → GradientBoostingClassifier on multi-scale data', () => {
    const X = [
      [0, 1000], [0.1, 1010], [0.2, 990],
      [1, 0], [1.1, 10], [1.2, -10],
    ];
    const y = [0, 0, 0, 1, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['gbc', new GradientBoostingClassifier({ n_estimators: 20,
                                                  random_state: 0 })],
      ],
    });
    pipe.fit(X, y);
    assert.equal(accuracy_score(y, pipe.predict(X)), 1);
  });

  test('full Pipeline dump/load preserves predictions', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11]];
    const y = [0, 0, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['gbc', new GradientBoostingClassifier({ n_estimators: 5,
                                                  random_state: 0 })],
      ],
    });
    pipe.fit(X, y);
    const before = Array.from(pipe.predict(X));
    const r = load(dump(pipe));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });
});
