// Splitters + cross-validation. The infrastructure layer that every
// estimator's evaluation flows through.
//
// Splitters share a uniform contract: a class with a `split(X, y, opts?)`
// generator method yielding [train_idx, test_idx] (or [train_idx,
// test_idx, n_dropped] for SpatialKFold). Indices are Int32Arrays for
// efficient row gather later.
//
// cross_val_score / cross_validate consume that contract — they don't
// know whether the splitter is k-fold, leave-one-out, group-aware, or
// spatial. New splitters land by implementing the same shape.

import { clone, check_is_fitted } from './base.js';
import { asMatrix, asVector, ValidationError,
         detectTable, tableColumns, tableNumRows, tableColumn } from './util/checks.js';
import { mulberry32 } from './util/random.js';

// ────────────────────────────────────────────────────────────────────
// train_test_split
// ────────────────────────────────────────────────────────────────────

/**
 * Split `X` and `y` into train/test subsets.
 *
 *   opts.test_size     (number, default 0.25) — fraction (0,1) or count
 *   opts.train_size    (number, optional) — overrides test_size
 *   opts.shuffle       (bool, default true)
 *   opts.stratify      (1D array, optional) — preserve class frequencies
 *   opts.random_state  (int|null, default null)
 *
 * Returns [X_train, X_test, y_train, y_test]. X is split as a row gather
 * (preserves shape and is allocator-friendly); y is split as a 1D vector.
 *
 * y may be omitted to split X alone — returns [X_train, X_test].
 */
export function train_test_split(X, y, opts = {}) {
  // Allow `train_test_split(X, opts)` shorthand (no y).
  if (y != null && typeof y === 'object' && !Array.isArray(y) && !ArrayBuffer.isView(y)
      && (y.test_size != null || y.train_size != null || y.shuffle != null
          || y.stratify != null || y.random_state != null)) {
    opts = y; y = null;
  }
  // Permit NaN at the split boundary — train_test_split is upstream of
  // any imputation in a typical pipeline.
  const { data: Xd, shape } = asMatrix(X, { allow_nan: true });
  const n = shape[0];
  const m = shape[1];
  const yv = y == null ? null : asVector(y, { allow_nan: true });
  if (yv != null && yv.length !== n) {
    throw new ValidationError(
      `train_test_split: y length ${yv.length} != n_samples ${n}`);
  }
  const n_test = _resolveSplitCount(n, opts);
  const n_train = n - n_test;
  if (n_train < 1 || n_test < 1) {
    throw new ValidationError(
      `train_test_split: degenerate split (n_train=${n_train}, n_test=${n_test})`);
  }
  const shuffle = opts.shuffle ?? true;
  const rng = opts.random_state == null ? null : mulberry32(opts.random_state);
  let train_idx, test_idx;
  if (opts.stratify != null) {
    if (!shuffle) {
      throw new ValidationError(
        `train_test_split: stratify requires shuffle=true`);
    }
    const strat = _asLabelArray(opts.stratify);
    if (strat.length !== n) {
      throw new ValidationError(
        `train_test_split: stratify length ${strat.length} != n_samples ${n}`);
    }
    [train_idx, test_idx] = _stratifiedSplit(strat, n_train, n_test, rng);
  } else {
    const indices = _arange(n);
    if (shuffle) _shuffleInPlace(indices, rng);
    train_idx = indices.slice(0, n_train);
    test_idx = indices.slice(n_train);
  }
  const X_train = _gatherRows(Xd, n, m, train_idx);
  const X_test = _gatherRows(Xd, n, m, test_idx);
  if (yv == null) return [X_train, X_test];
  const y_train = _gatherValues(yv, train_idx);
  const y_test = _gatherValues(yv, test_idx);
  return [X_train, X_test, y_train, y_test];
}

// ────────────────────────────────────────────────────────────────────
// KFold
// ────────────────────────────────────────────────────────────────────

export class KFold {
  constructor({ n_splits = 5, shuffle = false, random_state = null } = {}) {
    if (n_splits < 2) {
      throw new ValidationError(`KFold: n_splits=${n_splits} must be >= 2`);
    }
    this.n_splits = n_splits;
    this.shuffle = shuffle;
    this.random_state = random_state;
  }

  get_n_splits() { return this.n_splits; }

  *split(X, _y, _opts) {
    // Splitters care about shape only — NaN values pass through.
    const { shape } = asMatrix(X, { allow_nan: true });
    const n = shape[0];
    if (n < this.n_splits) {
      throw new ValidationError(
        `KFold: cannot have n_splits=${this.n_splits} > n_samples=${n}`);
    }
    const indices = _arange(n);
    if (this.shuffle) {
      const rng = this.random_state == null ? null : mulberry32(this.random_state);
      _shuffleInPlace(indices, rng);
    }
    // Sklearn convention: split into n_splits chunks with the first
    // (n % n_splits) folds carrying one extra element.
    const base = Math.floor(n / this.n_splits);
    const extra = n % this.n_splits;
    let start = 0;
    for (let f = 0; f < this.n_splits; f++) {
      const size = base + (f < extra ? 1 : 0);
      const test = indices.slice(start, start + size);
      const train = _concatExcept(indices, start, start + size);
      yield [train, test];
      start += size;
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// StratifiedKFold
// ────────────────────────────────────────────────────────────────────

export class StratifiedKFold {
  constructor({ n_splits = 5, shuffle = false, random_state = null } = {}) {
    if (n_splits < 2) {
      throw new ValidationError(`StratifiedKFold: n_splits=${n_splits} must be >= 2`);
    }
    this.n_splits = n_splits;
    this.shuffle = shuffle;
    this.random_state = random_state;
  }

  get_n_splits() { return this.n_splits; }

  *split(X, y, _opts) {
    if (y == null) {
      throw new ValidationError(`StratifiedKFold: y is required`);
    }
    const { shape } = asMatrix(X, { allow_nan: true });
    const n = shape[0];
    const yArr = _asLabelArray(y);
    if (yArr.length !== n) {
      throw new ValidationError(
        `StratifiedKFold: y length ${yArr.length} != n_samples ${n}`);
    }
    // Group indices by class; assign each class's indices to folds in
    // round-robin order so per-fold class counts differ by ≤ 1.
    const byClass = new Map();
    for (let i = 0; i < n; i++) {
      const c = yArr[i];
      if (!byClass.has(c)) byClass.set(c, []);
      byClass.get(c).push(i);
    }
    for (const [c, arr] of byClass) {
      if (arr.length < this.n_splits) {
        throw new ValidationError(
          `StratifiedKFold: class ${c} has ${arr.length} samples but ` +
          `n_splits=${this.n_splits}; cannot stratify.`);
      }
    }
    const rng = this.shuffle && this.random_state != null
      ? mulberry32(this.random_state) : null;
    if (this.shuffle) {
      for (const arr of byClass.values()) _shuffleInPlace(arr, rng);
    }
    const test_per_fold = Array.from({ length: this.n_splits }, () => []);
    for (const arr of byClass.values()) {
      for (let i = 0; i < arr.length; i++) {
        test_per_fold[i % this.n_splits].push(arr[i]);
      }
    }
    const all = new Set(_arange(n));
    for (let f = 0; f < this.n_splits; f++) {
      const test_set = new Set(test_per_fold[f]);
      const test = Int32Array.from(test_per_fold[f]).sort();
      const train_arr = [];
      for (const i of all) if (!test_set.has(i)) train_arr.push(i);
      train_arr.sort((a, b) => a - b);
      yield [Int32Array.from(train_arr), test];
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// GroupKFold
// ────────────────────────────────────────────────────────────────────

export class GroupKFold {
  constructor({ n_splits = 5 } = {}) {
    if (n_splits < 2) {
      throw new ValidationError(`GroupKFold: n_splits=${n_splits} must be >= 2`);
    }
    this.n_splits = n_splits;
  }

  get_n_splits() { return this.n_splits; }

  *split(X, _y, opts = {}) {
    const groups = opts.groups;
    if (groups == null) {
      throw new ValidationError(`GroupKFold.split: opts.groups is required`);
    }
    const { shape } = asMatrix(X, { allow_nan: true });
    const n = shape[0];
    const g = _asLabelArray(groups);
    if (g.length !== n) {
      throw new ValidationError(
        `GroupKFold: groups length ${g.length} != n_samples ${n}`);
    }
    // Bucket sample indices by group, then assign whole groups to folds
    // greedily — biggest group to lightest fold (matches sklearn's
    // GroupKFold balancing heuristic for fold-size variance).
    const byGroup = new Map();
    for (let i = 0; i < n; i++) {
      const k = g[i];
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(i);
    }
    const groupKeys = [...byGroup.keys()];
    if (groupKeys.length < this.n_splits) {
      throw new ValidationError(
        `GroupKFold: n_splits=${this.n_splits} > n_groups=${groupKeys.length}`);
    }
    // Sort groups by size descending; assign each to the currently smallest
    // fold (by total samples).
    groupKeys.sort((a, b) => byGroup.get(b).length - byGroup.get(a).length);
    const fold_assignment = new Array(this.n_splits).fill(0).map(() => []);
    const fold_sizes = new Array(this.n_splits).fill(0);
    for (const key of groupKeys) {
      let smallest = 0;
      for (let f = 1; f < this.n_splits; f++) {
        if (fold_sizes[f] < fold_sizes[smallest]) smallest = f;
      }
      fold_assignment[smallest].push(key);
      fold_sizes[smallest] += byGroup.get(key).length;
    }
    for (let f = 0; f < this.n_splits; f++) {
      const test_keys = new Set(fold_assignment[f]);
      const test = [];
      const train = [];
      for (let i = 0; i < n; i++) {
        if (test_keys.has(g[i])) test.push(i);
        else train.push(i);
      }
      yield [Int32Array.from(train), Int32Array.from(test)];
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// SpatialKFold
// ────────────────────────────────────────────────────────────────────

/**
 * Spatial cross-validation with an exclusion buffer around each fold's
 * test set (SPEC §5.1).
 *
 *   opts.n_splits         (int, default 5)
 *   opts.exclusion_radius (number, default 0) — units of xyz
 *   opts.shuffle          (bool, default true)
 *   opts.random_state     (int|null)
 *   opts.stratify         (1D array, optional) — class-balance the fold
 *                          assignment
 *
 * split(X, y, { xyz }) yields [train_idx, test_idx, n_dropped].
 *
 * exclusion_radius=0 reduces to standard KFold (no buffer applied).
 *
 * Brute-force O(n²) distance computation. Per spec §5.1, this is
 * acceptable for n < 5000; switch to a KDTree above that (lands with the
 * KNeighbors v0.2 work).
 */
export class SpatialKFold {
  constructor({
    n_splits = 5,
    exclusion_radius = 0,
    shuffle = true,
    random_state = null,
    stratify = null,
  } = {}) {
    if (n_splits < 2) {
      throw new ValidationError(`SpatialKFold: n_splits=${n_splits} must be >= 2`);
    }
    if (exclusion_radius < 0) {
      throw new ValidationError(
        `SpatialKFold: exclusion_radius=${exclusion_radius} must be >= 0`);
    }
    this.n_splits = n_splits;
    this.exclusion_radius = exclusion_radius;
    this.shuffle = shuffle;
    this.random_state = random_state;
    this.stratify = stratify;
  }

  get_n_splits() { return this.n_splits; }

  *split(X, y, opts = {}) {
    const xyz = opts.xyz;
    if (xyz == null) {
      throw new ValidationError(
        `SpatialKFold.split: opts.xyz is required (an [n, 1|2|3] coordinate array)`);
    }
    const { data: xyzd, shape: xyzShape } = asMatrix(xyz, { name: 'xyz' });
    const { shape } = asMatrix(X, { allow_nan: true });
    const n = shape[0];
    if (xyzShape[0] !== n) {
      throw new ValidationError(
        `SpatialKFold: xyz n_rows ${xyzShape[0]} != n_samples ${n}`);
    }
    const dim = xyzShape[1];
    if (dim < 1 || dim > 3) {
      throw new ValidationError(
        `SpatialKFold: xyz dimension ${dim} must be 1, 2, or 3`);
    }
    const r2 = this.exclusion_radius * this.exclusion_radius;

    // Fold assignment: stratified only when this.stratify is explicitly
    // set. Auto-stratifying on y would break regression workflows (the
    // whole point of SpatialKFold for continuous targets is the spatial
    // buffer, not stratification).
    const stratifyArr = this.stratify ?? null;
    const rng = this.random_state == null ? null : mulberry32(this.random_state);
    let fold_id;  // Int32Array[n]
    if (stratifyArr != null) {
      fold_id = _stratifiedFoldAssignment(stratifyArr, this.n_splits, rng);
    } else {
      const indices = _arange(n);
      if (this.shuffle) _shuffleInPlace(indices, rng);
      fold_id = new Int32Array(n);
      const base = Math.floor(n / this.n_splits);
      const extra = n % this.n_splits;
      let start = 0;
      for (let f = 0; f < this.n_splits; f++) {
        const size = base + (f < extra ? 1 : 0);
        for (let k = start; k < start + size; k++) fold_id[indices[k]] = f;
        start += size;
      }
    }

    for (let f = 0; f < this.n_splits; f++) {
      const test_arr = [];
      for (let i = 0; i < n; i++) if (fold_id[i] === f) test_arr.push(i);
      const test = Int32Array.from(test_arr);

      // For each non-test sample, find min squared distance to any test
      // sample. Drop if below r²; keep otherwise.
      const train_arr = [];
      let n_dropped = 0;
      for (let i = 0; i < n; i++) {
        if (fold_id[i] === f) continue;
        if (r2 === 0) { train_arr.push(i); continue; }
        let min_d2 = Infinity;
        const off_i = i * dim;
        for (let k = 0; k < test.length; k++) {
          const j = test[k];
          const off_j = j * dim;
          let d2 = 0;
          for (let d = 0; d < dim; d++) {
            const diff = xyzd[off_i + d] - xyzd[off_j + d];
            d2 += diff * diff;
            if (d2 >= min_d2) break;
          }
          if (d2 < min_d2) { min_d2 = d2; if (min_d2 < r2) break; }
        }
        if (min_d2 >= r2) train_arr.push(i);
        else n_dropped++;
      }
      yield [Int32Array.from(train_arr), test, n_dropped];
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// cross_val_score / cross_validate
// ────────────────────────────────────────────────────────────────────

/**
 * Run cross-validation, returning per-fold scores.
 *
 *   opts.cv            (splitter | int, default KFold(5))
 *   opts.scoring       (function, optional) — (estimator, X, y) → number;
 *                       defaults to estimator.score
 *   opts.sample_weight (1D array, optional) — split alongside X/y
 *   opts.split_opts    (object, optional) — passed through to cv.split
 *                       (e.g. { groups, xyz } for GroupKFold/SpatialKFold)
 *   opts.refit         (bool, default true) — when false, skip clone+fit and
 *                       score the already-fitted estimator on each fold's
 *                       test set. The only sklearn-API divergence in @gcu/learn
 *                       (SPEC §5.4): useful for honest k-fold scoring of a
 *                       bonsai-edited tree or any pre-trained model from disk.
 *
 * Returns Float64Array of length n_splits.
 */
export function cross_val_score(estimator, X, y, opts = {}) {
  const { scores } = _cvLoop(estimator, X, y, opts, /* multi= */ false);
  return scores;
}

/**
 * Run cross-validation collecting multiple metrics + optional train scores.
 *
 *   opts.cv, opts.scoring, opts.sample_weight, opts.split_opts as above
 *   opts.scoring may be { name: fn, ... } for multiple metrics
 *   opts.return_train_score (bool, default false)
 *   opts.refit (bool, default true) — see cross_val_score. When false,
 *     fit_time is 0 for every fold and train_<name> equals the score on
 *     the full training fold (no in-fold retraining occurred).
 *
 * Returns { test_score | test_<name>, [train_score | train_<name>],
 *           fit_time, score_time, n_dropped (when SpatialKFold) }.
 */
export function cross_validate(estimator, X, y, opts = {}) {
  return _cvLoop(estimator, X, y, opts, /* multi= */ true);
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function _cvLoop(estimator, X, y, opts, multi) {
  // Probe the estimator's tags to decide whether to accept NaN inputs.
  // Pipelines that include an imputer set allow_nan=true; we mustn't
  // reject NaN at the CV boundary in that case.
  const allow_nan = _estAllowsNan(estimator);
  const { data: Xd, shape } = asMatrix(X, { allow_nan });
  const n = shape[0], m = shape[1];
  const yv = y == null ? null : asVector(y, { allow_nan });
  if (yv != null && yv.length !== n) {
    throw new ValidationError(`cross_val: y length ${yv.length} != n_samples ${n}`);
  }
  const cv = _resolveCv(opts.cv);
  const splitOpts = opts.split_opts ?? {};
  const scoringDict = _resolveScoring(opts.scoring, multi);
  const returnTrain = opts.return_train_score ?? false;
  const refit = opts.refit ?? true;

  // refit=false requires a fitted estimator since we won't retrain. Fail
  // fast with a clear error rather than letting predict throw downstream.
  if (!refit) {
    try {
      check_is_fitted(estimator);
    } catch (_) {
      throw new ValidationError(
        'cross_val: refit=false requires a fitted estimator; got an unfitted one.');
    }
  }

  const X_envelope = { data: Xd, shape };
  const fold_results = [];
  for (const tup of cv.split(X_envelope, yv, splitOpts)) {
    const train_idx = tup[0];
    const test_idx = tup[1];
    const n_dropped = tup[2];

    const X_train = _gatherRows(Xd, n, m, train_idx);
    const X_test = _gatherRows(Xd, n, m, test_idx);
    const y_train = yv == null ? null : _gatherValues(yv, train_idx);
    const y_test = yv == null ? null : _gatherValues(yv, test_idx);

    let est, fit_time;
    if (refit) {
      est = clone(estimator);
      const t_fit = _now();
      est.fit(X_train, y_train);
      fit_time = _now() - t_fit;
    } else {
      // Use the as-passed (fitted) estimator. fit_time is 0 since no fit
      // happened. The estimator's frozen state is the same on every fold —
      // we're scoring it on the test partition only, which is exactly the
      // refit=false contract (SPEC §5.4).
      est = estimator;
      fit_time = 0;
    }

    const t_score = _now();
    const test_scores = {};
    const train_scores = {};
    for (const name of Object.keys(scoringDict)) {
      const fn = scoringDict[name];
      test_scores[name] = fn(est, X_test, y_test);
      if (returnTrain) train_scores[name] = fn(est, X_train, y_train);
    }
    const score_time = _now() - t_score;

    fold_results.push({
      test_scores, train_scores, fit_time, score_time, n_dropped,
    });
  }

  if (!multi) {
    const out = new Float64Array(fold_results.length);
    for (let i = 0; i < out.length; i++) {
      // Single-metric: pull the only key.
      const k = Object.keys(fold_results[i].test_scores)[0];
      out[i] = fold_results[i].test_scores[k];
    }
    return { scores: out };
  }

  // Multi-metric: collect per-name arrays.
  const out = {};
  const metricNames = Object.keys(fold_results[0].test_scores);
  for (const name of metricNames) {
    out[`test_${name}`] = new Float64Array(fold_results.length);
    if (returnTrain) out[`train_${name}`] = new Float64Array(fold_results.length);
    for (let i = 0; i < fold_results.length; i++) {
      out[`test_${name}`][i] = fold_results[i].test_scores[name];
      if (returnTrain) out[`train_${name}`][i] = fold_results[i].train_scores[name];
    }
  }
  out.fit_time = Float64Array.from(fold_results.map(f => f.fit_time));
  out.score_time = Float64Array.from(fold_results.map(f => f.score_time));
  if (fold_results.some(f => f.n_dropped !== undefined)) {
    out.n_dropped = Int32Array.from(fold_results.map(f => f.n_dropped ?? 0));
  }
  return out;
}

// Probe the estimator's __sklearn_tags__() for allow_nan. Returns false
// if the estimator doesn't expose tags (defensive default).
function _estAllowsNan(est) {
  if (est == null) return false;
  if (typeof est.__sklearn_tags__ === 'function') {
    try { return !!est.__sklearn_tags__().allow_nan; } catch (_) { return false; }
  }
  return false;
}

function _resolveCv(cv) {
  if (cv == null) return new KFold({ n_splits: 5 });
  if (typeof cv === 'number') return new KFold({ n_splits: cv });
  if (cv.split && typeof cv.split === 'function') return cv;
  throw new ValidationError(
    `cross_val: cv must be a splitter (with .split) or an integer; got ${typeof cv}`);
}

function _resolveScoring(scoring, multi) {
  // Default: use estimator.score.
  if (scoring == null) {
    return { score: (est, X, y) => est.score(X, y) };
  }
  if (typeof scoring === 'function') {
    return { score: scoring };
  }
  if (multi && typeof scoring === 'object') {
    const out = {};
    for (const name of Object.keys(scoring)) {
      const fn = scoring[name];
      if (typeof fn !== 'function') {
        throw new ValidationError(
          `cross_validate: scoring['${name}'] must be a function`);
      }
      out[name] = fn;
    }
    return out;
  }
  throw new ValidationError(
    `cross_val: scoring must be a function${multi ? ' or {name: fn, …}' : ''}`);
}

function _resolveSplitCount(n, opts) {
  const train_size = opts.train_size;
  let test_size = opts.test_size;
  if (train_size != null && test_size != null) {
    // Both given: as long as they're consistent, use them; else error.
  }
  if (train_size != null && test_size == null) {
    const t = train_size > 1 ? train_size : Math.round(train_size * n);
    return Math.max(0, n - t);
  }
  if (test_size == null) test_size = 0.25;  // sklearn default
  return test_size > 1 ? Math.floor(test_size) : Math.round(test_size * n);
}

function _stratifiedSplit(strat, n_train, n_test, rng) {
  const byClass = new Map();
  for (let i = 0; i < strat.length; i++) {
    const c = strat[i];
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(i);
  }
  const train = [];
  const test = [];
  for (const [, arr] of byClass) {
    _shuffleInPlace(arr, rng);
    // Per-class proportional split.
    const k_test = Math.max(1, Math.round(arr.length * n_test / strat.length));
    for (let i = 0; i < arr.length; i++) {
      if (i < k_test) test.push(arr[i]); else train.push(arr[i]);
    }
  }
  // Adjust to exact total counts (rounding may be off by a few).
  while (test.length > n_test) train.push(test.pop());
  while (train.length > n_train) test.push(train.pop());
  train.sort((a, b) => a - b);
  test.sort((a, b) => a - b);
  return [Int32Array.from(train), Int32Array.from(test)];
}

function _stratifiedFoldAssignment(strat, n_splits, rng) {
  const arr = _asLabelArray(strat);
  const n = arr.length;
  const byClass = new Map();
  for (let i = 0; i < n; i++) {
    const c = arr[i];
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(i);
  }
  const fold_id = new Int32Array(n);
  for (const [, idxs] of byClass) {
    _shuffleInPlace(idxs, rng);
    for (let k = 0; k < idxs.length; k++) {
      fold_id[idxs[k]] = k % n_splits;
    }
  }
  return fold_id;
}

function _arange(n) {
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

function _shuffleInPlace(arr, rng) {
  const r = rng ?? Math.random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
}

function _concatExcept(indices, lo, hi) {
  // Return a copy of `indices` with [lo, hi) excised.
  const out = new Int32Array(indices.length - (hi - lo));
  let w = 0;
  for (let i = 0; i < lo; i++) out[w++] = indices[i];
  for (let i = hi; i < indices.length; i++) out[w++] = indices[i];
  return out;
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

function _asLabelArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (ArrayBuffer.isView(v)) return Array.from(v);
  throw new ValidationError(`expected 1D array of labels; got ${typeof v}`);
}

function _now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now() / 1000  // sklearn returns seconds
    : Date.now() / 1000;
}

// ────────────────────────────────────────────────────────────────────
// from_table — extract sklearn-shape inputs from a sadpan/DataFrame-like
// ────────────────────────────────────────────────────────────────────

/**
 * Build (X, y, groups, xyz) tuples from a table-shaped input. Per
 * SPEC-learn §3.5.
 *
 * @param {object} df  — sadpan Table, sadpan DataFrame, or plain
 *                       JS object with named array-like columns
 * @param {object} opts
 * @param {string|null}    [opts.target]   — column name for y
 * @param {string[]|null}  [opts.features] — column names for X (default:
 *                       all columns except target/group/xyz)
 * @param {string|null}    [opts.group]    — column name for groups
 * @param {string[]|null}  [opts.xyz]      — column names for spatial coords
 *
 * @returns {object}
 *   X            { data, shape, feature_names } — same shape asMatrix returns
 *   y            Float64Array (or null) — int-encoded when target was string-typed
 *   groups       Array of raw group values (or null)
 *   xyz          { data, shape } 2D — or null
 *   feature_names string[] — actual feature column names
 *   classes      string[] — original class labels in encoded order, when
 *                target was string-typed; null otherwise
 */
export function from_table(df, opts = {}) {
  const kind = detectTable(df);
  if (kind == null) {
    throw new ValidationError(
      'from_table: input is not a sadpan Table, DataFrame, or named-column object');
  }
  const all_cols = tableColumns(df, kind);
  const n = tableNumRows(df, kind);
  const target = opts.target ?? null;
  const group = opts.group ?? null;
  const xyz_cols = opts.xyz ?? null;

  // Default features: all columns except target / group / xyz.
  let features = opts.features ?? null;
  if (features == null) {
    const exclude = new Set();
    if (target) exclude.add(target);
    if (group) exclude.add(group);
    if (Array.isArray(xyz_cols)) for (const c of xyz_cols) exclude.add(c);
    features = all_cols.filter(c => !exclude.has(c));
  }
  for (const c of features) {
    if (!all_cols.includes(c)) {
      throw new ValidationError(`from_table: feature '${c}' not in input columns`);
    }
  }

  // Build X by stacking feature columns numerically.
  const X_data = new Float64Array(n * features.length);
  for (let j = 0; j < features.length; j++) {
    const col = tableColumn(df, kind, features[j]);
    for (let i = 0; i < n; i++) {
      const v = +col[i];
      if (!Number.isFinite(v)) {
        throw new ValidationError(
          `from_table: non-finite value in feature '${features[j]}' at row ${i}`);
      }
      X_data[i * features.length + j] = v;
    }
  }
  X_data.shape = [n, features.length];
  const X = { data: X_data, shape: [n, features.length], feature_names: features.slice() };

  // y: extract target, auto-encode if string-typed.
  let y = null;
  let classes = null;
  if (target != null) {
    if (!all_cols.includes(target)) {
      throw new ValidationError(`from_table: target '${target}' not in input columns`);
    }
    const raw = tableColumn(df, kind, target);
    const isString = raw.length > 0 && typeof raw[0] === 'string';
    if (isString) {
      const seen = new Map();
      const order = [];
      for (let i = 0; i < n; i++) {
        const v = raw[i];
        if (!seen.has(v)) { seen.set(v, true); order.push(v); }
      }
      order.sort();
      const idx = new Map();
      for (let c = 0; c < order.length; c++) idx.set(order[c], c);
      const enc = new Float64Array(n);
      for (let i = 0; i < n; i++) enc[i] = idx.get(raw[i]);
      y = enc;
      classes = order;
    } else {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = +raw[i];
      y = out;
    }
  }

  // groups: raw values (splitter compares with === / Map keys).
  let groups = null;
  if (group != null) {
    if (!all_cols.includes(group)) {
      throw new ValidationError(`from_table: group '${group}' not in input columns`);
    }
    const raw = tableColumn(df, kind, group);
    groups = Array.from(raw);
  }

  // xyz: stack 1-3 columns.
  let xyz = null;
  if (Array.isArray(xyz_cols)) {
    if (xyz_cols.length < 1 || xyz_cols.length > 3) {
      throw new ValidationError(
        `from_table: xyz must list 1-3 columns; got ${xyz_cols.length}`);
    }
    for (const c of xyz_cols) {
      if (!all_cols.includes(c)) {
        throw new ValidationError(`from_table: xyz column '${c}' not in input columns`);
      }
    }
    const xyz_data = new Float64Array(n * xyz_cols.length);
    for (let j = 0; j < xyz_cols.length; j++) {
      const col = tableColumn(df, kind, xyz_cols[j]);
      for (let i = 0; i < n; i++) xyz_data[i * xyz_cols.length + j] = +col[i];
    }
    xyz_data.shape = [n, xyz_cols.length];
    xyz = { data: xyz_data, shape: [n, xyz_cols.length] };
  }

  return {
    X, y, groups, xyz,
    feature_names: features.slice(),
    classes,
  };
}
