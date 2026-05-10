// Creation helpers — every function returns a freshly-allocated NdArray.

import { NdArray, shapeProduct, validateShape } from './ndarray.js';

function _normalizeShape(shape) {
  if (typeof shape === 'number') return [shape];
  if (Array.isArray(shape)) return shape;
  throw new TypeError(`shape must be a number or array, got ${typeof shape}`);
}

export function zeros(shape) {
  const sh = _normalizeShape(shape);
  validateShape(sh);
  return new NdArray(new Float64Array(shapeProduct(sh)), sh);
}

export function ones(shape) {
  const sh = _normalizeShape(shape);
  validateShape(sh);
  const data = new Float64Array(shapeProduct(sh));
  data.fill(1);
  return new NdArray(data, sh);
}

export function full(shape, value) {
  const sh = _normalizeShape(shape);
  validateShape(sh);
  const data = new Float64Array(shapeProduct(sh));
  data.fill(value);
  return new NdArray(data, sh);
}

export function range(start, end, step) {
  if (end === undefined) {
    end = start;
    start = 0;
  }
  if (step === undefined) step = 1;
  if (step === 0) throw new RangeError('range step must be non-zero');
  const n = Math.max(0, Math.ceil((end - start) / step));
  const data = new Float64Array(n);
  for (let i = 0; i < n; i++) data[i] = start + i * step;
  return new NdArray(data, [n]);
}

export function linspace(a, b, n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`linspace count must be a non-negative integer, got ${n}`);
  }
  const data = new Float64Array(n);
  if (n === 1) {
    data[0] = a;
  } else if (n > 1) {
    const step = (b - a) / (n - 1);
    for (let i = 0; i < n; i++) data[i] = a + i * step;
  }
  return new NdArray(data, [n]);
}

export function eye(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`eye size must be a non-negative integer, got ${n}`);
  }
  const data = new Float64Array(n * n);
  for (let i = 0; i < n; i++) data[i * n + i] = 1;
  return new NdArray(data, [n, n]);
}

export function from(source, shape) {
  // Two modes:
  //   from(nestedArray)         -> auto-detect shape
  //   from(flatIterable, shape) -> reshape flat
  if (source instanceof NdArray) {
    const data = new Float64Array(source.data);
    return new NdArray(data, source.shape);
  }
  if (shape === undefined) {
    if (!Array.isArray(source)) {
      throw new TypeError('from() with no shape requires an array');
    }
    const detected = _detectShape(source);
    const data = new Float64Array(shapeProduct(detected));
    _flattenInto(source, data, 0, detected, 0);
    return new NdArray(data, detected);
  }
  const sh = _normalizeShape(shape);
  validateShape(sh);
  const size = shapeProduct(sh);
  const data = new Float64Array(size);
  let i = 0;
  for (const v of source) {
    if (i >= size) throw new RangeError(`source has more than ${size} elements`);
    data[i++] = v;
  }
  if (i !== size) {
    throw new RangeError(`source has ${i} elements, expected ${size} for shape [${sh.join(',')}]`);
  }
  return new NdArray(data, sh);
}

function _detectShape(arr) {
  const shape = [];
  let cur = arr;
  while (Array.isArray(cur)) {
    shape.push(cur.length);
    cur = cur.length > 0 ? cur[0] : null;
  }
  return shape;
}

function _flattenInto(arr, out, axis, shape, offset) {
  const dim = shape[axis];
  if (Array.isArray(arr) && arr.length !== dim) {
    throw new RangeError(`ragged array: axis ${axis} expected size ${dim}, got ${arr.length}`);
  }
  if (axis === shape.length - 1) {
    for (let i = 0; i < dim; i++) {
      const v = arr[i];
      if (typeof v !== 'number') {
        throw new TypeError(`expected number at deepest level, got ${typeof v}`);
      }
      out[offset + i] = v;
    }
    return;
  }
  let stride = 1;
  for (let k = axis + 1; k < shape.length; k++) stride *= shape[k];
  for (let i = 0; i < dim; i++) {
    if (!Array.isArray(arr[i])) {
      throw new TypeError(`expected array at axis ${axis + 1}, got ${typeof arr[i]}`);
    }
    _flattenInto(arr[i], out, axis + 1, shape, offset + i * stride);
  }
}
