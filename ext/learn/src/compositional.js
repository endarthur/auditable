// Compositional transforms — CLR, ILR, ALR. The pieces that justify
// @gcu/learn for assay / chemometrics / geomet workflows (SPEC §1.2).
//
// Geochemical assays are compositional data: rows sum to a constant
// (100% or 1.0) and live on the simplex. Standard linear methods on raw
// compositions are theoretically wrong (Aitchison 1986) and empirically
// misleading; the standard fix is to log-ratio transform first.
//
// Transforms:
//   - CLR (centred log-ratio):   clr(x)_i = log(x_i) - mean(log(x))
//                                Symmetric, preserves dimensionality (D out).
//                                Output rows sum to zero.
//   - ILR (isometric log-ratio): Helmert-basis projection of CLR.
//                                Outputs D-1 orthonormal coordinates.
//                                Use when distance-based methods need
//                                Euclidean coordinates (KMeans, KNN, PCA).
//   - ALR (additive log-ratio):  alr(x)_i = log(x_i / x_d)  (i ≠ d)
//                                Outputs D-1 columns, drops the
//                                denominator. Use when one component is
//                                a natural reference (e.g. SiO2).
//
// Zero handling: log(0) is undefined, so input zeros must be replaced
// before transformation. Multiplicative replacement is the default per
// Aitchison: replace zeros with 0.65 × detection_limit and rescale the
// non-zero portion of each row to preserve the unit sum. ROS (regression
// on order statistics) lands in v0.2 with BDLImputer.

import { BaseEstimator, TransformerMixin } from './base.js';
import { asMatrix, checkNFeatures, ValidationError } from './util/checks.js';
import { learnRegistry } from './serialize.js';

const MODULE_ID_COMPOSITIONAL = '@gcu/learn.compositional';

// ────────────────────────────────────────────────────────────────────
// CLR
// ────────────────────────────────────────────────────────────────────

export class CLR extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.zero_replacement = params.zero_replacement ?? 'multiplicative';
    this.detection_limit = params.detection_limit ?? 0.001;
    this._module = MODULE_ID_COMPOSITIONAL;
  }

  fit(X, _y, _opts) {
    const { shape } = asMatrix(X, { allow_nan: false });
    this.n_features_in_ = shape[1];
    this.n_features_out_ = shape[1];
    this.detection_limit_ = _resolveDetectionLimit(
      this.detection_limit, shape[1]);
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X, { allow_nan: false });
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const replaced = this.zero_replacement === 'multiplicative'
      ? _multiplicativeReplace(data, n, m, this.detection_limit_)
      : data;
    const out = new Float64Array(n * m);
    const log_x = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      let mean_log = 0;
      for (let j = 0; j < m; j++) {
        const v = replaced[off + j];
        if (v <= 0) {
          throw new ValidationError(
            `CLR.transform: non-positive value at row ${i} col ${j}; ` +
            `enable zero_replacement='multiplicative' or pre-impute zeros.`);
        }
        const lv = Math.log(v);
        log_x[j] = lv;
        mean_log += lv;
      }
      mean_log /= m;
      for (let j = 0; j < m; j++) out[off + j] = log_x[j] - mean_log;
    }
    out.shape = [n, m];
    return out;
  }

  inverse_transform(Z) {
    // clr_inv(z) = softmax(z) per row.
    const { data, shape } = asMatrix(Z, { allow_nan: false });
    checkNFeatures(this, shape, { name: 'Z' });
    const [n, m] = shape;
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      // Subtract max for numerical stability.
      let zmax = -Infinity;
      for (let j = 0; j < m; j++) if (data[off + j] > zmax) zmax = data[off + j];
      let denom = 0;
      for (let j = 0; j < m; j++) { out[off + j] = Math.exp(data[off + j] - zmax); denom += out[off + j]; }
      const inv = denom === 0 ? 0 : 1 / denom;
      for (let j = 0; j < m; j++) out[off + j] *= inv;
    }
    out.shape = [n, m];
    return out;
  }
}

Object.assign(CLR.prototype, TransformerMixin);
CLR._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// ILR
// ────────────────────────────────────────────────────────────────────

export class ILR extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.zero_replacement = params.zero_replacement ?? 'multiplicative';
    this.detection_limit = params.detection_limit ?? 0.001;
    this._module = MODULE_ID_COMPOSITIONAL;
  }

  fit(X, _y, _opts) {
    const { shape } = asMatrix(X, { allow_nan: false });
    if (shape[1] < 2) {
      throw new ValidationError(
        `ILR.fit: needs at least 2 features (got ${shape[1]})`);
    }
    this.n_features_in_ = shape[1];
    this.n_features_out_ = shape[1] - 1;
    this.detection_limit_ = _resolveDetectionLimit(
      this.detection_limit, shape[1]);
    // Precompute Helmert basis V of shape (D-1) × D.
    this.helmert_ = _helmertBasis(shape[1]);
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X, { allow_nan: false });
    checkNFeatures(this, shape, { name: 'X' });
    const [n, D] = shape;
    const Dm1 = D - 1;
    const replaced = this.zero_replacement === 'multiplicative'
      ? _multiplicativeReplace(data, n, D, this.detection_limit_)
      : data;
    const V = this.helmert_;
    const out = new Float64Array(n * Dm1);
    const log_x = new Float64Array(D);
    for (let i = 0; i < n; i++) {
      const off_in = i * D;
      const off_out = i * Dm1;
      let mean_log = 0;
      for (let j = 0; j < D; j++) {
        const v = replaced[off_in + j];
        if (v <= 0) {
          throw new ValidationError(
            `ILR.transform: non-positive value at row ${i} col ${j}; ` +
            `enable zero_replacement='multiplicative' or pre-impute zeros.`);
        }
        const lv = Math.log(v);
        log_x[j] = lv;
        mean_log += lv;
      }
      mean_log /= D;
      // CLR row, then project: ilr_i = sum_j V[i, j] * clr_j
      for (let k = 0; k < Dm1; k++) {
        let acc = 0;
        const off_V = k * D;
        for (let j = 0; j < D; j++) acc += V[off_V + j] * (log_x[j] - mean_log);
        out[off_out + k] = acc;
      }
    }
    out.shape = [n, Dm1];
    return out;
  }

  inverse_transform(Z) {
    const { data, shape } = asMatrix(Z, { allow_nan: false });
    if (shape[1] !== this.n_features_out_) {
      throw new ValidationError(
        `ILR.inverse_transform: Z has ${shape[1]} columns, expected ${this.n_features_out_}`);
    }
    const [n, Dm1] = shape;
    const D = Dm1 + 1;
    const V = this.helmert_;  // (D-1) × D
    const out = new Float64Array(n * D);
    const clr_row = new Float64Array(D);
    for (let i = 0; i < n; i++) {
      const off_in = i * Dm1;
      // CLR coords = V^T * z
      for (let j = 0; j < D; j++) {
        let acc = 0;
        for (let k = 0; k < Dm1; k++) acc += V[k * D + j] * data[off_in + k];
        clr_row[j] = acc;
      }
      // softmax → composition
      const off_out = i * D;
      let zmax = -Infinity;
      for (let j = 0; j < D; j++) if (clr_row[j] > zmax) zmax = clr_row[j];
      let denom = 0;
      for (let j = 0; j < D; j++) { out[off_out + j] = Math.exp(clr_row[j] - zmax); denom += out[off_out + j]; }
      const inv = denom === 0 ? 0 : 1 / denom;
      for (let j = 0; j < D; j++) out[off_out + j] *= inv;
    }
    out.shape = [n, D];
    return out;
  }
}

Object.assign(ILR.prototype, TransformerMixin);
ILR._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// ALR
// ────────────────────────────────────────────────────────────────────

export class ALR extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.zero_replacement = params.zero_replacement ?? 'multiplicative';
    this.detection_limit = params.detection_limit ?? 0.001;
    // Default: use the last column as denominator.
    this.denominator = params.denominator ?? -1;
    this._module = MODULE_ID_COMPOSITIONAL;
  }

  fit(X, _y, _opts) {
    const { shape } = asMatrix(X, { allow_nan: false });
    if (shape[1] < 2) {
      throw new ValidationError(
        `ALR.fit: needs at least 2 features (got ${shape[1]})`);
    }
    this.n_features_in_ = shape[1];
    this.n_features_out_ = shape[1] - 1;
    let d = this.denominator;
    if (d < 0) d = shape[1] + d;  // -1 → last column
    if (d < 0 || d >= shape[1]) {
      throw new ValidationError(
        `ALR.fit: denominator=${this.denominator} out of range for ${shape[1]} features`);
    }
    this.denominator_ = d;
    this.detection_limit_ = _resolveDetectionLimit(
      this.detection_limit, shape[1]);
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X, { allow_nan: false });
    checkNFeatures(this, shape, { name: 'X' });
    const [n, D] = shape;
    const replaced = this.zero_replacement === 'multiplicative'
      ? _multiplicativeReplace(data, n, D, this.detection_limit_)
      : data;
    const d = this.denominator_;
    const Dm1 = D - 1;
    const out = new Float64Array(n * Dm1);
    for (let i = 0; i < n; i++) {
      const off_in = i * D;
      const off_out = i * Dm1;
      const v_d = replaced[off_in + d];
      if (v_d <= 0) {
        throw new ValidationError(
          `ALR.transform: non-positive denominator value at row ${i}; ` +
          `enable zero_replacement='multiplicative' or pre-impute zeros.`);
      }
      const log_d = Math.log(v_d);
      let w = 0;
      for (let j = 0; j < D; j++) {
        if (j === d) continue;
        const v = replaced[off_in + j];
        if (v <= 0) {
          throw new ValidationError(
            `ALR.transform: non-positive value at row ${i} col ${j}`);
        }
        out[off_out + w++] = Math.log(v) - log_d;
      }
    }
    out.shape = [n, Dm1];
    return out;
  }

  inverse_transform(Z) {
    const { data, shape } = asMatrix(Z, { allow_nan: false });
    if (shape[1] !== this.n_features_out_) {
      throw new ValidationError(
        `ALR.inverse_transform: Z has ${shape[1]} columns, expected ${this.n_features_out_}`);
    }
    const [n, Dm1] = shape;
    const D = Dm1 + 1;
    const d = this.denominator_;
    const out = new Float64Array(n * D);
    for (let i = 0; i < n; i++) {
      const off_in = i * Dm1;
      const off_out = i * D;
      // exp(z), and 1 at the denominator slot, then normalize.
      let denom = 1;  // contribution from the implicit 1 at slot d
      let r = 0;
      for (let j = 0; j < D; j++) {
        if (j === d) { out[off_out + j] = 1; continue; }
        const v = Math.exp(data[off_in + r++]);
        out[off_out + j] = v;
        denom += v;
      }
      const inv = 1 / denom;
      for (let j = 0; j < D; j++) out[off_out + j] *= inv;
    }
    out.shape = [n, D];
    return out;
  }
}

Object.assign(ALR.prototype, TransformerMixin);
ALR._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function _resolveDetectionLimit(spec, m) {
  if (typeof spec === 'number') {
    const out = new Float64Array(m);
    out.fill(spec);
    return out;
  }
  if (Array.isArray(spec) || ArrayBuffer.isView(spec)) {
    if (spec.length !== m) {
      throw new ValidationError(
        `compositional: detection_limit array length ${spec.length} != n_features ${m}`);
    }
    const out = new Float64Array(m);
    for (let j = 0; j < m; j++) out[j] = +spec[j];
    return out;
  }
  throw new ValidationError(
    `compositional: detection_limit must be a number or array; got ${typeof spec}`);
}

// Multiplicative replacement (Martín-Fernández et al., 2003): replace
// zeros with 0.65 × detection_limit, then rescale the non-zero portion
// of the row so the sum is preserved. Returns a fresh Float64Array.
function _multiplicativeReplace(data, n, m, dl) {
  const out = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    const off = i * m;
    let row_sum = 0;
    let replaced_sum = 0;
    let nonzero_sum = 0;
    // Decide replacements + accumulate sums.
    for (let j = 0; j < m; j++) {
      const v = data[off + j];
      row_sum += v;
      if (v <= 0) {
        const r = 0.65 * dl[j];
        out[off + j] = r;
        replaced_sum += r;
      } else {
        out[off + j] = v;
        nonzero_sum += v;
      }
    }
    if (replaced_sum === 0) continue;  // no zeros to replace
    if (nonzero_sum === 0) {
      // All-zero row — leave the small replacements; they'll renormalize
      // any downstream consumer that expects unit sum.
      continue;
    }
    // Rescale non-zero entries so the row sum equals row_sum (preserving
    // the original total). Replaced entries keep their imputed values.
    const target_nonzero = row_sum - replaced_sum;
    const scale = target_nonzero / nonzero_sum;
    if (scale > 0 && Number.isFinite(scale)) {
      for (let j = 0; j < m; j++) {
        if (data[off + j] > 0) out[off + j] *= scale;
      }
    }
  }
  return out;
}

// Helmert basis V of shape (D-1) × D, row k contains the k-th contrast.
// Standard construction:
//   V[k, i] =  +1/sqrt((k+1)(k+2)),  for i ∈ 0..k
//   V[k, k+1] = -(k+1)/sqrt((k+1)(k+2))
//   V[k, i] = 0 elsewhere
// Each row has unit norm; rows are mutually orthogonal.
function _helmertBasis(D) {
  const Dm1 = D - 1;
  const V = new Float64Array(Dm1 * D);
  for (let k = 0; k < Dm1; k++) {
    const denom = Math.sqrt((k + 1) * (k + 2));
    const pos = 1 / denom;
    const neg = -(k + 1) / denom;
    const off = k * D;
    for (let i = 0; i <= k; i++) V[off + i] = pos;
    V[off + k + 1] = neg;
    // Remaining entries default to 0.
  }
  return V;
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('CLR', CLR, { module: MODULE_ID_COMPOSITIONAL });
learnRegistry.register('ILR', ILR, { module: MODULE_ID_COMPOSITIONAL });
learnRegistry.register('ALR', ALR, { module: MODULE_ID_COMPOSITIONAL });
