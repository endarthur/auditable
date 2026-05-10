// Element-wise binary and unary operations.
//
// Binary ops use three-arm dispatch:
//   1. Scalar  (one operand is number)        → tight flat loop
//   2. Shape-equal (both NdArray, same shape) → tight flat loop, V8 vectorizes
//   3. Broadcast (compatible different shapes)→ stride-iterated slow path
//
// Each op is written out explicitly (no shared callback indirection) so V8
// can inline the inner operation.

import { NdArray } from './ndarray.js';
import { broadcastBinary, shapesEqual } from './shape.js';

// ===== add =====

export function add(a, b) {
  if (typeof b === 'number') return _addScalar(a, b);
  if (typeof a === 'number') return _addScalar(b, a);
  if (shapesEqual(a.shape, b.shape)) {
    const out = new Float64Array(a.size);
    const ad = a.data, bd = b.data;
    for (let i = 0; i < a.size; i++) out[i] = ad[i] + bd[i];
    return new NdArray(out, a.shape);
  }
  return broadcastBinary(a, b, (x, y) => x + y);
}

function _addScalar(arr, s) {
  const out = new Float64Array(arr.size);
  const d = arr.data;
  for (let i = 0; i < arr.size; i++) out[i] = d[i] + s;
  return new NdArray(out, arr.shape);
}

// ===== sub =====

export function sub(a, b) {
  if (typeof b === 'number') {
    const out = new Float64Array(a.size);
    const d = a.data;
    for (let i = 0; i < a.size; i++) out[i] = d[i] - b;
    return new NdArray(out, a.shape);
  }
  if (typeof a === 'number') {
    const out = new Float64Array(b.size);
    const d = b.data;
    for (let i = 0; i < b.size; i++) out[i] = a - d[i];
    return new NdArray(out, b.shape);
  }
  if (shapesEqual(a.shape, b.shape)) {
    const out = new Float64Array(a.size);
    const ad = a.data, bd = b.data;
    for (let i = 0; i < a.size; i++) out[i] = ad[i] - bd[i];
    return new NdArray(out, a.shape);
  }
  return broadcastBinary(a, b, (x, y) => x - y);
}

// ===== mul =====

export function mul(a, b) {
  if (typeof b === 'number') return _mulScalar(a, b);
  if (typeof a === 'number') return _mulScalar(b, a);
  if (shapesEqual(a.shape, b.shape)) {
    const out = new Float64Array(a.size);
    const ad = a.data, bd = b.data;
    for (let i = 0; i < a.size; i++) out[i] = ad[i] * bd[i];
    return new NdArray(out, a.shape);
  }
  return broadcastBinary(a, b, (x, y) => x * y);
}

function _mulScalar(arr, s) {
  const out = new Float64Array(arr.size);
  const d = arr.data;
  for (let i = 0; i < arr.size; i++) out[i] = d[i] * s;
  return new NdArray(out, arr.shape);
}

// ===== div =====

export function div(a, b) {
  if (typeof b === 'number') {
    const out = new Float64Array(a.size);
    const d = a.data;
    for (let i = 0; i < a.size; i++) out[i] = d[i] / b;
    return new NdArray(out, a.shape);
  }
  if (typeof a === 'number') {
    const out = new Float64Array(b.size);
    const d = b.data;
    for (let i = 0; i < b.size; i++) out[i] = a / d[i];
    return new NdArray(out, b.shape);
  }
  if (shapesEqual(a.shape, b.shape)) {
    const out = new Float64Array(a.size);
    const ad = a.data, bd = b.data;
    for (let i = 0; i < a.size; i++) out[i] = ad[i] / bd[i];
    return new NdArray(out, a.shape);
  }
  return broadcastBinary(a, b, (x, y) => x / y);
}

// ===== pow =====

export function pow(a, b) {
  if (typeof b === 'number') {
    const out = new Float64Array(a.size);
    const d = a.data;
    for (let i = 0; i < a.size; i++) out[i] = Math.pow(d[i], b);
    return new NdArray(out, a.shape);
  }
  if (typeof a === 'number') {
    const out = new Float64Array(b.size);
    const d = b.data;
    for (let i = 0; i < b.size; i++) out[i] = Math.pow(a, d[i]);
    return new NdArray(out, b.shape);
  }
  if (shapesEqual(a.shape, b.shape)) {
    const out = new Float64Array(a.size);
    const ad = a.data, bd = b.data;
    for (let i = 0; i < a.size; i++) out[i] = Math.pow(ad[i], bd[i]);
    return new NdArray(out, a.shape);
  }
  return broadcastBinary(a, b, (x, y) => Math.pow(x, y));
}

// ===== unary =====

export function neg(a) {
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) out[i] = -d[i];
  return new NdArray(out, a.shape);
}

export function abs(a) {
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) out[i] = Math.abs(d[i]);
  return new NdArray(out, a.shape);
}

export function sqrt(a) {
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) out[i] = Math.sqrt(d[i]);
  return new NdArray(out, a.shape);
}

export function log(a) {
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) out[i] = Math.log(d[i]);
  return new NdArray(out, a.shape);
}

export function exp(a) {
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) out[i] = Math.exp(d[i]);
  return new NdArray(out, a.shape);
}

export function sin(a) {
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) out[i] = Math.sin(d[i]);
  return new NdArray(out, a.shape);
}

export function cos(a) {
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) out[i] = Math.cos(d[i]);
  return new NdArray(out, a.shape);
}

export function tan(a) {
  const out = new Float64Array(a.size);
  const d = a.data;
  for (let i = 0; i < a.size; i++) out[i] = Math.tan(d[i]);
  return new NdArray(out, a.shape);
}
