// Selection helpers — where (element-wise ternary), clip (clamp to range).

import { NdArray } from './ndarray.js';
import { shapesEqual } from './shape.js';

// where(cond, a, b) — out[i] = cond[i] ? a[i] : b[i].
//
// `cond` must be an NdArray; truthiness is the standard JS rule (non-zero,
// non-NaN). `a` and `b` may be either NdArrays with the same shape as cond,
// or scalars. Full broadcasting between cond/a/b is not supported in v1;
// shape-equal or scalar arguments only.

export function where(cond, a, b) {
  if (!(cond instanceof NdArray)) {
    throw new TypeError('where: cond must be an NdArray');
  }
  const aIsScalar = typeof a === 'number';
  const bIsScalar = typeof b === 'number';
  if (!aIsScalar && !(a instanceof NdArray)) {
    throw new TypeError('where: a must be NdArray or number');
  }
  if (!bIsScalar && !(b instanceof NdArray)) {
    throw new TypeError('where: b must be NdArray or number');
  }
  if (!aIsScalar && !shapesEqual(cond.shape, a.shape)) {
    throw new RangeError(
      `where: a shape [${a.shape.join(',')}] must match cond shape [${cond.shape.join(',')}]`
    );
  }
  if (!bIsScalar && !shapesEqual(cond.shape, b.shape)) {
    throw new RangeError(
      `where: b shape [${b.shape.join(',')}] must match cond shape [${cond.shape.join(',')}]`
    );
  }
  const out = new Float64Array(cond.size);
  const cd = cond.data;
  const ad = aIsScalar ? null : a.data;
  const bd = bIsScalar ? null : b.data;
  for (let i = 0; i < cond.size; i++) {
    out[i] = cd[i] ? (aIsScalar ? a : ad[i]) : (bIsScalar ? b : bd[i]);
  }
  return new NdArray(out, cond.shape);
}

// clip(a, lo, hi) — clamp each element to the range [lo, hi].
// lo and hi are scalars in v1.

export function clip(a, lo, hi) {
  if (!(a instanceof NdArray)) {
    throw new TypeError('clip: a must be an NdArray');
  }
  if (typeof lo !== 'number' || typeof hi !== 'number') {
    throw new TypeError('clip: lo and hi must be numbers');
  }
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) {
    const v = d[i];
    out[i] = v < lo ? lo : v > hi ? hi : v;
  }
  return new NdArray(out, a.shape);
}
