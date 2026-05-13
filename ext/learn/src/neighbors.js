// k-Nearest Neighbors — KNeighborsClassifier + KNeighborsRegressor.
//
// Backed by @gcu/scitra's KDTree (no re-implementation; reuse the
// existing well-tested spatial index). The tree is rebuilt from
// `fit_X_` on load — KDTree itself isn't serializable, but the
// underlying point cloud is.
//
// Distance metric: Euclidean only in v0.2 (KDTree's default and only
// metric). Manhattan / Chebyshev / Minkowski deferred — they need a
// different KDTree implementation that's not currently in scitra.

import { BaseEstimator, ClassifierMixin, RegressorMixin } from './base.js';
import { dump, load, learnRegistry } from './serialize.js';
import { asMatrix, asVector, checkNFeatures, captureFeatureNames, ValidationError } from './util/checks.js';
// Cross-package: scitra's KDTree.
import { KDTree } from '../../scitra/index.js';

const MODULE_ID_NEIGHBORS = '@gcu/learn.neighbors';

// ────────────────────────────────────────────────────────────────────
// KNeighborsClassifier
// ────────────────────────────────────────────────────────────────────

/**
 * Classifier based on k nearest training samples (Euclidean distance).
 *
 * Hyperparameters:
 *   - n_neighbors  (int, default 5)
 *   - weights      ('uniform' | 'distance', default 'uniform')
 *
 * Fitted attributes: fit_X_, fit_y_ (encoded), classes_,
 *                    n_features_in_, _kdtree (rebuilt on load).
 *
 * predict_proba returns a normalized class-frequency table over the
 * k-NN neighborhood (uniform-weighted; distance-weighted variant
 * accumulates inverse-distance weights instead).
 */
export class KNeighborsClassifier extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_neighbors = params.n_neighbors ?? 5;
    this.weights = params.weights ?? 'uniform';
    this._module = MODULE_ID_NEIGHBORS;
  }

  fit(X, y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const yv = asVector(y);
    const [n, m] = shape;
    if (yv.length !== n) {
      throw new ValidationError(
        `KNeighborsClassifier.fit: y length ${yv.length} != n_samples ${n}`);
    }
    const { classes, encoded } = _encodeClasses(yv);
    this.fit_X_ = new Float64Array(data);
    this.fit_y_ = encoded;
    this.classes_ = classes;
    this.n_features_in_ = m;
    this._kdtree = _buildKDTree(this.fit_X_, n, m);
    captureFeatureNames(this, X_info);
    return this;
  }

  predict(X) {
    const proba = this.predict_proba(X);
    const k = this.classes_.length;
    const n = proba.length / k;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0, bestP = -1;
      for (let c = 0; c < k; c++) {
        if (proba[i * k + c] > bestP) { best = c; bestP = proba[i * k + c]; }
      }
      out[i] = this.classes_[best];
    }
    return out;
  }

  predict_proba(X) {
    if (this._kdtree == null) throw new ValidationError('KNeighborsClassifier: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const k = Math.min(this.n_neighbors, this._kdtree.n);
    const K = this.classes_.length;
    // Batch-query KDTree.
    const points = _toRowArray(data, n, m);
    const { dist, idx } = this._kdtree.queryBatch(points, k);
    const out = new Float64Array(n * K);
    for (let i = 0; i < n; i++) {
      let total = 0;
      for (let r = 0; r < k; r++) {
        const ni = idx[i * k + r];
        const c = this.fit_y_[ni] | 0;
        const w = this.weights === 'distance'
          ? (dist[i * k + r] === 0 ? 1e12 : 1 / dist[i * k + r])
          : 1;
        out[i * K + c] += w;
        total += w;
      }
      const inv = total === 0 ? 0 : 1 / total;
      for (let c = 0; c < K; c++) out[i * K + c] *= inv;
    }
    out.shape = [n, K];
    return out;
  }

  __sklearn_clone__() {
    return new KNeighborsClassifier(this.get_params(false));
  }

  _toMimicIo() {
    return _knnEncode(this, 'KNeighborsClassifier', /* classifier */ true);
  }

  static _fromMimicIo(json, opts = {}) {
    return _knnDecode(KNeighborsClassifier, json, opts, /* classifier */ true);
  }
}

Object.assign(KNeighborsClassifier.prototype, ClassifierMixin);
KNeighborsClassifier._estimator_type = 'classifier';

// ────────────────────────────────────────────────────────────────────
// KNeighborsRegressor
// ────────────────────────────────────────────────────────────────────

export class KNeighborsRegressor extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_neighbors = params.n_neighbors ?? 5;
    this.weights = params.weights ?? 'uniform';
    this._module = MODULE_ID_NEIGHBORS;
  }

  fit(X, y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const yv = asVector(y);
    const [n, m] = shape;
    if (yv.length !== n) {
      throw new ValidationError(
        `KNeighborsRegressor.fit: y length ${yv.length} != n_samples ${n}`);
    }
    this.fit_X_ = new Float64Array(data);
    this.fit_y_ = new Float64Array(yv);
    this.n_features_in_ = m;
    this._kdtree = _buildKDTree(this.fit_X_, n, m);
    captureFeatureNames(this, X_info);
    return this;
  }

  predict(X) {
    if (this._kdtree == null) throw new ValidationError('KNeighborsRegressor: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const k = Math.min(this.n_neighbors, this._kdtree.n);
    const points = _toRowArray(data, n, m);
    const { dist, idx } = this._kdtree.queryBatch(points, k);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (this.weights === 'distance') {
        let num = 0, den = 0;
        for (let r = 0; r < k; r++) {
          const w = dist[i * k + r] === 0 ? 1e12 : 1 / dist[i * k + r];
          num += w * this.fit_y_[idx[i * k + r]];
          den += w;
        }
        out[i] = den === 0 ? 0 : num / den;
      } else {
        let s = 0;
        for (let r = 0; r < k; r++) s += this.fit_y_[idx[i * k + r]];
        out[i] = s / k;
      }
    }
    return out;
  }

  __sklearn_clone__() {
    return new KNeighborsRegressor(this.get_params(false));
  }

  _toMimicIo() {
    return _knnEncode(this, 'KNeighborsRegressor', /* classifier */ false);
  }

  static _fromMimicIo(json, opts = {}) {
    return _knnDecode(KNeighborsRegressor, json, opts, /* classifier */ false);
  }
}

Object.assign(KNeighborsRegressor.prototype, RegressorMixin);
KNeighborsRegressor._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

// Build a KDTree from a flat Float64Array. KDTree's constructor expects
// either an array of arrays OR a flat Float64Array with an opts object
// declaring n + d. We use the array-of-arrays path for simplicity.
function _buildKDTree(data, n, m) {
  return new KDTree(_toRowArray(data, n, m));
}

// Reshape a flat Float64Array (length n*m) into an array of m-length rows.
function _toRowArray(data, n, m) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(m);
    const off = i * m;
    for (let j = 0; j < m; j++) row[j] = data[off + j];
    rows[i] = row;
  }
  return rows;
}

function _encodeClasses(yv) {
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

// mimic-io codec: save the fit point cloud + targets; rebuild the
// KDTree on load (KDTree itself isn't serializable — it's an in-memory
// index over the points).
function _knnEncode(est, class_name, classifier) {
  const params = est.get_params(false);
  const out = {
    format: 'mimic-io',
    version: 2,
    class: class_name,
    module: est._module,
    params,
  };
  if (est.fit_X_) {
    out.fitted = {
      fit_X_: est.fit_X_,
      fit_y_: est.fit_y_,
      n_features_in_: est.n_features_in_,
    };
    if (classifier) out.fitted.classes_ = Array.from(est.classes_);
  } else {
    out.fitted = null;
  }
  return out;
}

function _knnDecode(Ctor, json, opts, classifier) {
  const inst = new Ctor(json.params ?? {});
  if (json.fitted) {
    inst.fit_X_ = json.fitted.fit_X_;  // already a Float64Array post-mimic-io decode
    inst.fit_y_ = json.fitted.fit_y_;
    inst.n_features_in_ = json.fitted.n_features_in_;
    if (classifier) inst.classes_ = Float64Array.from(json.fitted.classes_);
    const n = inst.fit_X_.length / inst.n_features_in_;
    inst._kdtree = _buildKDTree(inst.fit_X_, n, inst.n_features_in_);
  }
  return inst;
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('KNeighborsClassifier', KNeighborsClassifier, { module: MODULE_ID_NEIGHBORS });
learnRegistry.register('KNeighborsRegressor', KNeighborsRegressor, { module: MODULE_ID_NEIGHBORS });
