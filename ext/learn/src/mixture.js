// Gaussian Mixture Models — soft clustering / density estimation via EM.
//
// Sklearn-compatible (`sklearn.mixture.GaussianMixture`). v0.2 ships
// covariance_type='full' only (the most general); 'tied' / 'diag' /
// 'spherical' are simpler special cases that fall out of the same EM
// loop and land in v0.3.
//
// Numerical strategy. We store `precisions_cholesky_` (sklearn shape):
// the upper-triangular U such that Σ⁻¹ = U Uᵀ, computed once per M-step
// from the covariance Cholesky factor L (Σ = L Lᵀ → U = L⁻ᵀ). With this,
//   log N(x | μ, Σ) = -½ (m log 2π) + ½ log|Σ⁻¹| - ½ ‖Uᵀ(x - μ)‖²
// which avoids ever forming Σ⁻¹ explicitly and gives cheap log-density.

import { BaseEstimator, ClusterMixin } from './base.js';
import { asMatrix, checkNFeatures, captureFeatureNames, ValidationError } from './util/checks.js';
import { mulberry32 } from './util/random.js';
import { learnRegistry } from './serialize.js';
// Cross-package: line.cholesky for the precision factor.
import { NdArray, cholesky } from '../../line/index.js';

const MODULE_ID_MIXTURE = '@gcu/learn.mixture';

// ────────────────────────────────────────────────────────────────────
// GaussianMixture
// ────────────────────────────────────────────────────────────────────

export class GaussianMixture extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_components = params.n_components ?? 1;
    this.covariance_type = params.covariance_type ?? 'full';
    this.tol = params.tol ?? 1e-3;
    this.reg_covar = params.reg_covar ?? 1e-6;
    this.max_iter = params.max_iter ?? 100;
    this.n_init = params.n_init ?? 1;
    this.init_params = params.init_params ?? 'kmeans';
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_MIXTURE;
  }

  fit(X, _y, _opts) {
    const X_info = asMatrix(X);
    const { data, shape } = X_info;
    const [n, m] = shape;
    if (this.covariance_type !== 'full') {
      throw new ValidationError(
        `GaussianMixture: covariance_type='${this.covariance_type}' not supported in v0.2 (use 'full')`);
    }
    if (n < this.n_components) {
      throw new ValidationError(
        `GaussianMixture: n_components=${this.n_components} > n_samples=${n}`);
    }
    const baseSeed = this.random_state == null
      ? Math.floor(Math.random() * 0x7fffffff)
      : this.random_state;

    let best = null;
    for (let trial = 0; trial < this.n_init; trial++) {
      const rng = mulberry32(baseSeed + trial);
      const result = _emFit(
        data, n, m, this.n_components, this.tol, this.reg_covar,
        this.max_iter, this.init_params, rng);
      if (best == null || result.lower_bound > best.lower_bound) best = result;
    }
    this.weights_ = best.weights;
    this.means_ = best.means; this.means_.shape = [this.n_components, m];
    this.covariances_ = best.covariances;
    this.precisions_cholesky_ = best.precisions_cholesky;
    this.converged_ = best.converged;
    this.n_iter_ = best.n_iter;
    this.lower_bound_ = best.lower_bound;
    this.n_features_in_ = m;
    captureFeatureNames(this, X_info);
    return this;
  }

  predict(X) {
    const proba = this.predict_proba(X);
    const k = this.n_components;
    const n = proba.length / k;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0, bestP = -1;
      for (let c = 0; c < k; c++) {
        if (proba[i * k + c] > bestP) { best = c; bestP = proba[i * k + c]; }
      }
      out[i] = best;
    }
    return out;
  }

  predict_proba(X) {
    if (this.weights_ == null) throw new ValidationError('GaussianMixture: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const k = this.n_components;
    const log_resp = _computeLogResp(
      data, n, m, k, this.weights_, this.means_, this.precisions_cholesky_);
    // Convert log-responsibilities to probabilities (already normalized).
    const out = new Float64Array(n * k);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) out[i * k + c] = Math.exp(log_resp[i * k + c]);
    }
    out.shape = [n, k];
    return out;
  }

  score_samples(X) {
    if (this.weights_ == null) throw new ValidationError('GaussianMixture: not fitted');
    const { data, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    return _logProbX(data, n, m, this.n_components,
      this.weights_, this.means_, this.precisions_cholesky_);
  }

  score(X, _y, _opts) {
    const ll = this.score_samples(X);
    let s = 0; for (let i = 0; i < ll.length; i++) s += ll[i];
    return s / ll.length;
  }

}

Object.assign(GaussianMixture.prototype, ClusterMixin);
// Override after the mixin: ClusterMixin's fit_predict returns
// this.labels_, but GaussianMixture computes labels via predict().
GaussianMixture.prototype.fit_predict = function (X, y, opts) {
  return this.fit(X, y, opts).predict(X);
};
GaussianMixture._estimator_type = 'clusterer';

// ────────────────────────────────────────────────────────────────────
// EM core
// ────────────────────────────────────────────────────────────────────

// Returns { weights, means, covariances, precisions_cholesky,
//           converged, n_iter, lower_bound }.
function _emFit(X, n, m, k, tol, reg_covar, max_iter, init_params, rng) {
  // ── Initialize ──
  const means = init_params === 'kmeans'
    ? _kmeansPlusPlusMeans(X, n, m, k, rng)
    : _randomMeans(X, n, m, k, rng);
  // Initial covariances = sample covariance, replicated k times.
  const cov0 = _sampleCov(X, n, m, reg_covar);
  const covariances = new Array(k);
  for (let c = 0; c < k; c++) covariances[c] = cov0.slice();
  const weights = new Float64Array(k).fill(1 / k);
  let precisions_cholesky = _computePrecisionsCholesky(covariances, m, reg_covar);

  let prev_lb = -Infinity;
  let converged = false;
  let iter = 0;
  let lower_bound = -Infinity;
  for (iter = 0; iter < max_iter; iter++) {
    // ── E-step: log-responsibilities + log-likelihood per sample ──
    const log_resp = _computeLogResp(X, n, m, k, weights, means, precisions_cholesky);
    // ── M-step ──
    const Nk = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) Nk[c] += Math.exp(log_resp[i * k + c]);
    }
    // Update weights.
    for (let c = 0; c < k; c++) weights[c] = Math.max(1e-300, Nk[c] / n);
    // Update means.
    means.fill(0);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) {
        const r = Math.exp(log_resp[i * k + c]);
        for (let j = 0; j < m; j++) means[c * m + j] += r * X[i * m + j];
      }
    }
    for (let c = 0; c < k; c++) {
      const inv = 1 / Math.max(1e-300, Nk[c]);
      for (let j = 0; j < m; j++) means[c * m + j] *= inv;
    }
    // Update covariances.
    for (let c = 0; c < k; c++) {
      covariances[c].fill(0);
      const inv = 1 / Math.max(1e-300, Nk[c]);
      for (let i = 0; i < n; i++) {
        const r = Math.exp(log_resp[i * k + c]);
        for (let a = 0; a < m; a++) {
          const da = X[i * m + a] - means[c * m + a];
          for (let b = a; b < m; b++) {
            const db = X[i * m + b] - means[c * m + b];
            covariances[c][a * m + b] += r * da * db;
          }
        }
      }
      // Symmetrize + regularize.
      for (let a = 0; a < m; a++) {
        for (let b = a; b < m; b++) {
          covariances[c][a * m + b] *= inv;
          if (a === b) covariances[c][a * m + b] += reg_covar;
          covariances[c][b * m + a] = covariances[c][a * m + b];
        }
      }
    }
    precisions_cholesky = _computePrecisionsCholesky(covariances, m, reg_covar);
    // Recompute the lower bound (log-likelihood) from the post-update params.
    lower_bound = _logLikelihood(X, n, m, k, weights, means, precisions_cholesky);
    if (Math.abs(lower_bound - prev_lb) < tol) { converged = true; iter++; break; }
    prev_lb = lower_bound;
  }

  return {
    weights, means, covariances, precisions_cholesky,
    converged, n_iter: iter, lower_bound,
  };
}

// k-means++ initialization for means (mirrors cluster.js's _kmeansPlusPlusInit
// but produces just the centroids with no full Lloyd loop).
function _kmeansPlusPlusMeans(X, n, m, k, rng) {
  const means = new Float64Array(k * m);
  const i0 = Math.floor(rng() * n);
  for (let j = 0; j < m; j++) means[j] = X[i0 * m + j];
  const min_d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) min_d2[i] = Infinity;
  _updateMinD2_mix(min_d2, X, n, m, means, 0);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += min_d2[i];
    let r = rng() * total;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      r -= min_d2[i];
      if (r <= 0) { pick = i; break; }
    }
    for (let j = 0; j < m; j++) means[c * m + j] = X[pick * m + j];
    _updateMinD2_mix(min_d2, X, n, m, means, c);
  }
  return means;
}

function _updateMinD2_mix(min_d2, X, n, m, means, c) {
  const off_c = c * m;
  for (let i = 0; i < n; i++) {
    let d = 0;
    const off_x = i * m;
    for (let j = 0; j < m; j++) {
      const diff = X[off_x + j] - means[off_c + j];
      d += diff * diff;
    }
    if (d < min_d2[i]) min_d2[i] = d;
  }
}

function _randomMeans(X, n, m, k, rng) {
  const means = new Float64Array(k * m);
  for (let c = 0; c < k; c++) {
    const i = Math.floor(rng() * n);
    for (let j = 0; j < m; j++) means[c * m + j] = X[i * m + j];
  }
  return means;
}

// Sample covariance of X with regularization on the diagonal.
function _sampleCov(X, n, m, reg) {
  const mean = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) mean[j] += X[i * m + j];
  }
  const inv_n = 1 / n;
  for (let j = 0; j < m; j++) mean[j] *= inv_n;
  const cov = new Float64Array(m * m);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < m; a++) {
      const da = X[i * m + a] - mean[a];
      for (let b = a; b < m; b++) {
        cov[a * m + b] += da * (X[i * m + b] - mean[b]);
      }
    }
  }
  for (let a = 0; a < m; a++) {
    for (let b = a; b < m; b++) {
      cov[a * m + b] *= inv_n;
      if (a === b) cov[a * m + b] += reg;
      cov[b * m + a] = cov[a * m + b];
    }
  }
  return cov;
}

// For each component, compute U such that Σ⁻¹ = U Uᵀ.
// line.cholesky returns lower-triangular L with Σ = L Lᵀ. The precision
// factor U = L⁻ᵀ — we solve L Y = I for Y then transpose (or equivalently
// invert L via back-substitution). For the small per-component matrices
// here, the simplest correct path is: invert L via forward-solve, then
// the resulting matrix is L⁻¹ (lower triangular). Take transpose → U.
function _computePrecisionsCholesky(covariances, m, reg_covar) {
  const out = new Array(covariances.length);
  for (let c = 0; c < covariances.length; c++) {
    let cov = covariances[c];
    let L;
    let attempts = 0;
    while (attempts < 5) {
      try {
        L = cholesky(new NdArray(cov, [m, m]));
        break;
      } catch (_) {
        // Non-PD — boost regularization and retry.
        cov = cov.slice();
        for (let a = 0; a < m; a++) cov[a * m + a] += reg_covar * Math.pow(10, attempts + 1);
        attempts++;
      }
    }
    if (!L) throw new ValidationError(
      `GaussianMixture: covariance for component ${c} is not positive-definite ` +
      `even after regularization boost. Try a larger reg_covar.`);
    // L_inv: invert lower triangular via column-wise forward substitution.
    const Linv = new Float64Array(m * m);
    for (let col = 0; col < m; col++) {
      // Solve L * x = e_col for x.
      const x = new Float64Array(m);
      x[col] = 1 / L.data[col * m + col];
      for (let i = col + 1; i < m; i++) {
        let s = 0;
        for (let j = col; j < i; j++) s += L.data[i * m + j] * x[j];
        x[i] = -s / L.data[i * m + i];
      }
      for (let i = 0; i < m; i++) Linv[i * m + col] = x[i];
    }
    // U = L⁻ᵀ → upper triangular (since L⁻¹ is lower triangular, transpose).
    const U = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) U[i * m + j] = Linv[j * m + i];
    }
    out[c] = U;
  }
  return out;
}

// Compute log-responsibilities log P(component_c | x_i) for each (i, c).
// Output shape: [n * k] row-major.
function _computeLogResp(X, n, m, k, weights, means, precisions_cholesky) {
  // log_prob[i, c] = log w_c + log N(x_i | mu_c, Sigma_c)
  const log_prob = _logProbWeighted(X, n, m, k, weights, means, precisions_cholesky);
  const out = new Float64Array(n * k);
  for (let i = 0; i < n; i++) {
    let lmax = -Infinity;
    for (let c = 0; c < k; c++) if (log_prob[i * k + c] > lmax) lmax = log_prob[i * k + c];
    let denom = 0;
    for (let c = 0; c < k; c++) denom += Math.exp(log_prob[i * k + c] - lmax);
    const log_denom = lmax + Math.log(denom);
    for (let c = 0; c < k; c++) out[i * k + c] = log_prob[i * k + c] - log_denom;
  }
  return out;
}

// log P(x_i | params) — the marginal log-density over the mixture.
function _logProbX(X, n, m, k, weights, means, precisions_cholesky) {
  const log_prob = _logProbWeighted(X, n, m, k, weights, means, precisions_cholesky);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let lmax = -Infinity;
    for (let c = 0; c < k; c++) if (log_prob[i * k + c] > lmax) lmax = log_prob[i * k + c];
    let denom = 0;
    for (let c = 0; c < k; c++) denom += Math.exp(log_prob[i * k + c] - lmax);
    out[i] = lmax + Math.log(denom);
  }
  return out;
}

// Mean log-likelihood of X under the fitted mixture.
function _logLikelihood(X, n, m, k, weights, means, precisions_cholesky) {
  const ll = _logProbX(X, n, m, k, weights, means, precisions_cholesky);
  let s = 0; for (let i = 0; i < n; i++) s += ll[i];
  return s / n;
}

// log-prob plus log-weight per (sample, component). Uses precision Cholesky
// for fast log-density:
//   log N(x | μ, Σ) = -½ m log(2π) + log|U|_diag - ½ ‖Uᵀ(x - μ)‖²
// where Σ⁻¹ = U Uᵀ and log|Σ|^{-½} = sum(log diag(U)).
function _logProbWeighted(X, n, m, k, weights, means, precisions_cholesky) {
  const out = new Float64Array(n * k);
  const log_2pi = Math.log(2 * Math.PI);
  for (let c = 0; c < k; c++) {
    const U = precisions_cholesky[c];
    const log_det_prec_half = _logDiagSum(U, m);  // log |U| (since U is upper-tri)
    const log_w_c = Math.log(Math.max(1e-300, weights[c]));
    const norm_const = -0.5 * m * log_2pi + log_det_prec_half + log_w_c;
    for (let i = 0; i < n; i++) {
      // Compute Uᵀ * (x_i - μ_c) = (m-vector). U is upper tri.
      let sumsq = 0;
      for (let r = 0; r < m; r++) {
        // (Uᵀ d)[r] = sum_a U[a, r] * d[a]
        let s = 0;
        for (let a = 0; a <= r; a++) {
          s += U[a * m + r] * (X[i * m + a] - means[c * m + a]);
        }
        sumsq += s * s;
      }
      out[i * k + c] = norm_const - 0.5 * sumsq;
    }
  }
  return out;
}

function _logDiagSum(M, m) {
  let s = 0;
  for (let i = 0; i < m; i++) s += Math.log(Math.abs(M[i * m + i]));
  return s;
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('GaussianMixture', GaussianMixture, { module: MODULE_ID_MIXTURE });
