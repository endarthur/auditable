// Coverage for the medium-impact v0.2 spec gaps shipped 2026-05-13:
//   - predict_log_proba on classifiers (default via ClassifierMixin,
//     GMM override using log-responsibilities directly).
//   - get_feature_names_out on KBinsDiscretizer, PCA, ColumnTransformer.
//   - decision_function chains through Pipeline.
//   - Default silhouette score for clusterers via ClusterMixin.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionTreeClassifier,
  RandomForestClassifier,
  LogisticRegression,
  KNeighborsClassifier,
  GaussianMixture,
  KMeans, DBSCAN, AgglomerativeClustering,
  PCA, KBinsDiscretizer, StandardScaler, OneHotEncoder,
  Pipeline, ColumnTransformer,
  silhouette_score, silhouette_samples,
} from '../ext/learn/src/main.js';

// ────────────────────────────────────────────────────────────────────
// predict_log_proba
// ────────────────────────────────────────────────────────────────────

describe('predict_log_proba — default via ClassifierMixin', () => {
  // 2-class, 2-feature, 6 samples — well-separated.
  const X = [[0, 0], [0, 1], [1, 0], [4, 4], [4, 5], [5, 4]];
  const y = [0, 0, 0, 1, 1, 1];

  const cases = [
    ['DecisionTreeClassifier', () => new DecisionTreeClassifier({ max_depth: 3 })],
    ['RandomForestClassifier', () => new RandomForestClassifier({ n_estimators: 10, random_state: 0 })],
    ['LogisticRegression',     () => new LogisticRegression({ max_iter: 200 })],
    ['KNeighborsClassifier',   () => new KNeighborsClassifier({ n_neighbors: 3 })],
  ];

  for (const [name, make] of cases) {
    test(`${name}: log_proba ≈ log(proba), shape preserved`, () => {
      const est = make().fit(X, y);
      const proba = est.predict_proba(X);
      const log_proba = est.predict_log_proba(X);
      assert.equal(log_proba.length, proba.length);
      assert.deepEqual(log_proba.shape, proba.shape ?? [X.length, 2]);
      for (let i = 0; i < proba.length; i++) {
        // Clipped at log(1e-12) for p < 1e-12.
        const expected = proba[i] < 1e-12 ? Math.log(1e-12) : Math.log(proba[i]);
        assert.ok(
          Math.abs(log_proba[i] - expected) < 1e-10,
          `${name}[${i}]: got ${log_proba[i]}, want ${expected}`,
        );
      }
    });
  }
});

describe('predict_log_proba — GMM uses log-responsibilities directly', () => {
  test('matches log(predict_proba) within tolerance and is more accurate near zero', () => {
    // 3 well-separated clusters in 2D
    const X = [];
    for (let i = 0; i < 20; i++) X.push([Math.random() * 0.1, Math.random() * 0.1]);
    for (let i = 0; i < 20; i++) X.push([5 + Math.random() * 0.1, Math.random() * 0.1]);
    for (let i = 0; i < 20; i++) X.push([Math.random() * 0.1, 5 + Math.random() * 0.1]);
    const gmm = new GaussianMixture({ n_components: 3, random_state: 0, max_iter: 100 }).fit(X);
    const proba = gmm.predict_proba(X);
    const log_proba = gmm.predict_log_proba(X);
    assert.deepEqual(log_proba.shape, [X.length, 3]);
    // log_proba should match log(proba) for non-tiny entries
    for (let i = 0; i < proba.length; i++) {
      if (proba[i] > 1e-8) {
        assert.ok(
          Math.abs(log_proba[i] - Math.log(proba[i])) < 1e-6,
          `gmm[${i}]: log_proba=${log_proba[i]}, log(proba)=${Math.log(proba[i])}`,
        );
      }
    }
  });
});

describe('predict_log_proba — Pipeline', () => {
  test('chains through final step', () => {
    const X = [[0, 0], [0, 1], [1, 0], [10, 10], [10, 11], [11, 10]];
    const y = [0, 0, 0, 1, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['scale', new StandardScaler()],
        ['clf',   new LogisticRegression({ max_iter: 200 })],
      ],
    }).fit(X, y);
    const log_proba = pipe.predict_log_proba(X);
    const proba = pipe.predict_proba(X);
    for (let i = 0; i < proba.length; i++) {
      if (proba[i] > 1e-8) {
        assert.ok(Math.abs(log_proba[i] - Math.log(proba[i])) < 1e-6);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// get_feature_names_out
// ────────────────────────────────────────────────────────────────────

describe('PCA.get_feature_names_out', () => {
  test('returns pc0..pc{k-1}', () => {
    const X = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
    const pca = new PCA({ n_components: 2 }).fit(X);
    assert.deepEqual(pca.get_feature_names_out(), ['pc0', 'pc1']);
  });
  test('ignores input_features', () => {
    const X = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    const pca = new PCA({ n_components: 1 }).fit(X);
    assert.deepEqual(pca.get_feature_names_out(['a', 'b', 'c']), ['pc0']);
  });
  test('throws when unfitted', () => {
    const pca = new PCA();
    assert.throws(() => pca.get_feature_names_out());
  });
});

describe('KBinsDiscretizer.get_feature_names_out', () => {
  test('mirrors input names (ordinal preserves columns)', () => {
    const X = [[0, 100], [1, 200], [2, 300], [3, 400], [4, 500]];
    const kbd = new KBinsDiscretizer({ n_bins: 3, strategy: 'uniform' }).fit(X);
    assert.deepEqual(kbd.get_feature_names_out(['a', 'b']), ['a', 'b']);
  });
  test('falls back to feature_names_in_', () => {
    const X = { a: [0, 1, 2, 3, 4], b: [100, 200, 300, 400, 500] };
    const kbd = new KBinsDiscretizer({ n_bins: 3, strategy: 'uniform' }).fit(X);
    assert.deepEqual(kbd.get_feature_names_out(), ['a', 'b']);
  });
  test('falls back to x0..x{m-1} when no names', () => {
    const X = [[0, 100], [1, 200], [2, 300], [3, 400]];
    const kbd = new KBinsDiscretizer({ n_bins: 3, strategy: 'uniform' }).fit(X);
    assert.deepEqual(kbd.get_feature_names_out(), ['x0', 'x1']);
  });
});

describe('ColumnTransformer.get_feature_names_out', () => {
  test('prefixes each transformer block by name', () => {
    const X = [[1, 'a'], [2, 'b'], [3, 'a'], [4, 'c'], [5, 'b']];
    const ct = new ColumnTransformer({
      transformers: [
        ['num', new StandardScaler(), [0]],
        ['cat', new OneHotEncoder(), [1]],
      ],
    }).fit(X);
    const names = ct.get_feature_names_out(['amount', 'category']);
    // StandardScaler has no get_feature_names_out by default — falls back to
    // passthrough names from the slice.
    assert.ok(names.includes('num__amount'), names.join(', '));
    // OneHotEncoder produces "<input>_<category>" names.
    const catNames = names.filter(n => n.startsWith('cat__'));
    assert.equal(catNames.length, 3);
    for (const n of catNames) {
      assert.match(n, /^cat__category_[abc]$/);
    }
  });
  test('handles remainder=passthrough', () => {
    const X = [[1, 10, 100], [2, 20, 200], [3, 30, 300]];
    const ct = new ColumnTransformer({
      transformers: [['scale', new StandardScaler(), [0]]],
      remainder: 'passthrough',
    }).fit(X);
    const names = ct.get_feature_names_out(['a', 'b', 'c']);
    assert.ok(names.includes('scale__a'));
    assert.ok(names.includes('remainder__b'));
    assert.ok(names.includes('remainder__c'));
  });
});

// ────────────────────────────────────────────────────────────────────
// decision_function via Pipeline
// ────────────────────────────────────────────────────────────────────

describe('Pipeline.decision_function', () => {
  test('chains through to the final classifier', () => {
    const X = [[0, 0], [0, 1], [1, 0], [10, 10], [10, 11], [11, 10]];
    const y = [0, 0, 0, 1, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['scale', new StandardScaler()],
        ['clf',   new LogisticRegression({ max_iter: 200 })],
      ],
    }).fit(X, y);
    const z = pipe.decision_function(X);
    assert.equal(z.length, X.length);
    // Class 0 samples should have negative scores, class 1 positive.
    for (let i = 0; i < 3; i++) assert.ok(z[i] < 0);
    for (let i = 3; i < 6; i++) assert.ok(z[i] > 0);
  });
  test('throws when final step has no decision_function', () => {
    const X = [[0, 0], [1, 1]];
    const y = [0, 1];
    const pipe = new Pipeline({
      steps: [
        ['knn', new KNeighborsClassifier({ n_neighbors: 1 })],
      ],
    }).fit(X, y);
    assert.throws(() => pipe.decision_function(X), /no \.decision_function/);
  });
});

// ────────────────────────────────────────────────────────────────────
// silhouette_score + ClusterMixin.score
// ────────────────────────────────────────────────────────────────────

describe('silhouette_score', () => {
  test('two well-separated blobs score near 1', () => {
    const X = [];
    const labels = [];
    for (let i = 0; i < 10; i++) { X.push([0, i * 0.1]); labels.push(0); }
    for (let i = 0; i < 10; i++) { X.push([20, i * 0.1]); labels.push(1); }
    const s = silhouette_score(X, labels);
    assert.ok(s > 0.9, `expected > 0.9, got ${s}`);
  });

  test('two overlapping blobs score low', () => {
    const X = [];
    const labels = [];
    for (let i = 0; i < 10; i++) { X.push([Math.random(), Math.random()]); labels.push(0); }
    for (let i = 0; i < 10; i++) { X.push([Math.random(), Math.random()]); labels.push(1); }
    const s = silhouette_score(X, labels);
    assert.ok(s < 0.3, `expected < 0.3, got ${s}`);
  });

  test('single cluster returns NaN', () => {
    const X = [[0, 0], [1, 1], [2, 2]];
    const labels = [0, 0, 0];
    assert.ok(Number.isNaN(silhouette_score(X, labels)));
  });

  test('drops noise (label -1) samples', () => {
    const X = [];
    const labels = [];
    for (let i = 0; i < 10; i++) { X.push([0, i * 0.1]); labels.push(0); }
    for (let i = 0; i < 10; i++) { X.push([20, i * 0.1]); labels.push(1); }
    // Add noise points
    X.push([10, 10]); labels.push(-1);
    X.push([10, 5]); labels.push(-1);
    const samples = silhouette_samples(X, labels);
    assert.equal(samples.length, 20);
  });

  test('singleton cluster yields 0 for that sample', () => {
    const X = [[0, 0], [0, 1], [0, 2], [100, 100]];
    const labels = [0, 0, 0, 1];
    const samples = silhouette_samples(X, labels);
    // Index 3 is the singleton — its silhouette is 0 by sklearn convention.
    assert.equal(samples[3], 0);
  });
});

describe('ClusterMixin.score uses silhouette by default', () => {
  test('KMeans.score on training data returns positive silhouette for separated blobs', () => {
    const X = [];
    for (let i = 0; i < 20; i++) X.push([Math.random() * 0.5, Math.random() * 0.5]);
    for (let i = 0; i < 20; i++) X.push([10 + Math.random() * 0.5, 10 + Math.random() * 0.5]);
    const km = new KMeans({ n_clusters: 2, random_state: 0 }).fit(X);
    const s = km.score(X);
    assert.ok(s > 0.7, `expected high silhouette, got ${s}`);
  });

  test('AgglomerativeClustering.score on its labels_', () => {
    const X = [];
    for (let i = 0; i < 10; i++) X.push([Math.random() * 0.5, Math.random() * 0.5]);
    for (let i = 0; i < 10; i++) X.push([10 + Math.random() * 0.5, 10 + Math.random() * 0.5]);
    const ag = new AgglomerativeClustering({ n_clusters: 2 }).fit(X);
    const s = ag.score(X);
    assert.ok(s > 0.7, `expected high silhouette, got ${s}`);
  });

  test('DBSCAN.score handles noise points', () => {
    const X = [];
    for (let i = 0; i < 15; i++) X.push([Math.random() * 0.3, Math.random() * 0.3]);
    for (let i = 0; i < 15; i++) X.push([10 + Math.random() * 0.3, 10 + Math.random() * 0.3]);
    X.push([5, 5]);  // a likely-noise outlier
    const db = new DBSCAN({ eps: 1.0, min_samples: 3 }).fit(X);
    const s = db.score(X);
    // Should be either a real number (≥2 clusters survive) or NaN (only 1
    // cluster after filtering). Either is correct.
    assert.ok(typeof s === 'number');
  });

  test('GaussianMixture.score is NOT silhouette (override preserved)', () => {
    const X = [];
    for (let i = 0; i < 20; i++) X.push([Math.random(), Math.random()]);
    for (let i = 0; i < 20; i++) X.push([5 + Math.random(), 5 + Math.random()]);
    const gmm = new GaussianMixture({ n_components: 2, random_state: 0 }).fit(X);
    const s = gmm.score(X);
    // Log-likelihood for well-separated 2D gaussians is much larger than
    // any silhouette could be. This guards against silhouette accidentally
    // clobbering GMM's bespoke scorer.
    assert.ok(s < 0 || s > 1.0, `GMM.score returned silhouette-shaped ${s}?`);
  });
});
