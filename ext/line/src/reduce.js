// Reductions — sum/mean/max/min/std/var with optional axis,
// dot (overloaded by ndim), norm.
//
// Without axis: returns a scalar number.
// With { axis: i }: returns an NdArray with that axis removed.

import { NdArray } from './ndarray.js';
import { matmul } from './linalg-mul.js';

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
//
// Hot path: 4 parallel accumulators so V8 can use independent
// arithmetic units and auto-vectorize to AVX f64x4. ~3.5× speedup
// vs single accumulator on n ≥ 512. Sub-arrays smaller than 4 fall
// through the tail loop. See test/vec-v8-winking-bench.mjs.

export function sum(a, opts) {
  if (opts && opts.axis !== undefined) {
    return _reduceAxis(a, opts.axis, 0, (x, y) => x + y, (x) => x);
  }
  const d = a.data;
  const n = a.size;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += d[i  ];
    s1 += d[i+1];
    s2 += d[i+2];
    s3 += d[i+3];
  }
  let acc = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) acc += d[i];
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
  const m = mean(a);  // mean() inherits sum's unrolled-4 form
  const d = a.data;
  // Unrolled-4 sum-of-squared-deviations
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    const x0 = d[i  ] - m;
    const x1 = d[i+1] - m;
    const x2 = d[i+2] - m;
    const x3 = d[i+3] - m;
    s0 += x0 * x0;
    s1 += x1 * x1;
    s2 += x2 * x2;
    s3 += x3 * x3;
  }
  let s = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) {
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
//
// Same V8-winking pattern as sum — 4 parallel accumulators.
// Beats alpack-f64 dnrm2 by ~1.4× at n=32k and ~2.1× at n=262k
// (V8 auto-vectorizes to AVX f64x4 vs Wasm SIMD's f64x2).

export function norm(a) {
  const d = a.data;
  const n = a.size;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += d[i  ] * d[i  ];
    s1 += d[i+1] * d[i+1];
    s2 += d[i+2] * d[i+2];
    s3 += d[i+3] * d[i+3];
  }
  let s = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) s += d[i] * d[i];
  return Math.sqrt(s);
}

// ---------- dot ----------
// 1D · 1D → scalar
// 2D · 1D → 1D NdArray (matrix-vector)
// 1D · 2D → 1D NdArray (vector-matrix)
// 2D · 2D → delegates to matmul (imported lazily to avoid module init order)

export function dot(a, b) {
  // 1D · 1D — V8-winked unrolled-4. At n=32k, beats vec's previous
  // single-accumulator form by ~3× and matches alpack's wasm SIMD.
  if (a.ndim === 1 && b.ndim === 1) {
    if (a.size !== b.size) {
      throw new RangeError(`dot: 1D length mismatch ${a.size} vs ${b.size}`);
    }
    const ad = a.data, bd = b.data;
    const n = a.size;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    const n4 = n - (n & 3);
    let i = 0;
    for (; i < n4; i += 4) {
      s0 += ad[i  ] * bd[i  ];
      s1 += ad[i+1] * bd[i+1];
      s2 += ad[i+2] * bd[i+2];
      s3 += ad[i+3] * bd[i+3];
    }
    let s = (s0 + s1) + (s2 + s3);
    for (; i < n; i++) s += ad[i] * bd[i];
    return s;
  }
  // 2D · 1D — matrix-vector. Inner loop unrolled-4 over the column axis.
  // ~1.5-2× over the previous naive form across n=64..4096.
  if (a.ndim === 2 && b.ndim === 1) {
    const m = a.shape[0], n = a.shape[1];
    if (n !== b.size) {
      throw new RangeError(`dot: shape [${m},${n}] cannot multiply vector of length ${b.size}`);
    }
    const out = new Float64Array(m);
    const ad = a.data, bd = b.data;
    const n4 = n - (n & 3);
    for (let i = 0; i < m; i++) {
      const aRow = i * n;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      let j = 0;
      for (; j < n4; j += 4) {
        s0 += ad[aRow + j  ] * bd[j  ];
        s1 += ad[aRow + j+1] * bd[j+1];
        s2 += ad[aRow + j+2] * bd[j+2];
        s3 += ad[aRow + j+3] * bd[j+3];
      }
      let s = (s0 + s1) + (s2 + s3);
      for (; j < n; j++) s += ad[aRow + j] * bd[j];
      out[i] = s;
    }
    return new NdArray(out, [m]);
  }
  // 1D · 2D — vector-matrix. Column-major reduction; the inner loop
  // strides through B by N which is harder for V8 to auto-vectorize,
  // but the unrolled-4 form still helps via parallel accumulators.
  if (a.ndim === 1 && b.ndim === 2) {
    const m = b.shape[0], n = b.shape[1];
    if (a.size !== m) {
      throw new RangeError(`dot: vector length ${a.size} cannot multiply [${m},${n}]`);
    }
    const out = new Float64Array(n);
    const ad = a.data, bd = b.data;
    const m4 = m - (m & 3);
    for (let j = 0; j < n; j++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      let k = 0;
      for (; k < m4; k += 4) {
        s0 += ad[k  ] * bd[ k    * n + j];
        s1 += ad[k+1] * bd[(k+1) * n + j];
        s2 += ad[k+2] * bd[(k+2) * n + j];
        s3 += ad[k+3] * bd[(k+3) * n + j];
      }
      let s = (s0 + s1) + (s2 + s3);
      for (; k < m; k++) s += ad[k] * bd[k * n + j];
      out[j] = s;
    }
    return new NdArray(out, [n]);
  }
  if (a.ndim === 2 && b.ndim === 2) {
    // 2D · 2D dot is matmul — delegate to the register-tiled kernel.
    return matmul(a, b);
  }
  throw new RangeError(`dot: unsupported ndim combination (${a.ndim}, ${b.ndim})`);
}

// ---------- prod ----------

export function prod(a, opts) {
  if (opts && opts.axis !== undefined) {
    return _reduceAxis(a, opts.axis, 1, (x, y) => x * y, (x) => x);
  }
  let acc = 1;
  const d = a.data;
  for (let i = 0; i < a.size; i++) acc *= d[i];
  return acc;
}

// ---------- cumsum / cumprod ----------
// With axis: returns array of same shape with running sum/product along that axis.
// Without axis: numpy convention — flatten, return 1D running result.

function _cumAxis(arr, axis, init, combine) {
  axis = _normalizeAxis(axis, arr.ndim);
  const reduceSize = arr.shape[axis];
  let outerSize = 1;
  for (let i = 0; i < axis; i++) outerSize *= arr.shape[i];
  let innerSize = 1;
  for (let i = axis + 1; i < arr.ndim; i++) innerSize *= arr.shape[i];
  const out = new Float64Array(arr.size);
  const d = arr.data;
  for (let outer = 0; outer < outerSize; outer++) {
    const outerOff = outer * reduceSize * innerSize;
    for (let inner = 0; inner < innerSize; inner++) {
      let acc = init;
      for (let r = 0; r < reduceSize; r++) {
        const idx = outerOff + r * innerSize + inner;
        acc = combine(acc, d[idx]);
        out[idx] = acc;
      }
    }
  }
  return new NdArray(out, arr.shape);
}

export function cumsum(a, opts) {
  if (opts && opts.axis !== undefined) return _cumAxis(a, opts.axis, 0, (x, y) => x + y);
  const out = new Float64Array(a.size);
  const d = a.data;
  let acc = 0;
  for (let i = 0; i < a.size; i++) { acc += d[i]; out[i] = acc; }
  return new NdArray(out, [a.size]);
}

export function cumprod(a, opts) {
  if (opts && opts.axis !== undefined) return _cumAxis(a, opts.axis, 1, (x, y) => x * y);
  const out = new Float64Array(a.size);
  const d = a.data;
  let acc = 1;
  for (let i = 0; i < a.size; i++) { acc *= d[i]; out[i] = acc; }
  return new NdArray(out, [a.size]);
}

// ---------- argmin / argmax ----------
// Without axis: scalar (flat index).
// With axis: NdArray of indices with that axis removed.

function _argAxis(arr, axis, mode) {
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
      const baseOff = outerOff + inner;
      let bestIdx = 0;
      let bestVal = d[baseOff];
      if (mode === 'min') {
        for (let r = 1; r < reduceSize; r++) {
          const v = d[baseOff + r * innerSize];
          if (v < bestVal) { bestVal = v; bestIdx = r; }
        }
      } else {
        for (let r = 1; r < reduceSize; r++) {
          const v = d[baseOff + r * innerSize];
          if (v > bestVal) { bestVal = v; bestIdx = r; }
        }
      }
      out[outer * innerSize + inner] = bestIdx;
    }
  }
  return new NdArray(out, outShape);
}

export function argmin(a, opts) {
  if (opts && opts.axis !== undefined) return _argAxis(a, opts.axis, 'min');
  if (a.size === 0) throw new RangeError('argmin of empty array');
  let mi = 0;
  const d = a.data;
  for (let i = 1; i < a.size; i++) if (d[i] < d[mi]) mi = i;
  return mi;
}

export function argmax(a, opts) {
  if (opts && opts.axis !== undefined) return _argAxis(a, opts.axis, 'max');
  if (a.size === 0) throw new RangeError('argmax of empty array');
  let mi = 0;
  const d = a.data;
  for (let i = 1; i < a.size; i++) if (d[i] > d[mi]) mi = i;
  return mi;
}

// ---------- trace ----------
// Sum of the diagonal of a 2D matrix (square or rectangular).

export function trace(A) {
  if (A.ndim !== 2) {
    throw new RangeError(`trace requires 2D array, got ${A.ndim}D`);
  }
  const m = A.shape[0], n = A.shape[1];
  const k = Math.min(m, n);
  let s = 0;
  const d = A.data;
  for (let i = 0; i < k; i++) s += d[i * n + i];
  return s;
}
