// Reductions — sum/mean/max/min/std/var with optional axis,
// dot (overloaded by ndim), norm.
//
// Without axis: returns a scalar number.
// With { axis: i }: returns an NdArray with that axis removed.

import { NdArray } from './ndarray.js';

function _normalizeAxis(axis, ndim) {
  if (axis < 0) axis = ndim + axis;
  if (axis < 0 || axis >= ndim) {
    throw new RangeError(`axis ${axis} out of bounds for ndim ${ndim}`);
  }
  return axis;
}

// Generic per-axis reducer. init/combine/finalize define the operation.
//   init: starting accumulator value.
//   combine(acc, value): fold step.
//   finalize(acc, count): final transform per output cell.
function _reduceAxis(arr, axis, init, combine, finalize) {
  axis = _normalizeAxis(axis, arr.ndim);
  const reduceSize = arr.shape[axis];

  let outerSize = 1;
  for (let i = 0; i < axis; i++) outerSize *= arr.shape[i];
  let innerSize = 1;
  for (let i = axis + 1; i < arr.ndim; i++) innerSize *= arr.shape[i];

  const outShape = arr.shape.slice(0, axis).concat(arr.shape.slice(axis + 1));
  const out = new Float64Array(outerSize * innerSize);
  const d = arr.data;

  for (let outer = 0; outer < outerSize; outer++) {
    const outerOff = outer * reduceSize * innerSize;
    for (let inner = 0; inner < innerSize; inner++) {
      let acc = init;
      const baseOff = outerOff + inner;
      for (let r = 0; r < reduceSize; r++) {
        acc = combine(acc, d[baseOff + r * innerSize]);
      }
      out[outer * innerSize + inner] = finalize(acc, reduceSize);
    }
  }
  return new NdArray(out, outShape);
}

// ---------- sum ----------

export function sum(a, opts) {
  if (opts && opts.axis !== undefined) {
    return _reduceAxis(a, opts.axis, 0, (x, y) => x + y, (x) => x);
  }
  let acc = 0;
  const d = a.data;
  for (let i = 0; i < a.size; i++) acc += d[i];
  return acc;
}

// ---------- mean ----------

export function mean(a, opts) {
  if (opts && opts.axis !== undefined) {
    return _reduceAxis(a, opts.axis, 0, (x, y) => x + y, (x, n) => x / n);
  }
  if (a.size === 0) return NaN;
  return sum(a) / a.size;
}

// ---------- max / min ----------

export function max(a, opts) {
  if (opts && opts.axis !== undefined) {
    return _reduceAxis(a, opts.axis, -Infinity, (x, y) => (y > x ? y : x), (x) => x);
  }
  if (a.size === 0) return -Infinity;
  let m = a.data[0];
  const d = a.data;
  for (let i = 1; i < a.size; i++) if (d[i] > m) m = d[i];
  return m;
}

export function min(a, opts) {
  if (opts && opts.axis !== undefined) {
    return _reduceAxis(a, opts.axis, Infinity, (x, y) => (y < x ? y : x), (x) => x);
  }
  if (a.size === 0) return Infinity;
  let m = a.data[0];
  const d = a.data;
  for (let i = 1; i < a.size; i++) if (d[i] < m) m = d[i];
  return m;
}

// ---------- variance / standard deviation ----------
// Two-pass: numerically stable, easy to reason about. ddof default 0 (population).
// opts: { axis?, ddof? }

function _varAllAxes(a, ddof) {
  const n = a.size;
  const denom = n - ddof;
  if (denom <= 0) return NaN;
  const m = mean(a);
  let s = 0;
  const d = a.data;
  for (let i = 0; i < n; i++) {
    const x = d[i] - m;
    s += x * x;
  }
  return s / denom;
}

function _varAxis(arr, axis, ddof) {
  axis = _normalizeAxis(axis, arr.ndim);
  const reduceSize = arr.shape[axis];
  const denom = reduceSize - ddof;
  let outerSize = 1;
  for (let i = 0; i < axis; i++) outerSize *= arr.shape[i];
  let innerSize = 1;
  for (let i = axis + 1; i < arr.ndim; i++) innerSize *= arr.shape[i];
  const outShape = arr.shape.slice(0, axis).concat(arr.shape.slice(axis + 1));
  const out = new Float64Array(outerSize * innerSize);
  const d = arr.data;

  for (let outer = 0; outer < outerSize; outer++) {
    const outerOff = outer * reduceSize * innerSize;
    for (let inner = 0; inner < innerSize; inner++) {
      const baseOff = outerOff + inner;
      let s = 0;
      for (let r = 0; r < reduceSize; r++) s += d[baseOff + r * innerSize];
      const m = s / reduceSize;
      let ss = 0;
      for (let r = 0; r < reduceSize; r++) {
        const x = d[baseOff + r * innerSize] - m;
        ss += x * x;
      }
      out[outer * innerSize + inner] = denom > 0 ? ss / denom : NaN;
    }
  }
  return new NdArray(out, outShape);
}

export function variance(a, opts) {
  const ddof = (opts && opts.ddof !== undefined) ? opts.ddof : 0;
  if (opts && opts.axis !== undefined) return _varAxis(a, opts.axis, ddof);
  return _varAllAxes(a, ddof);
}

// Alias for the more numpy-ish name.
export { variance as var_ };

export function std(a, opts) {
  const v = variance(a, opts);
  if (typeof v === 'number') return Math.sqrt(v);
  const out = new Float64Array(v.size);
  for (let i = 0; i < v.size; i++) out[i] = Math.sqrt(v.data[i]);
  return new NdArray(out, v.shape);
}

// ---------- norm ----------
// L2 norm of the flattened array. Returns scalar.

export function norm(a) {
  let s = 0;
  const d = a.data;
  for (let i = 0; i < a.size; i++) s += d[i] * d[i];
  return Math.sqrt(s);
}

// ---------- dot ----------
// 1D · 1D → scalar
// 2D · 1D → 1D NdArray (matrix-vector)
// 1D · 2D → 1D NdArray (vector-matrix)
// 2D · 2D → delegates to matmul (imported lazily to avoid module init order)

export function dot(a, b) {
  if (a.ndim === 1 && b.ndim === 1) {
    if (a.size !== b.size) {
      throw new RangeError(`dot: 1D length mismatch ${a.size} vs ${b.size}`);
    }
    let s = 0;
    const ad = a.data, bd = b.data;
    for (let i = 0; i < a.size; i++) s += ad[i] * bd[i];
    return s;
  }
  if (a.ndim === 2 && b.ndim === 1) {
    const m = a.shape[0], n = a.shape[1];
    if (n !== b.size) {
      throw new RangeError(`dot: shape [${m},${n}] cannot multiply vector of length ${b.size}`);
    }
    const out = new Float64Array(m);
    const ad = a.data, bd = b.data;
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += ad[i * n + j] * bd[j];
      out[i] = s;
    }
    return new NdArray(out, [m]);
  }
  if (a.ndim === 1 && b.ndim === 2) {
    const m = b.shape[0], n = b.shape[1];
    if (a.size !== m) {
      throw new RangeError(`dot: vector length ${a.size} cannot multiply [${m},${n}]`);
    }
    const out = new Float64Array(n);
    const ad = a.data, bd = b.data;
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < m; k++) s += ad[k] * bd[k * n + j];
      out[j] = s;
    }
    return new NdArray(out, [n]);
  }
  if (a.ndim === 2 && b.ndim === 2) {
    // Avoid circular import — inline a small matmul here. Same loop-reorder
    // as linalg-mul.js. 2D × 2D dot is exactly matmul.
    const M = a.shape[0], K = a.shape[1];
    const Kb = b.shape[0], N = b.shape[1];
    if (K !== Kb) {
      throw new RangeError(`dot: 2D inner dim mismatch ${K} vs ${Kb}`);
    }
    const out = new Float64Array(M * N);
    const ad = a.data, bd = b.data;
    for (let i = 0; i < M; i++) {
      const aRow = i * K;
      const oRow = i * N;
      for (let k = 0; k < K; k++) {
        const aik = ad[aRow + k];
        const bRow = k * N;
        for (let j = 0; j < N; j++) {
          out[oRow + j] += aik * bd[bRow + j];
        }
      }
    }
    return new NdArray(out, [M, N]);
  }
  throw new RangeError(`dot: unsupported ndim combination (${a.ndim}, ${b.ndim})`);
}
