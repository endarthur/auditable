// @gcu/learn preprocessing fill-out test suite — MinMaxScaler,
// MaxAbsScaler, RobustScaler, LabelEncoder, OrdinalEncoder,
// OneHotEncoder, KBinsDiscretizer, PowerTransformer.
//
// (StandardScaler tests live in learn-foundations.test.mjs.)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MinMaxScaler, MaxAbsScaler, RobustScaler,
  LabelEncoder, OrdinalEncoder, OneHotEncoder,
  KBinsDiscretizer, PowerTransformer,
  check_estimator, dump, load,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;
const arrayClose = (a, b, tol = 1e-10) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

// ────────────────────────────────────────────────────────────────────
// MinMaxScaler
// ────────────────────────────────────────────────────────────────────

describe('MinMaxScaler', () => {
  const X = [[1, 10], [2, 20], [3, 30], [4, 40]];

  test('default range [0, 1]', () => {
    const sc = new MinMaxScaler().fit(X);
    const Xt = sc.transform(X);
    assert.deepEqual(Xt.shape, [4, 2]);
    assert.deepEqual(Array.from(sc.data_min_), [1, 10]);
    assert.deepEqual(Array.from(sc.data_max_), [4, 40]);
    // (1, 10) → (0, 0); (4, 40) → (1, 1)
    assert.ok(close(Xt[0], 0)); assert.ok(close(Xt[1], 0));
    assert.ok(close(Xt[6], 1)); assert.ok(close(Xt[7], 1));
  });

  test('custom feature_range', () => {
    const sc = new MinMaxScaler({ feature_range: [-1, 1] }).fit(X);
    const Xt = sc.transform(X);
    assert.ok(close(Xt[0], -1)); assert.ok(close(Xt[6], 1));
  });

  test('inverse_transform recovers the original', () => {
    const sc = new MinMaxScaler().fit(X);
    const Xt = sc.transform(X);
    const Xb = sc.inverse_transform(Xt);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 2; j++) {
        assert.ok(close(Xb[i * 2 + j], X[i][j], 1e-12));
      }
    }
  });

  test('zero-range column scales to feature_range[0]', () => {
    const sc = new MinMaxScaler().fit([[5, 1], [5, 2], [5, 3]]);
    assert.equal(sc.data_range_[0], 0);
    const Xt = sc.transform([[5, 1]]);
    assert.equal(Xt[0], 0);  // r_lo - 5 * 1 + 5*1 ... actually (5-5)*scale+min = 0
  });

  test('invalid feature_range raises', () => {
    assert.throws(() => new MinMaxScaler({ feature_range: [1, 0] }).fit(X),
      /feature_range must satisfy lo<hi/);
  });

  test('dump/load round-trip preserves transform', () => {
    const sc = new MinMaxScaler({ feature_range: [-2, 2] }).fit(X);
    const before = Array.from(sc.transform(X));
    const r = load(dump(sc));
    assert.deepEqual(Array.from(r.transform(X)), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(MinMaxScaler, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// MaxAbsScaler
// ────────────────────────────────────────────────────────────────────

describe('MaxAbsScaler', () => {
  test('output is in [-1, 1]', () => {
    const X = [[-3, 5], [2, -10], [-1, 3]];
    const sc = new MaxAbsScaler().fit(X);
    assert.deepEqual(Array.from(sc.max_abs_), [3, 10]);
    const Xt = sc.transform(X);
    for (let v of Xt) assert.ok(v >= -1 && v <= 1);
  });

  test('inverse_transform recovers original', () => {
    const X = [[-3, 5], [2, -10], [-1, 3]];
    const sc = new MaxAbsScaler().fit(X);
    const Xb = sc.inverse_transform(sc.transform(X));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      assert.ok(close(Xb[i * 2 + j], X[i][j]));
    }
  });

  test('preserves zeros and signs', () => {
    const X = [[0, -1], [0, 1], [4, 0]];
    const sc = new MaxAbsScaler().fit(X);
    const Xt = sc.transform(X);
    assert.equal(Xt[0], 0);  // 0/4 = 0
    assert.equal(Xt[2], 0);  // 0/1 = 0  (col 0 max is 4, col 1 max is 1)
    assert.ok(Xt[1] < 0);    // -1 → negative
    assert.ok(Xt[3] > 0);    //  1 → positive
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(MaxAbsScaler, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// RobustScaler
// ────────────────────────────────────────────────────────────────────

describe('RobustScaler', () => {
  test('IQR-based scaling, median-centered', () => {
    // Symmetric data 0..8, median=4, IQR = q75-q25 = 6-2 = 4
    const X = [[0], [1], [2], [3], [4], [5], [6], [7], [8]];
    const sc = new RobustScaler().fit(X);
    assert.ok(close(sc.center_[0], 4));
    assert.ok(close(sc.scale_[0], 4));
    const Xt = sc.transform([[4]]);
    assert.equal(Xt[0], 0);
    const Xt2 = sc.transform([[8]]);
    assert.equal(Xt2[0], 1);
  });

  test('robust to outliers (extreme value barely moves IQR)', () => {
    const X_clean = [[1], [2], [3], [4], [5]];
    const X_outl = [[1], [2], [3], [4], [1e6]];
    const a = new RobustScaler().fit(X_clean);
    const b = new RobustScaler().fit(X_outl);
    // IQR for both should be similar (q75 - q25 ≈ 2 either way).
    assert.ok(Math.abs(a.scale_[0] - b.scale_[0]) < 1);
  });

  test('with_centering=false, with_scaling=false', () => {
    const X = [[1], [2], [3]];
    const sc = new RobustScaler({ with_centering: false, with_scaling: false }).fit(X);
    const Xt = sc.transform([[5]]);
    assert.equal(Xt[0], 5);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(RobustScaler, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});

// ────────────────────────────────────────────────────────────────────
// LabelEncoder
// ────────────────────────────────────────────────────────────────────

describe('LabelEncoder', () => {
  test('sorts string labels alphabetically', () => {
    const le = new LabelEncoder().fit(['cat', 'dog', 'cat', 'bird']);
    assert.deepEqual(le.classes_, ['bird', 'cat', 'dog']);
  });

  test('transforms to 0..k-1', () => {
    const le = new LabelEncoder().fit(['cat', 'dog', 'bird']);
    const enc = le.transform(['bird', 'dog', 'cat']);
    assert.deepEqual(Array.from(enc), [0, 2, 1]);
  });

  test('inverse_transform recovers labels', () => {
    const le = new LabelEncoder().fit(['cat', 'dog', 'bird']);
    const enc = le.transform(['bird', 'dog', 'cat']);
    assert.deepEqual(le.inverse_transform(enc), ['bird', 'dog', 'cat']);
  });

  test('numeric labels sort numerically', () => {
    const le = new LabelEncoder().fit([10, 2, 30, 2]);
    assert.deepEqual(le.classes_, [2, 10, 30]);
  });

  test('unknown label raises', () => {
    const le = new LabelEncoder().fit(['a', 'b']);
    assert.throws(() => le.transform(['a', 'c']), /unknown label 'c'/);
  });

  test('fit_transform shorthand', () => {
    const le = new LabelEncoder();
    const enc = le.fit_transform(['x', 'y', 'x']);
    assert.deepEqual(Array.from(enc), [0, 1, 0]);
  });
});

// ────────────────────────────────────────────────────────────────────
// OrdinalEncoder
// ────────────────────────────────────────────────────────────────────

describe('OrdinalEncoder', () => {
  test('encodes per-column strings to ints', () => {
    const X = [['cat', 'red'], ['dog', 'blue'], ['bird', 'red'], ['cat', 'green']];
    const enc = new OrdinalEncoder().fit(X);
    assert.deepEqual(enc.categories_[0], ['bird', 'cat', 'dog']);
    assert.deepEqual(enc.categories_[1], ['blue', 'green', 'red']);
    const Xt = enc.transform(X);
    assert.deepEqual(Xt.shape, [4, 2]);
    // ('cat', 'red') → (1, 2)
    assert.equal(Xt[0], 1); assert.equal(Xt[1], 2);
  });

  test('handle_unknown="use_encoded_value" returns sentinel', () => {
    const enc = new OrdinalEncoder({
      handle_unknown: 'use_encoded_value', unknown_value: -1,
    }).fit([['a'], ['b']]);
    const Xt = enc.transform([['a'], ['c']]);
    assert.equal(Xt[0], 0);
    assert.equal(Xt[1], -1);
  });

  test('handle_unknown="error" raises on unseen', () => {
    const enc = new OrdinalEncoder().fit([['a'], ['b']]);
    assert.throws(() => enc.transform([['c']]), /unknown category 'c'/);
  });

  test('inverse_transform restores labels', () => {
    const X = [['cat', 'red'], ['dog', 'blue']];
    const enc = new OrdinalEncoder().fit(X);
    const Xt = enc.transform(X);
    const back = enc.inverse_transform(Xt);
    assert.deepEqual(back, X);
  });
});

// ────────────────────────────────────────────────────────────────────
// OneHotEncoder
// ────────────────────────────────────────────────────────────────────

describe('OneHotEncoder', () => {
  test('expands categorical column', () => {
    const X = [['cat'], ['dog'], ['bird'], ['cat']];
    const enc = new OneHotEncoder().fit(X);
    assert.equal(enc.n_features_out_, 3);
    const Xt = enc.transform(X);
    assert.deepEqual(Xt.shape, [4, 3]);
    // Row 0: 'cat' = index 1 in [bird, cat, dog] → [0, 1, 0]
    assert.deepEqual(Array.from(Xt.subarray(0, 3)), [0, 1, 0]);
    assert.deepEqual(Array.from(Xt.subarray(3, 6)), [0, 0, 1]);  // dog
    assert.deepEqual(Array.from(Xt.subarray(6, 9)), [1, 0, 0]);  // bird
  });

  test('drop="first" omits the first category per feature', () => {
    const X = [['cat'], ['dog'], ['bird']];
    const enc = new OneHotEncoder({ drop: 'first' }).fit(X);
    assert.equal(enc.n_features_out_, 2);
    const Xt = enc.transform(X);
    // Row 0: cat (index 1, drop bird) → [1, 0]
    assert.deepEqual(Array.from(Xt.subarray(0, 2)), [1, 0]);
    assert.deepEqual(Array.from(Xt.subarray(2, 4)), [0, 1]);  // dog
    assert.deepEqual(Array.from(Xt.subarray(4, 6)), [0, 0]);  // bird (dropped)
  });

  test('drop="if_binary" drops only binary features', () => {
    const X = [['a', 'cat'], ['b', 'dog'], ['a', 'bird']];
    const enc = new OneHotEncoder({ drop: 'if_binary' }).fit(X);
    // Col 0: 2 categories → drop, 1 col out
    // Col 1: 3 categories → no drop, 3 cols out
    assert.equal(enc.n_features_out_, 4);
  });

  test('handle_unknown="ignore" produces all-zero row', () => {
    const enc = new OneHotEncoder({ handle_unknown: 'ignore' }).fit([['a'], ['b']]);
    const Xt = enc.transform([['c']]);
    let s = 0;
    for (let v of Xt) s += v;
    assert.equal(s, 0);
  });

  test('get_feature_names_out returns column labels', () => {
    const enc = new OneHotEncoder().fit([['cat'], ['dog'], ['bird']]);
    const names = enc.get_feature_names_out();
    assert.deepEqual(names, ['x0_bird', 'x0_cat', 'x0_dog']);
  });

  test('get_feature_names_out with input_features', () => {
    const enc = new OneHotEncoder().fit([['a', 'r'], ['b', 'g']]);
    const names = enc.get_feature_names_out(['animal', 'color']);
    assert.deepEqual(names, ['animal_a', 'animal_b', 'color_g', 'color_r']);
  });

  test('inverse_transform restores categorical', () => {
    const X = [['cat'], ['dog'], ['bird']];
    const enc = new OneHotEncoder().fit(X);
    const back = enc.inverse_transform(enc.transform(X));
    assert.deepEqual(back, X);
  });
});

// ────────────────────────────────────────────────────────────────────
// KBinsDiscretizer
// ────────────────────────────────────────────────────────────────────

describe('KBinsDiscretizer', () => {
  test('uniform strategy, 4 bins on [0, 4]', () => {
    const X = [[0], [1], [2], [3], [4]];
    const kb = new KBinsDiscretizer({ n_bins: 4, strategy: 'uniform' }).fit(X);
    // Edges should be [0, 1, 2, 3, 4]
    assert.deepEqual(Array.from(kb.bin_edges_[0]), [0, 1, 2, 3, 4]);
    const Xt = kb.transform(X);
    // 0 → bin 0; 1 → bin 1; ...; 4 → bin 3 (clipped)
    assert.deepEqual(Array.from(Xt), [0, 1, 2, 3, 3]);
  });

  test('quantile strategy gives equal-count bins', () => {
    const X = Array.from({ length: 20 }, (_, i) => [i]);
    const kb = new KBinsDiscretizer({ n_bins: 4, strategy: 'quantile' }).fit(X);
    const Xt = kb.transform(X);
    // Each bin should contain ~5 samples.
    const counts = new Array(4).fill(0);
    for (let v of Xt) counts[v | 0]++;
    for (let c of counts) assert.ok(c >= 4 && c <= 6, `bin counts: ${counts}`);
  });

  test('per-feature n_bins', () => {
    const X = Array.from({ length: 10 }, (_, i) => [i, i * 2]);
    const kb = new KBinsDiscretizer({ n_bins: [3, 5], strategy: 'uniform' }).fit(X);
    assert.equal(kb.n_bins_[0], 3);
    assert.equal(kb.n_bins_[1], 5);
  });

  test('invalid strategy raises', () => {
    assert.throws(
      () => new KBinsDiscretizer({ strategy: 'kmeans' }).fit([[0]]),
      /strategy='kmeans'/);
  });
});

// ────────────────────────────────────────────────────────────────────
// PowerTransformer
// ────────────────────────────────────────────────────────────────────

describe('PowerTransformer', () => {
  test('fits a lambda per feature', () => {
    const n = 50;
    const X = Array.from({ length: n }, (_, i) => [Math.exp((i / n) - 0.5), i / n]);
    const pt = new PowerTransformer().fit(X);
    assert.equal(pt.lambdas_.length, 2);
    for (const l of pt.lambdas_) {
      assert.ok(l >= -2 && l <= 2);
    }
  });

  test('transforms produce zero-mean unit-variance when standardize=true', () => {
    const X = Array.from({ length: 30 }, (_, i) => [Math.exp(i / 10) - 1]);
    const pt = new PowerTransformer({ standardize: true }).fit(X);
    const Xt = pt.transform(X);
    let mean = 0; for (const v of Xt) mean += v; mean /= 30;
    let var_ = 0; for (const v of Xt) var_ += (v - mean) ** 2; var_ /= 30;
    assert.ok(close(mean, 0, 1e-10), `mean=${mean}`);
    assert.ok(close(var_, 1, 1e-10), `var=${var_}`);
  });

  test('inverse_transform recovers approximately', () => {
    const X = Array.from({ length: 20 }, (_, i) => [Math.exp(i / 10) - 0.5]);
    const pt = new PowerTransformer({ standardize: false }).fit(X);
    const Xt = pt.transform(X);
    const Xb = pt.inverse_transform(Xt);
    for (let i = 0; i < 20; i++) {
      assert.ok(close(Xb[i], X[i][0], 1e-8),
        `i=${i}: ${Xb[i]} vs ${X[i][0]}`);
    }
  });

  test('handles negative values (Yeo-Johnson)', () => {
    const X = Array.from({ length: 30 }, (_, i) => [(i - 15) / 5]);
    const pt = new PowerTransformer({ standardize: false }).fit(X);
    const Xt = pt.transform(X);
    for (const v of Xt) assert.ok(Number.isFinite(v));
  });

  test('dump/load round-trip preserves transform', () => {
    const X = Array.from({ length: 20 }, (_, i) => [Math.exp(i / 10)]);
    const pt = new PowerTransformer().fit(X);
    const before = Array.from(pt.transform(X));
    const r = load(dump(pt));
    assert.ok(arrayClose(Array.from(r.transform(X)), before));
  });

  test('unsupported method raises', () => {
    assert.throws(
      () => new PowerTransformer({ method: 'box-cox' }).fit([[1], [2]]),
      /method='box-cox'/);
  });
});
