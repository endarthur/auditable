// Ensembles — RandomForest, ExtraTrees, Bagging.
//
// Sklearn-compatible at the contract level. v0.2 ships these single-
// threaded; the worker-pool n_jobs > 1 variant lands later (per SPEC
// §6.2) once util/workers.js exists.
//
// Tree-family ensembles (RandomForest, ExtraTrees) reuse the
// DecisionTree{Classifier,Regressor} infrastructure from tree.js.
// Bagging is generic over any base estimator following the standard
// fit/predict contract.
//
// All three classes serialize via mimic-io with a custom codec hook —
// the fitted state holds an array of fitted child estimators, and the
// default mimic-io walker can't preserve their class identity. The
// hook mirrors Pipeline / ColumnTransformer's pattern.

import { BaseEstimator, ClassifierMixin, RegressorMixin } from './base.js';
import { dump, load, learnRegistry } from './serialize.js';
import { asMatrix, asVector, checkNFeatures, ValidationError } from './util/checks.js';
import { mulberry32 } from './util/random.js';
import { DecisionTreeClassifier, DecisionTreeRegressor } from './tree.js';

const MODULE_ID_ENSEMBLE = '@gcu/learn.ensemble';

// ────────────────────────────────────────────────────────────────────
// Shared infrastructure
// ────────────────────────────────────────────────────────────────────

// Bootstrap-sample row indices with replacement.
function _bootstrapIndices(n, n_samples, rng) {
  const out = new Int32Array(n_samples);
  for (let i = 0; i < n_samples; i++) out[i] = Math.floor(rng() * n);
  return out;
}

// Sample row indices without replacement (sklearn's max_samples<n with bootstrap=False).
function _subsampleIndices(n, n_samples, rng) {
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = 0; i < n_samples; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx.subarray(0, n_samples);
}

function _gatherRows(Xd, n, m, indices) {
  const k = indices.length;
  const out = new Float64Array(k * m);
  for (let i = 0; i < k; i++) {
    const src = indices[i] * m;
    const dst = i * m;
    for (let j = 0; j < m; j++) out[dst + j] = Xd[src + j];
  }
  out.shape = [k, m];
  return out;
}

function _gatherValues(yv, indices) {
  const k = indices.length;
  const out = new Float64Array(k);
  for (let i = 0; i < k; i++) out[i] = yv[indices[i]];
  return out;
}

// Resolve max_samples to integer count.
//
// Sklearn distinguishes int vs float here (1 = 1 sample, 1.0 = 100%).
// JS has no int/float type distinction (1 === 1.0), so we treat any
// value in (0, 1] as a fraction and anything > 1 as a count. The
// practical effect: max_samples=1 means "100% of samples"; to draw
// exactly 1 sample, pass max_samples=2 (which then clips to n=1 only
// when n=1 — useless edge case for ensembles anyway).
function _resolveMaxSamples(spec, n) {
  if (spec == null) return n;
  if (typeof spec === 'number') {
    if (spec <= 1) return Math.max(1, Math.min(n, Math.round(spec * n)));
    return Math.max(1, Math.min(n, Math.floor(spec)));
  }
  throw new ValidationError(`max_samples must be number|null; got ${spec}`);
}

// Sorted union of class labels across all child estimators (handles the
// case where a bootstrap sample misses a class entirely).
function _unionClasses(estimators) {
  const seen = new Set();
  for (const est of estimators) {
    if (est.classes_) for (const c of est.classes_) seen.add(c);
  }
  return Float64Array.from([...seen].sort((a, b) => a - b));
}

// ────────────────────────────────────────────────────────────────────
// _ForestBase — shared scaffolding for RandomForest + ExtraTrees
// ────────────────────────────────────────────────────────────────────

function _fitForest(est, X, y, opts) {
  const { data: Xd, shape } = asMatrix(X);
  const yv = y == null ? null : asVector(y);
  const [n, m] = shape;
  if (yv != null && yv.length !== n) {
    throw new ValidationError(`fit: y length ${yv.length} != n_samples ${n}`);
  }
  const baseSeed = est.random_state == null
    ? Math.floor(Math.random() * 0x7fffffff)
    : est.random_state;
  const rng = mulberry32(baseSeed);
  const n_samples = _resolveMaxSamples(est.max_samples, n);
  const estimators = [];
  for (let t = 0; t < est.n_estimators; t++) {
    const tree_seed = (rng() * 0x7fffffff) | 0;
    const tree_rng = mulberry32(tree_seed);
    let X_t, y_t;
    if (est.bootstrap) {
      const idx = _bootstrapIndices(n, n_samples, tree_rng);
      X_t = _gatherRows(Xd, n, m, idx);
      y_t = yv == null ? null : _gatherValues(yv, idx);
    } else if (n_samples < n) {
      const idx = _subsampleIndices(n, n_samples, tree_rng);
      X_t = _gatherRows(Xd, n, m, idx);
      y_t = yv == null ? null : _gatherValues(yv, idx);
    } else {
      X_t = X; y_t = y;
    }
    const tree = opts.makeTree(tree_seed);
    tree.fit(X_t, y_t);
    estimators.push(tree);
  }
  est.estimators_ = estimators;
  est.n_features_in_ = m;
  if (opts.classifier) {
    est.classes_ = _unionClasses(estimators);
    est.n_classes_ = est.classes_.length;
  }
  return est;
}

function _forestPredictProba(est, X) {
  const { shape } = asMatrix(X);
  checkNFeatures(est, shape, { name: 'X' });
  const n = shape[0];
  const k = est.classes_.length;
  const out = new Float64Array(n * k);
  // For each tree, accumulate its probability output averaged across the
  // forest. Map per-tree class indices to the union via a per-tree
  // remap when necessary.
  const inv_t = 1 / est.estimators_.length;
  for (const t of est.estimators_) {
    const proba = t.predict_proba(X);
    const t_classes = t.classes_;
    const k_t = t_classes.length;
    // Build remap: position c in t.classes_ → position in est.classes_.
    const remap = new Int32Array(k_t);
    for (let c = 0; c < k_t; c++) {
      remap[c] = est.classes_.indexOf(t_classes[c]);
    }
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k_t; c++) {
        out[i * k + remap[c]] += proba[i * k_t + c] * inv_t;
      }
    }
  }
  out.shape = [n, k];
  return out;
}

function _forestPredictClassifier(est, X) {
  const proba = _forestPredictProba(est, X);
  const n = proba.length / est.classes_.length;
  const k = est.classes_.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0, bestP = -1;
    for (let c = 0; c < k; c++) {
      if (proba[i * k + c] > bestP) { best = c; bestP = proba[i * k + c]; }
    }
    out[i] = est.classes_[best];
  }
  return out;
}

function _forestPredictRegressor(est, X) {
  const { shape } = asMatrix(X);
  checkNFeatures(est, shape, { name: 'X' });
  const n = shape[0];
  const out = new Float64Array(n);
  for (const t of est.estimators_) {
    const yh = t.predict(X);
    for (let i = 0; i < n; i++) out[i] += yh[i];
  }
  const inv = 1 / est.estimators_.length;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

// ────────────────────────────────────────────────────────────────────
// RandomForestClassifier
// ────────────────────────────────────────────────────────────────────

export class RandomForestClassifier extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_estimators = params.n_estimators ?? 100;
    this.criterion = params.criterion ?? 'gini';
    this.max_depth = params.max_depth ?? null;
    this.min_samples_split = params.min_samples_split ?? 2;
    this.min_samples_leaf = params.min_samples_leaf ?? 1;
    this.max_features = params.max_features ?? 'sqrt';
    this.bootstrap = params.bootstrap ?? true;
    this.max_samples = params.max_samples ?? null;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_ENSEMBLE;
  }

  fit(X, y) {
    return _fitForest(this, X, y, {
      classifier: true,
      makeTree: (seed) => new DecisionTreeClassifier({
        criterion: this.criterion,
        splitter: 'best',
        max_depth: this.max_depth,
        min_samples_split: this.min_samples_split,
        min_samples_leaf: this.min_samples_leaf,
        max_features: this.max_features,
        random_state: seed,
      }),
    });
  }

  predict(X) {
    if (!this.estimators_) throw new ValidationError('RandomForestClassifier: not fitted');
    return _forestPredictClassifier(this, X);
  }

  predict_proba(X) {
    if (!this.estimators_) throw new ValidationError('RandomForestClassifier: not fitted');
    return _forestPredictProba(this, X);
  }

  __sklearn_clone__() {
    return new RandomForestClassifier(this.get_params(false));
  }

  _toMimicIo() {
    return _ensembleEncode(this, 'RandomForestClassifier');
  }

  static _fromMimicIo(json, opts = {}) {
    return _ensembleDecode(RandomForestClassifier, json, opts, /* classifier */ true);
  }
}

Object.assign(RandomForestClassifier.prototype, ClassifierMixin);
RandomForestClassifier._estimator_type = 'classifier';

// ────────────────────────────────────────────────────────────────────
// RandomForestRegressor
// ────────────────────────────────────────────────────────────────────

export class RandomForestRegressor extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_estimators = params.n_estimators ?? 100;
    this.criterion = params.criterion ?? 'squared_error';
    this.max_depth = params.max_depth ?? null;
    this.min_samples_split = params.min_samples_split ?? 2;
    this.min_samples_leaf = params.min_samples_leaf ?? 1;
    this.max_features = params.max_features ?? 1.0;
    this.bootstrap = params.bootstrap ?? true;
    this.max_samples = params.max_samples ?? null;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_ENSEMBLE;
  }

  fit(X, y) {
    return _fitForest(this, X, y, {
      classifier: false,
      makeTree: (seed) => new DecisionTreeRegressor({
        criterion: this.criterion,
        splitter: 'best',
        max_depth: this.max_depth,
        min_samples_split: this.min_samples_split,
        min_samples_leaf: this.min_samples_leaf,
        max_features: this.max_features,
        random_state: seed,
      }),
    });
  }

  predict(X) {
    if (!this.estimators_) throw new ValidationError('RandomForestRegressor: not fitted');
    return _forestPredictRegressor(this, X);
  }

  __sklearn_clone__() {
    return new RandomForestRegressor(this.get_params(false));
  }

  _toMimicIo() {
    return _ensembleEncode(this, 'RandomForestRegressor');
  }

  static _fromMimicIo(json, opts = {}) {
    return _ensembleDecode(RandomForestRegressor, json, opts, /* classifier */ false);
  }
}

Object.assign(RandomForestRegressor.prototype, RegressorMixin);
RandomForestRegressor._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// ExtraTreesClassifier / ExtraTreesRegressor
// ────────────────────────────────────────────────────────────────────

export class ExtraTreesClassifier extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_estimators = params.n_estimators ?? 100;
    this.criterion = params.criterion ?? 'gini';
    this.max_depth = params.max_depth ?? null;
    this.min_samples_split = params.min_samples_split ?? 2;
    this.min_samples_leaf = params.min_samples_leaf ?? 1;
    this.max_features = params.max_features ?? 'sqrt';
    // ExtraTrees uses bootstrap=False by default (sklearn convention) — the
    // randomness comes from random thresholds, not bootstrap sampling.
    this.bootstrap = params.bootstrap ?? false;
    this.max_samples = params.max_samples ?? null;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_ENSEMBLE;
  }

  fit(X, y) {
    return _fitForest(this, X, y, {
      classifier: true,
      makeTree: (seed) => new DecisionTreeClassifier({
        criterion: this.criterion,
        splitter: 'random',
        max_depth: this.max_depth,
        min_samples_split: this.min_samples_split,
        min_samples_leaf: this.min_samples_leaf,
        max_features: this.max_features,
        random_state: seed,
      }),
    });
  }

  predict(X) {
    if (!this.estimators_) throw new ValidationError('ExtraTreesClassifier: not fitted');
    return _forestPredictClassifier(this, X);
  }

  predict_proba(X) {
    if (!this.estimators_) throw new ValidationError('ExtraTreesClassifier: not fitted');
    return _forestPredictProba(this, X);
  }

  __sklearn_clone__() {
    return new ExtraTreesClassifier(this.get_params(false));
  }

  _toMimicIo() { return _ensembleEncode(this, 'ExtraTreesClassifier'); }
  static _fromMimicIo(json, opts = {}) {
    return _ensembleDecode(ExtraTreesClassifier, json, opts, true);
  }
}

Object.assign(ExtraTreesClassifier.prototype, ClassifierMixin);
ExtraTreesClassifier._estimator_type = 'classifier';

export class ExtraTreesRegressor extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_estimators = params.n_estimators ?? 100;
    this.criterion = params.criterion ?? 'squared_error';
    this.max_depth = params.max_depth ?? null;
    this.min_samples_split = params.min_samples_split ?? 2;
    this.min_samples_leaf = params.min_samples_leaf ?? 1;
    this.max_features = params.max_features ?? 1.0;
    this.bootstrap = params.bootstrap ?? false;
    this.max_samples = params.max_samples ?? null;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_ENSEMBLE;
  }

  fit(X, y) {
    return _fitForest(this, X, y, {
      classifier: false,
      makeTree: (seed) => new DecisionTreeRegressor({
        criterion: this.criterion,
        splitter: 'random',
        max_depth: this.max_depth,
        min_samples_split: this.min_samples_split,
        min_samples_leaf: this.min_samples_leaf,
        max_features: this.max_features,
        random_state: seed,
      }),
    });
  }

  predict(X) {
    if (!this.estimators_) throw new ValidationError('ExtraTreesRegressor: not fitted');
    return _forestPredictRegressor(this, X);
  }

  __sklearn_clone__() {
    return new ExtraTreesRegressor(this.get_params(false));
  }

  _toMimicIo() { return _ensembleEncode(this, 'ExtraTreesRegressor'); }
  static _fromMimicIo(json, opts = {}) {
    return _ensembleDecode(ExtraTreesRegressor, json, opts, false);
  }
}

Object.assign(ExtraTreesRegressor.prototype, RegressorMixin);
ExtraTreesRegressor._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// BaggingClassifier / BaggingRegressor — generic bagging
// ────────────────────────────────────────────────────────────────────

/**
 * Generic bagging ensemble. Takes any base estimator that follows the
 * standard fit/predict (and optionally predict_proba) contract.
 *
 * Hyperparameters:
 *   - estimator (any unfitted estimator instance — used as the prototype
 *     to clone for each bag; default: DecisionTreeClassifier())
 *   - n_estimators, max_samples, max_features=1.0 (no per-bag feature
 *     subsampling in v0.2 — adds complexity, defer to v0.3),
 *     bootstrap=true, bootstrap_features=false (deferred), random_state.
 */
export class BaggingClassifier extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.estimator = params.estimator ?? new DecisionTreeClassifier();
    this.n_estimators = params.n_estimators ?? 10;
    this.max_samples = params.max_samples ?? 1.0;
    this.bootstrap = params.bootstrap ?? true;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_ENSEMBLE;
  }

  fit(X, y) {
    return _fitForest(this, X, y, {
      classifier: true,
      makeTree: (seed) => _cloneEstWithSeed(this.estimator, seed),
    });
  }

  predict(X) {
    if (!this.estimators_) throw new ValidationError('BaggingClassifier: not fitted');
    if (typeof this.estimators_[0].predict_proba === 'function') {
      return _forestPredictClassifier(this, X);
    }
    // Fall back to majority vote if the base estimator lacks predict_proba.
    return _majorityVote(this, X);
  }

  predict_proba(X) {
    if (!this.estimators_) throw new ValidationError('BaggingClassifier: not fitted');
    if (typeof this.estimators_[0].predict_proba !== 'function') {
      throw new ValidationError(
        'BaggingClassifier.predict_proba: base estimator has no predict_proba');
    }
    return _forestPredictProba(this, X);
  }

  __sklearn_clone__() {
    const Ctor = this.estimator.constructor;
    const params = typeof this.estimator.get_params === 'function'
      ? this.estimator.get_params(false) : {};
    return new BaggingClassifier({
      ...this.get_params(false),
      estimator: new Ctor(params),
    });
  }

  _toMimicIo() {
    const out = _ensembleEncode(this, 'BaggingClassifier');
    out.params.estimator = dump(this.estimator);
    return out;
  }
  static _fromMimicIo(json, opts = {}) {
    const params = { ...json.params };
    if (params.estimator) params.estimator = load(params.estimator, opts);
    return _ensembleDecodeFromParams(BaggingClassifier, json, params, opts, true);
  }
}

Object.assign(BaggingClassifier.prototype, ClassifierMixin);
BaggingClassifier._estimator_type = 'classifier';

export class BaggingRegressor extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.estimator = params.estimator ?? new DecisionTreeRegressor();
    this.n_estimators = params.n_estimators ?? 10;
    this.max_samples = params.max_samples ?? 1.0;
    this.bootstrap = params.bootstrap ?? true;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_ENSEMBLE;
  }

  fit(X, y) {
    return _fitForest(this, X, y, {
      classifier: false,
      makeTree: (seed) => _cloneEstWithSeed(this.estimator, seed),
    });
  }

  predict(X) {
    if (!this.estimators_) throw new ValidationError('BaggingRegressor: not fitted');
    return _forestPredictRegressor(this, X);
  }

  __sklearn_clone__() {
    const Ctor = this.estimator.constructor;
    const params = typeof this.estimator.get_params === 'function'
      ? this.estimator.get_params(false) : {};
    return new BaggingRegressor({
      ...this.get_params(false),
      estimator: new Ctor(params),
    });
  }

  _toMimicIo() {
    const out = _ensembleEncode(this, 'BaggingRegressor');
    out.params.estimator = dump(this.estimator);
    return out;
  }
  static _fromMimicIo(json, opts = {}) {
    const params = { ...json.params };
    if (params.estimator) params.estimator = load(params.estimator, opts);
    return _ensembleDecodeFromParams(BaggingRegressor, json, params, opts, false);
  }
}

Object.assign(BaggingRegressor.prototype, RegressorMixin);
BaggingRegressor._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

// Clone an estimator and inject a fresh random_state seed (when the
// estimator accepts one). Used by BaggingClassifier/Regressor to give
// each bag's child a distinct seed so they're not identical clones.
function _cloneEstWithSeed(template, seed) {
  const Ctor = template.constructor;
  const params = typeof template.get_params === 'function' ? template.get_params(false) : {};
  if ('random_state' in params) params.random_state = seed;
  return new Ctor(params);
}

// Majority-vote prediction (used by BaggingClassifier when the base
// estimator has no predict_proba). Each tree's predict() output is one
// vote per sample.
function _majorityVote(est, X) {
  const { shape } = asMatrix(X);
  const n = shape[0];
  const counts = new Array(n).fill(null).map(() => new Map());
  for (const t of est.estimators_) {
    const yh = t.predict(X);
    for (let i = 0; i < n; i++) {
      const k = yh[i];
      counts[i].set(k, (counts[i].get(k) ?? 0) + 1);
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let best = null, bestN = -1;
    for (const [k, c] of counts[i]) if (c > bestN) { best = k; bestN = c; }
    out[i] = best;
  }
  return out;
}

// Generic mimic-io encoder for tree-family ensembles. Children are
// dumped one-by-one through learn's dump (so they round-trip via the
// registered DecisionTree* classes).
function _ensembleEncode(est, class_name) {
  const params = est.get_params(false);
  const out = {
    format: 'mimic-io',
    version: 2,
    class: class_name,
    module: est._module,
    params,
  };
  if (est.estimators_) {
    out.fitted = {
      estimators_: est.estimators_.map(e => dump(e)),
      n_features_in_: est.n_features_in_,
    };
    if (est.classes_) {
      out.fitted.classes_ = Array.from(est.classes_);
      out.fitted.n_classes_ = est.n_classes_;
    }
  } else {
    out.fitted = null;
  }
  return out;
}

function _ensembleDecode(Ctor, json, opts, classifier) {
  const inst = new Ctor(json.params ?? {});
  return _ensembleHydrate(inst, json, opts, classifier);
}

function _ensembleDecodeFromParams(Ctor, json, params, opts, classifier) {
  const inst = new Ctor(params);
  return _ensembleHydrate(inst, json, opts, classifier);
}

function _ensembleHydrate(inst, json, opts, classifier) {
  if (json.fitted) {
    inst.estimators_ = (json.fitted.estimators_ ?? []).map(j => load(j, opts));
    inst.n_features_in_ = json.fitted.n_features_in_;
    if (classifier && json.fitted.classes_) {
      inst.classes_ = Float64Array.from(json.fitted.classes_);
      inst.n_classes_ = json.fitted.n_classes_;
    }
  }
  return inst;
}

// ────────────────────────────────────────────────────────────────────
// GradientBoostingRegressor
// ────────────────────────────────────────────────────────────────────

/**
 * Stagewise additive regression with squared-error loss.
 *
 *   F_0(x) = mean(y)
 *   for m = 1..n_estimators:
 *     residuals = y - F_{m-1}(X)
 *     tree_m fit to residuals
 *     F_m(x) = F_{m-1}(x) + learning_rate * tree_m.predict(x)
 *
 * v0.2 ships squared_error loss only. Subsample / early-stopping /
 * staged_predict / monitor_ deferred to v0.3.
 *
 * Hyperparameters:
 *   - loss              'squared_error' (only)
 *   - learning_rate     (default 0.1)
 *   - n_estimators      (default 100)
 *   - max_depth         (default 3 — weak learners)
 *   - min_samples_split (default 2)
 *   - min_samples_leaf  (default 1)
 *   - max_features      (default null — all features)
 *   - random_state      (int|null)
 */
export class GradientBoostingRegressor extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.loss = params.loss ?? 'squared_error';
    this.learning_rate = params.learning_rate ?? 0.1;
    this.n_estimators = params.n_estimators ?? 100;
    this.max_depth = params.max_depth ?? 3;
    this.min_samples_split = params.min_samples_split ?? 2;
    this.min_samples_leaf = params.min_samples_leaf ?? 1;
    this.max_features = params.max_features ?? null;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_ENSEMBLE;
  }

  fit(X, y, _opts) {
    if (this.loss !== 'squared_error') {
      throw new ValidationError(
        `GradientBoostingRegressor: loss='${this.loss}' not supported in v0.2 (use 'squared_error')`);
    }
    const { data, shape } = asMatrix(X);
    const yv = asVector(y);
    const [n, m] = shape;
    if (yv.length !== n) {
      throw new ValidationError(
        `GradientBoostingRegressor.fit: y length ${yv.length} != n_samples ${n}`);
    }
    // Init = mean(y).
    let init_value = 0;
    for (let i = 0; i < n; i++) init_value += yv[i];
    init_value /= n;
    // Working predictions F_m(x_i) — start at init_value.
    const F = new Float64Array(n);
    F.fill(init_value);
    const baseSeed = this.random_state == null
      ? Math.floor(Math.random() * 0x7fffffff)
      : this.random_state;
    const rng = mulberry32(baseSeed);

    const estimators = [];
    const train_score = new Float64Array(this.n_estimators);

    for (let stage = 0; stage < this.n_estimators; stage++) {
      // Residuals = -gradient of squared error / 2 = y - F.
      const residuals = new Float64Array(n);
      for (let i = 0; i < n; i++) residuals[i] = yv[i] - F[i];

      const tree_seed = (rng() * 0x7fffffff) | 0;
      const tree = new DecisionTreeRegressor({
        criterion: 'squared_error',
        splitter: 'best',
        max_depth: this.max_depth,
        min_samples_split: this.min_samples_split,
        min_samples_leaf: this.min_samples_leaf,
        max_features: this.max_features,
        random_state: tree_seed,
      });
      tree.fit(X, residuals);
      const yhat = tree.predict(X);
      // Update F.
      for (let i = 0; i < n; i++) F[i] += this.learning_rate * yhat[i];
      // Track training MSE.
      let mse = 0;
      for (let i = 0; i < n; i++) { const d = yv[i] - F[i]; mse += d * d; }
      train_score[stage] = mse / n;
      estimators.push(tree);
    }

    this.estimators_ = estimators;
    this.init_value_ = init_value;
    this.train_score_ = train_score;
    this.n_features_in_ = m;
    return this;
  }

  predict(X) {
    if (!this.estimators_) throw new ValidationError('GradientBoostingRegressor: not fitted');
    const { shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const n = shape[0];
    const out = new Float64Array(n);
    out.fill(this.init_value_);
    for (const tree of this.estimators_) {
      const yh = tree.predict(X);
      for (let i = 0; i < n; i++) out[i] += this.learning_rate * yh[i];
    }
    return out;
  }

  __sklearn_clone__() {
    return new GradientBoostingRegressor(this.get_params(false));
  }

  _toMimicIo() {
    return _gbEncode(this, 'GradientBoostingRegressor', /* classifier */ false);
  }
  static _fromMimicIo(json, opts = {}) {
    return _gbDecode(GradientBoostingRegressor, json, opts, /* classifier */ false);
  }
}

Object.assign(GradientBoostingRegressor.prototype, RegressorMixin);
GradientBoostingRegressor._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// GradientBoostingClassifier
// ────────────────────────────────────────────────────────────────────

/**
 * Multinomial (or binary) gradient boosting with cross-entropy loss.
 *
 *   F_0[k] = log(prior[k])  (log-prior init)
 *   for m = 1..n_estimators:
 *     for each class k:
 *       p[i, k] = softmax(F_m[i, :])[k]
 *       g[i] = y_one_hot[i, k] - p[i, k]   (negative gradient)
 *       tree_{m,k} fit to g
 *       leaf_value adjustment via Newton step:
 *         γ_l = (K-1)/K * Σ_{i ∈ leaf} g[i] / Σ_{i ∈ leaf} |g[i]|(1-|g[i]|)
 *       F_m[i, k] += learning_rate * γ_{leaf(i)}
 *
 * v0.2 ships log_loss only. We use the simpler per-leaf identity-update
 * (no Newton refinement — slightly slower convergence than sklearn but
 * conceptually clean and adequate for this scale). Trees fit to raw
 * gradients then their predictions are scaled by learning_rate.
 *
 * Fitted: estimators_ (length n_estimators × n_classes when multinomial,
 *         length n_estimators × 1 when binary), classes_, init_value_
 *         (Float64Array of log-priors per class), n_features_in_.
 */
export class GradientBoostingClassifier extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.loss = params.loss ?? 'log_loss';
    this.learning_rate = params.learning_rate ?? 0.1;
    this.n_estimators = params.n_estimators ?? 100;
    this.max_depth = params.max_depth ?? 3;
    this.min_samples_split = params.min_samples_split ?? 2;
    this.min_samples_leaf = params.min_samples_leaf ?? 1;
    this.max_features = params.max_features ?? null;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_ENSEMBLE;
  }

  fit(X, y, _opts) {
    if (this.loss !== 'log_loss') {
      throw new ValidationError(
        `GradientBoostingClassifier: loss='${this.loss}' not supported in v0.2 (use 'log_loss')`);
    }
    const { shape } = asMatrix(X);
    const yv = asVector(y);
    const [n, m] = shape;
    if (yv.length !== n) {
      throw new ValidationError(
        `GradientBoostingClassifier.fit: y length ${yv.length} != n_samples ${n}`);
    }
    const { classes, encoded } = _encodeClassesEnsemble(yv);
    const K = classes.length;
    // Init = log of class priors.
    const counts = new Float64Array(K);
    for (let i = 0; i < n; i++) counts[encoded[i] | 0]++;
    const init_value = new Float64Array(K);
    for (let c = 0; c < K; c++) init_value[c] = Math.log(Math.max(1e-300, counts[c] / n));
    // Working logits F[n, K]. Store flat row-major.
    const F = new Float64Array(n * K);
    for (let i = 0; i < n; i++) for (let c = 0; c < K; c++) F[i * K + c] = init_value[c];
    const baseSeed = this.random_state == null
      ? Math.floor(Math.random() * 0x7fffffff)
      : this.random_state;
    const rng = mulberry32(baseSeed);

    // estimators_ stored as 2D: [n_estimators][K] (binary still has K=2 here
    // — sklearn special-cases binary to use K=1 trees, but K=2 is simpler
    // and the predictions match modulo the softmax normalization).
    const estimators = [];
    const probs = new Float64Array(n * K);
    const grad = new Float64Array(n);

    for (let stage = 0; stage < this.n_estimators; stage++) {
      // Compute softmax probabilities row by row.
      for (let i = 0; i < n; i++) {
        let max = -Infinity;
        for (let c = 0; c < K; c++) if (F[i * K + c] > max) max = F[i * K + c];
        let denom = 0;
        for (let c = 0; c < K; c++) {
          const e = Math.exp(F[i * K + c] - max);
          probs[i * K + c] = e;
          denom += e;
        }
        const inv = 1 / denom;
        for (let c = 0; c < K; c++) probs[i * K + c] *= inv;
      }
      const stage_trees = new Array(K);
      for (let c = 0; c < K; c++) {
        // Gradient = y_one_hot[:, c] - p[:, c]
        for (let i = 0; i < n; i++) {
          grad[i] = ((encoded[i] | 0) === c ? 1 : 0) - probs[i * K + c];
        }
        const tree_seed = (rng() * 0x7fffffff) | 0;
        const tree = new DecisionTreeRegressor({
          criterion: 'squared_error',
          splitter: 'best',
          max_depth: this.max_depth,
          min_samples_split: this.min_samples_split,
          min_samples_leaf: this.min_samples_leaf,
          max_features: this.max_features,
          random_state: tree_seed,
        });
        tree.fit(X, grad);
        stage_trees[c] = tree;
      }
      // Apply this stage's trees to F.
      for (let c = 0; c < K; c++) {
        const yh = stage_trees[c].predict(X);
        for (let i = 0; i < n; i++) F[i * K + c] += this.learning_rate * yh[i];
      }
      estimators.push(stage_trees);
    }

    this.estimators_ = estimators;
    this.classes_ = classes;
    this.n_classes_ = K;
    this.init_value_ = init_value;
    this.n_features_in_ = m;
    return this;
  }

  decision_function(X) {
    if (!this.estimators_) throw new ValidationError('GradientBoostingClassifier: not fitted');
    const { shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const n = shape[0];
    const K = this.n_classes_;
    const out = new Float64Array(n * K);
    for (let i = 0; i < n; i++) for (let c = 0; c < K; c++) out[i * K + c] = this.init_value_[c];
    for (const stage_trees of this.estimators_) {
      for (let c = 0; c < K; c++) {
        const yh = stage_trees[c].predict(X);
        for (let i = 0; i < n; i++) out[i * K + c] += this.learning_rate * yh[i];
      }
    }
    out.shape = [n, K];
    return out;
  }

  predict_proba(X) {
    const F = this.decision_function(X);
    const n = F.length / this.n_classes_;
    const K = this.n_classes_;
    const out = new Float64Array(n * K);
    for (let i = 0; i < n; i++) {
      let max = -Infinity;
      for (let c = 0; c < K; c++) if (F[i * K + c] > max) max = F[i * K + c];
      let denom = 0;
      for (let c = 0; c < K; c++) {
        const e = Math.exp(F[i * K + c] - max);
        out[i * K + c] = e;
        denom += e;
      }
      const inv = 1 / denom;
      for (let c = 0; c < K; c++) out[i * K + c] *= inv;
    }
    out.shape = [n, K];
    return out;
  }

  predict(X) {
    const P = this.predict_proba(X);
    const K = this.n_classes_;
    const n = P.length / K;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0, bestP = -1;
      for (let c = 0; c < K; c++) {
        if (P[i * K + c] > bestP) { best = c; bestP = P[i * K + c]; }
      }
      out[i] = this.classes_[best];
    }
    return out;
  }

  __sklearn_clone__() {
    return new GradientBoostingClassifier(this.get_params(false));
  }

  _toMimicIo() {
    return _gbEncode(this, 'GradientBoostingClassifier', /* classifier */ true);
  }
  static _fromMimicIo(json, opts = {}) {
    return _gbDecode(GradientBoostingClassifier, json, opts, /* classifier */ true);
  }
}

Object.assign(GradientBoostingClassifier.prototype, ClassifierMixin);
GradientBoostingClassifier._estimator_type = 'classifier';

// ────────────────────────────────────────────────────────────────────
// GradientBoosting helpers
// ────────────────────────────────────────────────────────────────────

function _encodeClassesEnsemble(yv) {
  const seen = new Map();
  const order = [];
  for (let i = 0; i < yv.length; i++) {
    const v = yv[i];
    if (!seen.has(v)) { seen.set(v, true); order.push(v); }
  }
  order.sort((a, b) => a - b);
  const idx = new Map();
  for (let c = 0; c < order.length; c++) idx.set(order[c], c);
  const encoded = new Float64Array(yv.length);
  for (let i = 0; i < yv.length; i++) encoded[i] = idx.get(yv[i]);
  return { classes: Float64Array.from(order), encoded };
}

function _gbEncode(est, class_name, classifier) {
  const params = est.get_params(false);
  const out = {
    format: 'mimic-io',
    version: 2,
    class: class_name,
    module: est._module,
    params,
  };
  if (est.estimators_) {
    if (classifier) {
      // estimators_ is [n_estimators][n_classes].
      out.fitted = {
        estimators_: est.estimators_.map(stage => stage.map(t => dump(t))),
        classes_: Array.from(est.classes_),
        n_classes_: est.n_classes_,
        init_value_: Array.from(est.init_value_),
        n_features_in_: est.n_features_in_,
      };
    } else {
      out.fitted = {
        estimators_: est.estimators_.map(t => dump(t)),
        init_value_: est.init_value_,
        n_features_in_: est.n_features_in_,
      };
      if (est.train_score_) out.fitted.train_score_ = Array.from(est.train_score_);
    }
  } else {
    out.fitted = null;
  }
  return out;
}

function _gbDecode(Ctor, json, opts, classifier) {
  const inst = new Ctor(json.params ?? {});
  if (!json.fitted) return inst;
  inst.n_features_in_ = json.fitted.n_features_in_;
  if (classifier) {
    inst.estimators_ = (json.fitted.estimators_ ?? []).map(
      stage => stage.map(j => load(j, opts)));
    inst.classes_ = Float64Array.from(json.fitted.classes_);
    inst.n_classes_ = json.fitted.n_classes_;
    inst.init_value_ = Float64Array.from(json.fitted.init_value_);
  } else {
    inst.estimators_ = (json.fitted.estimators_ ?? []).map(j => load(j, opts));
    inst.init_value_ = json.fitted.init_value_;
    if (json.fitted.train_score_) inst.train_score_ = Float64Array.from(json.fitted.train_score_);
  }
  return inst;
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('RandomForestClassifier', RandomForestClassifier, { module: MODULE_ID_ENSEMBLE });
learnRegistry.register('RandomForestRegressor', RandomForestRegressor, { module: MODULE_ID_ENSEMBLE });
learnRegistry.register('ExtraTreesClassifier', ExtraTreesClassifier, { module: MODULE_ID_ENSEMBLE });
learnRegistry.register('ExtraTreesRegressor', ExtraTreesRegressor, { module: MODULE_ID_ENSEMBLE });
learnRegistry.register('BaggingClassifier', BaggingClassifier, { module: MODULE_ID_ENSEMBLE });
learnRegistry.register('BaggingRegressor', BaggingRegressor, { module: MODULE_ID_ENSEMBLE });
learnRegistry.register('GradientBoostingClassifier', GradientBoostingClassifier, { module: MODULE_ID_ENSEMBLE });
learnRegistry.register('GradientBoostingRegressor', GradientBoostingRegressor, { module: MODULE_ID_ENSEMBLE });
