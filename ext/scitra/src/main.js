// @gcu/scitra — top-level barrel.
// Re-exports the API surface organized by scipy-shaped namespace.

import { norm, lognorm, t } from './stats/distributions.js';
import {
  weighted_mean, weighted_var, weighted_std,
  weighted_percentile, weighted_median,
  ecdf, histogram, moments,
  gmean, hmean, ttest_ind,
} from './stats/descriptives.js';
import { normal_score_transform } from './stats/transform.js';
import { gaussian_kde } from './stats/kde.js';
import { cdist, pdist, squareform } from './spatial/distance.js';
import { KDTree } from './spatial/kdtree.js';
import { least_squares, curve_fit } from './optimize/lstsq.js';
import { erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta } from './util/special.js';
import { mulberry32, makeRng, makeNormalSampler } from './util/random.js';
import { setBackend, clearBackend, getNatra, GEMM_NM_THRESHOLD } from './util/backend.js';

export const stats = {
  // distributions
  norm,
  lognorm,
  t,
  // descriptives
  weighted_mean, weighted_var, weighted_std,
  weighted_percentile, weighted_median,
  ecdf, histogram, moments,
  gmean, hmean, ttest_ind,
  // transforms
  normal_score_transform,
  // kde
  gaussian_kde,
};

export const spatial = {
  // distance
  cdist, pdist, squareform,
  distance: { cdist, pdist, squareform },
  // kdtree
  KDTree,
  kdtree: { KDTree },
};

export const optimize = {
  least_squares,
  curve_fit,
};

export const special = {
  erf, erfc, erfinv, ndtri,
  lgamma, gamma, lbeta,
};

export const random = {
  mulberry32,
  makeRng,
  makeNormalSampler,
};

// Direct re-exports for tree-shaking convenience.
export { norm, lognorm, t };
export {
  weighted_mean, weighted_var, weighted_std,
  weighted_percentile, weighted_median,
  ecdf, histogram, moments,
  gmean, hmean, ttest_ind,
};
export { normal_score_transform };
export { gaussian_kde };
export { cdist, pdist, squareform, KDTree };
export { least_squares, curve_fit };
export { setBackend, clearBackend, getNatra, GEMM_NM_THRESHOLD };
export { erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta };
export { mulberry32, makeRng, makeNormalSampler };
