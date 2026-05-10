// @gcu/scitra — top-level barrel.
// Re-exports the API surface organized by scipy-shaped namespace.

import { norm, lognorm } from './stats/distributions.js';
import { erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta } from './util/special.js';
import { mulberry32, makeRng, makeNormalSampler } from './util/random.js';

export const stats = {
  // distributions
  norm,
  lognorm,
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
export { norm, lognorm };
export { erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta };
export { mulberry32, makeRng, makeNormalSampler };
