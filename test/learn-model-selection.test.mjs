// @gcu/learn model_selection test suite — splitter contracts +
// cross_val_score / cross_validate end-to-end.
//
// Splitters share a contract enforced by these tests:
//   - split() yields disjoint [train_idx, test_idx] pairs
//   - across all folds, every sample appears in exactly one test set
//   - reproducibility under fixed random_state
// Plus per-splitter specifics (class balance, group isolation, spatial buffer).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BaseEstimator, ClassifierMixin, RegressorMixin,
  train_test_split, KFold, StratifiedKFold, GroupKFold, SpatialKFold,
  cross_val_score, cross_validate,
  StandardScaler,
  accuracy_score, mean_squared_error,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-12) => Math.abs(a - b) < tol;

// Tiny X helper: n × m random-looking matrix.
function makeX(n, m) {
  const data = new Float64Array(n * m);
  for (let i = 0; i < n * m; i++) data[i] = (i * 0.137 + 0.31) % 5;
  return { data, shape: [n, m] };
}

// Coverage check: every sample index appears in exactly one test fold.
function assertExhaustivePartition(folds, n) {
  const seen = new Int32Array(n);
  for (const [, test] of folds) {
    for (const i of test) {
      assert.ok(i >= 0 && i < n, `index ${i} out of range`);
      seen[i]++;
    }
  }
  for (let i = 0; i < n; i++) {
    assert.equal(seen[i], 1, `index ${i} appeared in ${seen[i]} test folds`);
  }
}

// Disjoint check: train and test never share an index within a fold.
function assertDisjoint(folds) {
  for (const [train, test] of folds) {
    const t = new Set(train);
    for (const i of test) {
      assert.ok(!t.has(i), `index ${i} appears in both train and test`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// train_test_split
// ────────────────────────────────────────────────────────────────────

describe('train_test_split', () => {
  test('default split sizes (test_size=0.25)', () => {
    const X = makeX(20, 3);
    const y = Float64Array.from({ length: 20 }, (_, i) => i);
    const [Xtr, Xte, ytr, yte] = train_test_split(X, y, { random_state: 0 });
    assert.equal(Xtr.shape[0], 15);
    assert.equal(Xte.shape[0], 5);
    assert.equal(ytr.length, 15);
    assert.equal(yte.length, 5);
  });

  test('test_size as integer count', () => {
    const X = makeX(20, 2);
    const [, Xte] = train_test_split(X, null, { test_size: 7 });
    assert.equal(Xte.shape[0], 7);
  });

  test('reproducibility under fixed random_state', () => {
    const X = makeX(50, 2);
    const y = Float64Array.from({ length: 50 }, (_, i) => i);
    const a = train_test_split(X, y, { random_state: 42 });
    const b = train_test_split(X, y, { random_state: 42 });
    assert.deepEqual(Array.from(a[2]), Array.from(b[2]));
    assert.deepEqual(Array.from(a[3]), Array.from(b[3]));
  });

  test('shuffle=false returns first n_train then last n_test', () => {
    const X = makeX(10, 1);
    const y = Float64Array.from({ length: 10 }, (_, i) => i);
    const [, , ytr, yte] = train_test_split(X, y,
      { test_size: 3, shuffle: false });
    assert.deepEqual(Array.from(ytr), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(Array.from(yte), [7, 8, 9]);
  });

  test('stratify preserves class balance', () => {
    // 6 of class 0, 6 of class 1.
    const X = makeX(12, 2);
    const y = Float64Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    const [, , ytr, yte] = train_test_split(X, y,
      { stratify: y, test_size: 4, random_state: 0 });
    // Each split should have 2 of each class (50/50 of test_size=4).
    let n0_te = 0, n1_te = 0;
    for (const v of yte) v === 0 ? n0_te++ : n1_te++;
    assert.equal(n0_te, 2);
    assert.equal(n1_te, 2);
  });

  test('X-only form works', () => {
    const X = makeX(10, 2);
    const [Xtr, Xte] = train_test_split(X, null, { test_size: 0.4 });
    assert.equal(Xtr.shape[0] + Xte.shape[0], 10);
  });
});

// ────────────────────────────────────────────────────────────────────
// KFold
// ────────────────────────────────────────────────────────────────────

describe('KFold', () => {
  test('partitions are disjoint and exhaustive', () => {
    const X = makeX(10, 2);
    const cv = new KFold({ n_splits: 3 });
    const folds = [...cv.split(X)];
    assert.equal(folds.length, 3);
    assertDisjoint(folds);
    assertExhaustivePartition(folds, 10);
  });

  test('uneven splits give first folds the extra samples', () => {
    // n=10, k=3 → fold sizes [4, 3, 3]
    const X = makeX(10, 1);
    const cv = new KFold({ n_splits: 3 });
    const sizes = [...cv.split(X)].map(([, test]) => test.length);
    assert.deepEqual(sizes, [4, 3, 3]);
  });

  test('shuffle is deterministic under random_state', () => {
    const X = makeX(15, 2);
    const a = [...new KFold({ n_splits: 3, shuffle: true, random_state: 7 }).split(X)];
    const b = [...new KFold({ n_splits: 3, shuffle: true, random_state: 7 }).split(X)];
    assert.deepEqual(a.map(([, t]) => Array.from(t)),
                     b.map(([, t]) => Array.from(t)));
  });

  test('shuffle=false produces sequential folds', () => {
    const X = makeX(9, 1);
    const folds = [...new KFold({ n_splits: 3 }).split(X)];
    assert.deepEqual(Array.from(folds[0][1]), [0, 1, 2]);
    assert.deepEqual(Array.from(folds[1][1]), [3, 4, 5]);
    assert.deepEqual(Array.from(folds[2][1]), [6, 7, 8]);
  });

  test('n_splits > n_samples raises', () => {
    const X = makeX(3, 1);
    assert.throws(() => [...new KFold({ n_splits: 5 }).split(X)], /n_splits=5/);
  });

  test('n_splits < 2 raises', () => {
    assert.throws(() => new KFold({ n_splits: 1 }), /n_splits=1/);
  });
});

// ────────────────────────────────────────────────────────────────────
// StratifiedKFold
// ────────────────────────────────────────────────────────────────────

describe('StratifiedKFold', () => {
  test('preserves class proportions across folds', () => {
    // 12 samples, 6 of class 0 and 6 of class 1, 3 folds → 4 per fold,
    // 2 of each class per fold.
    const X = makeX(12, 1);
    const y = Float64Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    const cv = new StratifiedKFold({ n_splits: 3 });
    const folds = [...cv.split(X, y)];
    for (const [, test] of folds) {
      let n0 = 0, n1 = 0;
      for (const i of test) y[i] === 0 ? n0++ : n1++;
      assert.equal(n0, 2);
      assert.equal(n1, 2);
    }
    assertDisjoint(folds);
    assertExhaustivePartition(folds, 12);
  });

  test('class with too few samples raises', () => {
    const X = makeX(10, 1);
    const y = Float64Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);  // class 1 has 2
    assert.throws(
      () => [...new StratifiedKFold({ n_splits: 5 }).split(X, y)],
      /class 1 has 2 samples but n_splits=5/);
  });
});

// ────────────────────────────────────────────────────────────────────
// GroupKFold
// ────────────────────────────────────────────────────────────────────

describe('GroupKFold', () => {
  test('each group lives in exactly one fold', () => {
    const X = makeX(12, 1);
    const groups = [0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 4, 4];
    const cv = new GroupKFold({ n_splits: 3 });
    const folds = [...cv.split(X, null, { groups })];
    // Build group → fold assignment.
    const groupFold = {};
    folds.forEach(([, test], f) => {
      for (const i of test) {
        const g = groups[i];
        if (groupFold[g] === undefined) groupFold[g] = f;
        else assert.equal(groupFold[g], f, `group ${g} split across folds`);
      }
    });
    assertDisjoint(folds);
    assertExhaustivePartition(folds, 12);
  });

  test('n_splits > n_groups raises', () => {
    const X = makeX(8, 1);
    const groups = [0, 0, 0, 0, 1, 1, 1, 1];  // only 2 groups
    assert.throws(
      () => [...new GroupKFold({ n_splits: 3 }).split(X, null, { groups })],
      /n_groups=2/);
  });

  test('opts.groups required', () => {
    const X = makeX(8, 1);
    assert.throws(
      () => [...new GroupKFold({ n_splits: 2 }).split(X, null)],
      /opts.groups is required/);
  });
});

// ────────────────────────────────────────────────────────────────────
// SpatialKFold
// ────────────────────────────────────────────────────────────────────

describe('SpatialKFold', () => {
  test('exclusion_radius=0 is equivalent to KFold (no drops)', () => {
    const X = makeX(20, 2);
    const xyz = makeX(20, 2);
    const cv = new SpatialKFold({ n_splits: 4, exclusion_radius: 0,
                                  random_state: 1 });
    const folds = [...cv.split(X, null, { xyz })];
    for (const [, , n_dropped] of folds) assert.equal(n_dropped, 0);
    assertDisjoint(folds.map(([tr, te]) => [tr, te]));
  });

  test('positive radius drops nearby training samples', () => {
    // 8 samples on a 1D line at x=0,1,2,...,7. With 2 folds and a radius
    // of 1.5, each test sample knocks out its neighbors from training.
    const X = makeX(8, 1);
    const xyz = { data: Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
                  shape: [8, 1] };
    const cv = new SpatialKFold({
      n_splits: 2, exclusion_radius: 1.5, shuffle: false,
    });
    const folds = [...cv.split(X, null, { xyz })];
    assert.equal(folds.length, 2);
    // At least one fold should drop something — the buffer is real.
    const total_dropped = folds.reduce((a, [, , d]) => a + d, 0);
    assert.ok(total_dropped > 0, 'expected buffer to drop training samples');
    // Verify min-distance >= radius for every retained training sample.
    const r = 1.5;
    for (const [train, test] of folds) {
      for (const i of train) {
        let mind = Infinity;
        for (const j of test) {
          const d = Math.abs(xyz.data[i] - xyz.data[j]);
          if (d < mind) mind = d;
        }
        assert.ok(mind >= r,
          `retained training sample ${i} is within ${mind} of test set (radius=${r})`);
      }
    }
  });

  test('xyz dimension validation', () => {
    const X = makeX(5, 1);
    const xyz_bad = makeX(5, 4);
    assert.throws(
      () => [...new SpatialKFold({ n_splits: 2 }).split(X, null, { xyz: xyz_bad })],
      /dimension 4 must be 1, 2, or 3/);
  });

  test('opts.xyz is required', () => {
    const X = makeX(5, 1);
    assert.throws(
      () => [...new SpatialKFold({ n_splits: 2 }).split(X)],
      /opts.xyz is required/);
  });
});

// ────────────────────────────────────────────────────────────────────
// cross_val_score / cross_validate
// ────────────────────────────────────────────────────────────────────

// Minimal valid regressor for end-to-end testing: predicts the training
// y mean for any X. Has the right contract shape; predictions are stable.
class MeanRegressor extends BaseEstimator {
  constructor(_p = {}) { super(); }
  fit(_X, y) {
    let s = 0; for (let i = 0; i < y.length; i++) s += y[i];
    this.mean_ = y.length === 0 ? 0 : s / y.length;
    return this;
  }
  predict(X) {
    const n = (X.shape ?? [X.length])[0];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.mean_;
    return out;
  }
}
Object.assign(MeanRegressor.prototype, RegressorMixin);
MeanRegressor._estimator_type = 'regressor';

// Minimal valid classifier: predicts the most-common training class.
class MajorityClassifier extends BaseEstimator {
  constructor(_p = {}) { super(); }
  fit(_X, y) {
    const counts = new Map();
    for (let i = 0; i < y.length; i++) {
      const k = y[i]; counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let best = null, bestN = -1;
    for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
    this.majority_ = best;
    return this;
  }
  predict(X) {
    const n = (X.shape ?? [X.length])[0];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.majority_;
    return out;
  }
}
Object.assign(MajorityClassifier.prototype, ClassifierMixin);
MajorityClassifier._estimator_type = 'classifier';

describe('cross_val_score', () => {
  test('returns one score per fold (default cv=KFold(5))', () => {
    const X = makeX(20, 2);
    const y = Float64Array.from({ length: 20 }, (_, i) => i % 3);
    const scores = cross_val_score(new MajorityClassifier(), X, y);
    assert.equal(scores.length, 5);
    for (const s of scores) {
      assert.ok(Number.isFinite(s));
      assert.ok(s >= 0 && s <= 1);
    }
  });

  test('accepts integer cv as n_splits', () => {
    const X = makeX(10, 1);
    const y = Float64Array.from({ length: 10 }, (_, i) => i);
    const scores = cross_val_score(new MeanRegressor(), X, y, { cv: 3 });
    assert.equal(scores.length, 3);
  });

  test('accepts custom scoring function', () => {
    const X = makeX(20, 2);
    const y = Float64Array.from({ length: 20 }, (_, i) => i);
    const neg_mse = (est, X, y) => -mean_squared_error(y, est.predict(X));
    const scores = cross_val_score(new MeanRegressor(), X, y,
                                   { cv: 4, scoring: neg_mse });
    assert.equal(scores.length, 4);
    for (const s of scores) assert.ok(s <= 0);
  });

  test('uses estimator clones (no state leaks)', () => {
    const est = new MeanRegressor();
    const X = makeX(10, 1);
    const y = Float64Array.from({ length: 10 }, (_, i) => i);
    cross_val_score(est, X, y, { cv: 2 });
    // Original estimator should still be unfitted.
    assert.equal(est.mean_, undefined);
  });
});

describe('cross_validate', () => {
  test('returns dict with test_<name> per metric', () => {
    const X = makeX(20, 2);
    const y = Float64Array.from({ length: 20 }, (_, i) => i % 2);
    const out = cross_validate(new MajorityClassifier(), X, y, {
      cv: 4,
      scoring: {
        accuracy: (est, X, y) => accuracy_score(y, est.predict(X)),
      },
    });
    assert.ok(out.test_accuracy instanceof Float64Array);
    assert.equal(out.test_accuracy.length, 4);
    assert.ok(out.fit_time instanceof Float64Array);
    assert.ok(out.score_time instanceof Float64Array);
  });

  test('return_train_score adds train_<name>', () => {
    const X = makeX(15, 1);
    const y = Float64Array.from({ length: 15 }, (_, i) => i);
    const out = cross_validate(new MeanRegressor(), X, y, {
      cv: 3,
      scoring: { mse: (est, X, y) => mean_squared_error(y, est.predict(X)) },
      return_train_score: true,
    });
    assert.ok(out.train_mse instanceof Float64Array);
    assert.equal(out.train_mse.length, 3);
  });

  test('SpatialKFold passes n_dropped through', () => {
    const X = makeX(12, 1);
    const xyz = { data: Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
                  shape: [12, 1] };
    const y = Float64Array.from({ length: 12 }, (_, i) => i);
    const out = cross_validate(new MeanRegressor(), X, y, {
      cv: new SpatialKFold({ n_splits: 3, exclusion_radius: 1.5,
                             shuffle: false }),
      scoring: { mse: (est, X, y) => mean_squared_error(y, est.predict(X)) },
      split_opts: { xyz },
    });
    assert.ok(out.n_dropped instanceof Int32Array);
    assert.equal(out.n_dropped.length, 3);
    let total = 0; for (const v of out.n_dropped) total += v;
    assert.ok(total > 0, 'expected buffer to drop samples');
  });
});

// SPEC §5.4 — the only sklearn-API divergence in @gcu/learn: score a
// frozen pre-trained estimator across CV folds without retraining.
describe('cross_val_score refit=false', () => {
  test('skips clone+fit, scores frozen estimator on each fold', () => {
    const X = makeX(20, 2);
    const y = Float64Array.from({ length: 20 }, (_, i) => i);
    // Pre-fit on a separate "training" portion (the whole X here for
    // simplicity); under refit=false the same fitted state is used on
    // every fold's test set.
    const est = new MeanRegressor().fit(X, y);
    const frozen_mean = est.mean_;

    const scores = cross_val_score(est, X, y, {
      cv: 4,
      refit: false,
      scoring: (est, X, y) => -mean_squared_error(y, est.predict(X)),
    });
    assert.equal(scores.length, 4);
    for (const s of scores) assert.ok(Number.isFinite(s));
    // Estimator state should not have been mutated.
    assert.equal(est.mean_, frozen_mean);
  });

  test('refit=false rejects unfitted estimators', () => {
    const X = makeX(10, 2);
    const y = Float64Array.from({ length: 10 }, (_, i) => i);
    const est = new MeanRegressor();  // never fitted
    assert.throws(
      () => cross_val_score(est, X, y, { cv: 3, refit: false }),
      /requires a fitted estimator/,
    );
  });

  test('cross_validate refit=false: fit_time is 0, train scores still computed', () => {
    const X = makeX(20, 2);
    const y = Float64Array.from({ length: 20 }, (_, i) => i);
    const est = new MeanRegressor().fit(X, y);
    const out = cross_validate(est, X, y, {
      cv: 4,
      refit: false,
      return_train_score: true,
      scoring: { mse: (est, X, y) => mean_squared_error(y, est.predict(X)) },
    });
    assert.ok(out.test_mse instanceof Float64Array);
    assert.equal(out.test_mse.length, 4);
    assert.ok(out.train_mse instanceof Float64Array);
    for (const t of out.fit_time) assert.equal(t, 0);
  });

  test('frozen vs refit gives different scores when distribution shifts', () => {
    // Train on first half, test refit on full data — refit=true should
    // adapt to each fold (lower per-fold MSE in this setup); refit=false
    // uses the fixed train-on-first-half mean.
    const X = makeX(40, 1);
    const y = Float64Array.from({ length: 40 }, (_, i) => i < 20 ? 0 : 100);
    const frozen = new MeanRegressor().fit(X, y.slice(0, 20));  // mean ≈ 0
    const fresh = new MeanRegressor();

    const scoresRefit = cross_val_score(fresh, X, y, {
      cv: 4, scoring: (e, X, y) => -mean_squared_error(y, e.predict(X)),
    });
    const scoresFrozen = cross_val_score(frozen, X, y, {
      cv: 4, refit: false,
      scoring: (e, X, y) => -mean_squared_error(y, e.predict(X)),
    });
    // Refit should win on average (per-fold mean adapts to fold). Frozen
    // pays a heavy cost on the second half where actual mean is 100 but
    // frozen estimator predicts ~0.
    let sumRefit = 0; for (const s of scoresRefit) sumRefit += s;
    let sumFrozen = 0; for (const s of scoresFrozen) sumFrozen += s;
    assert.ok(sumRefit > sumFrozen,
      `expected refit (${sumRefit}) > frozen (${sumFrozen})`);
  });
});

// Sanity: StandardScaler still works after the new modules ship.
describe('preprocessing post-integration', () => {
  test('StandardScaler still passes its smoke test', () => {
    const sc = new StandardScaler().fit([[1, 2], [3, 4], [5, 6]]);
    assert.deepEqual(Array.from(sc.mean_), [3, 4]);
  });
});
