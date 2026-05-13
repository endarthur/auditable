// @gcu/learn linear_model test suite — LinearRegression, Ridge, Lasso,
// ElasticNet, LogisticRegression.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression,
  check_estimator, dump, load,
  r2_score, accuracy_score, mean_squared_error,
  Pipeline, StandardScaler,
  mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// Build a noiseless linear dataset y = intercept + Xβ.
function makeLinearXy(n, beta, intercept = 0, seed = 0) {
  const rng = mulberry32(seed);
  const m = beta.length;
  const X = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(m);
    let yi = intercept;
    for (let j = 0; j < m; j++) { row[j] = (rng() - 0.5) * 4; yi += row[j] * beta[j]; }
    X.push(row);
    y.push(yi);
  }
  return [X, y];
}

// ────────────────────────────────────────────────────────────────────
// LinearRegression
// ────────────────────────────────────────────────────────────────────

describe('LinearRegression', () => {
  test('recovers coefficients exactly on noiseless data', () => {
    const [X, y] = makeLinearXy(30, [3, 5, -2], 1.5, 42);
    const lr = new LinearRegression().fit(X, y);
    assert.ok(close(lr.coef_[0], 3, 1e-10));
    assert.ok(close(lr.coef_[1], 5, 1e-10));
    assert.ok(close(lr.coef_[2], -2, 1e-10));
    assert.ok(close(lr.intercept_, 1.5, 1e-10));
    assert.ok(close(r2_score(y, lr.predict(X)), 1, 1e-12));
  });

  test('fit_intercept=false zeros the intercept', () => {
    const [X, y] = makeLinearXy(30, [3, 5], 0, 0);
    const lr = new LinearRegression({ fit_intercept: false }).fit(X, y);
    assert.equal(lr.intercept_, 0);
    assert.ok(close(lr.coef_[0], 3, 1e-10));
  });

  test('predict raises on n_features mismatch', () => {
    // [[1,2],[3,4],[5,6]] is rank-deficient under intercept augmentation
    // (col_intercept + col_0 = col_1 + 1 in disguise) — use non-singular fit data.
    const lr = new LinearRegression().fit([[1, 5], [3, 4], [5, 9]], [1, 2, 3]);
    assert.throws(() => lr.predict([[1]]), /1 features.*fitted with 2/);
  });

  test('dump/load round-trip preserves predictions', () => {
    const [X, y] = makeLinearXy(20, [2, -1, 0.5], 0.7, 1);
    const lr = new LinearRegression().fit(X, y);
    const before = Array.from(lr.predict(X));
    const r = load(dump(lr));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(LinearRegression, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// Ridge
// ────────────────────────────────────────────────────────────────────

describe('Ridge', () => {
  test('alpha→0 matches LinearRegression closely', () => {
    const [X, y] = makeLinearXy(30, [3, 5, -2], 1, 7);
    const lr = new LinearRegression().fit(X, y);
    const r = new Ridge({ alpha: 1e-8 }).fit(X, y);
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(r.coef_[j] - lr.coef_[j]) < 1e-4);
    }
  });

  test('alpha shrinks coefficients toward 0', () => {
    const [X, y] = makeLinearXy(30, [10, -8, 5], 0, 7);
    const r0 = new Ridge({ alpha: 0.01 }).fit(X, y);
    const r1 = new Ridge({ alpha: 100 }).fit(X, y);
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(r1.coef_[j]) < Math.abs(r0.coef_[j]),
        `coef ${j}: small-α |${r0.coef_[j]}| should exceed large-α |${r1.coef_[j]}|`);
    }
  });

  test('matches sklearn closed-form on tiny fixture', () => {
    // Single feature, alpha=1, fit_intercept=false:
    //   coef = X^T y / (X^T X + α)
    // X = [[1],[2],[3]], y = [2,4,6] → β = (1*2+2*4+3*6)/(1+4+9+1) = 28/15
    const r = new Ridge({ alpha: 1, fit_intercept: false }).fit(
      [[1], [2], [3]], [2, 4, 6]);
    assert.ok(close(r.coef_[0], 28 / 15, 1e-12));
    assert.equal(r.intercept_, 0);
  });

  test('dump/load round-trip preserves predictions', () => {
    const [X, y] = makeLinearXy(20, [2, -1], 0.7, 1);
    const r = new Ridge({ alpha: 0.5 }).fit(X, y);
    const before = Array.from(r.predict(X));
    const r2 = load(dump(r));
    assert.deepEqual(Array.from(r2.predict(X)), before);
  });

  test('alpha < 0 raises', () => {
    assert.throws(() => new Ridge({ alpha: -1 }).fit([[1]], [1]),
      /alpha must be >= 0/);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(Ridge, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// Lasso
// ────────────────────────────────────────────────────────────────────

describe('Lasso', () => {
  test('zeros irrelevant features at high alpha', () => {
    // Only the first feature matters.
    const rng = mulberry32(0);
    const X = [];
    const y = [];
    for (let i = 0; i < 50; i++) {
      const x1 = (i - 25) / 10;
      const noise = (rng() - 0.5) * 0.5;
      X.push([x1, rng() * 5, rng() * 5, rng() * 5]);
      y.push(2 * x1 + noise);
    }
    const lasso = new Lasso({ alpha: 0.5 }).fit(X, y);
    // First coef should be nonzero; the irrelevant ones should hit zero.
    assert.ok(Math.abs(lasso.coef_[0]) > 0.5);
    let zeros = 0;
    for (let j = 1; j < 4; j++) if (lasso.coef_[j] === 0) zeros++;
    assert.ok(zeros >= 2, `expected >=2 zero coefs in irrelevant features, got ${zeros}`);
  });

  test('alpha=0 reduces to OLS (within tol)', () => {
    const [X, y] = makeLinearXy(30, [3, -2], 1, 0);
    const lasso = new Lasso({ alpha: 1e-6, max_iter: 5000, tol: 1e-9 }).fit(X, y);
    assert.ok(Math.abs(lasso.coef_[0] - 3) < 0.05);
    assert.ok(Math.abs(lasso.coef_[1] - (-2)) < 0.05);
  });

  test('selection="random" produces same fit as cyclic with fixed seed', () => {
    const [X, y] = makeLinearXy(30, [2, -1, 3], 0, 0);
    const a = new Lasso({ alpha: 0.1 }).fit(X, y);
    const b = new Lasso({ alpha: 0.1, selection: 'random', random_state: 1 }).fit(X, y);
    // Both should converge to similar coefficients at the same alpha.
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(a.coef_[j] - b.coef_[j]) < 0.1,
        `coef ${j}: ${a.coef_[j]} vs ${b.coef_[j]}`);
    }
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(Lasso, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });

  test('dump/load round-trip preserves predictions', () => {
    const [X, y] = makeLinearXy(30, [3, 0, 1], 0.5, 0);
    const lasso = new Lasso({ alpha: 0.1 }).fit(X, y);
    const before = Array.from(lasso.predict(X));
    const r = load(dump(lasso));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// ElasticNet
// ────────────────────────────────────────────────────────────────────

describe('ElasticNet', () => {
  test('l1_ratio=1 equals Lasso', () => {
    const [X, y] = makeLinearXy(30, [2, -1, 0.5], 0, 0);
    const lasso = new Lasso({ alpha: 0.1 }).fit(X, y);
    const en = new ElasticNet({ alpha: 0.1, l1_ratio: 1 }).fit(X, y);
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(lasso.coef_[j] - en.coef_[j]) < 1e-8);
    }
  });

  test('l1_ratio=0 is pure L2 (Ridge-like, coords nonzero)', () => {
    const [X, y] = makeLinearXy(30, [2, -1, 0.5], 0, 0);
    const en = new ElasticNet({ alpha: 0.5, l1_ratio: 0 }).fit(X, y);
    // No L1 penalty → no sparsity, all coefs should be nonzero.
    for (const c of en.coef_) assert.notEqual(c, 0);
  });

  test('intermediate l1_ratio sits between Lasso and Ridge sparsity', () => {
    const [X, y] = makeLinearXy(50, [3, 0, 0.5, 0], 0, 0);
    const lasso = new Lasso({ alpha: 0.5 }).fit(X, y);
    const ridge = new Ridge({ alpha: 1.0 }).fit(X, y);
    const en = new ElasticNet({ alpha: 0.5, l1_ratio: 0.5 }).fit(X, y);
    // ElasticNet should have at least one zero (some sparsity from L1)
    // but typically fewer than pure Lasso.
    let zerosL = 0; for (const c of lasso.coef_) if (c === 0) zerosL++;
    let zerosR = 0; for (const c of ridge.coef_) if (c === 0) zerosR++;
    let zerosE = 0; for (const c of en.coef_) if (c === 0) zerosE++;
    assert.equal(zerosR, 0);
    assert.ok(zerosE <= zerosL,
      `EN zeros=${zerosE}, Lasso zeros=${zerosL} (EN should be ≤ Lasso)`);
  });

  test('l1_ratio out of range raises', () => {
    assert.throws(() => new ElasticNet({ l1_ratio: 1.5 }).fit([[1]], [1]),
      /l1_ratio must be in \[0, 1\]/);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(ElasticNet, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// LogisticRegression
// ────────────────────────────────────────────────────────────────────

describe('LogisticRegression (binary)', () => {
  test('separable 2-class data → 100% accuracy', () => {
    const X = [
      [0, 0], [1, 1], [2, 2], [3, 3],
      [10, 10], [11, 11], [12, 12], [13, 13],
    ];
    const y = [0, 0, 0, 0, 1, 1, 1, 1];
    const lr = new LogisticRegression().fit(X, y);
    const yhat = lr.predict(X);
    assert.equal(accuracy_score(y, yhat), 1);
  });

  test('predict_proba rows sum to 1', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11]];
    const y = [0, 0, 1, 1];
    const lr = new LogisticRegression().fit(X, y);
    const P = lr.predict_proba(X);
    for (let i = 0; i < 4; i++) {
      const s = P[i * 2] + P[i * 2 + 1];
      assert.ok(close(s, 1, 1e-10), `row ${i} sums to ${s}`);
    }
  });

  test('coef_ shape is [1, n_features] for binary', () => {
    const lr = new LogisticRegression().fit([[0], [1], [10], [11]], [0, 0, 1, 1]);
    assert.deepEqual(lr.coef_.shape, [1, 1]);
    assert.equal(lr.intercept_.length, 1);
  });

  test('classes_ stored sorted', () => {
    const lr = new LogisticRegression().fit([[0], [1]], [5, 2]);
    assert.deepEqual(Array.from(lr.classes_), [2, 5]);
  });

  test('higher C reduces shrinkage', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11]];
    const y = [0, 0, 1, 1];
    const lo = new LogisticRegression({ C: 0.01 }).fit(X, y);
    const hi = new LogisticRegression({ C: 100 }).fit(X, y);
    let nlo = 0, nhi = 0;
    for (let j = 0; j < 2; j++) { nlo += lo.coef_[j] ** 2; nhi += hi.coef_[j] ** 2; }
    assert.ok(nhi > nlo, `higher C should give larger ||coef||² (got ${nhi} vs ${nlo})`);
  });

  test('penalty="none" is unregularized', () => {
    const X = [[0], [1], [10], [11]];
    const y = [0, 0, 1, 1];
    const lr = new LogisticRegression({ penalty: 'none' }).fit(X, y);
    // Without regularization on separable data, coefs grow large.
    assert.ok(Math.abs(lr.coef_[0]) > 0.5);
  });

  test('unsupported penalty raises', () => {
    assert.throws(
      () => new LogisticRegression({ penalty: 'l1' }).fit([[0]], [0]),
      /penalty='l1' not supported/);
  });

  test('dump/load round-trip preserves predictions', () => {
    const X = [[0, 0], [1, 1], [10, 10], [11, 11]];
    const y = [0, 0, 1, 1];
    const lr = new LogisticRegression().fit(X, y);
    const before = Array.from(lr.predict_proba(X));
    const r = load(dump(lr));
    assert.deepEqual(Array.from(r.predict_proba(X)), before);
  });
});

describe('LogisticRegression (multinomial)', () => {
  test('3-class fit produces sensible accuracy', () => {
    // 3 well-separated clusters in 2D.
    const X = [];
    const y = [];
    const centers = [[0, 0], [10, 0], [5, 9]];
    const rng = mulberry32(3);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 15; i++) {
        X.push([centers[c][0] + (rng() - 0.5) * 0.5,
                centers[c][1] + (rng() - 0.5) * 0.5]);
        y.push(c);
      }
    }
    const lr = new LogisticRegression({
      multi_class: 'multinomial', max_iter: 500,
    }).fit(X, y);
    const yhat = lr.predict(X);
    assert.deepEqual(lr.coef_.shape, [3, 2]);
    assert.equal(lr.intercept_.length, 3);
    assert.ok(accuracy_score(y, yhat) > 0.9);
  });

  test('predict_proba 3-class sums to 1', () => {
    const X = [];
    const y = [];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 8; i++) { X.push([c * 5, c * 5]); y.push(c); }
    }
    const lr = new LogisticRegression({
      multi_class: 'multinomial', max_iter: 200,
    }).fit(X, y);
    const P = lr.predict_proba(X);
    for (let i = 0; i < P.shape[0]; i++) {
      let s = 0; for (let c = 0; c < 3; c++) s += P[i * 3 + c];
      assert.ok(close(s, 1, 1e-8));
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Pipeline integration
// ────────────────────────────────────────────────────────────────────

describe('linear models + Pipeline', () => {
  test('StandardScaler → Lasso fits sensibly on a noisy sparse problem', () => {
    const [X, y] = makeLinearXy(40, [3, 0, 0, 1, 0], 0, 0);
    const pipe = new Pipeline({
      steps: [['scaler', new StandardScaler()], ['model', new Lasso({ alpha: 0.05 })]],
    });
    pipe.fit(X, y);
    const yhat = pipe.predict(X);
    assert.ok(r2_score(y, yhat) > 0.9);
  });
});
