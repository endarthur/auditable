// @gcu/learn metrics test suite — numerical correctness on canonical
// fixtures, edge cases, sample-weight handling, sklearn parity.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  accuracy_score, balanced_accuracy_score,
  precision_score, recall_score, f1_score,
  confusion_matrix, classification_report,
  cohen_kappa_score, matthews_corrcoef,
  r2_score, mean_squared_error, root_mean_squared_error,
  mean_absolute_error, mean_absolute_percentage_error,
  explained_variance_score,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-12) => Math.abs(a - b) < tol;

// ────────────────────────────────────────────────────────────────────
// accuracy_score
// ────────────────────────────────────────────────────────────────────

describe('accuracy_score', () => {
  test('perfect prediction = 1', () => {
    assert.equal(accuracy_score([1, 2, 3], [1, 2, 3]), 1);
  });
  test('zero match = 0', () => {
    assert.equal(accuracy_score([1, 2, 3], [4, 5, 6]), 0);
  });
  test('partial match', () => {
    assert.equal(accuracy_score([0, 0, 1, 1, 2], [0, 1, 1, 1, 2]), 4 / 5);
  });
  test('normalize=false returns count', () => {
    assert.equal(accuracy_score([0, 0, 1], [0, 1, 1], { normalize: false }), 2);
  });
  test('sample_weight upweights matches', () => {
    const a = accuracy_score([0, 0, 1, 1], [0, 1, 1, 1],
                             { sample_weight: [1, 2, 1, 1] });
    // Weighted: hits=1*1 + 0*2 + 1*1 + 1*1 = 3, total=5 → 3/5
    assert.ok(close(a, 3 / 5));
  });
  test('empty input returns 0', () => {
    assert.equal(accuracy_score([], []), 0);
  });
  test('mismatched lengths throws', () => {
    assert.throws(() => accuracy_score([1, 2], [1]), /must match/);
  });
});

// ────────────────────────────────────────────────────────────────────
// confusion_matrix
// ────────────────────────────────────────────────────────────────────

describe('confusion_matrix', () => {
  // 3-class fixture used across tests below.
  // Per-class confusion (rows=true, cols=pred):
  //   0: [2, 1, 0]   (3 trues; 2→0, 1→1)
  //   1: [0, 2, 1]   (3 trues; 2→1, 1→2)
  //   2: [1, 0, 2]   (3 trues; 1→0, 2→2)
  const yt = [0, 0, 1, 1, 2, 2, 0, 1, 2];
  const yp = [0, 1, 1, 1, 2, 0, 0, 2, 2];

  test('basic 3-class', () => {
    const { matrix, labels } = confusion_matrix(yt, yp);
    assert.deepEqual(labels, [0, 1, 2]);
    assert.deepEqual(matrix, [[2, 1, 0], [0, 2, 1], [1, 0, 2]]);
  });

  test('explicit labels reorders', () => {
    const { matrix, labels } = confusion_matrix(yt, yp, { labels: [2, 1, 0] });
    assert.deepEqual(labels, [2, 1, 0]);
    assert.deepEqual(matrix, [[2, 0, 1], [1, 2, 0], [0, 1, 2]]);
  });

  test('normalize=true row-normalizes', () => {
    const { matrix } = confusion_matrix(yt, yp, { normalize: 'true' });
    for (const row of matrix) {
      let s = 0; for (const v of row) s += v;
      assert.ok(close(s, 1));
    }
  });

  test('normalize=all sums to 1', () => {
    const { matrix } = confusion_matrix(yt, yp, { normalize: 'all' });
    let s = 0;
    for (const row of matrix) for (const v of row) s += v;
    assert.ok(close(s, 1));
  });

  test('string labels work', () => {
    const { matrix, labels } = confusion_matrix(
      ['cat', 'cat', 'dog'], ['cat', 'dog', 'dog']);
    assert.deepEqual(labels, ['cat', 'dog']);
    assert.deepEqual(matrix, [[1, 1], [0, 1]]);
  });
});

// ────────────────────────────────────────────────────────────────────
// precision / recall / f1
// ────────────────────────────────────────────────────────────────────

describe('precision/recall/f1', () => {
  const yt = [0, 0, 1, 1, 2, 2, 0, 1, 2];
  const yp = [0, 1, 1, 1, 2, 0, 0, 2, 2];

  test('per-class precision (average=null)', () => {
    const arr = precision_score(yt, yp, { average: null });
    // Class 0: TP=2, FP=1 (true 2 predicted 0) → 2/3
    // Class 1: TP=2, FP=1 (true 0 predicted 1) → 2/3
    // Class 2: TP=2, FP=1 (true 1 predicted 2) → 2/3
    for (const v of arr) assert.ok(close(v, 2 / 3));
  });

  test('per-class recall', () => {
    const arr = recall_score(yt, yp, { average: null });
    for (const v of arr) assert.ok(close(v, 2 / 3));
  });

  test('per-class f1', () => {
    const arr = f1_score(yt, yp, { average: null });
    for (const v of arr) assert.ok(close(v, 2 / 3));
  });

  test('macro average equals per-class mean (3 equal classes)', () => {
    assert.ok(close(f1_score(yt, yp, { average: 'macro' }), 2 / 3));
  });

  test('weighted average matches macro when classes are balanced', () => {
    // All three classes have 3 samples — weighted = macro.
    assert.ok(close(f1_score(yt, yp, { average: 'weighted' }), 2 / 3));
  });

  test('micro = accuracy when no labels are dropped', () => {
    assert.ok(close(precision_score(yt, yp, { average: 'micro' }),
                    accuracy_score(yt, yp)));
  });

  test('binary with pos_label', () => {
    const yt_b = [1, 1, 0, 0, 1, 1, 0];
    const yp_b = [1, 0, 0, 0, 1, 1, 1];
    // TP=3, FP=1, FN=1 → precision=3/4, recall=3/4, f1=3/4
    assert.ok(close(precision_score(yt_b, yp_b), 3 / 4));
    assert.ok(close(recall_score(yt_b, yp_b), 3 / 4));
    assert.ok(close(f1_score(yt_b, yp_b), 3 / 4));
  });

  test('binary average raises when pos_label not in y', () => {
    assert.throws(
      () => precision_score([0, 1], [0, 1], { pos_label: 99 }),
      /pos_label=99 not found/);
  });

  test('zero_division returns specified value when undefined', () => {
    // No predicted positives for class 1 → precision is undefined; with
    // explicit labels [0, 1] we surface that slot and zero_division kicks in.
    const arr = precision_score([0, 0], [0, 0], { average: null,
                                                  labels: [0, 1],
                                                  zero_division: 0.5 });
    assert.equal(arr[1], 0.5);
  });
});

// ────────────────────────────────────────────────────────────────────
// classification_report
// ────────────────────────────────────────────────────────────────────

describe('classification_report', () => {
  test('returns per-class + macro + weighted entries', () => {
    const yt = [0, 0, 1, 1, 2, 2, 0, 1, 2];
    const yp = [0, 1, 1, 1, 2, 0, 0, 2, 2];
    const r = classification_report(yt, yp);
    assert.ok(r['0'] && r['1'] && r['2']);
    assert.ok(r['macro avg']);
    assert.ok(r['weighted avg']);
    assert.equal(typeof r.accuracy, 'number');
    // Per-class values match what precision/recall/f1 returned.
    assert.ok(close(r['0'].f1, 2 / 3));
    assert.equal(r['0'].support, 3);
    assert.equal(r['1'].support, 3);
    assert.equal(r['2'].support, 3);
    assert.equal(r['macro avg'].support, 9);
  });
});

// ────────────────────────────────────────────────────────────────────
// cohen_kappa_score
// ────────────────────────────────────────────────────────────────────

describe('cohen_kappa_score', () => {
  test('perfect agreement = 1', () => {
    assert.equal(cohen_kappa_score([0, 1, 2], [0, 1, 2]), 1);
  });
  test('inverse agreement is negative', () => {
    const k = cohen_kappa_score([0, 0, 0, 1, 1, 1], [1, 1, 1, 0, 0, 0]);
    assert.ok(k < 0);
  });
  test('linear weights penalize close mistakes less than far', () => {
    // 3 classes; mistake by 1 vs mistake by 2 should differ.
    const yt = [0, 0, 0, 0];
    const yp_close = [1, 1, 1, 1];  // mistake by 1
    const yp_far = [2, 2, 2, 2];    // mistake by 2
    // With weights=null and identical inputs, both have observed != expected = 0 → undefined
    // With linear weights, far should be worse (more negative or smaller).
    const k_close = cohen_kappa_score(yt, yp_close, { weights: 'linear', labels: [0, 1, 2] });
    const k_far = cohen_kappa_score(yt, yp_far, { weights: 'linear', labels: [0, 1, 2] });
    assert.ok(k_far <= k_close);
  });
});

// ────────────────────────────────────────────────────────────────────
// matthews_corrcoef
// ────────────────────────────────────────────────────────────────────

describe('matthews_corrcoef', () => {
  test('perfect prediction = 1', () => {
    assert.equal(matthews_corrcoef([0, 1, 0, 1], [0, 1, 0, 1]), 1);
  });
  test('inverse prediction = -1 (binary)', () => {
    assert.equal(matthews_corrcoef([0, 1, 0, 1], [1, 0, 1, 0]), -1);
  });
  test('all-same prediction = 0 (zero variance in pred)', () => {
    assert.equal(matthews_corrcoef([0, 1, 0, 1], [1, 1, 1, 1]), 0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Regression metrics
// ────────────────────────────────────────────────────────────────────

describe('r2_score', () => {
  test('perfect prediction = 1', () => {
    assert.equal(r2_score([1, 2, 3], [1, 2, 3]), 1);
  });
  test('mean prediction = 0', () => {
    assert.ok(close(r2_score([1, 2, 3], [2, 2, 2]), 0));
  });
  test('worse than mean = negative', () => {
    assert.ok(r2_score([1, 2, 3], [3, 1, 2]) < 0);
  });
  test('sklearn doc fixture', () => {
    const r = r2_score([3, -0.5, 2, 7], [2.5, 0.0, 2, 8]);
    // sklearn: 0.948...
    assert.ok(close(r, 1 - 1.5 / 29.1875, 1e-10));
  });
  test('constant y_true: R²=1 if zero residual, else 0', () => {
    assert.equal(r2_score([5, 5, 5], [5, 5, 5]), 1);
    assert.equal(r2_score([5, 5, 5], [4, 5, 6]), 0);
  });
});

describe('mean_squared_error', () => {
  test('perfect prediction = 0', () => {
    assert.equal(mean_squared_error([1, 2, 3], [1, 2, 3]), 0);
  });
  test('sklearn doc fixture', () => {
    assert.ok(close(mean_squared_error([3, -0.5, 2, 7], [2.5, 0.0, 2, 8]),
                    0.375));
  });
  test('squared=false returns RMSE', () => {
    assert.ok(close(mean_squared_error([3, -0.5, 2, 7], [2.5, 0.0, 2, 8],
                                       { squared: false }),
                    Math.sqrt(0.375)));
  });
  test('root_mean_squared_error matches squared=false', () => {
    const a = root_mean_squared_error([3, -0.5, 2, 7], [2.5, 0.0, 2, 8]);
    const b = mean_squared_error([3, -0.5, 2, 7], [2.5, 0.0, 2, 8], { squared: false });
    assert.equal(a, b);
  });
  test('sample_weight reweights', () => {
    // Equal sample_weights = unweighted result.
    assert.ok(close(mean_squared_error([1, 2, 3], [1, 2, 4],
                                       { sample_weight: [1, 1, 1] }),
                    1 / 3));
    // Heavier weight on the last sample should pull mse up.
    assert.ok(close(mean_squared_error([1, 2, 3], [1, 2, 4],
                                       { sample_weight: [1, 1, 10] }),
                    10 / 12));
  });
});

describe('mean_absolute_error', () => {
  test('perfect prediction = 0', () => {
    assert.equal(mean_absolute_error([1, 2, 3], [1, 2, 3]), 0);
  });
  test('sklearn doc fixture', () => {
    assert.ok(close(mean_absolute_error([3, -0.5, 2, 7], [2.5, 0.0, 2, 8]),
                    0.5));
  });
});

describe('mean_absolute_percentage_error', () => {
  test('perfect prediction = 0', () => {
    assert.equal(mean_absolute_percentage_error([1, 2, 3], [1, 2, 3]), 0);
  });
  test('basic case', () => {
    // |2-1|/2 + |4-2|/4 + |6-3|/6 = 0.5 + 0.5 + 0.5 → mean = 0.5
    assert.ok(close(mean_absolute_percentage_error([2, 4, 6], [1, 2, 3]), 0.5));
  });
  test('zero y_true uses epsilon (no Infinity)', () => {
    const v = mean_absolute_percentage_error([0, 1, 2], [1, 1, 2]);
    assert.ok(Number.isFinite(v));
    assert.ok(v > 0);
  });
});

describe('explained_variance_score', () => {
  test('perfect prediction = 1', () => {
    assert.equal(explained_variance_score([1, 2, 3], [1, 2, 3]), 1);
  });
  test('constant prediction (mean) = 0', () => {
    // y_true = [1,2,3], y_pred = [2,2,2]: residual = [-1, 0, 1], var=2/3
    // var(y_true)=2/3, so explained_variance = 1 - (2/3)/(2/3) … but with mean
    // residual subtracted (residual mean = 0) gives same = 0.
    assert.ok(close(explained_variance_score([1, 2, 3], [2, 2, 2]), 0));
  });
  test('differs from r2 when residuals have nonzero mean', () => {
    // y_true = [1,2,3], y_pred = [0,1,2] (constant offset = 1)
    // r2: ss_res = 1+1+1=3, mean(yt)=2, ss_tot=1+0+1=2 → r2 = 1 - 3/2 = -0.5
    // explained_variance: residual = [1,1,1], var(res) = 0 → 1 - 0/var(yt) = 1
    const r2 = r2_score([1, 2, 3], [0, 1, 2]);
    const ev = explained_variance_score([1, 2, 3], [0, 1, 2]);
    assert.ok(close(r2, -0.5));
    assert.ok(close(ev, 1));
    assert.notEqual(r2, ev);
  });
});

// ────────────────────────────────────────────────────────────────────
// Error handling
// ────────────────────────────────────────────────────────────────────

describe('error handling', () => {
  test('mismatched lengths throws across all metrics', () => {
    const fns = [accuracy_score, precision_score, recall_score, f1_score,
                 r2_score, mean_squared_error, mean_absolute_error];
    for (const fn of fns) {
      assert.throws(() => fn([1, 2], [1]), /must match|length/);
    }
  });

  test('unknown average raises with valid options listed', () => {
    assert.throws(
      () => f1_score([0, 1], [0, 1], { average: 'bogus' }),
      /unknown average='bogus'/);
  });

  test('mismatched sample_weight length raises', () => {
    assert.throws(
      () => accuracy_score([1, 2, 3], [1, 2, 3], { sample_weight: [1, 1] }),
      /sample_weight length/);
  });
});
