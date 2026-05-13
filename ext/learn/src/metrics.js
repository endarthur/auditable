// Classification + regression metrics. Pure functions, no estimator
// coupling — every metric takes (y_true, y_pred, opts) and returns a
// number or a plain object.
//
// Sklearn-compatible at the contract level (`sklearn.metrics`). Same
// names, same averaging conventions, same multi-class rules. v0.1 ships
// 1D-output regression only — multi-output is out of scope (SPEC §3.6
// deviation 4 / §9 "multi-output meta-estimators").
//
// Sample weights: every metric accepts opts.sample_weight as a 1D array
// of the same length as y_true. When omitted, weights are uniform.
//
// zero_division: where division by zero is possible (precision with no
// predicted positives, recall with no actual positives), the
// zero_division opt determines the result. Defaults to 0; pass 1 to
// match the "perfect" interpretation, or NaN to surface the missing
// signal.

import { ValidationError } from './util/checks.js';

// ────────────────────────────────────────────────────────────────────
// Classification
// ────────────────────────────────────────────────────────────────────

/**
 * Fraction (or count, when normalize=false) of correctly predicted samples.
 *
 *   opts.normalize     (bool, default true)
 *   opts.sample_weight (1D array, optional)
 */
export function accuracy_score(y_true, y_pred, opts = {}) {
  const yt = _asArr(y_true, 'y_true');
  const yp = _asArr(y_pred, 'y_pred');
  _checkSameLength(yt, yp);
  const w = opts.sample_weight ?? null;
  const normalize = opts.normalize ?? true;
  if (w == null) {
    let hits = 0;
    for (let i = 0; i < yt.length; i++) if (yt[i] === yp[i]) hits++;
    return normalize ? (yt.length === 0 ? 0 : hits / yt.length) : hits;
  }
  if (w.length !== yt.length) {
    throw new ValidationError(
      `accuracy_score: sample_weight length ${w.length} != y length ${yt.length}`);
  }
  let num = 0, den = 0;
  for (let i = 0; i < yt.length; i++) {
    den += +w[i];
    if (yt[i] === yp[i]) num += +w[i];
  }
  return normalize ? (den === 0 ? 0 : num / den) : num;
}

/**
 * Macro-averaged recall (mean of per-class recall).
 *
 *   opts.adjusted      (bool, default false) — re-scale so chance = 0
 *   opts.sample_weight (1D array, optional)
 */
export function balanced_accuracy_score(y_true, y_pred, opts = {}) {
  const { recall } = _perClassPRF(y_true, y_pred, opts);
  if (recall.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < recall.length; i++) sum += recall[i];
  let bacc = sum / recall.length;
  if (opts.adjusted) {
    const chance = 1 / recall.length;
    bacc = (bacc - chance) / (1 - chance);
  }
  return bacc;
}

/**
 * Confusion matrix C where C[i, j] is the count of true class i predicted
 * as class j.
 *
 *   opts.labels        (array, optional) — class label order; defaults to
 *                       sorted union of y_true ∪ y_pred
 *   opts.sample_weight (1D array, optional)
 *   opts.normalize     ('true' | 'pred' | 'all' | null, default null)
 *
 * Returns { matrix: number[][], labels: array }.
 */
export function confusion_matrix(y_true, y_pred, opts = {}) {
  const yt = _asArr(y_true, 'y_true');
  const yp = _asArr(y_pred, 'y_pred');
  _checkSameLength(yt, yp);
  const labels = opts.labels ?? _uniqueLabels(yt, yp);
  const idx = new Map();
  for (let i = 0; i < labels.length; i++) idx.set(labels[i], i);
  const k = labels.length;
  const M = Array.from({ length: k }, () => new Array(k).fill(0));
  const w = opts.sample_weight ?? null;
  if (w != null && w.length !== yt.length) {
    throw new ValidationError(
      `confusion_matrix: sample_weight length ${w.length} != y length ${yt.length}`);
  }
  for (let i = 0; i < yt.length; i++) {
    const r = idx.get(yt[i]);
    const c = idx.get(yp[i]);
    if (r === undefined || c === undefined) continue;
    M[r][c] += w == null ? 1 : +w[i];
  }
  if (opts.normalize) {
    const norm = opts.normalize;
    if (norm === 'true') {
      for (let r = 0; r < k; r++) {
        let s = 0;
        for (let c = 0; c < k; c++) s += M[r][c];
        if (s > 0) for (let c = 0; c < k; c++) M[r][c] /= s;
      }
    } else if (norm === 'pred') {
      for (let c = 0; c < k; c++) {
        let s = 0;
        for (let r = 0; r < k; r++) s += M[r][c];
        if (s > 0) for (let r = 0; r < k; r++) M[r][c] /= s;
      }
    } else if (norm === 'all') {
      let s = 0;
      for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) s += M[r][c];
      if (s > 0) for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) M[r][c] /= s;
    } else {
      throw new ValidationError(
        `confusion_matrix: normalize must be 'true' | 'pred' | 'all' | null`);
    }
  }
  return { matrix: M, labels };
}

/**
 * Per-class precision averaged according to opts.average.
 *
 *   opts.labels        (array, optional)
 *   opts.pos_label     (any, default 1) — for binary average
 *   opts.average       ('binary' | 'micro' | 'macro' | 'weighted' | null,
 *                       default 'binary')
 *   opts.sample_weight (1D array, optional)
 *   opts.zero_division (number, default 0) — value when TP+FP == 0
 *
 * Returns a number for averaged variants, or an array (one per label)
 * when average=null.
 */
export function precision_score(y_true, y_pred, opts = {}) {
  return _aggregatePRF(y_true, y_pred, opts, 'precision');
}

/** Per-class recall, see precision_score for opts. */
export function recall_score(y_true, y_pred, opts = {}) {
  return _aggregatePRF(y_true, y_pred, opts, 'recall');
}

/** Harmonic mean of precision and recall (β=1). */
export function f1_score(y_true, y_pred, opts = {}) {
  return _aggregatePRF(y_true, y_pred, opts, 'f1');
}

/**
 * Sklearn-shape per-class report: precision/recall/f1/support per class
 * plus accuracy / macro avg / weighted avg.
 *
 * Returns an object keyed by label (and the special 'accuracy', 'macro avg',
 * 'weighted avg' entries). Values are { precision, recall, f1, support }.
 */
export function classification_report(y_true, y_pred, opts = {}) {
  const labels = opts.labels ?? _uniqueLabels(_asArr(y_true), _asArr(y_pred));
  const stats = _perClassPRF(y_true, y_pred, { ...opts, labels });
  const out = {};
  let total_support = 0;
  let macro_p = 0, macro_r = 0, macro_f = 0;
  let weighted_p = 0, weighted_r = 0, weighted_f = 0;
  for (let i = 0; i < labels.length; i++) {
    const support = stats.support[i];
    total_support += support;
    out[String(labels[i])] = {
      precision: stats.precision[i],
      recall: stats.recall[i],
      f1: stats.f1[i],
      support,
    };
    macro_p += stats.precision[i];
    macro_r += stats.recall[i];
    macro_f += stats.f1[i];
    weighted_p += stats.precision[i] * support;
    weighted_r += stats.recall[i] * support;
    weighted_f += stats.f1[i] * support;
  }
  const k = labels.length || 1;
  out['accuracy'] = accuracy_score(y_true, y_pred, opts);
  out['macro avg'] = {
    precision: macro_p / k, recall: macro_r / k, f1: macro_f / k,
    support: total_support,
  };
  out['weighted avg'] = total_support === 0 ? {
    precision: 0, recall: 0, f1: 0, support: 0,
  } : {
    precision: weighted_p / total_support,
    recall: weighted_r / total_support,
    f1: weighted_f / total_support,
    support: total_support,
  };
  return out;
}

/**
 * Cohen's kappa: agreement above chance.
 *
 *   opts.weights ('linear' | 'quadratic' | null, default null)
 *   opts.labels, opts.sample_weight
 */
export function cohen_kappa_score(y1, y2, opts = {}) {
  const { matrix: M, labels } = confusion_matrix(y1, y2, opts);
  const k = labels.length;
  if (k === 0) return 0;
  let total = 0;
  for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) total += M[r][c];
  if (total === 0) return 0;
  // Marginals.
  const row_sum = new Array(k).fill(0);
  const col_sum = new Array(k).fill(0);
  for (let r = 0; r < k; r++) {
    for (let c = 0; c < k; c++) {
      row_sum[r] += M[r][c];
      col_sum[c] += M[r][c];
    }
  }
  // Build weight matrix. None: 0 on diagonal, 1 off; linear: |i-j| / (k-1);
  // quadratic: (i-j)² / (k-1)².
  const W = Array.from({ length: k }, () => new Array(k).fill(0));
  const wmode = opts.weights ?? null;
  for (let r = 0; r < k; r++) {
    for (let c = 0; c < k; c++) {
      if (wmode == null) W[r][c] = r === c ? 0 : 1;
      else if (wmode === 'linear') W[r][c] = Math.abs(r - c) / Math.max(1, k - 1);
      else if (wmode === 'quadratic') {
        const d = (r - c) / Math.max(1, k - 1);
        W[r][c] = d * d;
      } else throw new ValidationError(`cohen_kappa_score: weights must be 'linear' | 'quadratic' | null`);
    }
  }
  let observed = 0, expected = 0;
  for (let r = 0; r < k; r++) {
    for (let c = 0; c < k; c++) {
      observed += W[r][c] * M[r][c];
      expected += W[r][c] * row_sum[r] * col_sum[c] / total;
    }
  }
  if (expected === 0) return 1;
  return 1 - observed / expected;
}

/**
 * Matthews correlation coefficient (multi-class generalization).
 * Returns 0 when any required marginal is zero (matches sklearn).
 */
export function matthews_corrcoef(y_true, y_pred, opts = {}) {
  const { matrix: M, labels } = confusion_matrix(y_true, y_pred, opts);
  const k = labels.length;
  if (k === 0) return 0;
  let n = 0;
  const t = new Array(k).fill(0);  // row sums (true totals per class)
  const p = new Array(k).fill(0);  // col sums (pred totals per class)
  let trace = 0;
  for (let r = 0; r < k; r++) {
    for (let c = 0; c < k; c++) {
      n += M[r][c];
      t[r] += M[r][c];
      p[c] += M[r][c];
      if (r === c) trace += M[r][c];
    }
  }
  if (n === 0) return 0;
  let dot_tp = 0, sq_t = 0, sq_p = 0;
  for (let i = 0; i < k; i++) {
    dot_tp += t[i] * p[i];
    sq_t += t[i] * t[i];
    sq_p += p[i] * p[i];
  }
  const num = trace * n - dot_tp;
  const den_a = n * n - sq_p;
  const den_b = n * n - sq_t;
  if (den_a <= 0 || den_b <= 0) return 0;
  return num / Math.sqrt(den_a * den_b);
}

// ────────────────────────────────────────────────────────────────────
// Regression
// ────────────────────────────────────────────────────────────────────

/**
 * Coefficient of determination R². Best is 1.0; can be negative.
 *
 *   opts.sample_weight (1D array, optional)
 *
 * Convention: when y_true is constant, R² = 1.0 if predictions match
 * exactly (zero residual), 0.0 otherwise. Matches sklearn.
 */
export function r2_score(y_true, y_pred, opts = {}) {
  const yt = _asNumArr(y_true);
  const yp = _asNumArr(y_pred);
  _checkSameLength(yt, yp);
  const w = opts.sample_weight ?? null;
  const n = yt.length;
  if (n === 0) return 0;

  let mean = 0, w_sum = 0;
  if (w == null) {
    for (let i = 0; i < n; i++) mean += yt[i];
    mean /= n; w_sum = n;
  } else {
    if (w.length !== n) throw new ValidationError(
      `r2_score: sample_weight length ${w.length} != y length ${n}`);
    for (let i = 0; i < n; i++) { mean += +w[i] * yt[i]; w_sum += +w[i]; }
    mean = w_sum === 0 ? 0 : mean / w_sum;
  }
  let ss_res = 0, ss_tot = 0;
  if (w == null) {
    for (let i = 0; i < n; i++) {
      const d = yt[i] - yp[i]; const t = yt[i] - mean;
      ss_res += d * d; ss_tot += t * t;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const d = yt[i] - yp[i]; const t = yt[i] - mean;
      ss_res += +w[i] * d * d; ss_tot += +w[i] * t * t;
    }
  }
  if (ss_tot === 0) return ss_res === 0 ? 1 : 0;
  return 1 - ss_res / ss_tot;
}

/**
 * Mean squared error.
 *
 *   opts.sample_weight (1D array, optional)
 *   opts.squared       (bool, default true) — when false, returns RMSE.
 *                       Use root_mean_squared_error explicitly in new code.
 */
export function mean_squared_error(y_true, y_pred, opts = {}) {
  const yt = _asNumArr(y_true);
  const yp = _asNumArr(y_pred);
  _checkSameLength(yt, yp);
  const w = opts.sample_weight ?? null;
  const n = yt.length;
  if (n === 0) return 0;
  let sum = 0, w_sum = 0;
  if (w == null) {
    for (let i = 0; i < n; i++) { const d = yt[i] - yp[i]; sum += d * d; }
    w_sum = n;
  } else {
    if (w.length !== n) throw new ValidationError(
      `mean_squared_error: sample_weight length ${w.length} != y length ${n}`);
    for (let i = 0; i < n; i++) {
      const d = yt[i] - yp[i]; sum += +w[i] * d * d; w_sum += +w[i];
    }
  }
  const mse = w_sum === 0 ? 0 : sum / w_sum;
  return (opts.squared ?? true) ? mse : Math.sqrt(mse);
}

/** Root mean squared error. Sklearn 1.4+ canonical name. */
export function root_mean_squared_error(y_true, y_pred, opts = {}) {
  return mean_squared_error(y_true, y_pred, { ...opts, squared: false });
}

/** Mean absolute error. */
export function mean_absolute_error(y_true, y_pred, opts = {}) {
  const yt = _asNumArr(y_true);
  const yp = _asNumArr(y_pred);
  _checkSameLength(yt, yp);
  const w = opts.sample_weight ?? null;
  const n = yt.length;
  if (n === 0) return 0;
  let sum = 0, w_sum = 0;
  if (w == null) {
    for (let i = 0; i < n; i++) sum += Math.abs(yt[i] - yp[i]);
    w_sum = n;
  } else {
    if (w.length !== n) throw new ValidationError(
      `mean_absolute_error: sample_weight length ${w.length} != y length ${n}`);
    for (let i = 0; i < n; i++) {
      sum += +w[i] * Math.abs(yt[i] - yp[i]); w_sum += +w[i];
    }
  }
  return w_sum === 0 ? 0 : sum / w_sum;
}

/**
 * Mean absolute percentage error: mean(|y_true - y_pred| / max(eps, |y_true|)).
 * Returns a fraction (sklearn convention) — multiply by 100 for percent.
 */
export function mean_absolute_percentage_error(y_true, y_pred, opts = {}) {
  const yt = _asNumArr(y_true);
  const yp = _asNumArr(y_pred);
  _checkSameLength(yt, yp);
  const w = opts.sample_weight ?? null;
  const n = yt.length;
  if (n === 0) return 0;
  const eps = Number.EPSILON;
  let sum = 0, w_sum = 0;
  if (w == null) {
    for (let i = 0; i < n; i++) {
      sum += Math.abs(yt[i] - yp[i]) / Math.max(eps, Math.abs(yt[i]));
    }
    w_sum = n;
  } else {
    if (w.length !== n) throw new ValidationError(
      `mean_absolute_percentage_error: sample_weight length ${w.length} != y length ${n}`);
    for (let i = 0; i < n; i++) {
      sum += +w[i] * Math.abs(yt[i] - yp[i]) / Math.max(eps, Math.abs(yt[i]));
      w_sum += +w[i];
    }
  }
  return w_sum === 0 ? 0 : sum / w_sum;
}

/**
 * Explained variance score: 1 - Var(y_true - y_pred) / Var(y_true).
 * Differs from R² by the absence of a mean-shift correction in the residual.
 */
export function explained_variance_score(y_true, y_pred, opts = {}) {
  const yt = _asNumArr(y_true);
  const yp = _asNumArr(y_pred);
  _checkSameLength(yt, yp);
  const w = opts.sample_weight ?? null;
  const n = yt.length;
  if (n === 0) return 0;

  let yt_mean = 0, w_sum = 0;
  if (w == null) {
    for (let i = 0; i < n; i++) yt_mean += yt[i];
    yt_mean /= n; w_sum = n;
  } else {
    if (w.length !== n) throw new ValidationError(
      `explained_variance_score: sample_weight length ${w.length} != y length ${n}`);
    for (let i = 0; i < n; i++) { yt_mean += +w[i] * yt[i]; w_sum += +w[i]; }
    yt_mean = w_sum === 0 ? 0 : yt_mean / w_sum;
  }
  // residuals + their mean
  let res_mean = 0;
  if (w == null) {
    for (let i = 0; i < n; i++) res_mean += yt[i] - yp[i];
    res_mean /= n;
  } else {
    for (let i = 0; i < n; i++) res_mean += +w[i] * (yt[i] - yp[i]);
    res_mean = w_sum === 0 ? 0 : res_mean / w_sum;
  }
  let var_y = 0, var_res = 0;
  if (w == null) {
    for (let i = 0; i < n; i++) {
      const dy = yt[i] - yt_mean;
      const dr = (yt[i] - yp[i]) - res_mean;
      var_y += dy * dy; var_res += dr * dr;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const dy = yt[i] - yt_mean;
      const dr = (yt[i] - yp[i]) - res_mean;
      var_y += +w[i] * dy * dy; var_res += +w[i] * dr * dr;
    }
  }
  if (var_y === 0) return var_res === 0 ? 1 : 0;
  return 1 - var_res / var_y;
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

// Coerce y to a JS array of (possibly non-numeric) labels. Strings, ints,
// any value works as long as === comparison is meaningful.
function _asArr(y, name = 'y') {
  if (y == null) throw new ValidationError(`${name}: input is ${y}`);
  if (Array.isArray(y)) return y;
  if (ArrayBuffer.isView(y)) return Array.from(y);
  throw new ValidationError(`${name}: unrecognized shape (${typeof y})`);
}

// Coerce y to a Float64Array view for regression metrics.
function _asNumArr(y) {
  if (y == null) throw new ValidationError(`y: input is ${y}`);
  if (y instanceof Float64Array) return y;
  if (ArrayBuffer.isView(y) && !(y instanceof DataView)) {
    const out = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) out[i] = y[i];
    return out;
  }
  if (Array.isArray(y)) {
    const out = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) out[i] = +y[i];
    return out;
  }
  throw new ValidationError(`y: unrecognized shape (${typeof y})`);
}

function _checkSameLength(a, b) {
  if (a.length !== b.length) {
    throw new ValidationError(
      `metrics: y_true (length ${a.length}) and y_pred (length ${b.length}) must match`);
  }
}

// Sorted union of unique labels across two arrays. Stringifies for set
// dedup, then casts back through the original arrays' first-seen value
// to preserve type (so int labels stay ints, string labels stay strings).
function _uniqueLabels(a, b) {
  const seen = new Map();  // string-key → original value
  for (const v of a) { const k = _labelKey(v); if (!seen.has(k)) seen.set(k, v); }
  for (const v of b) { const k = _labelKey(v); if (!seen.has(k)) seen.set(k, v); }
  return [...seen.values()].sort(_labelCmp);
}

function _labelKey(v) {
  return typeof v === 'string' ? `s:${v}` : `n:${v}`;
}

function _labelCmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// Per-class precision/recall/f1/support arrays, in the order of `labels`
// (resolved from opts.labels or sorted union of inputs).
function _perClassPRF(y_true, y_pred, opts = {}) {
  const yt = _asArr(y_true);
  const yp = _asArr(y_pred);
  _checkSameLength(yt, yp);
  const labels = opts.labels ?? _uniqueLabels(yt, yp);
  const idx = new Map();
  for (let i = 0; i < labels.length; i++) idx.set(labels[i], i);
  const w = opts.sample_weight ?? null;
  const k = labels.length;
  const tp = new Array(k).fill(0);
  const fp = new Array(k).fill(0);
  const fn = new Array(k).fill(0);
  const support = new Array(k).fill(0);
  for (let i = 0; i < yt.length; i++) {
    const ti = idx.get(yt[i]);
    const pi = idx.get(yp[i]);
    const wi = w == null ? 1 : +w[i];
    if (ti !== undefined) support[ti] += wi;
    if (ti === pi && ti !== undefined) tp[ti] += wi;
    else {
      if (pi !== undefined) fp[pi] += wi;
      if (ti !== undefined) fn[ti] += wi;
    }
  }
  const zero = opts.zero_division ?? 0;
  const precision = new Array(k);
  const recall = new Array(k);
  const f1 = new Array(k);
  for (let i = 0; i < k; i++) {
    const denP = tp[i] + fp[i];
    const denR = tp[i] + fn[i];
    precision[i] = denP === 0 ? zero : tp[i] / denP;
    recall[i] = denR === 0 ? zero : tp[i] / denR;
    const denF = precision[i] + recall[i];
    f1[i] = denF === 0 ? zero : 2 * precision[i] * recall[i] / denF;
  }
  return { precision, recall, f1, support, labels };
}

function _aggregatePRF(y_true, y_pred, opts, which) {
  const labels = opts.labels ?? _uniqueLabels(_asArr(y_true), _asArr(y_pred));
  const stats = _perClassPRF(y_true, y_pred, { ...opts, labels });
  const arr = stats[which];
  // Preserve explicit `average: null` (sklearn's "return per-class") —
  // `??` would collapse it into the 'binary' default.
  const average = 'average' in opts ? opts.average : 'binary';
  if (average == null) return arr;

  if (average === 'binary') {
    const pos = opts.pos_label ?? 1;
    let i = labels.indexOf(pos);
    if (i === -1) {
      // Match sklearn: not finding pos_label in binary mode raises.
      throw new ValidationError(
        `${which}_score(average='binary'): pos_label=${pos} not found in y_true. ` +
        `Set average='macro' / 'micro' / 'weighted' for multi-class problems.`);
    }
    return arr[i];
  }
  if (average === 'macro') {
    if (arr.length === 0) return 0;
    let s = 0; for (const v of arr) s += v; return s / arr.length;
  }
  if (average === 'weighted') {
    let total_support = 0;
    for (const s of stats.support) total_support += s;
    if (total_support === 0) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i] * stats.support[i];
    return s / total_support;
  }
  if (average === 'micro') {
    // Recompute totals globally rather than averaging per-class scores.
    let TP = 0, FP = 0, FN = 0;
    const yt = _asArr(y_true);
    const yp = _asArr(y_pred);
    const idx = new Map();
    for (let i = 0; i < labels.length; i++) idx.set(labels[i], i);
    const w = opts.sample_weight ?? null;
    for (let i = 0; i < yt.length; i++) {
      const ti = idx.get(yt[i]);
      const pi = idx.get(yp[i]);
      const wi = w == null ? 1 : +w[i];
      if (ti === pi && ti !== undefined) TP += wi;
      else {
        if (pi !== undefined) FP += wi;
        if (ti !== undefined) FN += wi;
      }
    }
    const zero = opts.zero_division ?? 0;
    if (which === 'precision') return (TP + FP) === 0 ? zero : TP / (TP + FP);
    if (which === 'recall') return (TP + FN) === 0 ? zero : TP / (TP + FN);
    // f1 micro
    const p = (TP + FP) === 0 ? zero : TP / (TP + FP);
    const r = (TP + FN) === 0 ? zero : TP / (TP + FN);
    return (p + r) === 0 ? zero : 2 * p * r / (p + r);
  }
  throw new ValidationError(
    `${which}_score: unknown average='${average}' (use 'binary' | 'micro' | 'macro' | 'weighted' | null)`);
}
