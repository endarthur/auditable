// @gcu/vec — TypedArray-based numerical library.
// Public entry: re-exports the entire vec namespace.

export { NdArray, shapeProduct, computeStrides } from './ndarray.js';
export {
  zeros, ones, full, range, linspace, eye, from,
} from './creation.js';
export {
  add, sub, mul, div, pow,
  neg, abs, sqrt, log, exp, sin, cos, tan,
} from './ops.js';
export {
  reshape, flatten, copy, slice,
  broadcastShapes, broadcastStrides, broadcastBinary, shapesEqual,
} from './shape.js';
export {
  sum, mean, max, min, std, variance, var_, norm, dot,
} from './reduce.js';
export {
  matmul, transpose,
  det2, det3, det4,
  inv2, inv3, inv4,
} from './linalg-mul.js';
