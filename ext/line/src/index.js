// @gcu/line — Linear algebra for JS (TypedArray ndarray + BLAS-1/2 + small dense linalg).
// Public entry: re-exports the entire line namespace.

export { NdArray, shapeProduct, computeStrides } from './ndarray.js';
export {
  zeros, ones, full, range, linspace, eye, from,
} from './creation.js';
export {
  add, sub, mul, div, pow,
  neg, abs, sqrt, log, exp, sin, cos, tan,
  asin, acos, atan,
  floor, ceil, round, sign,
  isnan, isfinite,
  atan2, hypot, maximum, minimum,
  eq, ne, lt, le, gt, ge,
} from './ops.js';
export {
  reshape, flatten, copy, slice, concat, stack,
  broadcastShapes, broadcastStrides, broadcastBinary, shapesEqual,
} from './shape.js';
export { where, clip } from './selection.js';
export {
  sum, mean, max, min, std, variance, var_, norm, dot,
  prod, cumsum, cumprod, argmin, argmax, trace,
} from './reduce.js';
export {
  matmul, transpose,
  det2, det3, det4,
  inv2, inv3, inv4,
  diag, outer, tril, triu,
} from './linalg-mul.js';
export {
  solve, det, inv, cholesky, solveCholesky,
} from './linalg-solve.js';
export { lstsq } from './linalg-lstsq.js';
export { eigSym3, eigSym } from './linalg-eigen.js';
