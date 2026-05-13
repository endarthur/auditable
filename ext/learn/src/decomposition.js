// Decomposition — PCA via @gcu/line's SVD.
//
// Sklearn-compatible at the contract level (`sklearn.decomposition.PCA`).
// Same hyperparameter names, fitted-attribute names, sign convention
// (per-component sign-flipped so the largest absolute loading is
// positive — matches sklearn).
//
// Numerical convention. Population variance (divide by n) when
// converting singular values to explained_variance_, matching sklearn's
// default since 0.20.

import { BaseEstimator, TransformerMixin } from './base.js';
import { asMatrix, checkNFeatures, captureFeatureNames, ValidationError } from './util/checks.js';
import { mulberry32 } from './util/random.js';
import { learnRegistry } from './serialize.js';
// Import @gcu/line for SVD. Cross-package relative path; build.js
// rewrites to '../line/index.js' for the bundle.
import { NdArray, svd } from '../../line/index.js';

const MODULE_ID_DECOMP = '@gcu/learn.decomposition';

// ────────────────────────────────────────────────────────────────────
// PCA
// ────────────────────────────────────────────────────────────────────

/**
 * Principal Component Analysis via Singular Value Decomposition.
 *
 * Hyperparameters:
 *   - n_components  (int | null, default null = min(n_samples, n_features))
 *   - whiten        (bool, default false) — divide projections by
 *                   sqrt(explained_variance) so output has unit variance
 *                   per component
 *
 * Fitted attributes:
 *   - components_              (Float64Array, shape [n_components, n_features])
 *                              Each row is a principal axis. Sign-flipped
 *                              per-component so the max-magnitude entry is
 *                              positive (sklearn convention; deterministic).
 *   - explained_variance_      (Float64Array, n_components)
 *                              Variance along each principal axis.
 *   - explained_variance_ratio_(Float64Array, n_components) — fraction of total.
 *   - singular_values_         (Float64Array, n_components)
 *   - mean_                    (Float64Array, n_features)
 *   - n_components_, n_features_in_, n_samples_
 *
 * Algorithm: center X, compute SVD of centered X, take the first
 * n_components singular vectors as principal axes. Single line.svd()
 * call — no iterative refinement needed for the in-browser scale.
 */
export class PCA extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_components = params.n_components ?? null;
    this.whiten = params.whiten ?? false;
    this._module = MODULE_ID_DECOMP;
  }

  fit(X, _y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const [n, m] = shape;
    if (n < 2) {
      throw new ValidationError(
        `PCA: n_samples=${n} must be >= 2 (no variance to decompose)`);
    }
    const k_max = Math.min(n, m);
    const k = this.n_components == null ? k_max
      : Math.min(this.n_components | 0, k_max);
    if (k < 1) {
      throw new ValidationError(
        `PCA: n_components=${this.n_components} resolved to ${k} (must be >= 1)`);
    }

    // Center X.
    const mean = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) mean[j] += data[off + j];
    }
    const inv_n = 1 / n;
    for (let j = 0; j < m; j++) mean[j] *= inv_n;
    const Xc = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) Xc[off + j] = data[off + j] - mean[j];
    }

    // SVD: Xc = U * diag(s) * V^T  (line returns V as [m, k_full] with
    // right singular vectors as columns).
    const Xc_nd = new NdArray(Xc, [n, m]);
    const { s, V } = svd(Xc_nd);
    const k_full = s.shape[0];
    const k_use = Math.min(k, k_full);

    // Components_: row c is the c-th right singular vector = V column c.
    // Sign flip: pick the entry with largest |.| in each component, force
    // it positive. Sklearn does this so two PCA fits agree on sign.
    const components = new Float64Array(k_use * m);
    for (let c = 0; c < k_use; c++) {
      let max_idx = 0, max_val = 0;
      for (let j = 0; j < m; j++) {
        const v = V.data[j * k_full + c];
        const av = Math.abs(v);
        if (av > max_val) { max_val = av; max_idx = j; }
      }
      const flip = V.data[max_idx * k_full + c] < 0 ? -1 : 1;
      for (let j = 0; j < m; j++) components[c * m + j] = flip * V.data[j * k_full + c];
    }
    components.shape = [k_use, m];

    // Explained variance: s² / n  (population variance — sklearn uses
    // (n-1) divisor for the "unbiased" version; we follow the more
    // recent sklearn convention of n in fit_transform path).
    const explained_variance = new Float64Array(k_use);
    for (let c = 0; c < k_use; c++) {
      explained_variance[c] = s.data[c] * s.data[c] / Math.max(1, n - 1);
    }
    // Total variance via the trace of the centred-X covariance.
    let total_var = 0;
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) total_var += Xc[off + j] * Xc[off + j];
    }
    total_var /= Math.max(1, n - 1);
    const explained_variance_ratio = new Float64Array(k_use);
    for (let c = 0; c < k_use; c++) {
      explained_variance_ratio[c] = total_var === 0 ? 0
        : explained_variance[c] / total_var;
    }
    const singular_values = new Float64Array(k_use);
    for (let c = 0; c < k_use; c++) singular_values[c] = s.data[c];

    this.components_ = components;
    this.explained_variance_ = explained_variance;
    this.explained_variance_ratio_ = explained_variance_ratio;
    this.singular_values_ = singular_values;
    this.mean_ = mean;
    this.n_components_ = k_use;
    this.n_features_in_ = m;
    this.n_samples_ = n;
    captureFeatureNames(this, X_info);
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X);
    if (this.components_ == null) throw new ValidationError('PCA: not fitted');
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const k = this.n_components_;
    const out = new Float64Array(n * k);
    for (let i = 0; i < n; i++) {
      const off_x = i * m;
      for (let c = 0; c < k; c++) {
        let acc = 0;
        const off_c = c * m;
        for (let j = 0; j < m; j++) {
          acc += (data[off_x + j] - this.mean_[j]) * this.components_[off_c + j];
        }
        out[i * k + c] = acc;
      }
    }
    if (this.whiten) {
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < k; c++) {
          const s = Math.sqrt(this.explained_variance_[c]);
          out[i * k + c] = s > 0 ? out[i * k + c] / s : 0;
        }
      }
    }
    out.shape = [n, k];
    return out;
  }

  inverse_transform(Z) {
    const { data, shape } = asMatrix(Z);
    if (this.components_ == null) throw new ValidationError('PCA: not fitted');
    if (shape[1] !== this.n_components_) {
      throw new ValidationError(
        `PCA.inverse_transform: Z has ${shape[1]} columns, expected ${this.n_components_}`);
    }
    const [n, k] = shape;
    const m = this.n_features_in_;
    const out = new Float64Array(n * m);
    // X = Z @ components_  + mean (un-whiten if applicable first).
    for (let i = 0; i < n; i++) {
      const off_z = i * k;
      const off_x = i * m;
      for (let j = 0; j < m; j++) {
        let acc = 0;
        for (let c = 0; c < k; c++) {
          let zv = data[off_z + c];
          if (this.whiten) zv *= Math.sqrt(this.explained_variance_[c]);
          acc += zv * this.components_[c * m + j];
        }
        out[off_x + j] = acc + this.mean_[j];
      }
    }
    out.shape = [n, m];
    return out;
  }

  /** Output feature names: "pc0", "pc1", ... — input_features ignored. */
  get_feature_names_out(_input_features = null) {
    if (this.components_ == null) throw new ValidationError('PCA: not fitted');
    const k = this.n_components_;
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = `pc${i}`;
    return out;
  }

  /** Total log-likelihood of X under the fitted Gaussian model. (Diagnostic.) */
  score_samples(X) {
    // Sklearn implements this via the probabilistic-PCA formula. For v0.1
    // we expose a simpler version: per-sample reconstruction loss.
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const Z = this.transform(X);
    const X_back = this.inverse_transform(Z);
    const n = shape[0], m = shape[1];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const off = i * m;
      for (let j = 0; j < m; j++) {
        const d = data[off + j] - X_back[off + j];
        s += d * d;
      }
      out[i] = -s;
    }
    return out;
  }
}

Object.assign(PCA.prototype, TransformerMixin);
PCA._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// TruncatedSVD
// ────────────────────────────────────────────────────────────────────

/**
 * Like PCA but without mean-centering. Standard for LSA over tf-idf
 * matrices and any setting where the data is already non-negative or
 * sparsity-positive (centering would destroy sparsity in sklearn's
 * sparse-matrix world; here it's mostly a semantic distinction —
 * TruncatedSVD operates on raw X).
 *
 * Hyperparameters:
 *   - n_components  (int, default 2) — must be < min(n_samples, n_features)
 *
 * Fitted attributes (sklearn-shape):
 *   - components_              [n_components, n_features]
 *   - explained_variance_      Float64Array(n_components)
 *   - explained_variance_ratio_
 *   - singular_values_
 *   - n_features_in_, n_samples_
 *
 * transform = X @ components_.T (no mean subtraction).
 */
export class TruncatedSVD extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_components = params.n_components ?? 2;
    this._module = MODULE_ID_DECOMP;
  }

  fit(X, _y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const [n, m] = shape;
    if (n < 2) throw new ValidationError('TruncatedSVD: n_samples must be >= 2');
    const k_max = Math.min(n, m);
    const k = Math.min(this.n_components | 0, k_max);
    if (k < 1) throw new ValidationError(
      `TruncatedSVD: n_components=${this.n_components} resolved to ${k}`);

    const X_nd = new NdArray(new Float64Array(data), [n, m]);
    const { s, V } = svd(X_nd);
    const k_full = s.shape[0];
    const k_use = Math.min(k, k_full);

    // Components_: row c is V column c with sklearn sign convention.
    const components = new Float64Array(k_use * m);
    for (let c = 0; c < k_use; c++) {
      let max_idx = 0, max_val = 0;
      for (let j = 0; j < m; j++) {
        const v = V.data[j * k_full + c];
        const av = Math.abs(v);
        if (av > max_val) { max_val = av; max_idx = j; }
      }
      const flip = V.data[max_idx * k_full + c] < 0 ? -1 : 1;
      for (let j = 0; j < m; j++) components[c * m + j] = flip * V.data[j * k_full + c];
    }
    components.shape = [k_use, m];

    const ev = new Float64Array(k_use);
    const sv = new Float64Array(k_use);
    for (let c = 0; c < k_use; c++) {
      sv[c] = s.data[c];
      ev[c] = s.data[c] * s.data[c] / Math.max(1, n - 1);
    }
    // Total variance via Frobenius norm of X (not centered).
    let total_var = 0;
    for (let i = 0; i < n * m; i++) total_var += data[i] * data[i];
    total_var /= Math.max(1, n - 1);
    const ratio = new Float64Array(k_use);
    for (let c = 0; c < k_use; c++) {
      ratio[c] = total_var === 0 ? 0 : ev[c] / total_var;
    }

    this.components_ = components;
    this.explained_variance_ = ev;
    this.explained_variance_ratio_ = ratio;
    this.singular_values_ = sv;
    this.n_components_ = k_use;
    this.n_features_in_ = m;
    this.n_samples_ = n;
    captureFeatureNames(this, X_info);
    return this;
  }

  transform(X) {
    const { data, shape } = asMatrix(X);
    if (this.components_ == null) throw new ValidationError('TruncatedSVD: not fitted');
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const k = this.n_components_;
    const out = new Float64Array(n * k);
    for (let i = 0; i < n; i++) {
      const off_x = i * m;
      for (let c = 0; c < k; c++) {
        let acc = 0;
        const off_c = c * m;
        for (let j = 0; j < m; j++) acc += data[off_x + j] * this.components_[off_c + j];
        out[i * k + c] = acc;
      }
    }
    out.shape = [n, k];
    return out;
  }

  inverse_transform(Z) {
    const { data, shape } = asMatrix(Z);
    if (this.components_ == null) throw new ValidationError('TruncatedSVD: not fitted');
    if (shape[1] !== this.n_components_) {
      throw new ValidationError(
        `TruncatedSVD.inverse_transform: Z has ${shape[1]} columns, expected ${this.n_components_}`);
    }
    const [n, k] = shape;
    const m = this.n_features_in_;
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off_z = i * k;
      const off_x = i * m;
      for (let j = 0; j < m; j++) {
        let acc = 0;
        for (let c = 0; c < k; c++) acc += data[off_z + c] * this.components_[c * m + j];
        out[off_x + j] = acc;
      }
    }
    out.shape = [n, m];
    return out;
  }
}

Object.assign(TruncatedSVD.prototype, TransformerMixin);
TruncatedSVD._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// NMF — Non-negative Matrix Factorization
// ────────────────────────────────────────────────────────────────────

/**
 * Decompose a non-negative X into W H, both non-negative.
 *
 * Hyperparameters:
 *   - n_components   (int, default 2)
 *   - init           'random' | 'nndsvd' (default 'nndsvd')
 *   - max_iter       (int, default 200)
 *   - tol            (number, default 1e-4) — relative tolerance on Frobenius
 *   - random_state   (int|null) — only used by init='random'
 *   - beta_loss      'frobenius' (only) — KL/IS deferred
 *
 * Fitted attributes:
 *   - components_         (Float64Array, shape [n_components, n_features]) — H
 *   - n_components_, n_iter_, reconstruction_err_, n_features_in_
 *
 * Algorithm: multiplicative-update rules (Lee & Seung 2001) for the
 * Frobenius objective ‖X - WH‖²_F:
 *   W ← W ⊙ (X H^T) / (W H H^T + eps)
 *   H ← H ⊙ (W^T X) / (W^T W H + eps)
 * Update both per iteration; converge when relative change in the
 * reconstruction error drops below tol.
 *
 * `transform` solves for W given a held-out X via the multiplicative
 * update with H frozen — converges in a few iterations.
 */
export class NMF extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_components = params.n_components ?? 2;
    this.init = params.init ?? 'nndsvd';
    this.max_iter = params.max_iter ?? 200;
    this.tol = params.tol ?? 1e-4;
    this.random_state = params.random_state ?? null;
    this.beta_loss = params.beta_loss ?? 'frobenius';
    this._module = MODULE_ID_DECOMP;
  }

  fit(X, _y, _opts) {
    if (this.beta_loss !== 'frobenius') {
      throw new ValidationError(
        `NMF: beta_loss='${this.beta_loss}' not supported in v0.2 (use 'frobenius')`);
    }
    this.fit_transform(X);
    return this;
  }

  fit_transform(X, _y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const [n, m] = shape;
    // Validate non-negativity at the boundary.
    for (let i = 0; i < data.length; i++) {
      if (data[i] < 0) {
        throw new ValidationError(
          `NMF: input must be non-negative; got ${data[i]} at flat index ${i}`);
      }
    }
    const k = Math.max(1, Math.min(this.n_components | 0, Math.min(n, m)));
    let W, H;
    if (this.init === 'nndsvd') {
      ({ W, H } = _nmfNndsvdInit(data, n, m, k));
    } else if (this.init === 'random') {
      const rng = mulberry32(this.random_state ?? Math.floor(Math.random() * 0x7fffffff));
      W = new Float64Array(n * k);
      H = new Float64Array(k * m);
      for (let i = 0; i < W.length; i++) W[i] = rng();
      for (let i = 0; i < H.length; i++) H[i] = rng();
    } else {
      throw new ValidationError(
        `NMF: init='${this.init}' must be 'random' | 'nndsvd'`);
    }
    const eps = 1e-10;
    let prev_err = Infinity;
    let iter = 0;
    let err = 0;
    for (iter = 0; iter < this.max_iter; iter++) {
      // H ← H ⊙ (W^T X) / (W^T W H + eps)
      const WtX = _matmul(W, n, k, true, data, n, m, false);   // (k × m)
      const WtW = _matmul(W, n, k, true, W, n, k, false);      // (k × k)
      const WtWH = _matmul(WtW, k, k, false, H, k, m, false);  // (k × m)
      for (let i = 0; i < k * m; i++) H[i] *= WtX[i] / (WtWH[i] + eps);
      // W ← W ⊙ (X H^T) / (W H H^T + eps)
      const XHt = _matmul(data, n, m, false, H, k, m, true);   // (n × k)
      const HHt = _matmul(H, k, m, false, H, k, m, true);      // (k × k)
      const WHHt = _matmul(W, n, k, false, HHt, k, k, false);  // (n × k)
      for (let i = 0; i < n * k; i++) W[i] *= XHt[i] / (WHHt[i] + eps);
      // Compute reconstruction error.
      err = _reconstructionError(data, n, m, W, H, k);
      // Skip convergence check on iter 0: prev_err is +Infinity then,
      // and Infinity arithmetic incorrectly satisfies the tolerance.
      if (iter > 0 && Math.abs(prev_err - err) <= this.tol * Math.max(1, prev_err)) {
        iter++;
        break;
      }
      prev_err = err;
    }
    H.shape = [k, m];
    this.components_ = H;
    this.n_components_ = k;
    this.n_iter_ = iter;
    this.reconstruction_err_ = err;
    this.n_features_in_ = m;
    captureFeatureNames(this, X_info);
    W.shape = [n, k];
    return W;
  }

  transform(X) {
    if (this.components_ == null) throw new ValidationError('NMF: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < 0) throw new ValidationError(
        `NMF.transform: input must be non-negative; got ${data[i]}`);
    }
    const k = this.n_components_;
    const H = this.components_;
    const eps = 1e-10;
    // Initialize W with column means of X / mean(H) per component.
    const W = new Float64Array(n * k);
    for (let i = 0; i < W.length; i++) W[i] = 0.5;
    // A few multiplicative updates with H frozen.
    for (let iter = 0; iter < 100; iter++) {
      const XHt = _matmul(data, n, m, false, H, k, m, true);
      const HHt = _matmul(H, k, m, false, H, k, m, true);
      const WHHt = _matmul(W, n, k, false, HHt, k, k, false);
      let max_delta = 0;
      for (let i = 0; i < n * k; i++) {
        const new_w = W[i] * XHt[i] / (WHHt[i] + eps);
        const d = Math.abs(new_w - W[i]);
        if (d > max_delta) max_delta = d;
        W[i] = new_w;
      }
      if (max_delta < 1e-6) break;
    }
    W.shape = [n, k];
    return W;
  }

  inverse_transform(W) {
    if (this.components_ == null) throw new ValidationError('NMF: not fitted');
    const { data, shape } = asMatrix(W);
    if (shape[1] !== this.n_components_) {
      throw new ValidationError(
        `NMF.inverse_transform: W has ${shape[1]} columns, expected ${this.n_components_}`);
    }
    const [n, k] = shape;
    const m = this.n_features_in_;
    // X ≈ W @ H
    const out = _matmul(data, n, k, false, this.components_, k, m, false);
    out.shape = [n, m];
    return out;
  }
}

// Snapshot NMF's class-defined fit_transform before Object.assign
// overwrites it with TransformerMixin's default. NMF computes W as a
// side-effect of fit, so fit_transform shouldn't go through the
// default fit().transform() path.
const _nmfFitTransform = NMF.prototype.fit_transform;
Object.assign(NMF.prototype, TransformerMixin);
NMF.prototype.fit_transform = _nmfFitTransform;
// Tag override: NMF requires non-negative X.
NMF.prototype.__sklearn_tags__ = function () {
  const base = TransformerMixin.__sklearn_tags__.call(this);
  return { ...base, requires_positive_X: true };
};
NMF._estimator_type = 'transformer';

// ────────────────────────────────────────────────────────────────────
// NMF helpers
// ────────────────────────────────────────────────────────────────────

// NNDSVD init (Boutsidis & Gallopoulos 2008): use the SVD of X to seed
// W and H with positive values that respect the data structure better
// than random init. Greatly accelerates convergence.
function _nmfNndsvdInit(X, n, m, k) {
  const X_nd = new NdArray(new Float64Array(X), [n, m]);
  const { s, V } = svd(X_nd);
  // line.svd doesn't expose U directly with shape [n, k]. Recompute U
  // from X = U Σ V^T → U = X V Σ⁻¹  (only first k columns).
  const k_full = s.shape[0];
  const k_use = Math.min(k, k_full);
  const U = new Float64Array(n * k_use);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k_use; c++) {
      let acc = 0;
      for (let j = 0; j < m; j++) acc += X[i * m + j] * V.data[j * k_full + c];
      U[i * k_use + c] = s.data[c] === 0 ? 0 : acc / s.data[c];
    }
  }
  const W = new Float64Array(n * k);
  const H = new Float64Array(k * m);
  // Component 0: positive part of leading singular vectors.
  const sqrt_s0 = Math.sqrt(s.data[0]);
  for (let i = 0; i < n; i++) W[i * k] = sqrt_s0 * Math.abs(U[i * k_use]);
  for (let j = 0; j < m; j++) H[j] = sqrt_s0 * Math.abs(V.data[j * k_full]);
  // Components 1..k-1: positive part of u and v separately, choose the
  // pair (uPos·vPos vs uNeg·vNeg) with larger Frobenius score.
  for (let c = 1; c < k; c++) {
    const sc = c < k_full ? s.data[c] : 0;
    const sqrt_sc = Math.sqrt(sc);
    let posU_norm2 = 0, negU_norm2 = 0, posV_norm2 = 0, negV_norm2 = 0;
    for (let i = 0; i < n; i++) {
      const u = c < k_use ? U[i * k_use + c] : 0;
      if (u > 0) posU_norm2 += u * u; else negU_norm2 += u * u;
    }
    for (let j = 0; j < m; j++) {
      const v = c < k_full ? V.data[j * k_full + c] : 0;
      if (v > 0) posV_norm2 += v * v; else negV_norm2 += v * v;
    }
    const pos_score = Math.sqrt(posU_norm2 * posV_norm2);
    const neg_score = Math.sqrt(negU_norm2 * negV_norm2);
    const usePos = pos_score >= neg_score;
    const u_norm = Math.sqrt(usePos ? posU_norm2 : negU_norm2);
    const v_norm = Math.sqrt(usePos ? posV_norm2 : negV_norm2);
    const sigma = sqrt_sc * Math.sqrt(usePos ? pos_score : neg_score);
    const uScale = u_norm > 0 ? sigma / u_norm : 0;
    const vScale = v_norm > 0 ? sigma / v_norm : 0;
    for (let i = 0; i < n; i++) {
      const u = c < k_use ? U[i * k_use + c] : 0;
      const ui = usePos ? Math.max(0, u) : Math.max(0, -u);
      W[i * k + c] = ui * uScale;
    }
    for (let j = 0; j < m; j++) {
      const v = c < k_full ? V.data[j * k_full + c] : 0;
      const vj = usePos ? Math.max(0, v) : Math.max(0, -v);
      H[c * m + j] = vj * vScale;
    }
  }
  // Replace any all-zero columns of W (or rows of H) with small random
  // positive values to avoid the multiplicative update getting stuck at 0.
  const eps0 = 1e-6;
  for (let c = 0; c < k; c++) {
    let max_w = 0; for (let i = 0; i < n; i++) if (W[i * k + c] > max_w) max_w = W[i * k + c];
    if (max_w === 0) for (let i = 0; i < n; i++) W[i * k + c] = eps0;
    let max_h = 0; for (let j = 0; j < m; j++) if (H[c * m + j] > max_h) max_h = H[c * m + j];
    if (max_h === 0) for (let j = 0; j < m; j++) H[c * m + j] = eps0;
  }
  return { W, H };
}

// Generic dense matmul: A is [aRows, aCols], B is [bRows, bCols], with
// optional transposes on either side. Returns Float64Array of shape
// [outRows, outCols] where the dimensions account for transposes.
function _matmul(A, aRows, aCols, aT, B, bRows, bCols, bT) {
  const M = aT ? aCols : aRows;
  const K1 = aT ? aRows : aCols;
  const N = bT ? bRows : bCols;
  const K2 = bT ? bCols : bRows;
  if (K1 !== K2) throw new ValidationError(
    `_matmul: inner dim mismatch ${K1} vs ${K2}`);
  const out = new Float64Array(M * N);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let p = 0; p < K1; p++) {
        const av = aT ? A[p * aCols + i] : A[i * aCols + p];
        const bv = bT ? B[j * bCols + p] : B[p * bCols + j];
        s += av * bv;
      }
      out[i * N + j] = s;
    }
  }
  return out;
}

function _reconstructionError(X, n, m, W, H, k) {
  let err = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let acc = 0;
      for (let c = 0; c < k; c++) acc += W[i * k + c] * H[c * m + j];
      const d = X[i * m + j] - acc;
      err += d * d;
    }
  }
  return Math.sqrt(err);
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('PCA', PCA, { module: MODULE_ID_DECOMP });
learnRegistry.register('TruncatedSVD', TruncatedSVD, { module: MODULE_ID_DECOMP });
learnRegistry.register('NMF', NMF, { module: MODULE_ID_DECOMP });
