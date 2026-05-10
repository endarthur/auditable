// Core vec tests — ndarray + creation + ops + shape with hand-computed expected values.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NdArray,
  zeros, ones, full, range, linspace, eye, from,
  add, sub, mul, div, pow,
  neg, abs, sqrt, log, exp, sin, cos, tan,
  reshape, flatten, copy, slice,
  broadcastShapes, shapesEqual,
} from '../ext/line/src/index.js';

const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-12) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

// ---------- NdArray basics ----------

test('NdArray construction validates shape vs data length', () => {
  assert.throws(() => new NdArray(new Float64Array(5), [2, 3]), /does not match/);
  assert.throws(() => new NdArray([1, 2, 3], [3]), /Float64Array/);
  assert.throws(() => new NdArray(new Float64Array(2), [-1]), /non-negative/);
});

test('NdArray strides are row-major', () => {
  const a = new NdArray(new Float64Array(12), [2, 3, 2]);
  assert.deepEqual(a.strides, [6, 2, 1]);
  assert.equal(a.size, 12);
  assert.equal(a.ndim, 3);
});

test('NdArray.get / set with bounds checking', () => {
  const a = new NdArray(new Float64Array([1, 2, 3, 4, 5, 6]), [2, 3]);
  assert.equal(a.get(0, 0), 1);
  assert.equal(a.get(1, 2), 6);
  assert.equal(a.get(0, 2), 3);
  a.set(1, 1, 99);
  assert.equal(a.get(1, 1), 99);
  assert.throws(() => a.get(2, 0), /out of bounds/);
  assert.throws(() => a.get(0), /expected 2 indices/);
});

test('NdArray.row and col copy data', () => {
  const a = new NdArray(new Float64Array([1, 2, 3, 4, 5, 6]), [2, 3]);
  const r = a.row(1);
  assert.deepEqual(Array.from(r.data), [4, 5, 6]);
  assert.deepEqual(r.shape, [3]);
  // Mutating the row must not affect the original.
  r.set(0, 999);
  assert.equal(a.get(1, 0), 4);

  const c = a.col(2);
  assert.deepEqual(Array.from(c.data), [3, 6]);
  assert.deepEqual(c.shape, [2]);
});

test('NdArray.row/col reject non-2D arrays', () => {
  const v = new NdArray(new Float64Array([1, 2, 3]), [3]);
  assert.throws(() => v.row(0), /2D/);
  assert.throws(() => v.col(0), /2D/);
});

test('NdArray.toArray nests correctly', () => {
  const a = new NdArray(new Float64Array([1, 2, 3, 4, 5, 6]), [2, 3]);
  assert.deepEqual(a.toArray(), [[1, 2, 3], [4, 5, 6]]);

  const v = new NdArray(new Float64Array([1, 2, 3]), [3]);
  assert.deepEqual(v.toArray(), [1, 2, 3]);

  const cube = new NdArray(new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]), [2, 2, 2]);
  assert.deepEqual(cube.toArray(), [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]);
});

test('NdArray.toString includes shape', () => {
  const a = new NdArray(new Float64Array([1, 2, 3]), [3]);
  assert.match(a.toString(), /shape=\[3\]/);
});

// ---------- Creation ----------

test('zeros / ones / full', () => {
  const z = zeros([2, 3]);
  assert.deepEqual(Array.from(z.data), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(z.shape, [2, 3]);

  const o = ones(5);
  assert.deepEqual(Array.from(o.data), [1, 1, 1, 1, 1]);
  assert.deepEqual(o.shape, [5]);

  const f = full([3], 7.5);
  assert.deepEqual(Array.from(f.data), [7.5, 7.5, 7.5]);
});

test('range matches Python semantics', () => {
  assert.deepEqual(Array.from(range(5).data), [0, 1, 2, 3, 4]);
  assert.deepEqual(Array.from(range(2, 7).data), [2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(range(0, 10, 2).data), [0, 2, 4, 6, 8]);
  assert.deepEqual(Array.from(range(5, 0, -1).data), [5, 4, 3, 2, 1]);
  assert.deepEqual(Array.from(range(0).data), []);
  assert.throws(() => range(0, 5, 0), /non-zero/);
});

test('linspace', () => {
  assert.ok(arrClose(linspace(0, 1, 5).data, [0, 0.25, 0.5, 0.75, 1]));
  assert.deepEqual(Array.from(linspace(2, 4, 1).data), [2]);
  assert.deepEqual(Array.from(linspace(0, 1, 0).data), []);
  assert.ok(arrClose(linspace(0, Math.PI, 3).data, [0, Math.PI / 2, Math.PI]));
});

test('eye produces identity', () => {
  const id = eye(3);
  assert.deepEqual(Array.from(id.data), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(id.shape, [3, 3]);
  assert.deepEqual(eye(0).shape, [0, 0]);
});

test('from(nested) auto-shapes', () => {
  const a = from([[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(a.shape, [3, 2]);
  assert.deepEqual(Array.from(a.data), [1, 2, 3, 4, 5, 6]);
});

test('from(flat, shape) reshapes', () => {
  const a = from([1, 2, 3, 4, 5, 6], [2, 3]);
  assert.deepEqual(a.shape, [2, 3]);
  assert.deepEqual(Array.from(a.data), [1, 2, 3, 4, 5, 6]);
});

test('from rejects ragged arrays', () => {
  assert.throws(() => from([[1, 2], [3]]), /ragged/);
});

test('from copies an existing NdArray', () => {
  const a = ones([2, 2]);
  const b = from(a);
  b.set(0, 0, 99);
  assert.equal(a.get(0, 0), 1);
});

// ---------- Element-wise binary ----------

test('add: shape-equal flat path', () => {
  const a = from([[1, 2], [3, 4]]);
  const b = from([[10, 20], [30, 40]]);
  const c = add(a, b);
  assert.deepEqual(Array.from(c.data), [11, 22, 33, 44]);
  assert.deepEqual(c.shape, [2, 2]);
});

test('add: scalar broadcast', () => {
  const a = from([1, 2, 3]);
  assert.deepEqual(Array.from(add(a, 10).data), [11, 12, 13]);
  assert.deepEqual(Array.from(add(10, a).data), [11, 12, 13]);
});

test('add: broadcast row vector to matrix', () => {
  const m = from([[1, 2, 3], [4, 5, 6]]);   // [2,3]
  const v = from([10, 20, 30]);              // [3]
  const c = add(m, v);
  assert.deepEqual(c.shape, [2, 3]);
  assert.deepEqual(Array.from(c.data), [11, 22, 33, 14, 25, 36]);
});

test('add: broadcast column vector', () => {
  const m = from([[1, 2, 3], [4, 5, 6]]);   // [2,3]
  const col = from([10, 20], [2, 1]);        // [2,1]
  const c = add(m, col);
  assert.deepEqual(c.shape, [2, 3]);
  assert.deepEqual(Array.from(c.data), [11, 12, 13, 24, 25, 26]);
});

test('add: incompatible shapes throw', () => {
  const a = from([[1, 2], [3, 4]]);     // [2,2]
  const b = from([[1, 2, 3], [4, 5, 6]]);// [2,3]
  assert.throws(() => add(a, b), /broadcast/);
});

test('sub / mul / div / pow basics', () => {
  const a = from([4, 9, 16]);
  const b = from([2, 3, 4]);
  assert.deepEqual(Array.from(sub(a, b).data), [2, 6, 12]);
  assert.deepEqual(Array.from(mul(a, b).data), [8, 27, 64]);
  assert.deepEqual(Array.from(div(a, b).data), [2, 3, 4]);
  assert.deepEqual(Array.from(pow(a, b).data), [16, 729, 65536]);
});

test('sub / div: scalar lhs path', () => {
  const a = from([1, 2, 4]);
  assert.deepEqual(Array.from(sub(10, a).data), [9, 8, 6]);
  assert.deepEqual(Array.from(div(12, a).data), [12, 6, 3]);
});

test('binary ops: 3D broadcast (right-aligned)', () => {
  const a = from([1, 2, 3, 4, 5, 6, 7, 8], [2, 2, 2]);
  const b = from([10, 100], [2]);              // broadcast across last axis
  const c = add(a, b);
  // last-axis pairs: [1+10,2+100], [3+10,4+100], [5+10,6+100], [7+10,8+100]
  assert.deepEqual(Array.from(c.data), [11, 102, 13, 104, 15, 106, 17, 108]);
  assert.deepEqual(c.shape, [2, 2, 2]);
});

// ---------- Element-wise unary ----------

test('neg / abs', () => {
  const a = from([-1, 2, -3]);
  assert.deepEqual(Array.from(neg(a).data), [1, -2, 3]);
  assert.deepEqual(Array.from(abs(a).data), [1, 2, 3]);
});

test('sqrt / log / exp', () => {
  const a = from([1, 4, 9]);
  assert.deepEqual(Array.from(sqrt(a).data), [1, 2, 3]);

  const b = from([1, Math.E, Math.E * Math.E]);
  assert.ok(arrClose(log(b).data, [0, 1, 2]));

  const c = from([0, 1, 2]);
  assert.ok(arrClose(exp(c).data, [1, Math.E, Math.E * Math.E]));
});

test('sin / cos / tan', () => {
  const a = from([0, Math.PI / 2, Math.PI]);
  assert.ok(arrClose(sin(a).data, [0, 1, Math.sin(Math.PI)]));
  assert.ok(arrClose(cos(a).data, [1, Math.cos(Math.PI / 2), -1]));
  const b = from([0, Math.PI / 4]);
  assert.ok(arrClose(tan(b).data, [0, 1]));
});

test('unary preserves shape', () => {
  const m = from([[-1, 2], [-3, 4]]);
  const r = abs(m);
  assert.deepEqual(r.shape, [2, 2]);
  assert.deepEqual(Array.from(r.data), [1, 2, 3, 4]);
});

// ---------- Shape ops ----------

test('reshape preserves data, validates size', () => {
  const a = range(6);
  const r = reshape(a, [2, 3]);
  assert.deepEqual(r.shape, [2, 3]);
  assert.deepEqual(Array.from(r.data), [0, 1, 2, 3, 4, 5]);
  assert.throws(() => reshape(a, [2, 2]), /cannot reshape/);
});

test('flatten produces 1D copy', () => {
  const m = from([[1, 2], [3, 4]]);
  const f = flatten(m);
  assert.deepEqual(f.shape, [4]);
  assert.deepEqual(Array.from(f.data), [1, 2, 3, 4]);
  f.set(0, 99);
  assert.equal(m.get(0, 0), 1);
});

test('copy is independent', () => {
  const a = from([1, 2, 3]);
  const b = copy(a);
  b.set(0, 99);
  assert.deepEqual(Array.from(a.data), [1, 2, 3]);
});

test('slice 1D basic / step / negative indices', () => {
  const a = range(10);
  assert.deepEqual(Array.from(slice(a, [{ start: 2, end: 7 }]).data), [2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(slice(a, [{ start: 0, end: 10, step: 2 }]).data), [0, 2, 4, 6, 8]);
  assert.deepEqual(Array.from(slice(a, [{ start: -3 }]).data), [7, 8, 9]);
  assert.deepEqual(Array.from(slice(a, [{ end: -5 }]).data), [0, 1, 2, 3, 4]);
  assert.deepEqual(Array.from(slice(a, [{ start: 9, end: 0, step: -1 }]).data), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test('slice 2D per-axis', () => {
  const m = from([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);
  // rows 1..2, all cols
  const r = slice(m, [{ start: 1, end: 3 }, null]);
  assert.deepEqual(r.shape, [2, 4]);
  assert.deepEqual(Array.from(r.data), [5, 6, 7, 8, 9, 10, 11, 12]);
  // all rows, cols 1..2
  const c = slice(m, [null, { start: 1, end: 3 }]);
  assert.deepEqual(c.shape, [3, 2]);
  assert.deepEqual(Array.from(c.data), [2, 3, 6, 7, 10, 11]);
});

// ---------- Broadcast helpers ----------

test('broadcastShapes follows numpy rules', () => {
  assert.deepEqual(broadcastShapes([3], [4, 3]), [4, 3]);
  assert.deepEqual(broadcastShapes([4, 1], [4, 3]), [4, 3]);
  assert.deepEqual(broadcastShapes([1, 3], [4, 3]), [4, 3]);
  assert.deepEqual(broadcastShapes([2, 1, 3], [1, 4, 1]), [2, 4, 3]);
  assert.throws(() => broadcastShapes([2, 3], [3, 2]), /broadcast/);
  assert.throws(() => broadcastShapes([2, 3], [2, 4]), /broadcast/);
});

test('shapesEqual', () => {
  assert.equal(shapesEqual([2, 3], [2, 3]), true);
  assert.equal(shapesEqual([2, 3], [3, 2]), false);
  assert.equal(shapesEqual([2, 3], [2]), false);
  assert.equal(shapesEqual([], []), true);
});

// ---------- Broadcast fuzz vs slow reference ----------

test('broadcast fuzz: random shapes vs slow reference', () => {
  // Slow reference: nested-loop iteration mirroring numpy's broadcast semantics.
  function refAdd(a, b) {
    const target = broadcastShapes(a.shape, b.shape);
    const size = target.reduce((p, x) => p * x, 1);
    const out = new Float64Array(size);
    if (size === 0) return new NdArray(out, target);
    const aLead = target.length - a.shape.length;
    const bLead = target.length - b.shape.length;
    const idx = new Array(target.length).fill(0);
    for (let i = 0; i < size; i++) {
      let aOff = 0, bOff = 0;
      for (let axis = 0; axis < target.length; axis++) {
        if (axis >= aLead) {
          const srcDim = a.shape[axis - aLead];
          aOff += (srcDim === 1 ? 0 : idx[axis]) * a.strides[axis - aLead];
        }
        if (axis >= bLead) {
          const srcDim = b.shape[axis - bLead];
          bOff += (srcDim === 1 ? 0 : idx[axis]) * b.strides[axis - bLead];
        }
      }
      out[i] = a.data[aOff] + b.data[bOff];
      for (let axis = target.length - 1; axis >= 0; axis--) {
        idx[axis]++;
        if (idx[axis] < target[axis]) break;
        idx[axis] = 0;
      }
    }
    return new NdArray(out, target);
  }

  const cases = [
    [[3], [4, 3]],
    [[4, 1], [4, 3]],
    [[1, 3], [4, 3]],
    [[2, 1, 3], [1, 4, 1]],
    [[5], [5]],
    [[1], [3]],
    [[2, 3, 4], [4]],
    [[2, 3, 1], [1, 1, 4]],
  ];
  let seed = 1234;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646 * 10 - 5;
  };
  const makeRand = (shape) => {
    const sz = shape.reduce((p, x) => p * x, 1);
    const data = new Float64Array(sz);
    for (let i = 0; i < sz; i++) data[i] = rand();
    return new NdArray(data, shape);
  };

  for (const [sa, sb] of cases) {
    const a = makeRand(sa);
    const b = makeRand(sb);
    const got = add(a, b);
    const ref = refAdd(a, b);
    assert.deepEqual(got.shape, ref.shape, `shape mismatch for ${JSON.stringify([sa, sb])}`);
    assert.ok(
      arrClose(got.data, ref.data),
      `broadcast result mismatch for ${JSON.stringify([sa, sb])}`
    );
  }
});

// ---------- 0-d / empty edge cases ----------

test('empty shapes work', () => {
  const empty = zeros([0]);
  assert.equal(empty.size, 0);
  assert.equal(add(empty, empty).size, 0);

  const empty2d = zeros([3, 0]);
  assert.equal(empty2d.size, 0);
});
