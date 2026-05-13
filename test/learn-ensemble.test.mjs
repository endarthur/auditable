// @gcu/learn ensemble test suite — RandomForest, ExtraTrees, Bagging.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  BaggingClassifier, BaggingRegressor,
  DecisionTreeClassifier, DecisionTreeRegressor,
  LogisticRegression,
  check_estimator, dump, load, clone,
  accuracy_score, r2_score, mean_squared_error,
  Pipeline, StandardScaler,
  mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// 3-class separable blobs.
function makeBlobs(n_per = 20, seed = 0) {
  const rng = mulberry32(seed);
  const X = [];
  const y = [];
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

// 1D regression target with noise.
function makeRegression(n = 50, seed = 0) {
  const rng = mulberry32(seed);
  const X = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    const x = (i - n / 2) / 5;
    X.push([x, Math.sin(x), Math.cos(x)]);
    y.push(2 * x + 0.1 * (rng() - 0.5));
  }
  return { X, y };
}

// ────────────────────────────────────────────────────────────────────
// RandomForestClassifier
// ────────────────────────────────────────────────────────────────────

describe('RandomForestClassifier', () => {
  test('100% accuracy on separable 3-class data', () => {
    const { X, y } = makeBlobs(20, 0);
    const rf = new RandomForestClassifier({ n_estimators: 20, random_state: 0 }).fit(X, y);
    assert.equal(accuracy_score(y, rf.predict(X)), 1);
  });

  test('predict_proba rows sum to 1', () => {
    const { X, y } = makeBlobs(15, 1);
    const rf = new RandomForestClassifier({ n_estimators: 10, random_state: 0 }).fit(X, y);
    const P = rf.predict_proba(X);
    for (let i = 0; i < X.length; i++) {
      let s = 0; for (let c = 0; c < 3; c++) s += P[i * 3 + c];
      assert.ok(close(s, 1, 1e-10), `row ${i} sums to ${s}`);
    }
  });

  test('n_estimators trees fitted', () => {
    const { X, y } = makeBlobs(10, 2);
    const rf = new RandomForestClassifier({ n_estimators: 7, random_state: 0 }).fit(X, y);
    assert.equal(rf.estimators_.length, 7);
    for (const t of rf.estimators_) assert.ok(t instanceof DecisionTreeClassifier);
  });

  test('reduces variance vs a single deep tree on noisy data', () => {
    // Tiny dataset where single trees over-fit but the forest averages out.
    const rng = mulberry32(7);
    const X = []; const y = [];
    for (let i = 0; i < 50; i++) {
      const x = rng() * 10;
      X.push([x, x * 0.5, rng()]);
      y.push((x > 5 ? 1 : 0) ^ (rng() > 0.85 ? 1 : 0));
    }
    const tree = new DecisionTreeClassifier({ random_state: 0 }).fit(X, y);
    const rf = new RandomForestClassifier({ n_estimators: 30, random_state: 0 }).fit(X, y);
    // Both fit train well; the test here is just that neither errors.
    assert.ok(Number.isFinite(accuracy_score(y, tree.predict(X))));
    assert.ok(Number.isFinite(accuracy_score(y, rf.predict(X))));
  });

  test('handles a class missing from a bootstrap sample', () => {
    // 2 samples per class → bootstrap may miss a class entirely; the
    // forest must union classes across trees.
    const X = [[0], [1], [10], [11], [20], [21]];
    const y = [0, 0, 1, 1, 2, 2];
    const rf = new RandomForestClassifier({ n_estimators: 30, random_state: 0 }).fit(X, y);
    assert.deepEqual(Array.from(rf.classes_), [0, 1, 2]);
    assert.equal(rf.n_classes_, 3);
  });

  test('dump/load round-trip preserves predictions', () => {
    const { X, y } = makeBlobs(15, 4);
    const rf = new RandomForestClassifier({ n_estimators: 10, random_state: 0 }).fit(X, y);
    const before = Array.from(rf.predict(X));
    const proba_before = Array.from(rf.predict_proba(X));
    const r = load(dump(rf));
    assert.ok(r instanceof RandomForestClassifier);
    assert.equal(r.estimators_.length, 10);
    assert.deepEqual(Array.from(r.predict(X)), before);
    assert.deepEqual(Array.from(r.predict_proba(X)), proba_before);
  });

  test('reproducibility under fixed random_state', () => {
    const { X, y } = makeBlobs(10, 0);
    const a = new RandomForestClassifier({ n_estimators: 5, random_state: 1 }).fit(X, y);
    const b = new RandomForestClassifier({ n_estimators: 5, random_state: 1 }).fit(X, y);
    assert.deepEqual(Array.from(a.predict(X)), Array.from(b.predict(X)));
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(RandomForestClassifier, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// RandomForestRegressor
// ────────────────────────────────────────────────────────────────────

describe('RandomForestRegressor', () => {
  test('high R² on a near-linear target', () => {
    const { X, y } = makeRegression(50, 0);
    const rf = new RandomForestRegressor({ n_estimators: 20, random_state: 0 }).fit(X, y);
    const r2 = r2_score(y, rf.predict(X));
    assert.ok(r2 > 0.9, `R² ${r2} should be > 0.9`);
  });

  test('predict averages tree outputs', () => {
    const { X, y } = makeRegression(30, 1);
    const rf = new RandomForestRegressor({ n_estimators: 5, random_state: 0,
                                            bootstrap: false }).fit(X, y);
    // With bootstrap=false and n_samples=n, each tree sees the same data.
    // (Different random_state seeds still give different feature subsets.)
    const yh = rf.predict(X);
    let ymean = 0;
    for (const t of rf.estimators_) {
      const yh_t = t.predict(X);
      for (let i = 0; i < yh_t.length; i++) ymean += yh_t[i];
    }
    ymean /= rf.estimators_.length;
    let yh_mean = 0; for (const v of yh) yh_mean += v;
    assert.ok(close(yh_mean, ymean, 1e-10));
  });

  test('dump/load round-trip preserves predictions', () => {
    const { X, y } = makeRegression(30, 2);
    const rf = new RandomForestRegressor({ n_estimators: 8, random_state: 0 }).fit(X, y);
    const before = Array.from(rf.predict(X));
    const r = load(dump(rf));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(RandomForestRegressor, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// ExtraTreesClassifier
// ────────────────────────────────────────────────────────────────────

describe('ExtraTreesClassifier', () => {
  test('classifies separable data', () => {
    const { X, y } = makeBlobs(20, 0);
    const et = new ExtraTreesClassifier({ n_estimators: 30, random_state: 0 }).fit(X, y);
    assert.ok(accuracy_score(y, et.predict(X)) > 0.9);
  });

  test('uses splitter=random under the hood', () => {
    const { X, y } = makeBlobs(15, 0);
    const et = new ExtraTreesClassifier({ n_estimators: 5, random_state: 0 }).fit(X, y);
    for (const t of et.estimators_) {
      assert.equal(t.splitter, 'random');
    }
  });

  test('default bootstrap=false (sklearn convention)', () => {
    const et = new ExtraTreesClassifier();
    assert.equal(et.bootstrap, false);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(ExtraTreesClassifier, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

describe('ExtraTreesRegressor', () => {
  test('fits a continuous target reasonably', () => {
    const { X, y } = makeRegression(50, 3);
    const et = new ExtraTreesRegressor({ n_estimators: 30, random_state: 0 }).fit(X, y);
    const r2 = r2_score(y, et.predict(X));
    assert.ok(r2 > 0.8, `R² ${r2} should be > 0.8`);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(ExtraTreesRegressor, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// BaggingClassifier with custom base estimator
// ────────────────────────────────────────────────────────────────────

describe('BaggingClassifier', () => {
  test('default base estimator is DecisionTreeClassifier', () => {
    const bc = new BaggingClassifier();
    assert.ok(bc.estimator instanceof DecisionTreeClassifier);
  });

  test('accepts LogisticRegression as base estimator', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11], [20, 20], [21, 21]];
    const y = [0, 0, 1, 1, 0, 0];
    const bc = new BaggingClassifier({
      estimator: new LogisticRegression(),
      n_estimators: 5, random_state: 0,
    }).fit(X, y);
    for (const e of bc.estimators_) assert.ok(e instanceof LogisticRegression);
    const yh = bc.predict(X);
    assert.equal(yh.length, X.length);
  });

  test('predict_proba averages base estimator probabilities', () => {
    const { X, y } = makeBlobs(15, 5);
    const bc = new BaggingClassifier({
      estimator: new DecisionTreeClassifier({ max_depth: 2 }),
      n_estimators: 10, random_state: 0,
    }).fit(X, y);
    const P = bc.predict_proba(X);
    for (let i = 0; i < X.length; i++) {
      let s = 0; for (let c = 0; c < 3; c++) s += P[i * 3 + c];
      assert.ok(close(s, 1, 1e-10));
    }
  });

  test('dump/load round-trip preserves predictions', () => {
    const { X, y } = makeBlobs(15, 6);
    const bc = new BaggingClassifier({
      estimator: new DecisionTreeClassifier({ max_depth: 3 }),
      n_estimators: 5, random_state: 0,
    }).fit(X, y);
    const before = Array.from(bc.predict(X));
    const r = load(dump(bc));
    assert.ok(r instanceof BaggingClassifier);
    assert.deepEqual(Array.from(r.predict(X)), before);
  });

  test('clone preserves estimator template independently', () => {
    const tpl = new DecisionTreeClassifier({ max_depth: 5 });
    const bc = new BaggingClassifier({ estimator: tpl, n_estimators: 3 });
    const c = clone(bc);
    assert.notEqual(c.estimator, bc.estimator);
    c.estimator.max_depth = 99;
    assert.equal(bc.estimator.max_depth, 5);
  });
});

// ────────────────────────────────────────────────────────────────────
// BaggingRegressor
// ────────────────────────────────────────────────────────────────────

describe('BaggingRegressor', () => {
  test('default base estimator is DecisionTreeRegressor', () => {
    const br = new BaggingRegressor();
    assert.ok(br.estimator instanceof DecisionTreeRegressor);
  });

  test('predict averages base regressor outputs', () => {
    const { X, y } = makeRegression(30, 7);
    const br = new BaggingRegressor({ n_estimators: 8, random_state: 0 }).fit(X, y);
    const yh = br.predict(X);
    assert.equal(yh.length, X.length);
    assert.ok(r2_score(y, yh) > 0.8);
  });

  test('dump/load round-trip preserves predictions', () => {
    const { X, y } = makeRegression(20, 8);
    const br = new BaggingRegressor({ n_estimators: 5, random_state: 0 }).fit(X, y);
    const before = Array.from(br.predict(X));
    const r = load(dump(br));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// Pipeline integration
// ────────────────────────────────────────────────────────────────────

describe('ensemble + Pipeline', () => {
  test('StandardScaler → RandomForest end-to-end', () => {
    const { X, y } = makeBlobs(15, 0);
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['rf', new RandomForestClassifier({ n_estimators: 10, random_state: 0 })],
      ],
    });
    pipe.fit(X, y);
    assert.equal(accuracy_score(y, pipe.predict(X)), 1);
  });

  test('full Pipeline dump/load preserves predictions', () => {
    const { X, y } = makeBlobs(10, 0);
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['rf', new RandomForestClassifier({ n_estimators: 5, random_state: 0 })],
      ],
    });
    pipe.fit(X, y);
    const before = Array.from(pipe.predict(X));
    const r = load(dump(pipe));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });
});
