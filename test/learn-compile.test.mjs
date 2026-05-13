// @gcu/learn .compile() test suite — JIT-emit predict for the tree family.
//
// Each test compares compiled-vs-interpreted predictions for exact match.
// The interpreted path is the spec's "correctness reference"; compiled
// only swaps in for performance.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionTreeClassifier, DecisionTreeRegressor,
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  GradientBoostingRegressor, GradientBoostingClassifier,
  LinearRegression, StandardScaler,
  dump, load, mulberry32,
} from '../ext/learn/src/main.js';

// 3-class blobs.
function makeBlobs(seed = 0, n_per = 15) {
  const rng = mulberry32(seed);
  const X = []; const y = [];
  const centers = [[0, 0], [10, 0], [5, 9]];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n_per; i++) {
      X.push([centers[c][0] + (rng() - 0.5) * 0.5,
              centers[c][1] + (rng() - 0.5) * 0.5]);
      y.push(c);
    }
  }
  return { X, y };
}

// ────────────────────────────────────────────────────────────────────
// Basic compile contract
// ────────────────────────────────────────────────────────────────────

describe('.compile() basics', () => {
  test('returns this for chaining', () => {
    const tree = new DecisionTreeRegressor().fit([[0], [1], [2]], [0, 1, 2]);
    const r = tree.compile();
    assert.equal(r, tree);
  });

  test('on non-tree estimator (LinearRegression) is a no-op returning this', () => {
    // Use non-rank-deficient X (avoid the [[1,2],[3,4],[5,6]]-style trap
    // where col_2 = col_1 + 1 makes the intercept-augmented matrix singular).
    const lr = new LinearRegression().fit([[0, 5], [1, 2], [2, 3]], [1, 3, 5]);
    const before = Array.from(lr.predict([[5, 6]]));
    const r = lr.compile();
    assert.equal(r, lr);
    assert.deepEqual(Array.from(lr.predict([[5, 6]])), before);
  });

  test('on a transformer (StandardScaler) is a no-op', () => {
    const sc = new StandardScaler().fit([[0, 1], [1, 2], [2, 3]]);
    const before = Array.from(sc.transform([[1, 2]]));
    sc.compile();
    assert.deepEqual(Array.from(sc.transform([[1, 2]])), before);
  });

  test('compile before fit raises for tree estimators', () => {
    assert.throws(() => new DecisionTreeRegressor().compile(),
      /not fitted/);
  });
});

// ────────────────────────────────────────────────────────────────────
// DecisionTree compiled vs interpreted
// ────────────────────────────────────────────────────────────────────

describe('DecisionTreeClassifier compile parity', () => {
  test('compiled predict matches interpreted EXACTLY', () => {
    const { X, y } = makeBlobs(0);
    const tree = new DecisionTreeClassifier({ random_state: 0 }).fit(X, y);
    const pred_before = Array.from(tree.predict(X));
    const proba_before = Array.from(tree.predict_proba(X));
    tree.compile();
    assert.deepEqual(Array.from(tree.predict(X)), pred_before);
    assert.deepEqual(Array.from(tree.predict_proba(X)), proba_before);
    assert.ok(tree._predict_interpreted, '_predict_interpreted preserved');
  });

  test('compile twice is idempotent', () => {
    const { X, y } = makeBlobs(1);
    const tree = new DecisionTreeClassifier({ max_depth: 4 }).fit(X, y);
    const expected = Array.from(tree.predict(X));
    tree.compile();
    tree.compile();
    assert.deepEqual(Array.from(tree.predict(X)), expected);
  });
});

describe('DecisionTreeRegressor compile parity', () => {
  test('compiled predict matches interpreted EXACTLY', () => {
    const X = []; const y = [];
    for (let i = 0; i < 30; i++) { X.push([i / 5]); y.push(Math.sin(i / 5)); }
    const tree = new DecisionTreeRegressor({ max_depth: 5 }).fit(X, y);
    const before = Array.from(tree.predict(X));
    tree.compile();
    assert.deepEqual(Array.from(tree.predict(X)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// Forest compile parity
// ────────────────────────────────────────────────────────────────────

describe('RandomForest compile parity', () => {
  test('classifier compiled predict matches', () => {
    const { X, y } = makeBlobs(2);
    const rf = new RandomForestClassifier({ n_estimators: 10, random_state: 0 }).fit(X, y);
    const pred = Array.from(rf.predict(X));
    const proba = Array.from(rf.predict_proba(X));
    rf.compile();
    assert.deepEqual(Array.from(rf.predict(X)), pred);
    assert.deepEqual(Array.from(rf.predict_proba(X)), proba);
  });

  test('regressor compiled predict matches', () => {
    const X = []; const y = [];
    for (let i = 0; i < 40; i++) {
      X.push([i / 5, Math.cos(i / 3)]);
      y.push(Math.sin(i / 5));
    }
    const rf = new RandomForestRegressor({ n_estimators: 8, random_state: 0 }).fit(X, y);
    const before = Array.from(rf.predict(X));
    rf.compile();
    assert.deepEqual(Array.from(rf.predict(X)), before);
  });
});

describe('ExtraTrees compile parity', () => {
  test('classifier compiled matches', () => {
    const { X, y } = makeBlobs(3);
    const et = new ExtraTreesClassifier({ n_estimators: 8, random_state: 0 }).fit(X, y);
    const before = Array.from(et.predict(X));
    et.compile();
    assert.deepEqual(Array.from(et.predict(X)), before);
  });

  test('regressor compiled matches', () => {
    const X = []; const y = [];
    for (let i = 0; i < 30; i++) { X.push([i / 5]); y.push(i / 5); }
    const et = new ExtraTreesRegressor({ n_estimators: 8, random_state: 0 }).fit(X, y);
    const before = Array.from(et.predict(X));
    et.compile();
    assert.deepEqual(Array.from(et.predict(X)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// GradientBoosting compile parity
// ────────────────────────────────────────────────────────────────────

describe('GradientBoostingRegressor compile parity', () => {
  test('compiled predict matches', () => {
    const X = []; const y = [];
    for (let i = 0; i < 50; i++) { X.push([i / 5]); y.push(Math.sin(i / 5)); }
    const gbr = new GradientBoostingRegressor({ n_estimators: 30, max_depth: 3,
                                                random_state: 0 }).fit(X, y);
    const before = Array.from(gbr.predict(X));
    gbr.compile();
    assert.deepEqual(Array.from(gbr.predict(X)), before);
  });
});

describe('GradientBoostingClassifier compile is no-op (deferred to v0.3)', () => {
  test('compile() returns this without breaking predict', () => {
    const { X, y } = makeBlobs(0, 10);
    const gbc = new GradientBoostingClassifier({ n_estimators: 5,
                                                 random_state: 0 }).fit(X, y);
    const before = Array.from(gbc.predict(X));
    const r = gbc.compile();
    // Default BaseEstimator.compile is a no-op; predict still works.
    assert.equal(r, gbc);
    assert.deepEqual(Array.from(gbc.predict(X)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// dump / load behavior
// ────────────────────────────────────────────────────────────────────

describe('compile + dump/load', () => {
  test('dump/load loses compiled fn but preserves predictions', () => {
    const { X, y } = makeBlobs(4);
    const tree = new DecisionTreeClassifier({ random_state: 0 }).fit(X, y);
    tree.compile();
    const expected = Array.from(tree.predict(X));
    const r = load(dump(tree));
    // Loaded estimator predicts via interpreted path (no compile yet).
    assert.deepEqual(Array.from(r.predict(X)), expected);
    // Recompile and verify.
    r.compile();
    assert.deepEqual(Array.from(r.predict(X)), expected);
  });
});

// ────────────────────────────────────────────────────────────────────
// Sanity: compiled fn is actually a Function, not the interpreted one
// ────────────────────────────────────────────────────────────────────

describe('compile internals', () => {
  test('DecisionTree stashes _compiled_predict_value / _compiled_predict_class', () => {
    const X = []; const y = [];
    for (let i = 0; i < 20; i++) { X.push([i / 5]); y.push(i % 3); }
    const cls = new DecisionTreeClassifier().fit(X, y).compile();
    assert.ok(typeof cls._compiled_predict_class === 'function');
    assert.ok(typeof cls._compiled_predict_leaf === 'function');
    const reg = new DecisionTreeRegressor().fit([[0], [1], [2], [3]], [0, 1, 2, 3]).compile();
    assert.ok(typeof reg._compiled_predict_value === 'function');
  });

  test('Forest stashes per-tree compiled fns', () => {
    const X = []; const y = [];
    for (let i = 0; i < 20; i++) { X.push([i / 5]); y.push(i / 5); }
    const rf = new RandomForestRegressor({ n_estimators: 5 }).fit(X, y).compile();
    assert.equal(rf._compiled_tree_values.length, 5);
    for (const fn of rf._compiled_tree_values) assert.ok(typeof fn === 'function');
  });
});
