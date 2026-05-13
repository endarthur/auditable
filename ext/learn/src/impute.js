// Imputation — SimpleImputer, KNNImputer, BDLImputer.
//
// Two flavors of missingness:
//   - generic (NaN markers): SimpleImputer, KNNImputer
//   - censored (below-detection-limit): BDLImputer (geo-distinctive,
//     SPEC §5.3)
//
// The two are conceptually distinct and shouldn't be conflated:
// generic missing means "we don't know the value"; censored missing
// means "we know the value is small but not how small". For assay
// data, mixing them produces statistically wrong downstream estimates.

import { BaseEstimator, TransformerMixin } from './base.js';
import { asMatrix, checkNFeatures, ValidationError } from './util/checks.js';
import { learnRegistry } from './serialize.js';
// Cross-package: scitra's ndtri (inverse normal CDF) for lognormal ROS.
import { ndtri } from '../../scitra/index.js';

const MODULE_ID_IMPUTE = '@gcu/learn.impute';

// ────────────────────────────────────────────────────────────────────
// SimpleImputer
// ────────────────────────────────────────────────────────────────────

/**
 * Per-column imputation with mean / median / most_frequent / constant.
 *
 * Hyperparameters:
 *   - missing_values  (number, default NaN) — value treated as missing
 *   - strategy        ('mean' | 'median' | 'most_frequent' | 'constant')
 *   - fill_value      (number, used by strategy='constant'; default 0)
 *   - keep_empty_features (bool, default false) — whether to keep all-missing
 *                     columns in output (filled with 0 / fill_value)
 *
 * Fitted attributes:
 *   - statistics_     (Float64Array, n_features)
 *   - n_features_in_, n_samples_seen_
 */
export class SimpleImputer extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.missing_values = params.missing_values ?? NaN;
    this.strategy = params.strategy ?? 'mean';
    this.fill_value = params.fill_value ?? 0;
    this.keep_empty_features = params.keep_empty_features ?? false;
    this._module = MODULE_ID_IMPUTE;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X, { allow_nan: true });
    const [n, m] = shape;
    if (n < 1) throw new ValidationError('SimpleImputer.fit: X has 0 samples');
    const isMissingNaN = Number.isNaN(this.missing_values);
    const isMissing = (v) => isMissingNaN ? Number.isNaN(v) : v === this.missing_values;
    const stats = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const col = [];
      for (let i = 0; i < n; i++) {
        const v = data[i * m + j];
        if (!isMissing(v)) col.push(v);
      }
      if (col.length === 0) {
        // All-missing column — fill_value (or 0 for non-constant strategies).
        stats[j] = this.strategy === 'constant' ? this.fill_value : 0;
        continue;
      }
      switch (this.strategy) {
        case 'mean': {
          let s = 0; for (const v of col) s += v;
          stats[j] = s / col.length;
          break;
        }
        case 'median': {
          col.sort((a, b) => a - b);
          const mid = col.length >> 1;
          stats[j] = (col.length & 1) ? col[mid] : 0.5 * (col[mid - 1] + col[mid]);
          break;
        }
        case 'most_frequent': {
          const counts = new Map();
          for (const v of col) counts.set(v, (counts.get(v) ?? 0) + 1);
          let best = col[0], bestN = 0;
          for (const [v, c] of counts) if (c > bestN) { best = v; bestN = c; }
          stats[j] = best;
          break;
        }
        case 'constant':
          stats[j] = this.fill_value;
          break;
        default:
          throw new ValidationError(
            `SimpleImputer: strategy='${this.strategy}' must be 'mean'|'median'|'most_frequent'|'constant'`);
      }
    }
    this.statistics_ = stats;
    this.n_features_in_ = m;
    this.n_samples_seen_ = n;
    return this;
  }

  transform(X) {
    if (this.statistics_ == null) throw new ValidationError('SimpleImputer: not fitted');
    const { data, shape } = asMatrix(X, { allow_nan: true });
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const isMissingNaN = Number.isNaN(this.missing_values);
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        const v = data[off + j];
        const missing = isMissingNaN ? Number.isNaN(v) : v === this.missing_values;
        out[off + j] = missing ? this.statistics_[j] : v;
      }
    }
    out.shape = [n, m];
    return out;
  }

}

Object.assign(SimpleImputer.prototype, TransformerMixin);
// Override AFTER the mixin so allow_nan: true sticks (Object.assign
// would otherwise overwrite the class's __sklearn_tags__ method).
SimpleImputer.prototype.__sklearn_tags__ = function () {
  const base = TransformerMixin.__sklearn_tags__.call(this);
  return { ...base, allow_nan: true };
};
SimpleImputer._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// KNNImputer
// ────────────────────────────────────────────────────────────────────

/**
 * KNN imputation. For each row with missing values, finds the
 * `n_neighbors` closest training rows under nan_euclidean distance
 * (which ignores features missing in either operand and rescales by
 * present-feature count), then averages those neighbors' values to
 * fill the missing cells.
 *
 * Hyperparameters:
 *   - n_neighbors    (int, default 5)
 *   - weights        ('uniform' | 'distance', default 'uniform')
 *   - missing_values (number, default NaN)
 *   - keep_empty_features (bool, default false)
 *
 * Fitted attributes: fit_X_, mask_fit_X_, n_features_in_.
 *
 * Algorithm: brute-force O(n_train × n_test × m). KDTree integration
 * deferred — nan_euclidean isn't a standard KDTree metric and writing
 * a custom one for v0.2 isn't justified at the n where browser
 * imputation runs (≤ a few thousand samples).
 */
export class KNNImputer extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_neighbors = params.n_neighbors ?? 5;
    this.weights = params.weights ?? 'uniform';
    this.missing_values = params.missing_values ?? NaN;
    this.keep_empty_features = params.keep_empty_features ?? false;
    this._module = MODULE_ID_IMPUTE;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X, { allow_nan: true });
    const [n, m] = shape;
    if (n < 1) throw new ValidationError('KNNImputer.fit: X has 0 samples');
    const isMissingNaN = Number.isNaN(this.missing_values);
    const mask = new Uint8Array(n * m);  // 1 = present, 0 = missing
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const v = data[i * m + j];
        const missing = isMissingNaN ? Number.isNaN(v) : v === this.missing_values;
        mask[i * m + j] = missing ? 0 : 1;
      }
    }
    this.fit_X_ = new Float64Array(data);  // copy to detach from caller
    this.mask_fit_X_ = mask;
    this.n_features_in_ = m;
    return this;
  }

  transform(X) {
    if (this.fit_X_ == null) throw new ValidationError('KNNImputer: not fitted');
    const { data, shape } = asMatrix(X, { allow_nan: true });
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const fit_data = this.fit_X_;
    const fit_mask = this.mask_fit_X_;
    const fit_n = fit_data.length / m;
    const isMissingNaN = Number.isNaN(this.missing_values);
    const out = new Float64Array(n * m);
    out.set(data);  // start with the original values
    out.shape = [n, m];

    const k = this.n_neighbors;
    // Per-row processing.
    for (let i = 0; i < n; i++) {
      // Find which features are missing in this row.
      const missing_cols = [];
      for (let j = 0; j < m; j++) {
        const v = data[i * m + j];
        const missing = isMissingNaN ? Number.isNaN(v) : v === this.missing_values;
        if (missing) missing_cols.push(j);
      }
      if (missing_cols.length === 0) continue;
      // For each missing column, find the k nearest training rows that
      // have a present value for THAT column. Compute distance using
      // nan_euclidean (ignoring features missing in either side).
      for (const target_col of missing_cols) {
        const dists = [];
        for (let r = 0; r < fit_n; r++) {
          if (!fit_mask[r * m + target_col]) continue;  // training row missing for target
          let sumsq = 0;
          let n_present = 0;
          for (let j = 0; j < m; j++) {
            if (j === target_col) continue;  // exclude the target column itself
            const xv = data[i * m + j];
            const yv = fit_data[r * m + j];
            const x_present = !(isMissingNaN ? Number.isNaN(xv) : xv === this.missing_values);
            if (!x_present || !fit_mask[r * m + j]) continue;
            const d = xv - yv;
            sumsq += d * d;
            n_present++;
          }
          if (n_present === 0) {
            // No common present features — skip this candidate.
            continue;
          }
          // nan_euclidean: scale by present-feature factor.
          const dist = Math.sqrt((m - 1) / n_present * sumsq);
          dists.push({ r, dist });
        }
        if (dists.length === 0) {
          // Fallback: column mean from training data.
          let s = 0, c = 0;
          for (let r = 0; r < fit_n; r++) {
            if (fit_mask[r * m + target_col]) { s += fit_data[r * m + target_col]; c++; }
          }
          out[i * m + target_col] = c > 0 ? s / c : 0;
          continue;
        }
        // Sort by distance, take top-k.
        dists.sort((a, b) => a.dist - b.dist);
        const top = dists.slice(0, Math.min(k, dists.length));
        // Aggregate.
        if (this.weights === 'distance') {
          let num = 0, den = 0;
          for (const t of top) {
            const w = t.dist === 0 ? 1e12 : 1 / t.dist;
            num += w * fit_data[t.r * m + target_col];
            den += w;
          }
          out[i * m + target_col] = den > 0 ? num / den : 0;
        } else {
          let s = 0;
          for (const t of top) s += fit_data[t.r * m + target_col];
          out[i * m + target_col] = s / top.length;
        }
      }
    }
    return out;
  }

}

Object.assign(KNNImputer.prototype, TransformerMixin);
KNNImputer.prototype.__sklearn_tags__ = function () {
  const base = TransformerMixin.__sklearn_tags__.call(this);
  return { ...base, allow_nan: true };
};
KNNImputer._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// BDLImputer (geo-distinctive)
// ────────────────────────────────────────────────────────────────────

/**
 * Below-detection-limit imputation. Distinct from generic imputation
 * because the missingness is informative (the value exists; we just
 * know it's small).
 *
 * Hyperparameters:
 *   - detection_limits  (number | array, default 0.001) — per-column
 *                       detection limits. Scalar broadcasts to all cols.
 *   - strategy          'multiplicative' (default; replace BDL with
 *                       0.65 × DL — Aitchison's compositional default)
 *                     | 'half' (replace BDL with 0.5 × DL — simpler
 *                       convention used widely outside compositional
 *                       data analysis)
 *                     | 'lognormal_ros' (fit lognormal MLE to above-
 *                       detection values, impute below-detection from
 *                       the lower tail using Blom-style plotting
 *                       positions and the fitted CDF)
 *   - random_state      (int|null) — only used by lognormal_ros to seed
 *                       plotting-position offsets if needed
 *
 * Convention. Zero values are treated as BDL markers — matches
 * @gcu/learn.compositional's _multiplicativeReplace. Negative values
 * are NOT supported (would conflate BDL with measurement error). For
 * lognormal_ros, columns with all-zero or single-non-zero values fall
 * back to multiplicative replacement (insufficient data for MLE).
 *
 * Fitted attributes:
 *   - detection_limits_  (Float64Array, n_features)
 *   - lognormal_params_  (Array of {mu, sigma} per column; only set when
 *                       strategy='lognormal_ros')
 *   - n_features_in_, n_samples_seen_
 *
 * Inverse transform is not defined — once a BDL value is imputed, the
 * original "below detection" status is lost.
 */
export class BDLImputer extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.detection_limits = params.detection_limits ?? 0.001;
    this.strategy = params.strategy ?? 'multiplicative';
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_IMPUTE;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X, { allow_nan: false });
    const [n, m] = shape;
    const dl = _resolveDLArray(this.detection_limits, m);
    this.detection_limits_ = dl;
    this.n_features_in_ = m;
    this.n_samples_seen_ = n;
    if (this.strategy === 'lognormal_ros') {
      // Fit lognormal MLE per column to above-detection values.
      this.lognormal_params_ = new Array(m);
      for (let j = 0; j < m; j++) {
        const above = [];
        for (let i = 0; i < n; i++) {
          const v = data[i * m + j];
          if (v > 0) above.push(v);
        }
        if (above.length < 2) {
          this.lognormal_params_[j] = null;  // fallback to multiplicative
          continue;
        }
        let log_sum = 0;
        for (const v of above) log_sum += Math.log(v);
        const mu = log_sum / above.length;
        let var_sum = 0;
        for (const v of above) {
          const d = Math.log(v) - mu;
          var_sum += d * d;
        }
        const sigma = Math.sqrt(var_sum / above.length);
        this.lognormal_params_[j] = { mu, sigma, n_above: above.length };
      }
    } else if (this.strategy !== 'multiplicative' && this.strategy !== 'half') {
      throw new ValidationError(
        `BDLImputer: strategy='${this.strategy}' must be 'multiplicative'|'half'|'lognormal_ros'`);
    }
    return this;
  }

  transform(X) {
    if (this.detection_limits_ == null) throw new ValidationError('BDLImputer: not fitted');
    const { data, shape } = asMatrix(X, { allow_nan: false });
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const dl = this.detection_limits_;
    const out = new Float64Array(n * m);
    out.set(data);
    if (this.strategy === 'multiplicative') {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          if (out[i * m + j] === 0) out[i * m + j] = 0.65 * dl[j];
        }
      }
    } else if (this.strategy === 'half') {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          if (out[i * m + j] === 0) out[i * m + j] = 0.5 * dl[j];
        }
      }
    } else if (this.strategy === 'lognormal_ros') {
      // For each column, find BDL positions and impute from the lower tail.
      // Blom plotting positions: p_i = (i - 0.375) / (n_below + 0.25), i = 1..n_below
      // Map to standard normal quantiles via ndtri, then to lognormal:
      //   x_i = exp(mu + sigma * z_i)
      // Constrain to (0, DL_j) — clip if mu/sigma yields values above DL_j.
      for (let j = 0; j < m; j++) {
        const params = this.lognormal_params_[j];
        // Collect BDL positions for this column.
        const bdl_positions = [];
        for (let i = 0; i < n; i++) {
          if (out[i * m + j] === 0) bdl_positions.push(i);
        }
        if (bdl_positions.length === 0) continue;
        if (!params) {
          // Fallback to multiplicative replacement.
          for (const i of bdl_positions) out[i * m + j] = 0.65 * dl[j];
          continue;
        }
        const { mu, sigma } = params;
        const n_below = bdl_positions.length;
        // Generate plotting-position quantile values (one per BDL position),
        // then assign sequentially to maintain reproducibility.
        for (let r = 0; r < n_below; r++) {
          const p = (r + 0.625) / (n_below + 0.25);  // Blom-like
          const z = ndtri(p);
          let v = Math.exp(mu + sigma * z);
          // Clip to (0, DL_j) since BDL means we know v < DL_j.
          if (v >= dl[j]) v = 0.65 * dl[j];
          if (v <= 0) v = 0.65 * dl[j];
          out[bdl_positions[r] * m + j] = v;
        }
      }
    }
    out.shape = [n, m];
    return out;
  }

  // Tag exposes that we *don't* allow NaN — only zeros are BDL markers.
}

Object.assign(BDLImputer.prototype, TransformerMixin);
BDLImputer._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function _resolveDLArray(spec, m) {
  if (typeof spec === 'number') {
    const out = new Float64Array(m);
    out.fill(spec);
    return out;
  }
  if (Array.isArray(spec) || ArrayBuffer.isView(spec)) {
    if (spec.length !== m) {
      throw new ValidationError(
        `BDLImputer: detection_limits length ${spec.length} != n_features ${m}`);
    }
    const out = new Float64Array(m);
    for (let j = 0; j < m; j++) out[j] = +spec[j];
    return out;
  }
  throw new ValidationError(
    `BDLImputer: detection_limits must be number or array; got ${typeof spec}`);
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('SimpleImputer', SimpleImputer, { module: MODULE_ID_IMPUTE });
learnRegistry.register('KNNImputer', KNNImputer, { module: MODULE_ID_IMPUTE });
learnRegistry.register('BDLImputer', BDLImputer, { module: MODULE_ID_IMPUTE });
