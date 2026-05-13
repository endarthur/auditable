// PLS regression — Partial Least Squares for high-dimensional / collinear
// design matrices. The chemometrics workhorse: when X is wide and the
// columns are correlated (typical of geochem assays / spectroscopy /
// drillhole composites), OLS overfits and PLS regularizes by projecting
// X onto a small set of latent components that maximize covariance
// with y.
//
// Sklearn-compatible (`sklearn.cross_decomposition.PLSRegression`) for
// the single-output case. PLS2 (multi-target y) is the natural next
// step but the scaffolding for multi-output regressors (which we don't
// yet have anywhere else) lands together with that — deferred.

import { BaseEstimator, RegressorMixin } from './base.js';
import { asMatrix, asVector, checkNFeatures, captureFeatureNames, ValidationError } from './util/checks.js';
import { learnRegistry } from './serialize.js';

const MODULE_ID_CROSS_DECOMP = '@gcu/learn.cross_decomposition';

// ────────────────────────────────────────────────────────────────────
// PLSRegression
// ────────────────────────────────────────────────────────────────────

/**
 * PLS1 regression via NIPALS.
 *
 * Hyperparameters:
 *   - n_components  (int, default 2)
 *   - scale         (bool, default true) — standardize X and y
 *   - max_iter      (int, default 500)   — power iteration cap (per component)
 *   - tol           (number, default 1e-6) — convergence tolerance for w
 *
 * Fitted attributes (sklearn-shape, single-output):
 *   - x_weights_     (Float64Array, [n_features, n_components])  W
 *   - x_loadings_    (Float64Array, [n_features, n_components])  P
 *   - x_scores_      (Float64Array, [n_samples, n_components])   T
 *   - y_loadings_    (Float64Array, [n_components])              q
 *   - x_rotations_   (Float64Array, [n_features, n_components])  W (P^T W)^-1
 *   - coef_          (Float64Array, [n_features])
 *   - intercept_     (number)
 *   - n_iter_        (Array of int per component)
 *   - x_mean_, x_std_, y_mean_, y_std_, n_features_in_
 *
 * Algorithm (PLS1, single y):
 *   for c = 1..n_components:
 *     w_c = X^T y / ‖X^T y‖
 *     t_c = X w_c
 *     p_c = X^T t_c / (t_c^T t_c)
 *     q_c = y^T t_c / (t_c^T t_c)
 *     X ← X - t_c p_c^T   (deflate)
 *     y ← y - t_c q_c     (deflate)
 *   coef = W (P^T W)^-1 q
 */
export class PLSRegression extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_components = params.n_components ?? 2;
    this.scale = params.scale ?? true;
    this.max_iter = params.max_iter ?? 500;
    this.tol = params.tol ?? 1e-6;
    this._module = MODULE_ID_CROSS_DECOMP;
  }

  fit(X, y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const yv = asVector(y);
    const [n, m] = shape;
    if (yv.length !== n) {
      throw new ValidationError(
        `PLSRegression.fit: y length ${yv.length} != n_samples ${n}`);
    }
    const k_max = Math.min(n, m);
    const k = Math.min(this.n_components | 0, k_max);
    if (k < 1) throw new ValidationError(
      `PLSRegression: n_components=${this.n_components} resolved to ${k}`);

    // Center (and optionally scale) X and y.
    const x_mean = new Float64Array(m);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) x_mean[j] += data[i * m + j];
    const inv_n = 1 / n;
    for (let j = 0; j < m; j++) x_mean[j] *= inv_n;
    let y_mean = 0; for (let i = 0; i < n; i++) y_mean += yv[i]; y_mean *= inv_n;

    const x_std = new Float64Array(m).fill(1);
    let y_std = 1;
    if (this.scale) {
      // Standard deviation with (n - 1) divisor (ddof=1, sklearn convention).
      for (let j = 0; j < m; j++) {
        let v = 0;
        for (let i = 0; i < n; i++) {
          const d = data[i * m + j] - x_mean[j];
          v += d * d;
        }
        v /= Math.max(1, n - 1);
        x_std[j] = v > 0 ? Math.sqrt(v) : 1;
      }
      let v = 0;
      for (let i = 0; i < n; i++) { const d = yv[i] - y_mean; v += d * d; }
      v /= Math.max(1, n - 1);
      y_std = v > 0 ? Math.sqrt(v) : 1;
    }
    // Working copies (residual matrices).
    const Xw = new Float64Array(n * m);
    const yw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) Xw[i * m + j] = (data[i * m + j] - x_mean[j]) / x_std[j];
      yw[i] = (yv[i] - y_mean) / y_std;
    }

    // NIPALS — extract up to n_components. Track the actual number we
    // managed to extract (we may stop early if y-residual converges to
    // zero before k components, which causes PtW to go singular).
    const W_full = new Float64Array(m * k);
    const P_full = new Float64Array(m * k);
    const T_full = new Float64Array(n * k);
    const Q_full = new Float64Array(k);
    const n_iter_full = new Array(k);
    let actual_k = 0;

    for (let c = 0; c < k; c++) {
      // PLS1 has a closed-form weight vector: w = X^T y (then normalize).
      let w_norm = 0;
      const w = new Float64Array(m);
      for (let j = 0; j < m; j++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += Xw[i * m + j] * yw[i];
        w[j] = s;
        w_norm += s * s;
      }
      w_norm = Math.sqrt(w_norm);
      if (w_norm < this.tol) break;  // X effectively orthogonal to y residual
      for (let j = 0; j < m; j++) w[j] /= w_norm;

      // t = X w
      const t = new Float64Array(n);
      let tt = 0;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < m; j++) s += Xw[i * m + j] * w[j];
        t[i] = s;
        tt += s * s;
      }
      if (tt < this.tol) break;

      // p = X^T t / (t^T t)
      const p = new Float64Array(m);
      for (let j = 0; j < m; j++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += Xw[i * m + j] * t[i];
        p[j] = s / tt;
      }
      // q = y^T t / (t^T t)
      let q = 0;
      for (let i = 0; i < n; i++) q += yw[i] * t[i];
      q /= tt;

      // Deflate X and y.
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) Xw[i * m + j] -= t[i] * p[j];
        yw[i] -= t[i] * q;
      }

      // Store column c of W, P, T, Q (using k stride).
      for (let j = 0; j < m; j++) W_full[j * k + c] = w[j];
      for (let j = 0; j < m; j++) P_full[j * k + c] = p[j];
      for (let i = 0; i < n; i++) T_full[i * k + c] = t[i];
      Q_full[c] = q;
      n_iter_full[c] = 1;  // PLS1 weight has closed form; no power iteration loop
      actual_k = c + 1;
    }

    // Truncate to actual_k columns (compact column layout to avoid
    // singularity in PtW when n_components > effective rank).
    const eff_k = actual_k > 0 ? actual_k : 1;
    const W = new Float64Array(m * eff_k);
    const P = new Float64Array(m * eff_k);
    const T = new Float64Array(n * eff_k);
    const Q = new Float64Array(eff_k);
    const n_iter = new Array(eff_k);
    for (let j = 0; j < m; j++) {
      for (let c = 0; c < eff_k; c++) W[j * eff_k + c] = W_full[j * k + c];
      for (let c = 0; c < eff_k; c++) P[j * eff_k + c] = P_full[j * k + c];
    }
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < eff_k; c++) T[i * eff_k + c] = T_full[i * k + c];
    }
    for (let c = 0; c < eff_k; c++) {
      Q[c] = Q_full[c];
      n_iter[c] = n_iter_full[c] ?? 1;
    }
    // From here on, k refers to the actual component count.
    const k_use = eff_k;

    // x_rotations = W (P^T W)^-1 — the projection that maps X_new to scores.
    // For a small (k_use × k_use) inverse we use a direct solve.
    const PtW = new Float64Array(k_use * k_use);
    for (let a = 0; a < k_use; a++) {
      for (let b = 0; b < k_use; b++) {
        let s = 0;
        for (let j = 0; j < m; j++) s += P[j * k_use + a] * W[j * k_use + b];
        PtW[a * k_use + b] = s;
      }
    }
    const PtW_inv = _invertSmallMatrix(PtW, k_use);
    const x_rotations = new Float64Array(m * k_use);
    for (let j = 0; j < m; j++) {
      for (let c = 0; c < k_use; c++) {
        let s = 0;
        for (let p_idx = 0; p_idx < k_use; p_idx++) s += W[j * k_use + p_idx] * PtW_inv[p_idx * k_use + c];
        x_rotations[j * k_use + c] = s;
      }
    }

    // coef on the (centered/scaled) data: coef_scaled = x_rotations @ Q
    const coef_scaled = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let c = 0; c < k_use; c++) s += x_rotations[j * k_use + c] * Q[c];
      coef_scaled[j] = s;
    }
    // Undo standardization to get coef on the original scale.
    const coef = new Float64Array(m);
    for (let j = 0; j < m; j++) coef[j] = coef_scaled[j] * (y_std / x_std[j]);

    // Intercept = y_mean - X_mean . coef
    let intercept = y_mean;
    for (let j = 0; j < m; j++) intercept -= x_mean[j] * coef[j];

    this.x_weights_ = W;       this.x_weights_.shape = [m, k_use];
    this.x_loadings_ = P;      this.x_loadings_.shape = [m, k_use];
    this.x_scores_ = T;        this.x_scores_.shape = [n, k_use];
    this.y_loadings_ = Q;
    this.x_rotations_ = x_rotations; this.x_rotations_.shape = [m, k_use];
    this.coef_ = coef;
    this.intercept_ = intercept;
    this.n_iter_ = n_iter;
    this.x_mean_ = x_mean;
    this.x_std_ = x_std;
    this.y_mean_ = y_mean;
    this.y_std_ = y_std;
    this.n_features_in_ = m;
    this.n_components_ = k_use;
    captureFeatureNames(this, X_info);
    return this;
  }

  predict(X) {
    if (this.coef_ == null) throw new ValidationError('PLSRegression: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = this.intercept_;
      for (let j = 0; j < m; j++) acc += data[i * m + j] * this.coef_[j];
      out[i] = acc;
    }
    return out;
  }

  transform(X) {
    if (this.x_rotations_ == null) throw new ValidationError('PLSRegression: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const k = this.n_components_;
    const out = new Float64Array(n * k);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) {
        let acc = 0;
        for (let j = 0; j < m; j++) {
          acc += (data[i * m + j] - this.x_mean_[j]) / this.x_std_[j]
               * this.x_rotations_[j * k + c];
        }
        out[i * k + c] = acc;
      }
    }
    out.shape = [n, k];
    return out;
  }
}

Object.assign(PLSRegression.prototype, RegressorMixin);
PLSRegression._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

// Invert a small (k × k) matrix via Gauss-Jordan elimination with
// partial pivoting. k is bounded by n_components which is typically
// small (≤ 10), so this is fine.
function _invertSmallMatrix(A, k) {
  const aug = new Float64Array(k * 2 * k);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) aug[i * 2 * k + j] = A[i * k + j];
    aug[i * 2 * k + k + i] = 1;
  }
  for (let i = 0; i < k; i++) {
    // Pivot.
    let max_row = i;
    for (let r = i + 1; r < k; r++) {
      if (Math.abs(aug[r * 2 * k + i]) > Math.abs(aug[max_row * 2 * k + i])) max_row = r;
    }
    if (max_row !== i) {
      for (let c = 0; c < 2 * k; c++) {
        const t = aug[i * 2 * k + c];
        aug[i * 2 * k + c] = aug[max_row * 2 * k + c];
        aug[max_row * 2 * k + c] = t;
      }
    }
    const pivot = aug[i * 2 * k + i];
    if (Math.abs(pivot) < 1e-14) {
      throw new ValidationError(
        `PLSRegression: singular matrix in coefficient computation`);
    }
    for (let c = 0; c < 2 * k; c++) aug[i * 2 * k + c] /= pivot;
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const factor = aug[r * 2 * k + i];
      for (let c = 0; c < 2 * k; c++) aug[r * 2 * k + c] -= factor * aug[i * 2 * k + c];
    }
  }
  const inv = new Float64Array(k * k);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) inv[i * k + j] = aug[i * 2 * k + k + j];
  return inv;
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('PLSRegression', PLSRegression, { module: MODULE_ID_CROSS_DECOMP });
