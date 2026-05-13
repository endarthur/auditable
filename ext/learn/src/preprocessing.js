// Preprocessing: feature scaling, encoding, discretization, power
// transformation. The workhorse transformers most ML workflows rely on.
//
// All transformers in this module return a Float64Array with `.shape`
// set as an own property (`[n, m]`). The asMatrix helper accepts this
// shape on input, so estimator outputs flow into other estimator inputs
// without copy.
//
// Conventions:
//   - Scalers (Standard/MinMax/Robust/MaxAbs) preserve column count.
//   - Encoders (Label/Ordinal/OneHot) accept arbitrary value types
//     (strings, ints, floats) and emit numeric output.
//   - OneHotEncoder expands columns; get_feature_names_out reports them.
//   - All transformers self-register on import for mimic-io load.

import { BaseEstimator, TransformerMixin } from './base.js';
import { asMatrix, asVector, checkNFeatures, ValidationError } from './util/checks.js';
import { learnRegistry } from './serialize.js';

const MODULE_ID_PREPROCESSING = '@gcu/learn.preprocessing';

// ────────────────────────────────────────────────────────────────────
// StandardScaler
// ────────────────────────────────────────────────────────────────────

/**
 * Standardize features by removing the mean and scaling to unit variance.
 *
 * Sklearn-compatible (`sklearn.preprocessing.StandardScaler`). Same
 * defaults, same fitted-attribute names, same numerical convention.
 *
 * Hyperparameters:
 *   - with_mean (bool, default true) — center before scaling
 *   - with_std  (bool, default true) — scale to unit variance
 *
 * Fitted attributes:
 *   - mean_              (Float64Array, m) — per-feature mean
 *   - scale_             (Float64Array, m) — per-feature scaling factor
 *   - var_               (Float64Array, m) — per-feature variance
 *   - n_samples_seen_    (number)          — number of training samples
 *   - n_features_in_     (number)          — number of input features
 *
 * Numerical convention. Variance is the population estimate (divide by
 * n), matching sklearn's default. When a feature has zero variance,
 * `scale_` for that feature is set to 1.0 — `transform` then returns
 * `(x - mean)` (or `0` when `with_mean=true`), avoiding division by zero.
 */
export class StandardScaler extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.with_mean = params.with_mean ?? true;
    this.with_std = params.with_std ?? true;
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    if (n < 1) throw new ValidationError('StandardScaler.fit: X has 0 samples');

    const mean = new Float64Array(m);
    if (this.with_mean || this.with_std) {
      for (let i = 0; i < n; i++) {
        const off = i * m;
        for (let j = 0; j < m; j++) mean[j] += data[off + j];
      }
      const inv_n = 1 / n;
      for (let j = 0; j < m; j++) mean[j] *= inv_n;
    }

    const variance = new Float64Array(m);
    if (this.with_std) {
      for (let i = 0; i < n; i++) {
        const off = i * m;
        for (let j = 0; j < m; j++) {
          const d = data[off + j] - mean[j];
          variance[j] += d * d;
        }
      }
      const inv_n = 1 / n;
      for (let j = 0; j < m; j++) variance[j] *= inv_n;
    }

    const scale = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const v = variance[j];
      // Match sklearn: zero-variance features get scale=1 (no scaling).
      scale[j] = (this.with_std && v > 0) ? Math.sqrt(v) : 1.0;
    }

    this.mean_ = mean;
    this.scale_ = scale;
    this.var_ = variance;
    this.n_samples_seen_ = n;
    this.n_features_in_ = m;
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    const mean = this.mean_;
    const scale = this.scale_;
    const center = this.with_mean;
    const norm = this.with_std;

    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        let v = data[off + j];
        if (center) v -= mean[j];
        if (norm) v /= scale[j];
        out[off + j] = v;
      }
    }
    out.shape = [n, m];
    return out;
  }

  inverse_transform(X) {
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    const mean = this.mean_;
    const scale = this.scale_;
    const uncenter = this.with_mean;
    const unnorm = this.with_std;

    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        let v = data[off + j];
        if (unnorm) v *= scale[j];
        if (uncenter) v += mean[j];
        out[off + j] = v;
      }
    }
    out.shape = [n, m];
    return out;
  }
}

Object.assign(StandardScaler.prototype, TransformerMixin);
StandardScaler._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// MinMaxScaler
// ────────────────────────────────────────────────────────────────────

/**
 * Scale features to a given range (default [0, 1]).
 *
 * Hyperparameters:
 *   - feature_range  ([min, max], default [0, 1])
 *
 * Fitted attributes:
 *   - data_min_, data_max_, data_range_  (Float64Array, m)
 *   - scale_, min_                        (Float64Array, m)
 *   - n_samples_seen_, n_features_in_
 *
 * For zero-range features (data_max == data_min), scale_ = 1 and
 * min_ = feature_range[0] — transform returns the lower bound.
 */
export class MinMaxScaler extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.feature_range = params.feature_range ?? [0, 1];
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    if (n < 1) throw new ValidationError('MinMaxScaler.fit: X has 0 samples');
    const [r_lo, r_hi] = this.feature_range;
    if (!(r_lo < r_hi)) {
      throw new ValidationError(
        `MinMaxScaler: feature_range must satisfy lo<hi; got [${r_lo}, ${r_hi}]`);
    }
    const data_min = new Float64Array(m);
    const data_max = new Float64Array(m);
    for (let j = 0; j < m; j++) { data_min[j] = Infinity; data_max[j] = -Infinity; }
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        const v = data[off + j];
        if (v < data_min[j]) data_min[j] = v;
        if (v > data_max[j]) data_max[j] = v;
      }
    }
    const data_range = new Float64Array(m);
    const scale = new Float64Array(m);
    const min_ = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      data_range[j] = data_max[j] - data_min[j];
      const s = data_range[j] === 0 ? 1 : (r_hi - r_lo) / data_range[j];
      scale[j] = s;
      min_[j] = r_lo - data_min[j] * s;
    }
    this.data_min_ = data_min;
    this.data_max_ = data_max;
    this.data_range_ = data_range;
    this.scale_ = scale;
    this.min_ = min_;
    this.n_samples_seen_ = n;
    this.n_features_in_ = m;
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) out[off + j] = data[off + j] * this.scale_[j] + this.min_[j];
    }
    out.shape = [n, m];
    return out;
  }

  inverse_transform(X) {
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) out[off + j] = (data[off + j] - this.min_[j]) / this.scale_[j];
    }
    out.shape = [n, m];
    return out;
  }
}

Object.assign(MinMaxScaler.prototype, TransformerMixin);
MinMaxScaler._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// MaxAbsScaler
// ────────────────────────────────────────────────────────────────────

/**
 * Scale each feature by its maximum absolute value. Output ranges in
 * [-1, 1]; zeros and signs preserved (useful for sparsity-friendly
 * downstream methods, even though we don't ship sparse matrices).
 *
 * Fitted attributes:
 *   - max_abs_, scale_           (Float64Array, m)
 *   - n_samples_seen_, n_features_in_
 *
 * Zero max_abs collapses scale_ to 1 (transform returns 0 for that col).
 */
export class MaxAbsScaler extends BaseEstimator {
  constructor(_params = {}) {
    super();
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    const max_abs = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        const a = Math.abs(data[off + j]);
        if (a > max_abs[j]) max_abs[j] = a;
      }
    }
    const scale = new Float64Array(m);
    for (let j = 0; j < m; j++) scale[j] = max_abs[j] === 0 ? 1 : max_abs[j];
    this.max_abs_ = max_abs;
    this.scale_ = scale;
    this.n_samples_seen_ = n;
    this.n_features_in_ = m;
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) out[off + j] = data[off + j] / this.scale_[j];
    }
    out.shape = [n, m];
    return out;
  }

  inverse_transform(X) {
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) out[off + j] = data[off + j] * this.scale_[j];
    }
    out.shape = [n, m];
    return out;
  }
}

Object.assign(MaxAbsScaler.prototype, TransformerMixin);
MaxAbsScaler._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// RobustScaler
// ────────────────────────────────────────────────────────────────────

/**
 * Scale features using median (centering) and inter-quartile range
 * (scaling), robust to outliers.
 *
 * Hyperparameters:
 *   - with_centering   (bool, default true)
 *   - with_scaling     (bool, default true)
 *   - quantile_range   ([lo, hi], default [25.0, 75.0]) — percentiles
 *
 * Fitted attributes: center_, scale_  (Float64Array, m).
 * Zero-IQR features get scale_ = 1.
 */
export class RobustScaler extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.with_centering = params.with_centering ?? true;
    this.with_scaling = params.with_scaling ?? true;
    this.quantile_range = params.quantile_range ?? [25.0, 75.0];
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    if (n < 1) throw new ValidationError('RobustScaler.fit: X has 0 samples');
    const [q_lo, q_hi] = this.quantile_range;
    if (!(q_lo < q_hi) || q_lo < 0 || q_hi > 100) {
      throw new ValidationError(
        `RobustScaler: quantile_range must be [lo, hi] in [0,100]; got [${q_lo}, ${q_hi}]`);
    }
    const center = new Float64Array(m);
    const scale = new Float64Array(m);
    const col = new Float64Array(n);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) col[i] = data[i * m + j];
      const sorted = Array.from(col).sort((a, b) => a - b);
      if (this.with_centering) center[j] = _quantile(sorted, 50);
      if (this.with_scaling) {
        const lo = _quantile(sorted, q_lo);
        const hi = _quantile(sorted, q_hi);
        const iqr = hi - lo;
        scale[j] = iqr === 0 ? 1 : iqr;
      } else {
        scale[j] = 1;
      }
    }
    this.center_ = center;
    this.scale_ = scale;
    this.n_features_in_ = m;
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    const c = this.with_centering;
    const s = this.with_scaling;
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        let v = data[off + j];
        if (c) v -= this.center_[j];
        if (s) v /= this.scale_[j];
        out[off + j] = v;
      }
    }
    out.shape = [n, m];
    return out;
  }

  inverse_transform(X) {
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    const c = this.with_centering;
    const s = this.with_scaling;
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        let v = data[off + j];
        if (s) v *= this.scale_[j];
        if (c) v += this.center_[j];
        out[off + j] = v;
      }
    }
    out.shape = [n, m];
    return out;
  }
}

Object.assign(RobustScaler.prototype, TransformerMixin);
RobustScaler._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// LabelEncoder
// ────────────────────────────────────────────────────────────────────

/**
 * Encode target labels to integer values 0..k-1.
 *
 * Operates on 1D arrays (y), not 2D matrices (X). For per-column
 * encoding of features use OrdinalEncoder. classes_ stores the original
 * labels in sorted order.
 */
export class LabelEncoder extends BaseEstimator {
  constructor(_params = {}) {
    super();
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(y, _opts) {
    const arr = _asLabelArray1d(y);
    const classes = _uniqueSorted(arr);
    this.classes_ = classes;
    return this;
  }

  transform(y) {
    if (this.classes_ == null) throw new ValidationError('LabelEncoder: not fitted');
    const arr = _asLabelArray1d(y);
    const idx = new Map();
    for (let i = 0; i < this.classes_.length; i++) idx.set(this.classes_[i], i);
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!idx.has(v)) {
        throw new ValidationError(
          `LabelEncoder: unknown label '${v}' at index ${i}; ` +
          `known labels are [${this.classes_.join(', ')}]`);
      }
      out[i] = idx.get(v);
    }
    return out;
  }

  fit_transform(y) {
    return this.fit(y).transform(y);
  }

  inverse_transform(yEnc) {
    if (this.classes_ == null) throw new ValidationError('LabelEncoder: not fitted');
    const arr = _asLabelArray1d(yEnc);
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const k = arr[i] | 0;
      if (k < 0 || k >= this.classes_.length) {
        throw new ValidationError(
          `LabelEncoder.inverse_transform: encoded value ${k} out of range [0, ${this.classes_.length})`);
      }
      out[i] = this.classes_[k];
    }
    return out;
  }
}

LabelEncoder._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// OrdinalEncoder
// ────────────────────────────────────────────────────────────────────

/**
 * Encode each column of X to integer 0..k_j-1 based on the column's
 * unique values.
 *
 * Hyperparameters:
 *   - categories       'auto' | array of arrays  (per-column known labels)
 *   - handle_unknown   'error' | 'use_encoded_value'  (default 'error')
 *   - unknown_value    number (default NaN; required when handle_unknown='use_encoded_value')
 *
 * Fitted attributes:
 *   - categories_      array of per-column arrays (sorted unique labels)
 *   - n_features_in_
 */
export class OrdinalEncoder extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.categories = params.categories ?? 'auto';
    this.handle_unknown = params.handle_unknown ?? 'error';
    this.unknown_value = params.unknown_value ?? NaN;
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(X, _y, _opts) {
    const cols = _columnsToArrays(X);
    let categories;
    if (this.categories === 'auto') {
      categories = cols.map(c => _uniqueSorted(c));
    } else {
      if (!Array.isArray(this.categories) || this.categories.length !== cols.length) {
        throw new ValidationError(
          `OrdinalEncoder: categories must be 'auto' or array of length n_features (${cols.length})`);
      }
      categories = this.categories.map(arr => arr.slice());
    }
    this.categories_ = categories;
    this.n_features_in_ = cols.length;
    return this;
  }

  transform(X) {
    if (this.categories_ == null) throw new ValidationError('OrdinalEncoder: not fitted');
    const cols = _columnsToArrays(X);
    if (cols.length !== this.n_features_in_) {
      throw new ValidationError(
        `OrdinalEncoder.transform: X has ${cols.length} features, expected ${this.n_features_in_}`);
    }
    const n = cols[0].length;
    const m = cols.length;
    const out = new Float64Array(n * m);
    for (let j = 0; j < m; j++) {
      const idx = new Map();
      const cats = this.categories_[j];
      for (let k = 0; k < cats.length; k++) idx.set(cats[k], k);
      for (let i = 0; i < n; i++) {
        const v = cols[j][i];
        if (idx.has(v)) {
          out[i * m + j] = idx.get(v);
        } else if (this.handle_unknown === 'use_encoded_value') {
          out[i * m + j] = this.unknown_value;
        } else {
          throw new ValidationError(
            `OrdinalEncoder: unknown category '${v}' in column ${j} at row ${i}`);
        }
      }
    }
    out.shape = [n, m];
    return out;
  }

  inverse_transform(X) {
    if (this.categories_ == null) throw new ValidationError('OrdinalEncoder: not fitted');
    const { data, shape } = asMatrix(X);
    if (shape[1] !== this.n_features_in_) {
      throw new ValidationError(
        `OrdinalEncoder.inverse_transform: X has ${shape[1]} features, expected ${this.n_features_in_}`);
    }
    const [n, m] = shape;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = new Array(m);
      for (let j = 0; j < m; j++) {
        const k = data[i * m + j] | 0;
        const cats = this.categories_[j];
        row[j] = (k >= 0 && k < cats.length) ? cats[k] : null;
      }
      out[i] = row;
    }
    return out;
  }
}

Object.assign(OrdinalEncoder.prototype, TransformerMixin);
OrdinalEncoder._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// OneHotEncoder
// ────────────────────────────────────────────────────────────────────

/**
 * One-hot expand each input column to len(categories_[col]) binary
 * columns. Output is dense (no scipy.sparse — see SPEC §3.6 dev #3).
 *
 * Hyperparameters:
 *   - categories       'auto' | array of arrays
 *   - drop             null | 'first' | 'if_binary'  (omit one column per feature)
 *   - handle_unknown   'error' | 'ignore'  (default 'error'; 'ignore' = all-zero row)
 *
 * Fitted attributes:
 *   - categories_, drop_idx_  (Int32Array — index into categories_[j], or -1)
 *   - n_features_in_, n_features_out_
 */
export class OneHotEncoder extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.categories = params.categories ?? 'auto';
    this.drop = params.drop ?? null;
    this.handle_unknown = params.handle_unknown ?? 'error';
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(X, _y, _opts) {
    const cols = _columnsToArrays(X);
    let categories;
    if (this.categories === 'auto') {
      categories = cols.map(c => _uniqueSorted(c));
    } else {
      if (!Array.isArray(this.categories) || this.categories.length !== cols.length) {
        throw new ValidationError(
          `OneHotEncoder: categories must be 'auto' or array of length n_features (${cols.length})`);
      }
      categories = this.categories.map(arr => arr.slice());
    }
    const drop_idx = new Int32Array(cols.length);
    drop_idx.fill(-1);
    if (this.drop === 'first') {
      for (let j = 0; j < cols.length; j++) drop_idx[j] = 0;
    } else if (this.drop === 'if_binary') {
      for (let j = 0; j < cols.length; j++) if (categories[j].length === 2) drop_idx[j] = 0;
    } else if (this.drop != null) {
      throw new ValidationError(
        `OneHotEncoder: drop must be null | 'first' | 'if_binary'; got '${this.drop}'`);
    }
    let n_out = 0;
    for (let j = 0; j < cols.length; j++) {
      n_out += categories[j].length - (drop_idx[j] >= 0 ? 1 : 0);
    }
    this.categories_ = categories;
    this.drop_idx_ = drop_idx;
    this.n_features_in_ = cols.length;
    this.n_features_out_ = n_out;
    return this;
  }

  transform(X) {
    if (this.categories_ == null) throw new ValidationError('OneHotEncoder: not fitted');
    const cols = _columnsToArrays(X);
    if (cols.length !== this.n_features_in_) {
      throw new ValidationError(
        `OneHotEncoder.transform: X has ${cols.length} features, expected ${this.n_features_in_}`);
    }
    const n = cols[0].length;
    const out = new Float64Array(n * this.n_features_out_);
    // Per-feature output column offsets.
    const offsets = new Int32Array(cols.length);
    let acc = 0;
    for (let j = 0; j < cols.length; j++) {
      offsets[j] = acc;
      acc += this.categories_[j].length - (this.drop_idx_[j] >= 0 ? 1 : 0);
    }
    for (let j = 0; j < cols.length; j++) {
      const cats = this.categories_[j];
      const drop = this.drop_idx_[j];
      const idx = new Map();
      for (let k = 0; k < cats.length; k++) idx.set(cats[k], k);
      for (let i = 0; i < n; i++) {
        const v = cols[j][i];
        if (!idx.has(v)) {
          if (this.handle_unknown === 'ignore') continue;
          throw new ValidationError(
            `OneHotEncoder: unknown category '${v}' in column ${j} at row ${i}`);
        }
        const k = idx.get(v);
        if (k === drop) continue;
        const col_idx = drop >= 0 && k > drop ? k - 1 : k;
        out[i * this.n_features_out_ + offsets[j] + col_idx] = 1;
      }
    }
    out.shape = [n, this.n_features_out_];
    return out;
  }

  inverse_transform(X) {
    if (this.categories_ == null) throw new ValidationError('OneHotEncoder: not fitted');
    const { data, shape } = asMatrix(X);
    if (shape[1] !== this.n_features_out_) {
      throw new ValidationError(
        `OneHotEncoder.inverse_transform: X has ${shape[1]} columns, expected ${this.n_features_out_}`);
    }
    const [n, m_out] = shape;
    const offsets = new Int32Array(this.n_features_in_);
    let acc = 0;
    for (let j = 0; j < this.n_features_in_; j++) {
      offsets[j] = acc;
      acc += this.categories_[j].length - (this.drop_idx_[j] >= 0 ? 1 : 0);
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = new Array(this.n_features_in_);
      for (let j = 0; j < this.n_features_in_; j++) {
        const cats = this.categories_[j];
        const drop = this.drop_idx_[j];
        const w = cats.length - (drop >= 0 ? 1 : 0);
        let chosen = -1;
        for (let k = 0; k < w; k++) {
          if (data[i * m_out + offsets[j] + k] > 0.5) { chosen = k; break; }
        }
        if (chosen === -1 && drop >= 0) {
          // No bit set + drop active → it's the dropped category.
          row[j] = cats[drop];
        } else if (chosen === -1) {
          row[j] = null;  // handle_unknown='ignore' produced an all-zero row
        } else {
          // Map the column index back to the original category index.
          const k = drop >= 0 && chosen >= drop ? chosen + 1 : chosen;
          row[j] = cats[k];
        }
      }
      out[i] = row;
    }
    return out;
  }

  /**
   * Output column names: "<input_feature_<j>>_<category>" by default.
   * Pass a string array of input feature names to use those instead.
   */
  get_feature_names_out(input_features = null) {
    if (this.categories_ == null) {
      throw new ValidationError('OneHotEncoder: not fitted');
    }
    const names = [];
    for (let j = 0; j < this.n_features_in_; j++) {
      const base = input_features?.[j] ?? `x${j}`;
      const cats = this.categories_[j];
      const drop = this.drop_idx_[j];
      for (let k = 0; k < cats.length; k++) {
        if (k === drop) continue;
        names.push(`${base}_${cats[k]}`);
      }
    }
    return names;
  }
}

Object.assign(OneHotEncoder.prototype, TransformerMixin);
OneHotEncoder._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// KBinsDiscretizer
// ────────────────────────────────────────────────────────────────────

/**
 * Bin continuous features into intervals (ordinal output).
 *
 * Hyperparameters:
 *   - n_bins    int | array (default 5; per-feature when array)
 *   - strategy  'uniform' | 'quantile'  (default 'quantile')
 *   - encode    'ordinal' (only — 'onehot' deferred to v0.2)
 *
 * Fitted attributes:
 *   - bin_edges_  array of per-column Float64Array of edges (length k+1)
 *   - n_bins_     Int32Array of per-column actual bin counts
 */
export class KBinsDiscretizer extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_bins = params.n_bins ?? 5;
    this.strategy = params.strategy ?? 'quantile';
    this.encode = params.encode ?? 'ordinal';
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    if (this.encode !== 'ordinal') {
      throw new ValidationError(
        `KBinsDiscretizer: encode='${this.encode}' not supported in v0.1 (use 'ordinal')`);
    }
    const n_bins = _resolveNBins(this.n_bins, m);
    const bin_edges = new Array(m);
    const actual_bins = new Int32Array(m);
    const col = new Float64Array(n);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) col[i] = data[i * m + j];
      const k = n_bins[j];
      if (k < 2) {
        throw new ValidationError(
          `KBinsDiscretizer: n_bins[${j}]=${k} must be >= 2`);
      }
      let edges;
      if (this.strategy === 'uniform') {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) {
          if (col[i] < lo) lo = col[i];
          if (col[i] > hi) hi = col[i];
        }
        edges = new Float64Array(k + 1);
        for (let i = 0; i <= k; i++) edges[i] = lo + (hi - lo) * i / k;
      } else if (this.strategy === 'quantile') {
        const sorted = Array.from(col).sort((a, b) => a - b);
        edges = new Float64Array(k + 1);
        for (let i = 0; i <= k; i++) edges[i] = _quantile(sorted, 100 * i / k);
      } else {
        throw new ValidationError(
          `KBinsDiscretizer: strategy='${this.strategy}' must be 'uniform' | 'quantile'`);
      }
      // Collapse degenerate edges (zero-width bins) — sklearn warns + collapses.
      const unique = [edges[0]];
      for (let i = 1; i < edges.length; i++) {
        if (edges[i] > unique[unique.length - 1]) unique.push(edges[i]);
      }
      bin_edges[j] = Float64Array.from(unique);
      actual_bins[j] = unique.length - 1;
    }
    this.bin_edges_ = bin_edges;
    this.n_bins_ = actual_bins;
    this.n_features_in_ = m;
    return this;
  }

  transform(X) {
    if (this.bin_edges_ == null) throw new ValidationError('KBinsDiscretizer: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    for (let j = 0; j < m; j++) {
      const edges = this.bin_edges_[j];
      const k = this.n_bins_[j];
      for (let i = 0; i < n; i++) {
        const v = data[i * m + j];
        // Find which bin (0..k-1). Clip to first/last bin for outliers.
        let bin = 0;
        for (let b = 1; b < k; b++) {
          if (v >= edges[b]) bin = b; else break;
        }
        out[i * m + j] = bin;
      }
    }
    out.shape = [n, m];
    return out;
  }
}

Object.assign(KBinsDiscretizer.prototype, TransformerMixin);
KBinsDiscretizer._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// PowerTransformer (Yeo-Johnson)
// ────────────────────────────────────────────────────────────────────

/**
 * Power transform (Yeo-Johnson only in v0.1) to make data more
 * Gaussian-like. Lambda fit per feature via golden-section search on
 * the log-likelihood.
 *
 * Hyperparameters:
 *   - method        'yeo-johnson'  (only; Box-Cox excluded as it requires
 *                    strictly positive input)
 *   - standardize   bool (default true) — apply zero-mean unit-variance
 *                    after the power transform, like sklearn does
 *
 * Fitted attributes:
 *   - lambdas_      Float64Array, m
 *   - mean_, scale_ (Float64Array, m) — when standardize=true
 *   - n_features_in_
 */
export class PowerTransformer extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.method = params.method ?? 'yeo-johnson';
    this.standardize = params.standardize ?? true;
    this._module = MODULE_ID_PREPROCESSING;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    if (this.method !== 'yeo-johnson') {
      throw new ValidationError(
        `PowerTransformer: method='${this.method}' not supported in v0.1 (use 'yeo-johnson')`);
    }
    const lambdas = new Float64Array(m);
    const col = new Float64Array(n);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) col[i] = data[i * m + j];
      lambdas[j] = _fitYeoJohnsonLambda(col);
    }
    this.lambdas_ = lambdas;
    this.n_features_in_ = m;
    if (this.standardize) {
      // Apply transform once, then fit a StandardScaler on the result.
      const Xt = this._yeoJohnsonForward(data, n, m);
      const mean = new Float64Array(m);
      const variance = new Float64Array(m);
      for (let i = 0; i < n; i++) {
        const off = i * m;
        for (let j = 0; j < m; j++) mean[j] += Xt[off + j];
      }
      const inv_n = 1 / n;
      for (let j = 0; j < m; j++) mean[j] *= inv_n;
      for (let i = 0; i < n; i++) {
        const off = i * m;
        for (let j = 0; j < m; j++) {
          const d = Xt[off + j] - mean[j];
          variance[j] += d * d;
        }
      }
      for (let j = 0; j < m; j++) variance[j] *= inv_n;
      const scale = new Float64Array(m);
      for (let j = 0; j < m; j++) scale[j] = variance[j] > 0 ? Math.sqrt(variance[j]) : 1;
      this.mean_ = mean;
      this.scale_ = scale;
    }
    return this;
  }

  transform(X) {
    if (this.lambdas_ == null) throw new ValidationError('PowerTransformer: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const Xt = this._yeoJohnsonForward(data, n, m);
    if (this.standardize) {
      for (let i = 0; i < n; i++) {
        const off = i * m;
        for (let j = 0; j < m; j++) {
          Xt[off + j] = (Xt[off + j] - this.mean_[j]) / this.scale_[j];
        }
      }
    }
    Xt.shape = [n, m];
    return Xt;
  }

  inverse_transform(X) {
    if (this.lambdas_ == null) throw new ValidationError('PowerTransformer: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        let v = data[off + j];
        if (this.standardize) v = v * this.scale_[j] + this.mean_[j];
        out[off + j] = _yeoJohnsonInverse(v, this.lambdas_[j]);
      }
    }
    out.shape = [n, m];
    return out;
  }

  _yeoJohnsonForward(data, n, m) {
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) {
        out[off + j] = _yeoJohnson(data[off + j], this.lambdas_[j]);
      }
    }
    return out;
  }
}

Object.assign(PowerTransformer.prototype, TransformerMixin);
PowerTransformer._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

// Linear-interpolation quantile from a sorted array; q in [0, 100].
function _quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Coerce 1D input to a JS array (preserves arbitrary value types).
function _asLabelArray1d(y) {
  if (y == null) throw new ValidationError('input is null/undefined');
  if (Array.isArray(y)) return y;
  if (ArrayBuffer.isView(y)) return Array.from(y);
  throw new ValidationError(`expected 1D array; got ${typeof y}`);
}

// Sorted unique values from a 1D array. Numbers sort numerically;
// strings lexicographically; mixed types compared via String() coercion.
function _uniqueSorted(arr) {
  const seen = new Set();
  for (const v of arr) seen.add(v);
  const u = [...seen];
  // If all numeric, sort numerically; else lexicographic on String().
  const allNumeric = u.every(v => typeof v === 'number');
  if (allNumeric) u.sort((a, b) => a - b);
  else u.sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  return u;
}

// Convert input X (2D nested array, Float64Array.shape, or {data,shape}) to
// per-column JS arrays. Preserves arbitrary value types — encoders work
// on strings/ints/floats uniformly.
function _columnsToArrays(X) {
  if (Array.isArray(X) && X.length > 0 && Array.isArray(X[0])) {
    const n = X.length;
    const m = X[0].length;
    const cols = Array.from({ length: m }, () => new Array(n));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) cols[j][i] = X[i][j];
    }
    return cols;
  }
  // Fall back to numeric matrix shape.
  const { data, shape } = asMatrix(X);
  const [n, m] = shape;
  const cols = Array.from({ length: m }, () => new Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) cols[j][i] = data[i * m + j];
  }
  return cols;
}

function _resolveNBins(spec, m) {
  if (typeof spec === 'number') {
    const out = new Int32Array(m);
    out.fill(spec);
    return out;
  }
  if (Array.isArray(spec) || ArrayBuffer.isView(spec)) {
    if (spec.length !== m) {
      throw new ValidationError(
        `KBinsDiscretizer: n_bins array length ${spec.length} != n_features ${m}`);
    }
    const out = new Int32Array(m);
    for (let j = 0; j < m; j++) out[j] = spec[j] | 0;
    return out;
  }
  throw new ValidationError(`KBinsDiscretizer: n_bins must be int or array`);
}

// Yeo-Johnson forward transform.
function _yeoJohnson(x, lambda) {
  if (x >= 0) {
    if (lambda === 0) return Math.log1p(x);
    return (Math.pow(x + 1, lambda) - 1) / lambda;
  } else {
    if (lambda === 2) return -Math.log1p(-x);
    return -(Math.pow(-x + 1, 2 - lambda) - 1) / (2 - lambda);
  }
}

// Yeo-Johnson inverse.
function _yeoJohnsonInverse(y, lambda) {
  if (y >= 0) {
    if (lambda === 0) return Math.expm1(y);
    return Math.pow(y * lambda + 1, 1 / lambda) - 1;
  } else {
    if (lambda === 2) return -Math.expm1(-y);
    return -(Math.pow(-y * (2 - lambda) + 1, 1 / (2 - lambda)) - 1);
  }
}

// Maximum-likelihood lambda for Yeo-Johnson via golden-section search
// over [-2, 2]. Returns the lambda that maximizes the log-likelihood
// of the transformed column being normally distributed.
function _fitYeoJohnsonLambda(col) {
  const n = col.length;
  // Precompute log-Jacobian helper sum (for the standard YJ likelihood).
  let log_jac_const = 0;
  for (let i = 0; i < n; i++) log_jac_const += Math.sign(col[i]) * Math.log(Math.abs(col[i]) + 1);

  const ll = (lambda) => {
    // Transform the column, compute variance, then likelihood.
    let sum = 0, sq = 0;
    for (let i = 0; i < n; i++) {
      const t = _yeoJohnson(col[i], lambda);
      sum += t; sq += t * t;
    }
    const mean = sum / n;
    const variance = Math.max(1e-300, sq / n - mean * mean);
    return -n / 2 * Math.log(variance) + (lambda - 1) * log_jac_const;
  };

  // Golden-section search maximizing ll over [-2, 2].
  const phi = (Math.sqrt(5) - 1) / 2;  // ≈ 0.618
  let a = -2, b = 2;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let llc = ll(c), lld = ll(d);
  for (let iter = 0; iter < 100; iter++) {
    if (Math.abs(b - a) < 1e-6) break;
    if (llc > lld) {
      b = d; d = c; lld = llc;
      c = b - phi * (b - a);
      llc = ll(c);
    } else {
      a = c; c = d; llc = lld;
      d = a + phi * (b - a);
      lld = ll(d);
    }
  }
  return (a + b) / 2;
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('StandardScaler', StandardScaler, { module: MODULE_ID_PREPROCESSING });
learnRegistry.register('MinMaxScaler', MinMaxScaler, { module: MODULE_ID_PREPROCESSING });
learnRegistry.register('MaxAbsScaler', MaxAbsScaler, { module: MODULE_ID_PREPROCESSING });
learnRegistry.register('RobustScaler', RobustScaler, { module: MODULE_ID_PREPROCESSING });
learnRegistry.register('LabelEncoder', LabelEncoder, { module: MODULE_ID_PREPROCESSING });
learnRegistry.register('OrdinalEncoder', OrdinalEncoder, { module: MODULE_ID_PREPROCESSING });
learnRegistry.register('OneHotEncoder', OneHotEncoder, { module: MODULE_ID_PREPROCESSING });
learnRegistry.register('KBinsDiscretizer', KBinsDiscretizer, { module: MODULE_ID_PREPROCESSING });
learnRegistry.register('PowerTransformer', PowerTransformer, { module: MODULE_ID_PREPROCESSING });
