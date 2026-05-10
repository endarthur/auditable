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
