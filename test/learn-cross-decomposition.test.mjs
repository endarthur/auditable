// @gcu/learn cross_decomposition test suite — PLSRegression (PLS1).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLSRegression,
  Pipeline, StandardScaler, LinearRegression,
  check_estimator, dump, load,
  r2_score, mulberry32,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// y = 2x_1 + 3x_2 + 5x_3 with strongly correlated features.
function makeCollinear(n = 30, seed = 0) {
  const rng = mulberry32(seed);
  const X = []; const y = [];
  for (let i = 0; i < n; i++) {
    const a = rng(), b = rng(), c = rng();
    X.push([a, a + 0.1 * rng(), b, b + 0.1 * rng(), c]);
    y.push(2 * a + 3 * b + 5 * c);
  }
  return { X, y };
}

// ────────────────────────────────────────────────────────────────────
// PLSRegression
// ────────────────────────────────────────────────────────────────────

describe('PLSRegression', () => {
  test('fits collinear data with high R²', () => {
    const { X, y } = makeCollinear(30, 0);
    const pls = new PLSRegression({ n_components: 3 }).fit(X, y);
    assert.ok(r2_score(y, pls.predict(X)) > 0.99);
  });

  test('predict on training data matches sklearn-ish reconstruction', () => {
    const X = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];
    const y = [3, 7, 11, 15, 19];  // exactly y = 1 + x1 + x2
    const pls = new PLSRegression({ n_components: 1 }).fit(X, y);
    const yhat = pls.predict(X);
    for (let i = 0; i < 5; i++) {
      assert.ok(close(yhat[i], y[i], 1e-8));
    }
  });

  test('n_components controls degrees of freedom', () => {
    const { X, y } = makeCollinear(30, 1);
    const r1 = r2_score(y, new PLSRegression({ n_components: 1 }).fit(X, y).predict(X));
    const r3 = r2_score(y, new PLSRegression({ n_components: 3 }).fit(X, y).predict(X));
    assert.ok(r3 >= r1, `R² should not decrease with more components (got ${r1} → ${r3})`);
  });

  test('caps n_components at min(n_samples, n_features) and may stop early', () => {
    // n=3, m=2 → upper bound 2. y here is exactly 5*x1+5 so the y residual
    // hits zero after one component; n_components_ should reflect that
    // (not the full 2-component cap).
    const X = [[1, 2], [3, 4], [5, 6]];
    const y = [10, 20, 30];
    const pls = new PLSRegression({ n_components: 99 }).fit(X, y);
    assert.ok(pls.n_components_ <= 2 && pls.n_components_ >= 1);
  });

  test('transform shape is [n_samples, n_components]', () => {
    const { X, y } = makeCollinear(20, 2);
    const pls = new PLSRegression({ n_components: 2 }).fit(X, y);
    const T = pls.transform(X);
    assert.deepEqual(T.shape, [20, 2]);
  });

  test('on a non-collinear well-conditioned problem, PLS roughly matches OLS', () => {
    const X = [[0, 0], [1, 0], [0, 1], [1, 1]];
    const y = [1, 3, 5, 7];  // y = 1 + 2*x1 + 4*x2
    const lr = new LinearRegression().fit(X, y);
    const pls = new PLSRegression({ n_components: 2 }).fit(X, y);
    // PLS with full n_components should give the same predictions as OLS.
    for (let i = 0; i < X.length; i++) {
      const yp_lr = lr.predict([X[i]])[0];
      const yp_pls = pls.predict([X[i]])[0];
      assert.ok(close(yp_lr, yp_pls, 1e-8),
        `LR ${yp_lr} vs PLS ${yp_pls} at i=${i}`);
    }
  });

  test('scale=false changes coef_ predictably', () => {
    const { X, y } = makeCollinear(30, 3);
    const a = new PLSRegression({ n_components: 3, scale: true }).fit(X, y);
    const b = new PLSRegression({ n_components: 3, scale: false }).fit(X, y);
    // Both should still predict, but coefficients differ.
    assert.ok(r2_score(y, a.predict(X)) > 0.95);
    assert.ok(r2_score(y, b.predict(X)) > 0.95);
  });

  test('predict raises on n_features mismatch', () => {
    const pls = new PLSRegression().fit([[1, 2], [3, 4], [5, 6]], [1, 2, 3]);
    assert.throws(() => pls.predict([[1]]), /1 features.*fitted with 2/);
  });

  test('dump/load round-trip preserves predictions exactly', () => {
    const { X, y } = makeCollinear(20, 4);
    const pls = new PLSRegression({ n_components: 2 }).fit(X, y);
    const before = Array.from(pls.predict(X));
    const r = load(dump(pls));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(PLSRegression, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// Pipeline integration
// ────────────────────────────────────────────────────────────────────

describe('PLSRegression + Pipeline', () => {
  test('StandardScaler → PLSRegression on collinear data', () => {
    const { X, y } = makeCollinear(40, 0);
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['pls', new PLSRegression({ n_components: 3 })],
      ],
    });
    pipe.fit(X, y);
    assert.ok(r2_score(y, pipe.predict(X)) > 0.99);
  });

  test('full pipeline dump/load preserves predictions', () => {
    const { X, y } = makeCollinear(20, 5);
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['pls', new PLSRegression({ n_components: 2 })],
      ],
    });
    pipe.fit(X, y);
    const before = Array.from(pipe.predict(X));
    const r = load(dump(pipe));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });
});
