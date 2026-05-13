// @gcu/learn DBSCAN test suite (extras for cluster.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DBSCAN, check_estimator, dump, load, mulberry32,
} from '../ext/learn/src/main.js';

describe('DBSCAN', () => {
  test('identifies dense clusters and marks isolates as noise', () => {
    // Two dense blobs + one outlier far away.
    const rng = mulberry32(0);
    const X = [];
    for (let i = 0; i < 10; i++) X.push([rng(), rng()]);
    for (let i = 0; i < 10; i++) X.push([10 + rng(), 10 + rng()]);
    X.push([100, 100]);
    const d = new DBSCAN({ eps: 1.0, min_samples: 3 }).fit(X);
    // Two clusters → label set should be {0, 1, -1}.
    const labels = Array.from(d.labels_);
    assert.ok(labels.slice(0, 10).every(l => l === labels[0]),
      'first 10 should share a label');
    assert.ok(labels.slice(10, 20).every(l => l === labels[10]),
      'next 10 should share a label');
    assert.notEqual(labels[0], labels[10]);
    assert.equal(labels[20], -1, 'outlier should be noise');
  });

  test('eps too small marks all points as noise', () => {
    const X = [[0, 0], [1, 1], [2, 2], [3, 3]];
    const d = new DBSCAN({ eps: 0.001, min_samples: 2 }).fit(X);
    for (const l of d.labels_) assert.equal(l, -1);
  });

  test('core_sample_indices_ identifies dense points', () => {
    const X = [[0, 0], [0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [10, 10]];
    const d = new DBSCAN({ eps: 0.5, min_samples: 3 }).fit(X);
    const cores = new Set(Array.from(d.core_sample_indices_));
    // First 4 are cores (each within 0.5 of >= 3 others); 4th index is the outlier.
    assert.ok(cores.has(0));
    assert.ok(!cores.has(4));
  });

  test('components_ contains coordinates of core points', () => {
    const X = [[0, 0], [0.1, 0.1], [0.2, 0.2], [10, 10]];
    const d = new DBSCAN({ eps: 0.5, min_samples: 3 }).fit(X);
    assert.deepEqual(d.components_.shape, [d.core_sample_indices_.length, 2]);
  });

  test('fit_predict returns labels_', () => {
    const X = [[0, 0], [1, 0], [2, 0], [10, 0], [11, 0]];
    const d = new DBSCAN({ eps: 1.5, min_samples: 2 });
    const labels = d.fit_predict(X);
    assert.deepEqual(Array.from(labels), Array.from(d.labels_));
  });

  test('unsupported metric raises', () => {
    assert.throws(
      () => new DBSCAN({ metric: 'manhattan' }).fit([[0, 0]]),
      /metric='manhattan'/);
  });

  test('eps <= 0 raises', () => {
    assert.throws(() => new DBSCAN({ eps: -1 }).fit([[0, 0]]),
      /eps=-1/);
  });

  test('dump/load round-trip preserves labels_', () => {
    const X = [[0, 0], [0.1, 0.1], [0.2, 0.2], [10, 10], [10.1, 10.1]];
    const d = new DBSCAN({ eps: 0.5, min_samples: 2 }).fit(X);
    const before = Array.from(d.labels_);
    const r = load(dump(d));
    assert.deepEqual(Array.from(r.labels_), before);
  });

  test('check_estimator passes', () => {
    const errs = check_estimator(DBSCAN, { collect: true });
    assert.deepEqual(errs, [], `unexpected:\n  ${errs.join('\n  ')}`);
  });
});
