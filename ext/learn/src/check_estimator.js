// check_estimator — the conformance gate.
//
// JS port of scikit-learn's `sklearn.utils.estimator_checks.check_estimator`,
// scoped to the contract @gcu/learn promises (SPEC-learn §3.6). Every
// estimator that ships in @gcu/learn must pass it. Users implementing
// custom estimators against the BaseEstimator contract should also run it.
//
// What it checks (one method per check, in stable order):
//
//   1. Construction stores only hyperparameters, no fitted attrs.
//   2. __sklearn_tags__() returns the documented shape.
//   3. _estimator_type is one of the known values.
//   4. get_params(false) round-trips through set_params.
//   5. clone() returns an independent unfitted instance with same params.
//   6. fit(X, y) returns this.
//   7. fit produces at least one trailing-underscore attribute.
//   8. check_is_fitted raises before fit and passes after.
//   9. transform / predict / predict_proba shapes match conventions.
//  10. predict_proba rows sum to one (classifiers).
//  11. score returns a finite number.
//  12. dump → load preserves predictions exactly on a held-out batch.
//  13. predicting on different n_features raises a clear error.
//  14. fitting on NaN raises ValidationError when allow_nan=false.
//
// Usage:
//   check_estimator(new StandardScaler());                   // throw on first
//   check_estimator(StandardScaler);                         // ctor form too
//   const errs = check_estimator(est, { collect: true });    // collect all

import { clone, check_is_fitted, NotFittedError } from './base.js';
import { dump, load } from './serialize.js';
import { mulberry32 } from './util/random.js';

const VALID_ESTIMATOR_TYPES = new Set([
  'classifier', 'regressor', 'transformer', 'clusterer', 'density_estimator', null,
]);

const VALID_TAG_KEYS = new Set([
  'requires_y', 'allow_nan', 'binary_only', 'multioutput',
  'pairwise', 'requires_positive_X', 'requires_positive_y',
  'non_deterministic', 'poor_score', 'no_validation', 'stateless',
  'estimator_type',
]);

/**
 * Run the conformance suite against an estimator (or an estimator class).
 *
 * @param {object|Function} target — an estimator instance, or its class
 * @param {object} [opts]
 * @param {boolean} [opts.collect=false] — return list of violations
 *   instead of throwing on first failure
 * @param {number}  [opts.seed=42]       — RNG seed for synthetic data
 * @param {number}  [opts.n_samples=30]  — synthetic sample count
 * @param {number}  [opts.n_features=4]  — synthetic feature count
 * @param {number}  [opts.n_classes=3]   — synthetic class count (classifiers)
 * @returns {string[]|undefined} list of violations (when collect=true)
 */
export function check_estimator(target, opts = {}) {
  const { collect = false, seed = 42 } = opts;
  const errors = [];
  const fail = (check, msg) => {
    const line = `${check}: ${msg}`;
    if (collect) errors.push(line);
    else throw new Error(`check_estimator: ${line}`);
  };

  // Resolve to fresh instance + class.
  const Ctor = typeof target === 'function' ? target : target.constructor;
  let est0;
  try {
    est0 = typeof target === 'function' ? new target() : clone(target);
  } catch (e) {
    fail('construct', `default-construction failed: ${e.message}`);
    return collect ? errors : undefined;
  }

  // 1. Construction stores only hyperparameters.
  for (const k of Object.keys(est0)) {
    if (k.endsWith('_') && !k.startsWith('_')) {
      fail('construct', `fitted attribute '${k}' present after construction`);
    }
  }

  // 2. __sklearn_tags__ shape.
  let tags;
  try { tags = est0.__sklearn_tags__(); }
  catch (e) { fail('tags', `__sklearn_tags__ threw: ${e.message}`); return _ret(collect, errors); }
  if (tags == null || typeof tags !== 'object') {
    fail('tags', '__sklearn_tags__ must return an object');
    return _ret(collect, errors);
  }
  for (const k of Object.keys(tags)) {
    if (!VALID_TAG_KEYS.has(k)) {
      fail('tags', `unknown tag key '${k}' (typo? see SPEC §3.6 for valid keys)`);
    }
  }

  // 3. estimator_type valid.
  const etype = tags.estimator_type ?? Ctor._estimator_type ?? null;
  if (!VALID_ESTIMATOR_TYPES.has(etype)) {
    fail('tags', `unknown estimator_type '${etype}'`);
  }

  // 4. get_params round-trip via set_params.
  const params0 = est0.get_params(false);
  try {
    const est_round = new Ctor(params0);
    const params1 = est_round.get_params(false);
    for (const k of Object.keys(params0)) {
      if (!_paramEquals(params0[k], params1[k])) {
        fail('get_params', `param '${k}' differs after constructor round-trip`);
      }
    }
  } catch (e) {
    fail('get_params', `round-trip failed: ${e.message}`);
  }
  // set_params back-and-forth.
  try {
    const est_set = new Ctor();
    est_set.set_params(params0);
    for (const k of Object.keys(params0)) {
      if (!_paramEquals(params0[k], est_set[k])) {
        fail('set_params', `param '${k}' not assigned by set_params`);
      }
    }
  } catch (e) {
    fail('set_params', `set_params(get_params()) failed: ${e.message}`);
  }

  // 5. clone independence.
  try {
    const c = clone(est0);
    if (c === est0) fail('clone', 'returned same object reference');
    const before = est0.get_params(false);
    // Mutate only if there's a finite numeric param to perturb. Skip NaN
    // (sentinel for missing_values etc.) since NaN+1=NaN and NaN!==NaN
    // would falsely report a clone leak.
    for (const k of Object.keys(before)) {
      if (typeof before[k] === 'number' && Number.isFinite(before[k])) {
        c[k] = before[k] + 1;
        if (est0[k] !== before[k]) {
          fail('clone', `mutating clone's '${k}' affected the original`);
        }
        break;
      }
    }
  } catch (e) {
    fail('clone', `clone failed: ${e.message}`);
  }

  // 6-14: data-driven checks. Skip when the estimator declares it as
  // stateless (no fit) or no_validation (skip data shape checks).
  if (tags.stateless) return _ret(collect, errors);

  const { X, y, X2 } = _makeData({ ...opts, requires_positive_X: tags.requires_positive_X }, etype);
  const est = clone(est0);

  // 8a. check_is_fitted raises before fit.
  try {
    check_is_fitted(est);
    fail('check_is_fitted', 'did not raise NotFittedError before fit');
  } catch (e) {
    if (!(e instanceof NotFittedError)) {
      fail('check_is_fitted', `raised non-NotFittedError before fit: ${e.message}`);
    }
  }

  // 6. fit returns this.
  let fit_result;
  try { fit_result = est.fit(X, y); }
  catch (e) { fail('fit', `threw: ${e.message}`); return _ret(collect, errors); }
  if (fit_result !== est) fail('fit', 'did not return this');

  // 7. fit produces at least one trailing-underscore attribute.
  let any_fitted = false;
  for (const k of Object.keys(est)) {
    if (k.endsWith('_') && !k.startsWith('_')) { any_fitted = true; break; }
  }
  if (!any_fitted && typeof est.__sklearn_is_fitted__ !== 'function') {
    fail('fit', 'no trailing-underscore attribute set by fit (and no __sklearn_is_fitted__ override)');
  }

  // 8b. check_is_fitted passes after fit.
  try { check_is_fitted(est); }
  catch (e) { fail('check_is_fitted', `raised after fit: ${e.message}`); }

  // 9. transform / predict shape conventions. Gate on estimator_type so
  // an estimator that exposes both methods (Pipeline) only gets tested
  // against the path appropriate to its role: transformers test
  // transform; classifiers/regressors/clusterers test predict.
  const expects_transform = etype === 'transformer';
  const expects_predict = etype === 'classifier' || etype === 'regressor'
                       || etype === 'clusterer';
  if (expects_transform && typeof est.transform === 'function') {
    try {
      const Xt = est.transform(X2);
      if (!_isMatrix(Xt)) fail('transform', 'output is not a matrix');
      else if (Xt.shape[0] !== X2.shape[0]) {
        fail('transform', `output rows ${Xt.shape[0]} != input rows ${X2.shape[0]}`);
      }
    } catch (e) { fail('transform', `threw: ${e.message}`); }
  }
  if (expects_predict && typeof est.predict === 'function') {
    try {
      const yhat = est.predict(X2);
      if (yhat == null) fail('predict', 'returned null');
      else if (yhat.length !== X2.shape[0]) {
        fail('predict', `output length ${yhat.length} != input rows ${X2.shape[0]}`);
      }
    } catch (e) { fail('predict', `threw: ${e.message}`); }
  }

  // 10. predict_proba rows sum to one (classifiers only).
  if (etype === 'classifier' && typeof est.predict_proba === 'function') {
    try {
      const P = est.predict_proba(X2);
      const n = X2.shape[0];
      const m = (P.shape ?? [n, P.length / n])[1];
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < m; j++) sum += P[i * m + j] ?? P[i]?.[j];
        if (Math.abs(sum - 1) > 1e-6) {
          fail('predict_proba', `row ${i} sums to ${sum}, expected 1.0`);
          break;
        }
      }
    } catch (e) { fail('predict_proba', `threw: ${e.message}`); }
  }

  // 11. score returns a finite number.
  if (typeof est.score === 'function' && y != null) {
    try {
      const s = est.score(X, y);
      if (!Number.isFinite(s)) fail('score', `returned non-finite ${s}`);
    } catch (e) { fail('score', `threw: ${e.message}`); }
  }

  // 12. dump → load round-trip preserves predictions/transforms.
  try {
    const json = dump(est);
    const reloaded = load(json);
    if (expects_predict && typeof est.predict === 'function') {
      const a = est.predict(X2);
      const b = reloaded.predict(X2);
      if (!_arrayCloseExact(a, b)) {
        fail('dump/load', 'predictions differ after round-trip');
      }
    }
    if (expects_transform && typeof est.transform === 'function') {
      const a = est.transform(X2);
      const b = reloaded.transform(X2);
      if (!_arrayCloseExact(a, b)) {
        fail('dump/load', 'transforms differ after round-trip');
      }
    }
  } catch (e) { fail('dump/load', `failed: ${e.message}`); }

  // Resolve which method to drive these data-validation checks against.
  const probe_fn = expects_transform && typeof est.transform === 'function'
    ? (X) => est.transform(X)
    : expects_predict && typeof est.predict === 'function'
    ? (X) => est.predict(X)
    : null;

  // 13. wrong n_features raises.
  if (probe_fn) {
    const wrong_X = { data: new Float64Array(X.shape[0] * (X.shape[1] + 1)),
                      shape: [X.shape[0], X.shape[1] + 1] };
    try {
      probe_fn(wrong_X);
      fail('n_features', 'did not raise on n_features mismatch');
    } catch (_) { /* expected */ }
  }

  // 14. NaN handling per allow_nan tag.
  if (!tags.allow_nan && probe_fn) {
    const nan_X = { data: new Float64Array(X.shape[0] * X.shape[1]),
                    shape: [X.shape[0], X.shape[1]] };
    nan_X.data.set(X.data);
    nan_X.data[0] = NaN;
    try {
      probe_fn(nan_X);
      fail('allow_nan', 'allow_nan=false but accepted NaN input without raising');
    } catch (_) { /* expected */ }
  }

  return _ret(collect, errors);
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function _ret(collect, errors) { return collect ? errors : undefined; }

function _isMatrix(v) {
  if (v == null || typeof v !== 'object') return false;
  if (Array.isArray(v.shape) && v.shape.length === 2) return true;
  if (v.data instanceof Float64Array && Array.isArray(v.shape)) return true;
  return false;
}

function _paramEquals(a, b) {
  if (a === b) return true;
  // NaN-aware equality — sklearn's missing_values=NaN convention runs
  // through this comparator; NaN !== NaN by default.
  if (typeof a === 'number' && typeof b === 'number'
      && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!_paramEquals(a[i], b[i])) return false;
    return true;
  }
  // Object: compare own keys.
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!_paramEquals(a[k], b[k])) return false;
  return true;
}

function _arrayCloseExact(a, b) {
  if (a == null || b == null) return a === b;
  const la = a.length ?? a.data?.length ?? 0;
  const lb = b.length ?? b.data?.length ?? 0;
  if (la !== lb) return false;
  const da = a.data ?? a;
  const db = b.data ?? b;
  for (let i = 0; i < la; i++) {
    if (da[i] !== db[i] && !(Number.isNaN(da[i]) && Number.isNaN(db[i]))) return false;
  }
  return true;
}

// Deterministic synthetic data per estimator_type. n × m features,
// classifier targets are integer-coded, regressor targets are floats.
// X2 is a held-out batch for predict/transform shape checks.
function _makeData(opts, etype) {
  const n = opts.n_samples ?? 30;
  const m = opts.n_features ?? 4;
  const k = opts.n_classes ?? 3;
  const seed = opts.seed ?? 42;
  const rnd = mulberry32(seed);

  const X = { data: new Float64Array(n * m), shape: [n, m] };
  for (let i = 0; i < n * m; i++) X.data[i] = (rnd() - 0.5) * 4;
  const X2 = { data: new Float64Array(10 * m), shape: [10, m] };
  for (let i = 0; i < 10 * m; i++) X2.data[i] = (rnd() - 0.5) * 4;
  // Shift to non-negative when the estimator requires it (NMF, etc.).
  if (opts.requires_positive_X) {
    let min_v = 0;
    for (const v of X.data) if (v < min_v) min_v = v;
    for (const v of X2.data) if (v < min_v) min_v = v;
    const shift = -min_v + 0.1;
    for (let i = 0; i < X.data.length; i++) X.data[i] += shift;
    for (let i = 0; i < X2.data.length; i++) X2.data[i] += shift;
  }

  let y;
  if (etype === 'classifier') {
    y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = i % k;
  } else if (etype === 'regressor') {
    y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = X.data[i * m] + 2 * X.data[i * m + 1];
  } else {
    y = null;
  }
  return { X, y, X2 };
}
