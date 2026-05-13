import { silhouette_score } from './metrics.js';

// BaseEstimator + mixins + clone + check_is_fitted.
//
// Mirrors scikit-learn's `sklearn.base` to the letter, modulo the four
// JS-imposed deviations listed in SPEC-learn §3.6:
//   1. No keyword arguments — fit/predict take a trailing options object.
//   2. No pickle — dump/load go through @gcu/mimic-io.
//   3. No scipy.sparse — dense ndarrays only.
//   4. random_state accepts integer or null only.
//
// Hyperparameter convention. sklearn introspects the constructor signature
// to know what the hyperparameters are. JS doesn't expose that without
// transpilation, so we use a property-based convention:
//
//   - Hyperparameters are own enumerable properties with no leading or
//     trailing underscore. The constructor sets them, never modifies them
//     thereafter.
//   - Fitted attributes have a trailing underscore (mean_, coef_, tree_,
//     n_features_in_, etc.). check_is_fitted scans for at least one.
//   - Internal state has a leading underscore (_predict_interpreted, etc.)
//     and is preserved by clone but not exposed in get_params or
//     check_is_fitted.
//
// Estimators that need explicit control over what get_params returns set
// `static _param_keys = [...]` on the class. Useful when an estimator
// stores derived/cached values on `this` for hot-path lookup.

// ────────────────────────────────────────────────────────────────────
// NotFittedError
// ────────────────────────────────────────────────────────────────────

export class NotFittedError extends Error {
  constructor(estimator_or_name) {
    const name = typeof estimator_or_name === 'string'
      ? estimator_or_name
      : estimator_or_name?.constructor?.name ?? 'estimator';
    super(
      `This ${name} instance is not fitted yet. Call 'fit' with appropriate ` +
      `arguments before using this estimator.`,
    );
    this.name = 'NotFittedError';
  }
}

// ────────────────────────────────────────────────────────────────────
// BaseEstimator
// ────────────────────────────────────────────────────────────────────

export class BaseEstimator {
  /**
   * Return the hyperparameter dict.
   *
   * @param {boolean} [deep=true] — when true, recursively expands nested
   *   estimator hyperparameters using the dotted double-underscore notation
   *   (`pipeline__step__param`). When false, returns only the top-level
   *   hyperparameters with nested estimators as opaque references.
   */
  get_params(deep = true) {
    const keys = _paramKeys(this);
    const out = {};
    for (const key of keys) {
      const v = this[key];
      out[key] = v;
      if (deep && _isEstimator(v) && typeof v.get_params === 'function') {
        const sub = v.get_params(true);
        for (const sk of Object.keys(sub)) {
          out[`${key}__${sk}`] = sub[sk];
        }
      }
    }
    return out;
  }

  /**
   * Set hyperparameters in place. Returns this for chaining.
   *
   * Accepts dotted double-underscore notation for nested estimators
   * (`{ 'forest__max_depth': 8 }`), splitting on `__` and walking the
   * nested structure to call set_params on the right sub-estimator.
   */
  set_params(params) {
    if (params == null) return this;
    const valid = new Set(_paramKeys(this));

    // Group nested params by their root key to avoid re-walking for each
    // sub-key (a Pipeline with 5 params on the same step shouldn't dispatch
    // 5 times).
    const direct = {};
    const nested = {};
    for (const key of Object.keys(params)) {
      const idx = key.indexOf('__');
      if (idx === -1) {
        direct[key] = params[key];
      } else {
        const root = key.slice(0, idx);
        const sub = key.slice(idx + 2);
        if (!nested[root]) nested[root] = {};
        nested[root][sub] = params[key];
      }
    }

    for (const key of Object.keys(direct)) {
      if (!valid.has(key)) {
        throw new Error(
          `Invalid parameter '${key}' for estimator ${this.constructor.name}. ` +
          `Valid parameters are: ${[...valid].sort().join(', ')}.`,
        );
      }
      this[key] = direct[key];
    }

    for (const root of Object.keys(nested)) {
      if (!valid.has(root)) {
        throw new Error(
          `Invalid parameter '${root}' for estimator ${this.constructor.name}. ` +
          `Valid parameters are: ${[...valid].sort().join(', ')}.`,
        );
      }
      const sub = this[root];
      if (!_isEstimator(sub) || typeof sub.set_params !== 'function') {
        throw new Error(
          `Parameter '${root}' on ${this.constructor.name} is not an estimator; ` +
          `cannot set nested params on it.`,
        );
      }
      sub.set_params(nested[root]);
    }

    return this;
  }

  /**
   * Capability flags. Subclasses override to set tags. The base returns the
   * sklearn-default tag dict; mixins override individual flags.
   */
  __sklearn_tags__() {
    return {
      requires_y: false,
      allow_nan: false,
      binary_only: false,
      multioutput: false,
      pairwise: false,
      requires_positive_X: false,
      requires_positive_y: false,
      non_deterministic: false,
      poor_score: false,
      no_validation: false,
      stateless: false,
      // Set by mixins when they apply. Estimators inheriting from no
      // mixin (e.g. raw transformers extending BaseEstimator directly)
      // get an empty estimator_type and check_estimator falls back to
      // probing `_estimator_type` on the class.
      estimator_type: this.constructor._estimator_type ?? null,
    };
  }

  /**
   * Default fit_transform: fit then transform, threading the same opts
   * object through both. Subclasses override only when there's a fused
   * implementation that's faster than sequential.
   */
  fit_transform(X, y, opts) {
    if (typeof this.transform !== 'function') {
      throw new Error(
        `${this.constructor.name} does not implement transform(); cannot ` +
        `default-implement fit_transform.`,
      );
    }
    return this.fit(X, y, opts).transform(X);
  }

  /**
   * Opt-in JIT-compile for performance per SPEC §6.5. No-op default —
   * tree-family estimators (DecisionTree*, RandomForest*, ExtraTrees*,
   * GradientBoosting*) override to compile their fitted trees into JS
   * functions and rewire predict/predict_proba to dispatch through them.
   *
   * Returns this for chaining: est.fit(X, y).compile().predict(X).
   */
  compile() {
    return this;
  }

  /** Stable string identity for debugging and registry lookup. */
  toString() {
    const params = this.get_params(false);
    const parts = Object.keys(params).sort().map(k => {
      const v = params[k];
      if (v == null) return `${k}=null`;
      if (typeof v === 'string') return `${k}='${v}'`;
      if (typeof v === 'object') return `${k}=<${v.constructor?.name ?? 'object'}>`;
      return `${k}=${v}`;
    });
    return `${this.constructor.name}(${parts.join(', ')})`;
  }
}

BaseEstimator._estimator_type = null;

// ────────────────────────────────────────────────────────────────────
// Mixins
// ────────────────────────────────────────────────────────────────────
//
// JS doesn't have multiple inheritance, but sklearn's mixins are just bags
// of methods + a tag override. We expose them as helpers that subclasses
// invoke explicitly:
//
//   class StandardScaler extends BaseEstimator {
//     static _estimator_type = 'transformer';
//     // ... fit/transform ...
//   }
//   Object.assign(StandardScaler.prototype, TransformerMixin);
//
// The tag override and default scorer come along for free.

export const ClassifierMixin = {
  /** Mean accuracy on (X, y). */
  score(X, y, opts) {
    const yhat = this.predict(X);
    return _accuracy(asArray1d(y), asArray1d(yhat), opts?.sample_weight);
  },
  /**
   * log of predict_proba, clipped to avoid -Infinity on zero-probability cells.
   * Subclasses with a more accurate log-domain pathway (e.g. GMM via
   * log-responsibilities) override; the default works for any classifier
   * that exposes predict_proba.
   */
  predict_log_proba(X) {
    if (typeof this.predict_proba !== 'function') {
      throw new Error(
        `${this.constructor.name}.predict_log_proba: predict_proba not implemented`);
    }
    const proba = this.predict_proba(X);
    return _logProbaInPlace(proba);
  },
  __sklearn_tags__() {
    const base = BaseEstimator.prototype.__sklearn_tags__.call(this);
    return { ...base, requires_y: true, estimator_type: 'classifier' };
  },
};

export const RegressorMixin = {
  /** R² coefficient of determination. */
  score(X, y, opts) {
    const yhat = this.predict(X);
    return _r2(asArray1d(y), asArray1d(yhat), opts?.sample_weight);
  },
  __sklearn_tags__() {
    const base = BaseEstimator.prototype.__sklearn_tags__.call(this);
    return { ...base, requires_y: true, estimator_type: 'regressor' };
  },
};

export const TransformerMixin = {
  /**
   * Default fit_transform — overridden here because TransformerMixin's
   * version threads through the y argument when fit accepts it. (Most
   * transformers ignore y; some — TargetEncoder, supervised PCA — don't.)
   */
  fit_transform(X, y, opts) {
    return this.fit(X, y, opts).transform(X);
  },
  __sklearn_tags__() {
    const base = BaseEstimator.prototype.__sklearn_tags__.call(this);
    return { ...base, requires_y: false, estimator_type: 'transformer' };
  },
};

export const ClusterMixin = {
  /**
   * Default scorer for clusterers is silhouette over the fitted labels.
   * Implementations override when a non-silhouette default makes sense
   * (GaussianMixture overrides with average log-likelihood).
   *
   * Returns NaN when fewer than 2 distinct clusters survive noise filtering
   * (sklearn behaviour: silhouette is undefined for a single-cluster
   * partition). y is ignored — silhouette is unsupervised.
   */
  score(X, _y, _opts) {
    if (this.labels_ == null) {
      throw new Error(`${this.constructor.name}.score: not fitted`);
    }
    // Use fresh predictions for X if predict is available (e.g. KMeans on
    // held-out data). For partition-only clusterers (Agglomerative, DBSCAN)
    // the score is over fit_predict, which is the labels we already have.
    const labels = typeof this.predict === 'function'
      ? this.predict(X)
      : this.labels_;
    return silhouette_score(X, labels);
  },
  fit_predict(X, y, opts) {
    return this.fit(X, y, opts).labels_;
  },
  __sklearn_tags__() {
    const base = BaseEstimator.prototype.__sklearn_tags__.call(this);
    return { ...base, requires_y: false, estimator_type: 'clusterer' };
  },
};

// ────────────────────────────────────────────────────────────────────
// clone
// ────────────────────────────────────────────────────────────────────

/**
 * Build a fresh, unfitted copy of `estimator` with the same hyperparameters.
 *
 * Recursively clones nested-estimator hyperparameters (the Pipeline case).
 * Non-estimator hyperparameters are deep-copied if they're plain
 * arrays/objects/typed arrays; primitives pass through by value.
 *
 * Estimators with custom cloning needs override `__sklearn_clone__()` to
 * return a fresh instance directly.
 */
export function clone(estimator) {
  if (estimator == null) return estimator;
  if (Array.isArray(estimator)) return estimator.map(clone);
  if (typeof estimator !== 'object') return estimator;

  // Override hook (spec §3.6).
  if (typeof estimator.__sklearn_clone__ === 'function') {
    return estimator.__sklearn_clone__();
  }

  // Estimator: recreate via constructor with cloned params.
  if (_isEstimator(estimator)) {
    const Ctor = estimator.constructor;
    const params = estimator.get_params(false);
    const clonedParams = {};
    for (const key of Object.keys(params)) {
      clonedParams[key] = clone(params[key]);
    }
    return new Ctor(clonedParams);
  }

  // Plain object / typed array — deep-copy.
  if (ArrayBuffer.isView(estimator) && !(estimator instanceof DataView)) {
    return new estimator.constructor(estimator);
  }
  // Plain object: copy own enumerable keys recursively.
  const out = {};
  for (const k of Object.keys(estimator)) out[k] = clone(estimator[k]);
  return out;
}

// ────────────────────────────────────────────────────────────────────
// check_is_fitted
// ────────────────────────────────────────────────────────────────────

/**
 * Raise NotFittedError if `estimator` is not fitted.
 *
 * Default: scan for any own enumerable trailing-underscore attribute.
 * Estimators that need a different signal (e.g. a fitted attribute that
 * doesn't end in `_`) override `__sklearn_is_fitted__()` to return a bool.
 */
export function check_is_fitted(estimator, attributes = null) {
  if (estimator == null || typeof estimator !== 'object') {
    throw new TypeError('check_is_fitted: input is not an estimator');
  }
  // Override hook (spec §3.6).
  if (typeof estimator.__sklearn_is_fitted__ === 'function') {
    if (estimator.__sklearn_is_fitted__()) return;
    throw new NotFittedError(estimator);
  }
  // Specific attribute(s) requested.
  if (attributes != null) {
    const names = Array.isArray(attributes) ? attributes : [attributes];
    for (const name of names) {
      if (estimator[name] === undefined || estimator[name] === null) {
        throw new NotFittedError(estimator);
      }
    }
    return;
  }
  // Default: any trailing-underscore attribute counts.
  for (const k of Object.keys(estimator)) {
    if (k.endsWith('_') && !k.startsWith('_')) return;
  }
  throw new NotFittedError(estimator);
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

// Resolve the hyperparameter key list. Either explicit via static
// _param_keys, or convention-based (own enumerable, no leading/trailing
// underscore).
function _paramKeys(est) {
  const Ctor = est.constructor;
  if (Ctor && Array.isArray(Ctor._param_keys)) return Ctor._param_keys;
  const out = [];
  for (const k of Object.keys(est)) {
    if (k.startsWith('_') || k.endsWith('_')) continue;
    out.push(k);
  }
  return out;
}

// Heuristic: object with a get_params method is an estimator.
function _isEstimator(v) {
  return v != null && typeof v === 'object' && typeof v.get_params === 'function';
}

// Mixin score-helpers operate on plain 1D arrays. Coerce typed arrays /
// nested arrays into a flat numeric array. Tolerant — used in score()
// where input has already been validated by predict().
function asArray1d(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (ArrayBuffer.isView(v)) return Array.from(v);
  return [v];
}

function _accuracy(y_true, y_pred, weights) {
  const n = y_true.length;
  if (n === 0) return 0;
  if (weights == null) {
    let hits = 0;
    for (let i = 0; i < n; i++) if (y_true[i] === y_pred[i]) hits++;
    return hits / n;
  }
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const w = +weights[i];
    den += w;
    if (y_true[i] === y_pred[i]) num += w;
  }
  return den === 0 ? 0 : num / den;
}

// log of a row-major Float64Array with .shape, clipped at 1e-12 to avoid
// -Infinity. Returns a fresh Float64Array with the same shape.
function _logProbaInPlace(proba) {
  const out = new Float64Array(proba.length);
  for (let i = 0; i < proba.length; i++) {
    const p = proba[i];
    out[i] = p < 1e-12 ? Math.log(1e-12) : Math.log(p);
  }
  if (proba.shape) out.shape = proba.shape.slice();
  return out;
}

function _r2(y_true, y_pred, weights) {
  const n = y_true.length;
  if (n === 0) return 0;
  let mean = 0, w_sum = 0;
  if (weights == null) {
    for (let i = 0; i < n; i++) mean += y_true[i];
    mean /= n; w_sum = n;
  } else {
    for (let i = 0; i < n; i++) {
      const w = +weights[i];
      mean += w * y_true[i];
      w_sum += w;
    }
    mean = w_sum === 0 ? 0 : mean / w_sum;
  }
  let ss_res = 0, ss_tot = 0;
  if (weights == null) {
    for (let i = 0; i < n; i++) {
      const d = y_true[i] - y_pred[i];
      const t = y_true[i] - mean;
      ss_res += d * d;
      ss_tot += t * t;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const w = +weights[i];
      const d = y_true[i] - y_pred[i];
      const t = y_true[i] - mean;
      ss_res += w * d * d;
      ss_tot += w * t * t;
    }
  }
  if (ss_tot === 0) return ss_res === 0 ? 1 : 0;
  return 1 - ss_res / ss_tot;
}
