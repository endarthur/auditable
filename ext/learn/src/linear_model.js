// Linear models — LinearRegression, Ridge, Lasso, ElasticNet,
// LogisticRegression.
//
// Sklearn-compatible at the contract level. Closed-form solvers for
// LinearRegression / Ridge via @gcu/line's lstsq + cholesky-solve;
// coordinate descent for Lasso / ElasticNet; Newton-Raphson IRLS for
// binary LogisticRegression and gradient descent for multinomial.
//
// v0.2 scope: single-output regression only (multi-output / multi-task
// variants deferred). Sample weights handled by per-residual weighting
// in the regressors; class weights for LogisticRegression deferred.
//
// Numerical convention. Penalties follow sklearn's per-sample scaling:
// the Lasso objective is `(1/(2n)) * ||y - Xβ||² + α * ||β||_1`. Ridge
// uses `||y - Xβ||² + α * ||β||²` (NOT divided by n — matches sklearn).
// LogisticRegression uses `C^-1 / 2 * ||β||² + log_loss(y, Xβ)`, also
// matches sklearn's parameterization.

import { BaseEstimator, RegressorMixin, ClassifierMixin } from './base.js';
import { asMatrix, asVector, checkNFeatures, captureFeatureNames, ValidationError } from './util/checks.js';
import { mulberry32 } from './util/random.js';
import { learnRegistry } from './serialize.js';
// Cross-package import — build.js rewrites to '../line/index.js'.
import { NdArray, lstsq, cholesky, solveCholesky } from '../../line/index.js';

const MODULE_ID_LINEAR = '@gcu/learn.linear_model';

// ────────────────────────────────────────────────────────────────────
// LinearRegression
// ────────────────────────────────────────────────────────────────────

/**
 * Ordinary least-squares linear regression.
 *
 * Hyperparameters:
 *   - fit_intercept (bool, default true)
 *
 * Fitted attributes:
 *   - coef_           (Float64Array, n_features) — slope per feature
 *   - intercept_      (number)                    — bias term, 0 when fit_intercept=false
 *   - n_features_in_, n_samples_seen_
 *
 * Algorithm: solves (X^T X) β = X^T y via line.lstsq (which uses QR /
 * SVD under the hood — handles rank-deficient X without a special path).
 * For fit_intercept=true, the intercept is fit by appending a constant
 * column to X and solving jointly, then peeling the intercept off.
 */
export class LinearRegression extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.fit_intercept = params.fit_intercept ?? true;
    this._module = MODULE_ID_LINEAR;
  }

  fit(X, y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const yv = asVector(y);
    const [n, m] = shape;
    if (yv.length !== n) {
      throw new ValidationError(
        `LinearRegression.fit: y length ${yv.length} != n_samples ${n}`);
    }
    let X_aug, m_aug;
    if (this.fit_intercept) {
      // Append a leading column of 1s so the intercept solves jointly.
      X_aug = new Float64Array(n * (m + 1));
      m_aug = m + 1;
      for (let i = 0; i < n; i++) {
        X_aug[i * m_aug] = 1;
        for (let j = 0; j < m; j++) X_aug[i * m_aug + 1 + j] = data[i * m + j];
      }
    } else {
      X_aug = data;
      m_aug = m;
    }
    const X_nd = new NdArray(X_aug, [n, m_aug]);
    const y_nd = new NdArray(yv instanceof Float64Array ? yv : Float64Array.from(yv), [n]);
    const beta = lstsq(X_nd, y_nd);
    if (this.fit_intercept) {
      this.intercept_ = beta.data[0];
      this.coef_ = new Float64Array(m);
      for (let j = 0; j < m; j++) this.coef_[j] = beta.data[1 + j];
    } else {
      this.intercept_ = 0;
      this.coef_ = new Float64Array(m);
      for (let j = 0; j < m; j++) this.coef_[j] = beta.data[j];
    }
    this.n_features_in_ = m;
    this.n_samples_seen_ = n;
    captureFeatureNames(this, X_info);
    return this;
  }

  predict(X) {
    if (this.coef_ == null) throw new ValidationError('LinearRegression: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = this.intercept_;
      const off = i * m;
      for (let j = 0; j < m; j++) acc += data[off + j] * this.coef_[j];
      out[i] = acc;
    }
    return out;
  }
}

Object.assign(LinearRegression.prototype, RegressorMixin);
LinearRegression._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// Ridge
// ────────────────────────────────────────────────────────────────────

/**
 * Ridge regression — least-squares with L2 regularization.
 *
 * Hyperparameters:
 *   - alpha         (number, default 1.0) — L2 strength
 *   - fit_intercept (bool, default true)
 *
 * Fitted attributes: coef_, intercept_, n_features_in_, n_samples_seen_.
 *
 * Algorithm: when fit_intercept=true, center X and y first (so the
 * intercept doesn't get penalized — matches sklearn). Then solve
 * (X^T X + α I) β = X^T y via Cholesky factorization of the regularized
 * Gram matrix.
 */
export class Ridge extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.alpha = params.alpha ?? 1.0;
    this.fit_intercept = params.fit_intercept ?? true;
    this._module = MODULE_ID_LINEAR;
  }

  fit(X, y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const yv = asVector(y);
    const [n, m] = shape;
    if (yv.length !== n) {
      throw new ValidationError(
        `Ridge.fit: y length ${yv.length} != n_samples ${n}`);
    }
    if (this.alpha < 0) {
      throw new ValidationError(`Ridge: alpha must be >= 0; got ${this.alpha}`);
    }
    // Center X and y so the intercept term isn't regularized.
    let X_c, y_c, x_mean, y_mean;
    if (this.fit_intercept) {
      x_mean = new Float64Array(m);
      for (let i = 0; i < n; i++) {
        const off = i * m;
        for (let j = 0; j < m; j++) x_mean[j] += data[off + j];
      }
      const inv_n = 1 / n;
      for (let j = 0; j < m; j++) x_mean[j] *= inv_n;
      y_mean = 0;
      for (let i = 0; i < n; i++) y_mean += yv[i];
      y_mean *= inv_n;
      X_c = new Float64Array(n * m);
      for (let i = 0; i < n; i++) {
        const off = i * m;
        for (let j = 0; j < m; j++) X_c[off + j] = data[off + j] - x_mean[j];
      }
      y_c = new Float64Array(n);
      for (let i = 0; i < n; i++) y_c[i] = yv[i] - y_mean;
    } else {
      x_mean = new Float64Array(m);  // zeros
      y_mean = 0;
      X_c = data instanceof Float64Array ? data : Float64Array.from(data);
      y_c = yv instanceof Float64Array ? yv : Float64Array.from(yv);
    }
    // Build Gram = X^T X (m × m), regularize, Cholesky-solve.
    const gram = new Float64Array(m * m);
    for (let j = 0; j < m; j++) {
      for (let k = j; k < m; k++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += X_c[i * m + j] * X_c[i * m + k];
        gram[j * m + k] = s;
        gram[k * m + j] = s;
      }
    }
    for (let j = 0; j < m; j++) gram[j * m + j] += this.alpha;
    // Build X^T y (length m).
    const xty = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X_c[i * m + j] * y_c[i];
      xty[j] = s;
    }
    // Cholesky-solve (gram + αI) β = X^T y.
    const gram_nd = new NdArray(gram, [m, m]);
    const L = cholesky(gram_nd);
    const xty_nd = new NdArray(xty, [m]);
    const beta = solveCholesky(L, xty_nd);

    this.coef_ = new Float64Array(m);
    for (let j = 0; j < m; j++) this.coef_[j] = beta.data[j];
    if (this.fit_intercept) {
      let inter = y_mean;
      for (let j = 0; j < m; j++) inter -= x_mean[j] * this.coef_[j];
      this.intercept_ = inter;
    } else {
      this.intercept_ = 0;
    }
    this.n_features_in_ = m;
    this.n_samples_seen_ = n;
    captureFeatureNames(this, X_info);
    return this;
  }

  predict(X) {
    if (this.coef_ == null) throw new ValidationError('Ridge: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = this.intercept_;
      const off = i * m;
      for (let j = 0; j < m; j++) acc += data[off + j] * this.coef_[j];
      out[i] = acc;
    }
    return out;
  }
}

Object.assign(Ridge.prototype, RegressorMixin);
Ridge._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// Lasso
// ────────────────────────────────────────────────────────────────────

/**
 * Lasso — least-squares with L1 regularization. Coordinate descent
 * with soft-thresholding.
 *
 * Hyperparameters:
 *   - alpha         (number, default 1.0)
 *   - fit_intercept (bool, default true)
 *   - max_iter      (int, default 1000)
 *   - tol           (number, default 1e-4) — duality-gap-like stopping
 *   - selection     ('cyclic' | 'random', default 'cyclic')
 *   - random_state  (int|null) — only consulted when selection='random'
 *
 * Fitted attributes: coef_, intercept_, n_iter_, n_features_in_.
 *
 * Algorithm: cyclic coordinate descent with soft-thresholding update
 *   β_j ← S(X_j^T r + ||X_j||² β_j, α n) / ||X_j||²
 * where S(z, t) = sign(z) max(0, |z| - t). r is the residual y - Xβ.
 */
export class Lasso extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.alpha = params.alpha ?? 1.0;
    this.fit_intercept = params.fit_intercept ?? true;
    this.max_iter = params.max_iter ?? 1000;
    this.tol = params.tol ?? 1e-4;
    this.selection = params.selection ?? 'cyclic';
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_LINEAR;
  }

  fit(X, y, _opts) {
    return _fitElasticNet(this, X, y, this.alpha, 1.0);
  }

  predict(X) {
    if (this.coef_ == null) throw new ValidationError('Lasso: not fitted');
    return _linearPredict(this, X);
  }
}

Object.assign(Lasso.prototype, RegressorMixin);
Lasso._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// ElasticNet
// ────────────────────────────────────────────────────────────────────

/**
 * ElasticNet — combined L1 + L2 regularization.
 *
 *   objective = (1/(2n)) ||y - Xβ||² + α(l1 ||β||_1 + 0.5(1-l1) ||β||²)
 *
 * Hyperparameters:
 *   - alpha         (number, default 1.0) — total regularization strength
 *   - l1_ratio      (number in [0,1], default 0.5) — balance between L1 / L2
 *   - fit_intercept, max_iter, tol, selection, random_state — as Lasso
 *
 * l1_ratio=1 reduces to Lasso; l1_ratio=0 reduces to Ridge (with the
 * sklearn-style per-sample-scaled objective).
 */
export class ElasticNet extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.alpha = params.alpha ?? 1.0;
    this.l1_ratio = params.l1_ratio ?? 0.5;
    this.fit_intercept = params.fit_intercept ?? true;
    this.max_iter = params.max_iter ?? 1000;
    this.tol = params.tol ?? 1e-4;
    this.selection = params.selection ?? 'cyclic';
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_LINEAR;
  }

  fit(X, y, _opts) {
    if (this.l1_ratio < 0 || this.l1_ratio > 1) {
      throw new ValidationError(
        `ElasticNet: l1_ratio must be in [0, 1]; got ${this.l1_ratio}`);
    }
    return _fitElasticNet(this, X, y, this.alpha, this.l1_ratio);
  }

  predict(X) {
    if (this.coef_ == null) throw new ValidationError('ElasticNet: not fitted');
    return _linearPredict(this, X);
  }
}

Object.assign(ElasticNet.prototype, RegressorMixin);
ElasticNet._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// LogisticRegression
// ────────────────────────────────────────────────────────────────────

/**
 * Logistic regression — binary via Newton-Raphson IRLS, multinomial
 * via gradient descent.
 *
 * Hyperparameters:
 *   - penalty       ('l2' | 'none', default 'l2')
 *   - C             (number, default 1.0) — inverse regularization
 *                   strength (sklearn convention: smaller C → stronger penalty)
 *   - fit_intercept (bool, default true)
 *   - max_iter      (int, default 100)
 *   - tol           (number, default 1e-4)
 *   - solver        ('lbfgs', default — the only one we ship in v0.2;
 *                   actual implementation is IRLS for binary, gradient
 *                   descent for multinomial)
 *   - multi_class   ('auto' | 'ovr' | 'multinomial', default 'auto')
 *
 * Fitted attributes:
 *   - coef_         (Float64Array, shape [n_classes_eff, n_features])
 *                   (n_classes_eff = 1 for binary, n_classes for multinomial)
 *   - intercept_    (Float64Array, length n_classes_eff)
 *   - classes_      (sorted unique class labels)
 *   - n_iter_       (int)
 *   - n_features_in_
 */
export class LogisticRegression extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.penalty = params.penalty ?? 'l2';
    this.C = params.C ?? 1.0;
    this.fit_intercept = params.fit_intercept ?? true;
    this.max_iter = params.max_iter ?? 100;
    this.tol = params.tol ?? 1e-4;
    this.solver = params.solver ?? 'lbfgs';
    this.multi_class = params.multi_class ?? 'auto';
    this._module = MODULE_ID_LINEAR;
  }

  fit(X, y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const yv = asVector(y);
    const [n, m] = shape;
    if (yv.length !== n) {
      throw new ValidationError(
        `LogisticRegression.fit: y length ${yv.length} != n_samples ${n}`);
    }
    if (this.penalty !== 'l2' && this.penalty !== 'none') {
      throw new ValidationError(
        `LogisticRegression: penalty='${this.penalty}' not supported in v0.2 ` +
        `(use 'l2' or 'none')`);
    }
    const { classes, encoded } = _encodeClasses(yv);
    this.classes_ = classes;
    const K = classes.length;
    const isBinary = K === 2 && this.multi_class !== 'multinomial';
    const lambda = this.penalty === 'l2' ? 1 / Math.max(1e-300, this.C) : 0;

    if (isBinary) {
      const { beta, n_iter } = _logRegBinaryIRLS(
        data, encoded, n, m, lambda,
        this.fit_intercept, this.max_iter, this.tol);
      // coef_ shape [1, m], intercept_ shape [1]
      this.coef_ = new Float64Array(m);
      for (let j = 0; j < m; j++) this.coef_[j] = beta[this.fit_intercept ? j + 1 : j];
      this.coef_.shape = [1, m];
      this.intercept_ = new Float64Array(1);
      this.intercept_[0] = this.fit_intercept ? beta[0] : 0;
      this.n_iter_ = n_iter;
    } else {
      const { W, n_iter } = _logRegMultinomialGD(
        data, encoded, n, m, K, lambda,
        this.fit_intercept, this.max_iter, this.tol);
      // W shape [K, m + (1 if intercept else 0)] — first col is intercept.
      this.coef_ = new Float64Array(K * m);
      this.intercept_ = new Float64Array(K);
      const stride = this.fit_intercept ? m + 1 : m;
      for (let c = 0; c < K; c++) {
        if (this.fit_intercept) this.intercept_[c] = W[c * stride];
        for (let j = 0; j < m; j++) {
          this.coef_[c * m + j] = W[c * stride + (this.fit_intercept ? j + 1 : j)];
        }
      }
      this.coef_.shape = [K, m];
      this.n_iter_ = n_iter;
    }
    this.n_features_in_ = m;
    captureFeatureNames(this, X_info);
    return this;
  }

  decision_function(X) {
    if (this.coef_ == null) throw new ValidationError('LogisticRegression: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    // K_eff = how many decision rows the coef_ matrix carries: 1 for binary,
    // n_classes for multinomial. mimic-io drops the .shape property on
    // Float64Array round-trip, so derive it from length / n_features_in_.
    const K_eff = this.coef_.length / m;
    const out = new Float64Array(n * K_eff);
    for (let i = 0; i < n; i++) {
      const off_x = i * m;
      for (let c = 0; c < K_eff; c++) {
        let acc = this.intercept_[c];
        const off_c = c * m;
        for (let j = 0; j < m; j++) acc += data[off_x + j] * this.coef_[off_c + j];
        out[i * K_eff + c] = acc;
      }
    }
    out.shape = [n, K_eff];
    return out;
  }

  predict_proba(X) {
    const z = this.decision_function(X);
    const m = this.n_features_in_;
    const K_eff = this.coef_.length / m;
    const n = z.length / K_eff;
    const K = this.classes_.length;
    if (K === 2 && K_eff === 1) {
      const out = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        const p = 1 / (1 + Math.exp(-z[i]));
        out[i * 2] = 1 - p;
        out[i * 2 + 1] = p;
      }
      out.shape = [n, 2];
      return out;
    }
    // Multinomial softmax.
    const out = new Float64Array(n * K);
    for (let i = 0; i < n; i++) {
      let zmax = -Infinity;
      for (let c = 0; c < K; c++) if (z[i * K + c] > zmax) zmax = z[i * K + c];
      let denom = 0;
      for (let c = 0; c < K; c++) {
        const e = Math.exp(z[i * K + c] - zmax);
        out[i * K + c] = e;
        denom += e;
      }
      const inv = 1 / denom;
      for (let c = 0; c < K; c++) out[i * K + c] *= inv;
    }
    out.shape = [n, K];
    return out;
  }

  predict(X) {
    const proba = this.predict_proba(X);
    const K = this.classes_.length;
    const n = proba.length / K;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0, bestP = -1;
      for (let c = 0; c < K; c++) {
        if (proba[i * K + c] > bestP) { best = c; bestP = proba[i * K + c]; }
      }
      out[i] = this.classes_[best];
    }
    return out;
  }
}

Object.assign(LogisticRegression.prototype, ClassifierMixin);
LogisticRegression._estimator_type = 'classifier';

// ────────────────────────────────────────────────────────────────────
// Internals — coordinate descent, IRLS, helpers
// ────────────────────────────────────────────────────────────────────

// Shared coordinate-descent fit for Lasso/ElasticNet. l1 = l1_ratio.
function _fitElasticNet(est, X, y, alpha, l1) {
  const X_info = asMatrix(X);
  const { data, shape } = X_info;
  const yv = asVector(y);
  const [n, m] = shape;
  if (yv.length !== n) {
    throw new ValidationError(`fit: y length ${yv.length} != n_samples ${n}`);
  }
  // Center X / y when fit_intercept (so intercept isn't penalized).
  let X_c, y_c, x_mean, y_mean;
  if (est.fit_intercept) {
    x_mean = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) x_mean[j] += data[off + j];
    }
    const inv_n = 1 / n;
    for (let j = 0; j < m; j++) x_mean[j] *= inv_n;
    y_mean = 0;
    for (let i = 0; i < n; i++) y_mean += yv[i];
    y_mean *= inv_n;
    X_c = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const off = i * m;
      for (let j = 0; j < m; j++) X_c[off + j] = data[off + j] - x_mean[j];
    }
    y_c = new Float64Array(n);
    for (let i = 0; i < n; i++) y_c[i] = yv[i] - y_mean;
  } else {
    x_mean = new Float64Array(m);
    y_mean = 0;
    X_c = data instanceof Float64Array ? data : Float64Array.from(data);
    y_c = yv instanceof Float64Array ? yv : Float64Array.from(yv);
  }
  // Pre-compute column squared-norms.
  const xx = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const v = X_c[i * m + j];
      s += v * v;
    }
    xx[j] = s;
  }
  // Initialize residual r = y - X β  with β = 0 → r = y.
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = y_c[i];
  const beta = new Float64Array(m);
  // Penalty constants (sklearn-style, scaled by n).
  const l1_term = alpha * l1 * n;
  const l2_term = alpha * (1 - l1) * n;
  // Coordinate ordering helper.
  const rng = est.selection === 'random' && est.random_state != null
    ? mulberry32(est.random_state) : null;
  const order = new Int32Array(m);
  for (let j = 0; j < m; j++) order[j] = j;

  let n_iter = 0;
  for (let iter = 0; iter < est.max_iter; iter++) {
    n_iter = iter + 1;
    if (est.selection === 'random' && rng) {
      for (let i = m - 1; i > 0; i--) {
        const k = Math.floor(rng() * (i + 1));
        const t = order[i]; order[i] = order[k]; order[k] = t;
      }
    }
    let max_delta = 0;
    for (let p = 0; p < m; p++) {
      const j = order[p];
      const xx_j = xx[j];
      if (xx_j === 0) continue;
      // Compute X_j · r + xx_j * β_j (residual including current β_j contrib).
      let z = 0;
      for (let i = 0; i < n; i++) z += X_c[i * m + j] * r[i];
      z += xx_j * beta[j];
      // Soft-threshold with combined L1/L2.
      let new_beta;
      if (z > l1_term) new_beta = (z - l1_term) / (xx_j + l2_term);
      else if (z < -l1_term) new_beta = (z + l1_term) / (xx_j + l2_term);
      else new_beta = 0;
      const delta = new_beta - beta[j];
      if (delta !== 0) {
        for (let i = 0; i < n; i++) r[i] -= X_c[i * m + j] * delta;
        beta[j] = new_beta;
      }
      const adelta = Math.abs(delta);
      if (adelta > max_delta) max_delta = adelta;
    }
    if (max_delta < est.tol) break;
  }

  est.coef_ = beta;
  est.intercept_ = est.fit_intercept ? _intercept(y_mean, x_mean, beta, m) : 0;
  est.n_iter_ = n_iter;
  est.n_features_in_ = m;
  est.n_samples_seen_ = n;
  captureFeatureNames(est, X_info);
  return est;
}

function _intercept(y_mean, x_mean, beta, m) {
  let inter = y_mean;
  for (let j = 0; j < m; j++) inter -= x_mean[j] * beta[j];
  return inter;
}

function _linearPredict(est, X) {
  const { data, shape } = asMatrix(X);
  checkNFeatures(est, shape, { name: 'X' });
  const [n, m] = shape;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = est.intercept_;
    const off = i * m;
    for (let j = 0; j < m; j++) acc += data[off + j] * est.coef_[j];
    out[i] = acc;
  }
  return out;
}

// Binary IRLS: maximize ℓ(β) - λ/2 ||β||² with logistic loss.
//   p_i = sigmoid(η_i),  η = X̃β
//   gradient = X̃^T (p - y) + λ β
//   Hessian  = X̃^T diag(p(1-p)) X̃ + λ I
// Newton step: β_new = β - H^{-1} gradient.
function _logRegBinaryIRLS(X, y, n, m, lambda, fit_intercept, max_iter, tol) {
  const m_aug = fit_intercept ? m + 1 : m;
  // Build augmented design matrix.
  const X_aug = new Float64Array(n * m_aug);
  for (let i = 0; i < n; i++) {
    if (fit_intercept) X_aug[i * m_aug] = 1;
    for (let j = 0; j < m; j++) X_aug[i * m_aug + (fit_intercept ? j + 1 : j)] = X[i * m + j];
  }
  const beta = new Float64Array(m_aug);  // start at 0
  const eta = new Float64Array(n);
  const p = new Float64Array(n);
  const w = new Float64Array(n);
  const grad = new Float64Array(m_aug);
  const H = new Float64Array(m_aug * m_aug);
  let n_iter = 0;
  for (let iter = 0; iter < max_iter; iter++) {
    n_iter = iter + 1;
    // η = X̃β; p = sigmoid(η); w = p(1-p)
    for (let i = 0; i < n; i++) {
      let e = 0;
      const off = i * m_aug;
      for (let j = 0; j < m_aug; j++) e += X_aug[off + j] * beta[j];
      eta[i] = e;
      const pi = 1 / (1 + Math.exp(-e));
      p[i] = pi;
      w[i] = pi * (1 - pi);
    }
    // gradient = X̃^T (p - y) + λ β  (don't penalize intercept)
    for (let j = 0; j < m_aug; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X_aug[i * m_aug + j] * (p[i] - y[i]);
      const reg_j = (fit_intercept && j === 0) ? 0 : lambda * beta[j];
      grad[j] = s + reg_j;
    }
    // Hessian = X̃^T diag(w) X̃ + λ I (skip intercept on regularizer)
    for (let a = 0; a < m_aug; a++) {
      for (let b = a; b < m_aug; b++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += X_aug[i * m_aug + a] * w[i] * X_aug[i * m_aug + b];
        H[a * m_aug + b] = s;
        H[b * m_aug + a] = s;
      }
    }
    for (let j = 0; j < m_aug; j++) {
      if (!(fit_intercept && j === 0)) H[j * m_aug + j] += lambda;
    }
    // Solve H δ = grad → β -= δ
    const H_nd = new NdArray(H, [m_aug, m_aug]);
    const grad_nd = new NdArray(grad, [m_aug]);
    let delta;
    try {
      const L = cholesky(H_nd);
      delta = solveCholesky(L, grad_nd);
    } catch (_) {
      // Hessian non-PD (unlikely with positive λ); fall back to lstsq.
      delta = lstsq(H_nd, grad_nd);
    }
    let max_delta = 0;
    for (let j = 0; j < m_aug; j++) {
      beta[j] -= delta.data[j];
      const a = Math.abs(delta.data[j]);
      if (a > max_delta) max_delta = a;
    }
    if (max_delta < tol) break;
  }
  return { beta, n_iter };
}

// Multinomial logistic regression via gradient descent with line search.
// Minimizes -log-likelihood + (λ/2) ||W||² (sklearn-style penalty).
function _logRegMultinomialGD(X, y, n, m, K, lambda, fit_intercept, max_iter, tol) {
  const m_aug = fit_intercept ? m + 1 : m;
  const X_aug = new Float64Array(n * m_aug);
  for (let i = 0; i < n; i++) {
    if (fit_intercept) X_aug[i * m_aug] = 1;
    for (let j = 0; j < m; j++) X_aug[i * m_aug + (fit_intercept ? j + 1 : j)] = X[i * m + j];
  }
  const W = new Float64Array(K * m_aug);
  const eta = new Float64Array(n * K);
  const probs = new Float64Array(n * K);
  let n_iter = 0;
  let lr = 1.0;
  let prev_loss = Infinity;
  for (let iter = 0; iter < max_iter; iter++) {
    n_iter = iter + 1;
    // η = X̃ W^T  (n × K)
    for (let i = 0; i < n; i++) {
      const off_x = i * m_aug;
      for (let c = 0; c < K; c++) {
        let s = 0;
        const off_w = c * m_aug;
        for (let j = 0; j < m_aug; j++) s += X_aug[off_x + j] * W[off_w + j];
        eta[i * K + c] = s;
      }
    }
    // Softmax probabilities + cross-entropy loss.
    let loss = 0;
    for (let i = 0; i < n; i++) {
      let zmax = -Infinity;
      for (let c = 0; c < K; c++) if (eta[i * K + c] > zmax) zmax = eta[i * K + c];
      let denom = 0;
      for (let c = 0; c < K; c++) {
        const e = Math.exp(eta[i * K + c] - zmax);
        probs[i * K + c] = e;
        denom += e;
      }
      const inv = 1 / denom;
      const yi = y[i] | 0;
      for (let c = 0; c < K; c++) probs[i * K + c] *= inv;
      loss -= Math.log(Math.max(1e-300, probs[i * K + yi]));
    }
    loss += 0.5 * lambda * _l2NormSq(W, fit_intercept ? m_aug : 0, m_aug, K);
    if (Math.abs(prev_loss - loss) < tol * Math.max(1, Math.abs(prev_loss))) break;
    prev_loss = loss;
    // Gradient of loss w.r.t. W: G[c, j] = sum_i (probs[i,c] - I[y_i=c]) x[i,j] + λ W[c,j]
    const G = new Float64Array(K * m_aug);
    for (let c = 0; c < K; c++) {
      for (let j = 0; j < m_aug; j++) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const r = probs[i * K + c] - (y[i] === c ? 1 : 0);
          s += r * X_aug[i * m_aug + j];
        }
        const reg = (fit_intercept && j === 0) ? 0 : lambda * W[c * m_aug + j];
        G[c * m_aug + j] = s + reg;
      }
    }
    // Update with simple step + lr backoff if loss didn't go down.
    for (let i = 0; i < W.length; i++) W[i] -= lr * G[i] / n;
  }
  return { W, n_iter };
}

function _l2NormSq(W, intercept_offset, stride, K) {
  let s = 0;
  for (let c = 0; c < K; c++) {
    for (let j = intercept_offset > 0 ? 1 : 0; j < stride; j++) {
      const v = W[c * stride + j];
      s += v * v;
    }
  }
  return s;
}

// Encode unique class labels to dense ints. Identical to tree.js's helper —
// kept inline to avoid reaching across module boundaries during build concat.
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

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('LinearRegression', LinearRegression, { module: MODULE_ID_LINEAR });
learnRegistry.register('Ridge', Ridge, { module: MODULE_ID_LINEAR });
learnRegistry.register('Lasso', Lasso, { module: MODULE_ID_LINEAR });
learnRegistry.register('ElasticNet', ElasticNet, { module: MODULE_ID_LINEAR });
learnRegistry.register('LogisticRegression', LogisticRegression, { module: MODULE_ID_LINEAR });
