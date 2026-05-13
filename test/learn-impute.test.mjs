// @gcu/learn impute test suite — SimpleImputer, KNNImputer, BDLImputer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SimpleImputer, KNNImputer, BDLImputer,
  check_estimator, dump, load,
  Pipeline, StandardScaler, DecisionTreeClassifier,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// ────────────────────────────────────────────────────────────────────
// SimpleImputer
// ────────────────────────────────────────────────────────────────────

describe('SimpleImputer', () => {
  test('mean strategy fills NaN with column mean', () => {
    const X = [[1, 2], [NaN, 4], [3, NaN]];
    const si = new SimpleImputer().fit(X);
    // Col 0 mean of [1, 3] = 2; col 1 mean of [2, 4] = 3
    assert.deepEqual(Array.from(si.statistics_), [2, 3]);
    const Xt = si.transform(X);
    assert.deepEqual(Array.from(Xt), [1, 2, 2, 4, 3, 3]);
  });

  test('median strategy', () => {
    const X = [[1], [2], [10], [NaN], [3]];
    const si = new SimpleImputer({ strategy: 'median' }).fit(X);
    // Median of [1, 2, 10, 3] = (2+3)/2 = 2.5
    assert.equal(si.statistics_[0], 2.5);
  });

  test('most_frequent strategy', () => {
    const X = [[1], [2], [2], [NaN], [3]];
    const si = new SimpleImputer({ strategy: 'most_frequent' }).fit(X);
    assert.equal(si.statistics_[0], 2);
  });

  test('constant strategy uses fill_value', () => {
    const X = [[1, NaN], [NaN, 2]];
    const si = new SimpleImputer({ strategy: 'constant', fill_value: -1 }).fit(X);
    const Xt = si.transform(X);
    assert.deepEqual(Array.from(Xt), [1, -1, -1, 2]);
  });

  test('all-missing column → 0 (or fill_value for constant)', () => {
    const X = [[NaN, 1], [NaN, 2]];
    const si = new SimpleImputer().fit(X);
    assert.equal(si.statistics_[0], 0);
    const si2 = new SimpleImputer({ strategy: 'constant', fill_value: 99 }).fit(X);
    assert.equal(si2.statistics_[0], 99);
  });

  test('non-NaN missing_values', () => {
    const X = [[1, 2], [-99, 4], [3, -99]];
    const si = new SimpleImputer({ missing_values: -99 }).fit(X);
    assert.deepEqual(Array.from(si.statistics_), [2, 3]);
    const Xt = si.transform(X);
    assert.deepEqual(Array.from(Xt), [1, 2, 2, 4, 3, 3]);
  });

  test('predict raises on n_features mismatch', () => {
    const si = new SimpleImputer().fit([[1, 2], [3, 4]]);
    assert.throws(() => si.transform([[1]]), /1 features.*fitted with 2/);
  });

  test('dump/load round-trip preserves transform', () => {
    const X = [[1, 2], [NaN, 4], [3, NaN]];
    const si = new SimpleImputer({ strategy: 'mean' }).fit(X);
    const before = Array.from(si.transform(X));
    const r = load(dump(si));
    assert.deepEqual(Array.from(r.transform(X)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(SimpleImputer, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// KNNImputer
// ────────────────────────────────────────────────────────────────────

describe('KNNImputer', () => {
  test('fills NaN with neighbor average (uniform)', () => {
    // Two clusters; missing value in row 2 should be filled from cluster A.
    const X_fit = [
      [0, 0], [0.1, 0.1], [0.2, 0.2],
      [10, 10], [10.1, 10.1], [10.2, 10.2],
    ];
    const X_test = [[0.05, NaN], [10.05, NaN]];
    const ki = new KNNImputer({ n_neighbors: 2 }).fit(X_fit);
    const Xt = ki.transform(X_test);
    // First row's missing col 1 should be near 0.1 (avg of two cluster-A neighbors).
    assert.ok(Xt[1] < 1, `row 0 col 1 = ${Xt[1]}, expected near cluster A`);
    // Second row's missing col 1 should be near 10.
    assert.ok(Xt[3] > 9, `row 1 col 1 = ${Xt[3]}, expected near cluster B`);
  });

  test('weights="distance" puts more weight on closer neighbors', () => {
    const X_fit = [[0, 0], [1, 1], [10, 10]];
    const X_test = [[0.5, NaN]];
    const u = new KNNImputer({ n_neighbors: 3, weights: 'uniform' }).fit(X_fit).transform(X_test);
    const d = new KNNImputer({ n_neighbors: 3, weights: 'distance' }).fit(X_fit).transform(X_test);
    // Uniform: average of [0, 1, 10] = 11/3 ≈ 3.67
    assert.ok(close(u[1], 11 / 3, 1e-6));
    // Distance: closer to 0.5 (the nearby points 0, 1) than 3.67.
    assert.ok(d[1] < u[1], `distance-weighted ${d[1]} should be < uniform ${u[1]}`);
    assert.ok(d[1] < 2);
  });

  test('falls back to column mean when no neighbors share features', () => {
    // Pathological: only one row with feature 0 present, none share other features.
    const X_fit = [[1, NaN], [NaN, 5], [NaN, 6]];
    const X_test = [[NaN, 5.5]];
    const ki = new KNNImputer({ n_neighbors: 1 }).fit(X_fit);
    const Xt = ki.transform(X_test);
    // Feature 0 should be filled with the only available value (1).
    assert.equal(Xt[0], 1);
  });

  test('row with no missing values passes through unchanged', () => {
    const X_fit = [[0, 0], [1, 1], [2, 2]];
    const X_test = [[5, 5]];
    const ki = new KNNImputer({ n_neighbors: 2 }).fit(X_fit);
    const Xt = ki.transform(X_test);
    assert.deepEqual(Array.from(Xt), [5, 5]);
  });

  test('dump/load round-trip preserves transform', () => {
    const X_fit = [[0, 0], [1, 1], [2, 2], [10, 10], [11, 11]];
    const X_test = [[1.5, NaN]];
    const ki = new KNNImputer({ n_neighbors: 2 }).fit(X_fit);
    const before = Array.from(ki.transform(X_test));
    const r = load(dump(ki));
    assert.deepEqual(Array.from(r.transform(X_test)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(KNNImputer, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// BDLImputer
// ────────────────────────────────────────────────────────────────────

describe('BDLImputer', () => {
  test('multiplicative replacement uses 0.65 × DL', () => {
    const X = [[0, 0.5], [0.6, 0]];
    const bdl = new BDLImputer({ detection_limits: 0.01 }).fit(X);
    const Xt = bdl.transform(X);
    // BDL positions (0, 0) and (1, 1) → 0.65 * 0.01 = 0.0065
    assert.ok(close(Xt[0], 0.0065));
    assert.ok(close(Xt[3], 0.0065));
    // Above-detection values preserved exactly.
    assert.equal(Xt[1], 0.5);
    assert.equal(Xt[2], 0.6);
  });

  test('half strategy uses 0.5 × DL', () => {
    const X = [[0, 0.5]];
    const bdl = new BDLImputer({ detection_limits: 0.01, strategy: 'half' }).fit(X);
    const Xt = bdl.transform(X);
    assert.ok(close(Xt[0], 0.005));
  });

  test('per-column detection_limits', () => {
    const X = [[0, 0.5], [0.6, 0]];
    const bdl = new BDLImputer({ detection_limits: [0.01, 0.1] }).fit(X);
    const Xt = bdl.transform(X);
    // Col 0 BDL → 0.0065; col 1 BDL → 0.065
    assert.ok(close(Xt[0], 0.0065));
    assert.ok(close(Xt[3], 0.065));
  });

  test('lognormal_ros fits per-column lognormal MLE', () => {
    // 10 above-detection samples drawn from a known lognormal, plus zeros.
    const X = [];
    for (let i = 1; i <= 10; i++) X.push([i * 0.1]);  // 0.1, 0.2, ..., 1.0
    X.push([0]); X.push([0]); X.push([0]);  // 3 BDL
    const bdl = new BDLImputer({
      detection_limits: 0.05, strategy: 'lognormal_ros',
    }).fit(X);
    assert.ok(bdl.lognormal_params_[0] != null);
    assert.equal(bdl.lognormal_params_[0].n_above, 10);
    const Xt = bdl.transform(X);
    // BDL positions should be filled with values < 0.05 (DL).
    assert.ok(Xt[10] < 0.05);
    assert.ok(Xt[11] < 0.05);
    assert.ok(Xt[12] < 0.05);
    assert.ok(Xt[10] > 0);
  });

  test('lognormal_ros falls back to multiplicative when too few above-detection', () => {
    const X = [[0], [0], [0.5]];
    const bdl = new BDLImputer({
      detection_limits: 0.01, strategy: 'lognormal_ros',
    }).fit(X);
    // Only 1 above-detection value → MLE undefined; column param is null.
    assert.equal(bdl.lognormal_params_[0], null);
    const Xt = bdl.transform(X);
    // BDL values should fall back to 0.65 * 0.01 = 0.0065.
    assert.ok(close(Xt[0], 0.0065));
    assert.ok(close(Xt[1], 0.0065));
  });

  test('detection_limits length mismatch raises', () => {
    assert.throws(
      () => new BDLImputer({ detection_limits: [0.01, 0.1] }).fit([[0]]),
      /detection_limits length 2 != n_features 1/);
  });

  test('unsupported strategy raises', () => {
    assert.throws(
      () => new BDLImputer({ strategy: 'kaplan-meier' }).fit([[0]]),
      /strategy='kaplan-meier'/);
  });

  test('dump/load round-trip preserves transform', () => {
    const X = [[0, 0.5], [0.6, 0]];
    const bdl = new BDLImputer({ detection_limits: [0.01, 0.1] }).fit(X);
    const before = Array.from(bdl.transform(X));
    const r = load(dump(bdl));
    assert.deepEqual(Array.from(r.transform(X)), before);
  });

  test('lognormal_ros dump/load round-trip', () => {
    const X = [];
    for (let i = 1; i <= 10; i++) X.push([i * 0.1]);
    X.push([0]); X.push([0]);
    const bdl = new BDLImputer({
      detection_limits: 0.05, strategy: 'lognormal_ros',
    }).fit(X);
    const before = Array.from(bdl.transform(X));
    const r = load(dump(bdl));
    assert.deepEqual(Array.from(r.transform(X)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// CV-with-NaN regression — pipelines with imputers must be CV-scorable
// ────────────────────────────────────────────────────────────────────

import { cross_val_score, KFold, SpatialKFold, train_test_split,
         RandomForestClassifier, accuracy_score } from '../ext/learn/src/main.js';

describe('cross_val_score with NaN inputs (imputer pipeline)', () => {
  test('SimpleImputer + DecisionTree pipeline scores under KFold despite NaN', () => {
    const X = [
      [1, 2], [NaN, 4], [3, NaN], [4, 5],
      [10, 20], [NaN, 22], [12, NaN], [13, 25],
    ];
    const y = [0, 0, 0, 0, 1, 1, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['imp', new SimpleImputer({ strategy: 'mean' })],
        ['rf', new RandomForestClassifier({ n_estimators: 10, random_state: 0 })],
      ],
    });
    const scores = cross_val_score(pipe, X, y,
      { cv: new KFold({ n_splits: 4, shuffle: true, random_state: 0 }) });
    assert.equal(scores.length, 4);
    for (const s of scores) assert.ok(Number.isFinite(s));
  });

  test('train_test_split passes NaN through (downstream imputer handles it)', () => {
    const X = [[1, 2], [NaN, 4], [3, NaN], [4, 5]];
    const y = [0, 0, 1, 1];
    const [Xtr, Xte, ytr, yte] = train_test_split(X, y,
      { test_size: 0.5, random_state: 0 });
    assert.equal(Xtr.shape[0] + Xte.shape[0], 4);
    // NaN survives intact in the split outputs.
    let any_nan = false;
    for (const v of Xtr) if (Number.isNaN(v)) any_nan = true;
    for (const v of Xte) if (Number.isNaN(v)) any_nan = true;
    assert.ok(any_nan, 'NaN should pass through train_test_split');
  });
});

// ────────────────────────────────────────────────────────────────────
// Pipeline integration
// ────────────────────────────────────────────────────────────────────

describe('imputation + Pipeline', () => {
  test('SimpleImputer → StandardScaler → DecisionTree end-to-end with NaN', () => {
    // 6 samples in 2D with one NaN; classes well-separated after imputation.
    const X = [
      [0, 0], [1, NaN], [0, 1],
      [10, 10], [11, 10], [10, NaN],
    ];
    const y = [0, 0, 0, 1, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['imp', new SimpleImputer({ strategy: 'mean' })],
        ['scaler', new StandardScaler()],
        ['clf', new DecisionTreeClassifier({ random_state: 0 })],
      ],
    });
    pipe.fit(X, y);
    const yh = pipe.predict(X);
    let hits = 0;
    for (let i = 0; i < y.length; i++) if (yh[i] === y[i]) hits++;
    assert.ok(hits >= 5, `pipeline accuracy = ${hits}/6`);
  });

  test('BDLImputer → CLR → DecisionTree on assay-shaped data', () => {
    // 6 compositional rows (sum to 1) with a few BDL zeros, 2 classes.
    const X = [
      [0.5, 0.3, 0.2],
      [0.5, 0.5, 0],         // BDL on col 2
      [0.45, 0.35, 0.2],
      [0.2, 0.2, 0.6],
      [0.2, 0, 0.8],          // BDL on col 1
      [0.15, 0.25, 0.6],
    ];
    const y = [0, 0, 0, 1, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['bdl', new BDLImputer({ detection_limits: 0.001 })],
        ['clf', new DecisionTreeClassifier({ random_state: 0 })],
      ],
    });
    pipe.fit(X, y);
    assert.deepEqual(Array.from(pipe.predict(X)), y);
  });
});
