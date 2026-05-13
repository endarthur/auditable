// @gcu/learn — sadpan integration test suite (SPEC §3.5).
//
// Covers:
//   - asMatrix accepts sadpan Table, sadpan DataFrame, plain JS named-
//     column objects; surfaces feature_names through.
//   - asVector accepts sadpan Series-shaped objects (anything with .values).
//   - from_table builds (X, y, groups, xyz) tuples from a table; auto-
//     encodes string class labels and returns the inverse mapping.
//   - StandardScaler / DecisionTree* / Pipeline populate feature_names_in_
//     when fit on a Table.
//   - feature_names_in_ round-trips through dump/load.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  StandardScaler, MinMaxScaler, MaxAbsScaler, RobustScaler,
  OrdinalEncoder, OneHotEncoder, KBinsDiscretizer, PowerTransformer,
  DecisionTreeClassifier, DecisionTreeRegressor,
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, BaggingClassifier,
  GradientBoostingRegressor, GradientBoostingClassifier,
  LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression,
  KMeans, AgglomerativeClustering, DBSCAN,
  PCA, TruncatedSVD, NMF,
  GaussianMixture,
  KNeighborsClassifier, KNeighborsRegressor,
  PLSRegression,
  SimpleImputer, KNNImputer, BDLImputer,
  CLR, ILR, ALR,
  Pipeline, ColumnTransformer, KFold,
  from_table, cross_val_score,
  dump, load,
} from '../ext/learn/src/main.js';
import * as sadpan from '../ext/sadpan/index.js';

// ────────────────────────────────────────────────────────────────────
// asMatrix accepts table-shaped inputs
// ────────────────────────────────────────────────────────────────────

describe('asMatrix table-shaped inputs', () => {
  test('sadpan Table → fit on StandardScaler', () => {
    const t = sadpan.table({
      SiO2: [62, 64, 60, 65],
      Al2O3: [15, 14, 16, 13],
    });
    const sc = new StandardScaler().fit(t);
    assert.deepEqual(Array.from(sc.mean_), [62.75, 14.5]);
    assert.deepEqual(sc.feature_names_in_, ['SiO2', 'Al2O3']);
    assert.equal(sc.n_features_in_, 2);
  });

  test('sadpan DataFrame → fit on StandardScaler', () => {
    const df = new sadpan.DataFrame({
      SiO2: [62, 64, 60, 65],
      Al2O3: [15, 14, 16, 13],
    });
    const sc = new StandardScaler().fit(df);
    assert.deepEqual(Array.from(sc.mean_), [62.75, 14.5]);
    assert.deepEqual(sc.feature_names_in_, ['SiO2', 'Al2O3']);
  });

  test('plain {col: array} object → fit on StandardScaler', () => {
    const X = { SiO2: [62, 64, 60, 65], Al2O3: [15, 14, 16, 13] };
    const sc = new StandardScaler().fit(X);
    assert.deepEqual(sc.feature_names_in_, ['SiO2', 'Al2O3']);
  });

  test('Float64Array.shape passes through (no feature_names)', () => {
    const X = new Float64Array([1, 2, 3, 4, 5, 6]);
    X.shape = [3, 2];
    const sc = new StandardScaler().fit(X);
    assert.equal(sc.feature_names_in_, undefined);
    assert.equal(sc.n_features_in_, 2);
  });

  test('mismatched column lengths raise', () => {
    const X = { a: [1, 2, 3], b: [1, 2] };
    assert.throws(() => new StandardScaler().fit(X), /column 'b' has length 2/);
  });

  test('empty table raises', () => {
    const X = {};
    assert.throws(() => new StandardScaler().fit(X), /unrecognized shape/);
  });
});

// ────────────────────────────────────────────────────────────────────
// asVector / Series-shaped y
// ────────────────────────────────────────────────────────────────────

describe('asVector Series-shaped y', () => {
  test('sadpan Series via DataFrame.__getitem__ → fit a tree', () => {
    const df = new sadpan.DataFrame({
      SiO2: [10, 20, 30, 40],
      domain: [0, 0, 1, 1],
    });
    const y_series = df.__getitem__('domain');
    const X = sadpan.table({SiO2: [10, 20, 30, 40]});
    const tree = new DecisionTreeClassifier({ random_state: 0 }).fit(X, y_series);
    const yhat = tree.predict([[15], [35]]);
    assert.deepEqual(Array.from(yhat), [0, 1]);
  });
});

// ────────────────────────────────────────────────────────────────────
// from_table
// ────────────────────────────────────────────────────────────────────

describe('from_table', () => {
  test('extracts X / y / feature_names with explicit features list', () => {
    const t = sadpan.table({
      SiO2: [62, 64, 60, 65],
      Al2O3: [15, 14, 16, 13],
      Fe2O3: [5, 4, 6, 5],
      domain: [0, 0, 1, 1],
    });
    const { X, y, feature_names } = from_table(t, {
      target: 'domain',
      features: ['SiO2', 'Al2O3', 'Fe2O3'],
    });
    assert.deepEqual(X.shape, [4, 3]);
    assert.deepEqual(feature_names, ['SiO2', 'Al2O3', 'Fe2O3']);
    assert.deepEqual(Array.from(y), [0, 0, 1, 1]);
  });

  test('default features = all cols except target/group/xyz', () => {
    const t = sadpan.table({
      a: [1, 2, 3],
      b: [4, 5, 6],
      c: [7, 8, 9],
      target: [0, 1, 0],
      dhid: [1, 1, 2],
      X: [10, 11, 12], Y: [20, 21, 22], Z: [30, 31, 32],
    });
    const { feature_names } = from_table(t, {
      target: 'target', group: 'dhid', xyz: ['X', 'Y', 'Z'],
    });
    assert.deepEqual(feature_names, ['a', 'b', 'c']);
  });

  test('auto-encodes string class labels and returns inverse mapping', () => {
    const t = sadpan.table({
      SiO2: [62, 64, 60, 65],
      domain: ['ox', 'sulf', 'ox', 'sulf'],
    });
    const { y, classes } = from_table(t, {
      target: 'domain', features: ['SiO2'],
    });
    assert.deepEqual(Array.from(y), [0, 1, 0, 1]);
    assert.deepEqual(classes, ['ox', 'sulf']);
  });

  test('numeric target preserved as Float64Array (no encoding)', () => {
    const t = sadpan.table({
      x: [1, 2, 3],
      grade: [0.5, 1.2, 2.7],
    });
    const { y, classes } = from_table(t, { target: 'grade' });
    assert.deepEqual(Array.from(y), [0.5, 1.2, 2.7]);
    assert.equal(classes, null);
  });

  test('groups and xyz extraction', () => {
    const t = sadpan.table({
      a: [1, 2, 3, 4],
      dhid: [1, 1, 2, 2],
      X: [0, 1, 0, 1], Y: [0, 0, 1, 1],
    });
    const { groups, xyz } = from_table(t, {
      target: null, features: ['a'], group: 'dhid', xyz: ['X', 'Y'],
    });
    assert.deepEqual(groups, [1, 1, 2, 2]);
    assert.deepEqual(xyz.shape, [4, 2]);
    assert.deepEqual(Array.from(xyz.data), [0, 0, 1, 0, 0, 1, 1, 1]);
  });

  test('feature not in table raises', () => {
    const t = sadpan.table({ a: [1, 2] });
    assert.throws(() => from_table(t, { features: ['b'] }),
      /feature 'b' not in input columns/);
  });

  test('xyz with wrong dimension raises', () => {
    const t = sadpan.table({ a: [1], b: [2], c: [3], d: [4], e: [5] });
    assert.throws(() => from_table(t, { features: ['a'], xyz: ['b', 'c', 'd', 'e'] }),
      /xyz must list 1-3 columns/);
  });

  test('works with sadpan DataFrame too', () => {
    const df = new sadpan.DataFrame({
      x: [1, 2, 3], y_target: [10, 20, 30],
    });
    const { X, y, feature_names } = from_table(df, {
      target: 'y_target', features: ['x'],
    });
    assert.deepEqual(X.shape, [3, 1]);
    assert.deepEqual(feature_names, ['x']);
    assert.deepEqual(Array.from(y), [10, 20, 30]);
  });

  test('works with plain {col: array} JS object', () => {
    const X = { SiO2: [10, 20, 30], domain: [0, 0, 1] };
    const { X: Xfeat, y, feature_names } = from_table(X, {
      target: 'domain', features: ['SiO2'],
    });
    assert.deepEqual(feature_names, ['SiO2']);
    assert.deepEqual(Array.from(y), [0, 0, 1]);
  });
});

// ────────────────────────────────────────────────────────────────────
// feature_names_in_ population on key estimators
// ────────────────────────────────────────────────────────────────────

describe('feature_names_in_ auto-population', () => {
  test('DecisionTreeClassifier on Table', () => {
    const t = sadpan.table({
      SiO2: [10, 20, 30, 40, 50, 60],
      Al2O3: [5, 6, 7, 8, 9, 10],
    });
    const tree = new DecisionTreeClassifier({ random_state: 0 }).fit(
      t, [0, 0, 0, 1, 1, 1]);
    assert.deepEqual(tree.feature_names_in_, ['SiO2', 'Al2O3']);
  });

  test('DecisionTreeRegressor on Table', () => {
    const t = sadpan.table({ x: [1, 2, 3, 4] });
    const reg = new DecisionTreeRegressor().fit(t, [10, 20, 30, 40]);
    assert.deepEqual(reg.feature_names_in_, ['x']);
  });

  test('Pipeline inherits feature_names_in_ from first step', () => {
    const t = sadpan.table({
      SiO2: [10, 20, 30, 40, 50, 60],
      Al2O3: [5, 6, 7, 8, 9, 10],
    });
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['tree', new DecisionTreeClassifier({ random_state: 0 })],
      ],
    });
    pipe.fit(t, [0, 0, 0, 1, 1, 1]);
    assert.deepEqual(pipe.feature_names_in_, ['SiO2', 'Al2O3']);
    assert.deepEqual(pipe.named_steps.scaler.feature_names_in_, ['SiO2', 'Al2O3']);
  });

  test('Float64Array input → no feature_names_in_ set', () => {
    const X = new Float64Array([1, 2, 3, 4, 5, 6]);
    X.shape = [3, 2];
    const sc = new StandardScaler().fit(X);
    assert.equal(sc.feature_names_in_, undefined);
  });
});

// ────────────────────────────────────────────────────────────────────
// Roll-out coverage: feature_names_in_ across every estimator family
// ────────────────────────────────────────────────────────────────────

describe('feature_names_in_ rollout coverage', () => {
  // Numeric classification table.
  const tCls = sadpan.table({
    SiO2: [62, 64, 60, 65, 30, 32, 28, 35],
    Al2O3: [15, 14, 16, 13, 25, 24, 26, 22],
    Fe2O3: [5, 4, 6, 5, 12, 13, 11, 14],
  });
  const yCls = [0, 0, 0, 0, 1, 1, 1, 1];
  // Numeric regression table.
  const tReg = sadpan.table({
    x1: [1, 2, 3, 4, 5, 6, 7, 8],
    x2: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
  });
  const yReg = [10, 20, 30, 40, 50, 60, 70, 80];
  // Compositional table (row sums close to 1, all positive).
  const tComp = sadpan.table({
    A: [0.4, 0.5, 0.6, 0.3],
    B: [0.4, 0.3, 0.2, 0.4],
    C: [0.2, 0.2, 0.2, 0.3],
  });
  const expectedCls = ['SiO2', 'Al2O3', 'Fe2O3'];
  const expectedReg = ['x1', 'x2'];
  const expectedComp = ['A', 'B', 'C'];

  // Scalers + encoders + binning + power.
  test('all preprocessing transformers', () => {
    assert.deepEqual(new MinMaxScaler().fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(new MaxAbsScaler().fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(new RobustScaler().fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(new KBinsDiscretizer({ n_bins: 3 }).fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(new PowerTransformer().fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(new OrdinalEncoder().fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(new OneHotEncoder().fit(tCls).feature_names_in_, expectedCls);
  });

  // Tree family.
  test('all tree-family estimators', () => {
    assert.deepEqual(
      new DecisionTreeClassifier({ random_state: 0 }).fit(tCls, yCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new DecisionTreeRegressor().fit(tReg, yReg).feature_names_in_,
      expectedReg);
    assert.deepEqual(
      new RandomForestClassifier({ n_estimators: 5, random_state: 0 }).fit(tCls, yCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new RandomForestRegressor({ n_estimators: 5, random_state: 0 }).fit(tReg, yReg).feature_names_in_,
      expectedReg);
    assert.deepEqual(
      new ExtraTreesClassifier({ n_estimators: 5, random_state: 0 }).fit(tCls, yCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new BaggingClassifier({ n_estimators: 5, random_state: 0 }).fit(tCls, yCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new GradientBoostingRegressor({ n_estimators: 5, random_state: 0 }).fit(tReg, yReg).feature_names_in_,
      expectedReg);
    assert.deepEqual(
      new GradientBoostingClassifier({ n_estimators: 5, random_state: 0 }).fit(tCls, yCls).feature_names_in_,
      expectedCls);
  });

  // Linear models.
  test('all linear models', () => {
    assert.deepEqual(
      new LinearRegression().fit(tReg, yReg).feature_names_in_, expectedReg);
    assert.deepEqual(
      new Ridge({ alpha: 0.1 }).fit(tReg, yReg).feature_names_in_, expectedReg);
    assert.deepEqual(
      new Lasso({ alpha: 0.01 }).fit(tReg, yReg).feature_names_in_, expectedReg);
    assert.deepEqual(
      new ElasticNet({ alpha: 0.01 }).fit(tReg, yReg).feature_names_in_, expectedReg);
    assert.deepEqual(
      new LogisticRegression({ max_iter: 50 }).fit(tCls, yCls).feature_names_in_,
      expectedCls);
  });

  // Cluster + decomposition + mixture + KNN + PLS.
  test('cluster / decomposition / mixture / KNN / PLS', () => {
    assert.deepEqual(
      new KMeans({ n_clusters: 2, n_init: 3, random_state: 0 }).fit(tCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new AgglomerativeClustering({ n_clusters: 2 }).fit(tCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new DBSCAN({ eps: 5, min_samples: 2 }).fit(tCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new PCA({ n_components: 2 }).fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(
      new TruncatedSVD({ n_components: 2 }).fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(
      new NMF({ n_components: 2, max_iter: 50 }).fit(tCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new GaussianMixture({ n_components: 2, random_state: 0 }).fit(tCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new KNeighborsClassifier({ n_neighbors: 3 }).fit(tCls, yCls).feature_names_in_,
      expectedCls);
    assert.deepEqual(
      new KNeighborsRegressor({ n_neighbors: 3 }).fit(tReg, yReg).feature_names_in_,
      expectedReg);
    assert.deepEqual(
      new PLSRegression({ n_components: 2 }).fit(tReg, yReg).feature_names_in_,
      expectedReg);
  });

  // Imputers + compositional.
  test('imputers and compositional transforms', () => {
    assert.deepEqual(
      new SimpleImputer().fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(
      new KNNImputer().fit(tCls).feature_names_in_, expectedCls);
    assert.deepEqual(
      new BDLImputer({ detection_limits: 0.001 }).fit(tComp).feature_names_in_,
      expectedComp);
    assert.deepEqual(new CLR().fit(tComp).feature_names_in_, expectedComp);
    assert.deepEqual(new ILR().fit(tComp).feature_names_in_, expectedComp);
    assert.deepEqual(new ALR().fit(tComp).feature_names_in_, expectedComp);
  });

  // ColumnTransformer (numeric routes; uses int column indices, not names).
  test('ColumnTransformer captures input column names', () => {
    const ct = new ColumnTransformer({
      transformers: [['scale', new StandardScaler(), [0, 1]]],
      remainder: 'drop',
    });
    ct.fit(tReg);
    assert.deepEqual(ct.feature_names_in_, expectedReg);
    // Round-trip preserves them.
    const r = load(dump(ct));
    assert.deepEqual(r.feature_names_in_, expectedReg);
  });
});

// ────────────────────────────────────────────────────────────────────
// dump/load round-trip preserves feature_names_in_
// ────────────────────────────────────────────────────────────────────

describe('feature_names_in_ + mimic-io round-trip', () => {
  test('StandardScaler feature_names_in_ survives dump/load', () => {
    const t = sadpan.table({ SiO2: [62, 64, 60, 65], Al2O3: [15, 14, 16, 13] });
    const sc = new StandardScaler().fit(t);
    const r = load(dump(sc));
    assert.deepEqual(r.feature_names_in_, ['SiO2', 'Al2O3']);
  });

  test('DecisionTreeClassifier feature_names_in_ survives dump/load', () => {
    const t = sadpan.table({ a: [10, 20, 30, 40], b: [1, 2, 3, 4] });
    const tree = new DecisionTreeClassifier({ random_state: 0 }).fit(t, [0, 0, 1, 1]);
    const r = load(dump(tree));
    assert.deepEqual(r.feature_names_in_, ['a', 'b']);
  });

  test('Pipeline feature_names_in_ survives dump/load', () => {
    const t = sadpan.table({ a: [10, 20, 30, 40], b: [1, 2, 3, 4] });
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['tree', new DecisionTreeClassifier({ random_state: 0 })],
      ],
    });
    pipe.fit(t, [0, 0, 1, 1]);
    const r = load(dump(pipe));
    assert.deepEqual(r.feature_names_in_, ['a', 'b']);
    assert.deepEqual(r.named_steps.scaler.feature_names_in_, ['a', 'b']);
  });
});

// ────────────────────────────────────────────────────────────────────
// End-to-end geomet workflow with from_table
// ────────────────────────────────────────────────────────────────────

describe('end-to-end from_table workflow', () => {
  test('SpatialKFold via from_table', () => {
    const t = sadpan.table({
      SiO2: [62, 64, 60, 65, 30, 32, 28, 35],
      Al2O3: [15, 14, 16, 13, 25, 24, 26, 22],
      domain: ['ox', 'ox', 'ox', 'ox', 'sulf', 'sulf', 'sulf', 'sulf'],
      X: [0, 1, 2, 3, 10, 11, 12, 13],
      Y: [0, 0, 0, 0, 0, 0, 0, 0],
    });
    const { X, y, xyz, feature_names } = from_table(t, {
      target: 'domain', features: ['SiO2', 'Al2O3'], xyz: ['X', 'Y'],
    });
    assert.deepEqual(feature_names, ['SiO2', 'Al2O3']);
    assert.deepEqual(xyz.shape, [8, 2]);
    const tree = new DecisionTreeClassifier({ random_state: 0 });
    const scores = cross_val_score(tree, X, y, {
      cv: new KFold({ n_splits: 4, shuffle: true, random_state: 0 }),
    });
    assert.equal(scores.length, 4);
    for (const s of scores) assert.ok(Number.isFinite(s));
  });
});
