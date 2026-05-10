// Shape ops + broadcast helpers.

import { NdArray, shapeProduct, computeStrides, validateShape } from './ndarray.js';

export function reshape(a, newShape) {
  validateShape(newShape);
  const target = shapeProduct(newShape);
  if (target !== a.size) {
    throw new RangeError(
      `cannot reshape array of size ${a.size} into shape [${newShape.join(',')}] (size ${target})`
    );
  }
  return new NdArray(new Float64Array(a.data), newShape);
}

export function flatten(a) {
  return new NdArray(new Float64Array(a.data), [a.size]);
}

export function copy(a) {
  return new NdArray(new Float64Array(a.data), a.shape);
}

// slice(a, ranges) — ranges is an array of per-axis specs.
//   null / undefined / missing → full axis
//   { start?, end?, step? }    → standard slice (defaults: 0, axis size, 1)
export function slice(a, ranges) {
  if (!Array.isArray(ranges)) {
    throw new TypeError('slice ranges must be an array');
  }
  if (ranges.length > a.ndim) {
    throw new RangeError(`too many slice ranges: got ${ranges.length}, array has ${a.ndim} axes`);
  }
  const starts = new Array(a.ndim);
  const steps = new Array(a.ndim);
  const newShape = new Array(a.ndim);
  for (let axis = 0; axis < a.ndim; axis++) {
    const r = ranges[axis];
    const dim = a.shape[axis];
    if (r === null || r === undefined) {
      starts[axis] = 0;
      steps[axis] = 1;
      newShape[axis] = dim;
      continue;
    }
    let start = r.start === undefined ? 0 : r.start;
    let end = r.end === undefined ? dim : r.end;
    let step = r.step === undefined ? 1 : r.step;
    if (step === 0) throw new RangeError(`slice step on axis ${axis} cannot be zero`);
    if (start < 0) start = Math.max(0, dim + start);
    if (end < 0) end = Math.max(0, dim + end);
    if (start > dim) start = dim;
    if (end > dim) end = dim;
    let len;
    if (step > 0) {
      len = end > start ? Math.ceil((end - start) / step) : 0;
    } else {
      len = end < start ? Math.ceil((start - end) / -step) : 0;
    }
    starts[axis] = start;
    steps[axis] = step;
    newShape[axis] = len;
  }
  const outSize = shapeProduct(newShape);
  const out = new Float64Array(outSize);
  if (outSize === 0) return new NdArray(out, newShape);

  const idx = new Array(a.ndim).fill(0);
  for (let i = 0; i < outSize; i++) {
    let off = 0;
    for (let axis = 0; axis < a.ndim; axis++) {
      off += (starts[axis] + idx[axis] * steps[axis]) * a.strides[axis];
    }
    out[i] = a.data[off];
    for (let axis = a.ndim - 1; axis >= 0; axis--) {
      idx[axis]++;
      if (idx[axis] < newShape[axis]) break;
      idx[axis] = 0;
    }
  }
  return new NdArray(out, newShape);
}

// Broadcast helpers ---------------------------------------------------------

// Compute broadcast shape from two input shapes. Right-aligned; each axis must
// match exactly or one side must be 1. Throws on mismatch.
export function broadcastShapes(shapeA, shapeB) {
  const nd = Math.max(shapeA.length, shapeB.length);
  const out = new Array(nd);
  for (let i = 0; i < nd; i++) {
    const a = i < nd - shapeA.length ? 1 : shapeA[i - (nd - shapeA.length)];
    const b = i < nd - shapeB.length ? 1 : shapeB[i - (nd - shapeB.length)];
    if (a === b) out[i] = a;
    else if (a === 1) out[i] = b;
    else if (b === 1) out[i] = a;
    else {
      throw new RangeError(
        `cannot broadcast shapes [${shapeA.join(',')}] and [${shapeB.join(',')}]`
      );
    }
  }
  return out;
}

// Compute the strides used to *read* an operand at the broadcast shape.
// Axes where the source has size 1 but the target has size >1 use stride 0
// (re-read the same element). Leading missing axes are also stride 0.
export function broadcastStrides(srcShape, srcStrides, targetShape) {
  const nd = targetShape.length;
  const lead = nd - srcShape.length;
  const out = new Array(nd);
  for (let i = 0; i < nd; i++) {
    if (i < lead) {
      out[i] = 0;
      continue;
    }
    const srcDim = srcShape[i - lead];
    const tgtDim = targetShape[i];
    if (srcDim === tgtDim) out[i] = srcStrides[i - lead];
    else if (srcDim === 1) out[i] = 0;
    else {
      throw new RangeError(
        `incompatible broadcast: source axis ${i - lead} (size ${srcDim}) -> target axis ${i} (size ${tgtDim})`
      );
    }
  }
  return out;
}

// Apply a binary scalar op across two arrays via broadcast-strided iteration.
// Used by ops.js as the slow-path. fn(aVal, bVal) -> resultVal.
export function broadcastBinary(a, b, fn) {
  const targetShape = broadcastShapes(a.shape, b.shape);
  const aStr = broadcastStrides(a.shape, a.strides, targetShape);
  const bStr = broadcastStrides(b.shape, b.strides, targetShape);
  const size = shapeProduct(targetShape);
  const out = new Float64Array(size);
  if (size === 0) return new NdArray(out, targetShape);

  const nd = targetShape.length;
  const idx = new Array(nd).fill(0);
  for (let i = 0; i < size; i++) {
    let aOff = 0, bOff = 0;
    for (let axis = 0; axis < nd; axis++) {
      aOff += idx[axis] * aStr[axis];
      bOff += idx[axis] * bStr[axis];
    }
    out[i] = fn(a.data[aOff], b.data[bOff]);
    for (let axis = nd - 1; axis >= 0; axis--) {
      idx[axis]++;
      if (idx[axis] < targetShape[axis]) break;
      idx[axis] = 0;
    }
  }
  return new NdArray(out, targetShape);
}

// Shape equality check (cheap).
export function shapesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// concat(arrays, axis = 0) — joins arrays along an existing axis. Shapes must
// match exactly except along `axis`.

export function concat(arrays, axis = 0) {
  if (!Array.isArray(arrays) || arrays.length === 0) {
    throw new TypeError('concat requires a non-empty array of NdArrays');
  }
  const ndim = arrays[0].ndim;
  if (axis < 0) axis = ndim + axis;
  if (axis < 0 || axis >= ndim) {
    throw new RangeError(`axis ${axis} out of bounds for ndim ${ndim}`);
  }
  const baseShape = arrays[0].shape;
  let totalAxis = 0;
  for (const arr of arrays) {
    if (arr.ndim !== ndim) {
      throw new RangeError(`concat: ndim mismatch (${arr.ndim} vs ${ndim})`);
    }
    for (let i = 0; i < ndim; i++) {
      if (i === axis) continue;
      if (arr.shape[i] !== baseShape[i]) {
        throw new RangeError(
          `concat: shape mismatch on axis ${i} (${arr.shape[i]} vs ${baseShape[i]})`
        );
      }
    }
    totalAxis += arr.shape[axis];
  }
  const outShape = baseShape.slice();
  outShape[axis] = totalAxis;
  const outSize = shapeProduct(outShape);
  const out = new Float64Array(outSize);

  let outerSize = 1;
  for (let i = 0; i < axis; i++) outerSize *= outShape[i];
  let innerSize = 1;
  for (let i = axis + 1; i < ndim; i++) innerSize *= outShape[i];

  for (let outer = 0; outer < outerSize; outer++) {
    let outAxisOff = 0;
    for (const arr of arrays) {
      const arrAxis = arr.shape[axis];
      const arrOff = outer * arrAxis * innerSize;
      const outOff = outer * totalAxis * innerSize + outAxisOff * innerSize;
      const span = arrAxis * innerSize;
      for (let i = 0; i < span; i++) out[outOff + i] = arr.data[arrOff + i];
      outAxisOff += arrAxis;
    }
  }
  return new NdArray(out, outShape);
}

// stack(arrays, axis = 0) — joins arrays along a NEW axis. All input shapes
// must match exactly. Result has ndim+1 dimensions.

export function stack(arrays, axis = 0) {
  if (!Array.isArray(arrays) || arrays.length === 0) {
    throw new TypeError('stack requires a non-empty array of NdArrays');
  }
  const ndim = arrays[0].ndim;
  for (const arr of arrays) {
    if (!shapesEqual(arr.shape, arrays[0].shape)) {
      throw new RangeError(`stack: all arrays must have the same shape`);
    }
  }
  const targetNdim = ndim + 1;
  if (axis < 0) axis = targetNdim + axis;
  if (axis < 0 || axis > ndim) {
    throw new RangeError(`stack axis ${axis} out of bounds for ndim+1=${targetNdim}`);
  }
  const newShape = arrays[0].shape.slice();
  newShape.splice(axis, 0, arrays.length);
  const out = new Float64Array(shapeProduct(newShape));

  let outerSize = 1;
  for (let i = 0; i < axis; i++) outerSize *= newShape[i];
  let innerSize = 1;
  for (let i = axis + 1; i < newShape.length; i++) innerSize *= newShape[i];
  const k = arrays.length;

  for (let outer = 0; outer < outerSize; outer++) {
    for (let kk = 0; kk < k; kk++) {
      const srcOff = outer * innerSize;
      const dstOff = outer * k * innerSize + kk * innerSize;
      for (let i = 0; i < innerSize; i++) out[dstOff + i] = arrays[kk].data[srcOff + i];
    }
  }
  return new NdArray(out, newShape);
}
