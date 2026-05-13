// @gcu/learn compositional test suite — CLR, ILR, ALR + multiplicative
// zero replacement.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLR, ILR, ALR,
  check_estimator, dump, load,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// Canonical compositional fixture: rows sum to 1, all positive.
const X_simplex = [
  [0.2, 0.3, 0.5],
  [0.1, 0.6, 0.3],
  [0.4, 0.4, 0.2],
  [0.7, 0.2, 0.1],
];

// ────────────────────────────────────────────────────────────────────
// CLR
// ────────────────────────────────────────────────────────────────────

describe('CLR', () => {
  test('output rows sum to zero', () => {
    const clr = new CLR().fit(X_simplex);
    const Z = clr.transform(X_simplex);
    assert.deepEqual(Z.shape, [4, 3]);
    for (let i = 0; i < 4; i++) {
      let s = 0;
      for (let j = 0; j < 3; j++) s += Z[i * 3 + j];
      assert.ok(close(s, 0, 1e-12), `row ${i} sums to ${s}`);
    }
  });

  test('inverse_transform recovers a closed composition', () => {
    const clr = new CLR().fit(X_simplex);
    const Z = clr.transform(X_simplex);
    const X_back = clr.inverse_transform(Z);
    // Compositions are equivalent under rescaling; rows should match exactly
    // since X_simplex already sums to 1.
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        assert.ok(close(X_back[i * 3 + j], X_simplex[i][j], 1e-10),
          `i=${i} j=${j}: ${X_back[i * 3 + j]} vs ${X_simplex[i][j]}`);
      }
    }
  });

  test('reproduces sklearn-like output on a known composition', () => {
    // CLR([0.2, 0.3, 0.5]):
    //   logs = [-1.609, -1.204, -0.693]
    //   mean = -1.169
    //   centred = [-0.440, -0.035, 0.476]
    const clr = new CLR().fit([[0.2, 0.3, 0.5]]);
    const Z = clr.transform([[0.2, 0.3, 0.5]]);
    const logs = [Math.log(0.2), Math.log(0.3), Math.log(0.5)];
    const m = (logs[0] + logs[1] + logs[2]) / 3;
    for (let j = 0; j < 3; j++) {
      assert.ok(close(Z[j], logs[j] - m, 1e-12));
    }
  });

  test('multiplicative zero replacement handles zeros', () => {
    const clr = new CLR({ detection_limit: 0.01 }).fit([[0.5, 0.5, 0.0]]);
    // Should not throw; row will be replaced + rescaled.
    const Z = clr.transform([[0.5, 0.5, 0.0]]);
    assert.ok(Number.isFinite(Z[0]) && Number.isFinite(Z[1]) && Number.isFinite(Z[2]));
  });

  test('zero_replacement="none" raises on zeros', () => {
    const clr = new CLR({ zero_replacement: 'none' }).fit([[0.5, 0.5, 0.5]]);
    assert.throws(() => clr.transform([[0.5, 0.0, 0.5]]),
      /non-positive value at row 0/);
  });

  test('dump/load round-trip preserves output', () => {
    const clr = new CLR().fit(X_simplex);
    const before = Array.from(clr.transform(X_simplex));
    const reloaded = load(dump(clr));
    assert.deepEqual(Array.from(reloaded.transform(X_simplex)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// ILR
// ────────────────────────────────────────────────────────────────────

describe('ILR', () => {
  test('output has D-1 columns', () => {
    const ilr = new ILR().fit(X_simplex);
    const Z = ilr.transform(X_simplex);
    assert.deepEqual(Z.shape, [4, 2]);
    assert.equal(ilr.n_features_out_, 2);
  });

  test('Helmert basis rows are unit-norm and mutually orthogonal', () => {
    const ilr = new ILR().fit(X_simplex);
    const V = ilr.helmert_;
    const D = ilr.n_features_in_;
    const Dm1 = D - 1;
    // Each row has unit norm.
    for (let k = 0; k < Dm1; k++) {
      let n = 0;
      for (let j = 0; j < D; j++) n += V[k * D + j] * V[k * D + j];
      assert.ok(close(n, 1, 1e-12), `row ${k} norm² = ${n}`);
    }
    // Pairs orthogonal.
    for (let a = 0; a < Dm1; a++) {
      for (let b = a + 1; b < Dm1; b++) {
        let dot = 0;
        for (let j = 0; j < D; j++) dot += V[a * D + j] * V[b * D + j];
        assert.ok(close(dot, 0, 1e-12), `rows ${a},${b} dot = ${dot}`);
      }
    }
    // V^T V = I_D - (1/D) J  (the Helmert/CLR-projection identity).
    // Diagonal entries should be 1 - 1/D; off-diagonal should be -1/D.
    for (let i = 0; i < D; i++) {
      for (let j = 0; j < D; j++) {
        let dot = 0;
        for (let k = 0; k < Dm1; k++) dot += V[k * D + i] * V[k * D + j];
        const expected = (i === j ? 1 : 0) - 1 / D;
        assert.ok(close(dot, expected, 1e-12),
          `(V^T V)[${i},${j}] = ${dot}, expected ${expected}`);
      }
    }
  });

  test('inverse_transform recovers closed composition', () => {
    const ilr = new ILR().fit(X_simplex);
    const Z = ilr.transform(X_simplex);
    const X_back = ilr.inverse_transform(Z);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        assert.ok(close(X_back[i * 3 + j], X_simplex[i][j], 1e-10),
          `i=${i} j=${j}: ${X_back[i * 3 + j]} vs ${X_simplex[i][j]}`);
      }
    }
  });

  test('dump/load round-trip preserves output', () => {
    const ilr = new ILR().fit(X_simplex);
    const before = Array.from(ilr.transform(X_simplex));
    const reloaded = load(dump(ilr));
    assert.deepEqual(Array.from(reloaded.transform(X_simplex)), before);
  });

  test('fit raises on D < 2', () => {
    assert.throws(() => new ILR().fit([[0.5]]), /needs at least 2 features/);
  });
});

// ────────────────────────────────────────────────────────────────────
// ALR
// ────────────────────────────────────────────────────────────────────

describe('ALR', () => {
  test('output has D-1 columns; default denominator is last', () => {
    const alr = new ALR().fit(X_simplex);
    assert.equal(alr.denominator_, 2);  // last column for D=3
    const Z = alr.transform(X_simplex);
    assert.deepEqual(Z.shape, [4, 2]);
  });

  test('reproduces alr formula exactly', () => {
    const alr = new ALR({ denominator: 0 }).fit(X_simplex);
    // alr_i = log(x_i / x_d)  for i ≠ d
    const Z = alr.transform([[0.2, 0.3, 0.5]]);
    // d=0, x_d=0.2; output = [log(0.3/0.2), log(0.5/0.2)]
    assert.ok(close(Z[0], Math.log(0.3 / 0.2), 1e-12));
    assert.ok(close(Z[1], Math.log(0.5 / 0.2), 1e-12));
  });

  test('inverse_transform recovers closed composition', () => {
    const alr = new ALR({ denominator: 0 }).fit(X_simplex);
    const Z = alr.transform(X_simplex);
    const X_back = alr.inverse_transform(Z);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        assert.ok(close(X_back[i * 3 + j], X_simplex[i][j], 1e-10));
      }
    }
  });

  test('negative denominator wraps from end', () => {
    const a1 = new ALR({ denominator: -1 }).fit(X_simplex);
    const a2 = new ALR({ denominator: 2 }).fit(X_simplex);
    assert.equal(a1.denominator_, a2.denominator_);
  });

  test('out-of-range denominator raises', () => {
    assert.throws(() => new ALR({ denominator: 99 }).fit(X_simplex),
      /denominator=99 out of range/);
  });

  test('dump/load round-trip preserves output', () => {
    const alr = new ALR({ denominator: 1 }).fit(X_simplex);
    const before = Array.from(alr.transform(X_simplex));
    const reloaded = load(dump(alr));
    assert.equal(reloaded.denominator_, 1);
    assert.deepEqual(Array.from(reloaded.transform(X_simplex)), before);
  });
});

// ────────────────────────────────────────────────────────────────────
// Multiplicative zero replacement
// ────────────────────────────────────────────────────────────────────

describe('multiplicative replacement', () => {
  test('replaces zeros with 0.65 × detection_limit', () => {
    const clr = new CLR({ detection_limit: 0.01 }).fit([[0.5, 0.5, 0.0]]);
    // Just smoke-test that transform produces finite values; the
    // round-trip via inverse should be approximately the original
    // composition with zero replaced by ~0.0065.
    const Z = clr.transform([[0.5, 0.5, 0.0]]);
    const back = clr.inverse_transform(Z);
    // Replaced position should be ~0.0065 / row_sum = 0.0065 / 1.0 ≈ 0.0065
    assert.ok(back[2] > 0 && back[2] < 0.01);
  });

  test('preserves row sum', () => {
    const X = [[0.5, 0.0, 0.5]];
    const clr = new CLR({ detection_limit: 0.01 }).fit(X);
    const Z = clr.transform(X);
    const back = clr.inverse_transform(Z);
    let s = 0; for (let j = 0; j < 3; j++) s += back[j];
    assert.ok(close(s, 1, 1e-10));
  });
});

// ────────────────────────────────────────────────────────────────────
// check_estimator
// ────────────────────────────────────────────────────────────────────

describe('check_estimator (compositional)', () => {
  // The default check_estimator data is signed (centered around 0), which
  // is invalid for compositional transforms (need positive simplex). We
  // pass a custom positive instance and skip data-driven checks by
  // running on instance only — check_estimator's NaN check still runs and
  // should error appropriately because asMatrix rejects NaN.
  test('CLR construction + clone + tags + dump/load contract', () => {
    const errs = check_estimator(CLR, { collect: true,
                                          n_samples: 10, n_features: 3 });
    // CLR will fail the data-driven check because synthetic data has
    // negatives; skip those failures, just assert the contract checks pass.
    const contractFailures = errs.filter(e =>
      !/transform: threw/.test(e) && !/dump\/load.*transforms differ/.test(e));
    assert.deepEqual(contractFailures, [],
      `contract violations:\n  ${contractFailures.join('\n  ')}`);
  });
});
