// vec/adder — TypedArray-backed numerical bridge for adder (Python) cells.
// Registers as window._auditableExtensions['vec'].
//
// Unlike natra (which has wasm + bump-allocator scope discipline), vec is
// pure JS with GC-managed lifetimes. There's no async init, no scope hook,
// no arena. Every operation runs synchronously and returns a fresh
// NdArray-backed VecArray.
//
// Users alias at import time: `import vec as np` (Auditable's convention is
// to register modules under their package name; aliasing is the user's job).

import * as vec from './index.js';

// ---------- helpers ----------

function _isVa(v) { return v && v._va === true; }

function _unwrap(v) {
  if (_isVa(v)) return v._arr;
  if (typeof v === 'number') return v;
  if (v instanceof vec.NdArray) return v;
  if (Array.isArray(v)) return vec.from(v);
  return v;
}

function _wrap(v) {
  if (typeof v === 'number') return v;
  if (v instanceof vec.NdArray) return new VecArray(v);
  return v;
}

// ---------- VecArray wrapper ----------
// Python-friendly facade over an NdArray, exposing dunder methods that
// adder's runtime calls during arithmetic / indexing / iteration.

class VecArray {
  constructor(nd) {
    if (!(nd instanceof vec.NdArray)) {
      throw new TypeError('VecArray expects an NdArray');
    }
    this._va = true;
    this._arr = nd;
  }

  get shape() { return [...this._arr.shape]; }
  get ndim()  { return this._arr.ndim; }
  get dtype() { return this._arr.dtype; }
  get size()  { return this._arr.size; }
  get T()     { return new VecArray(vec.transpose(this._arr)); }

  // arithmetic dunders
  __add__(o)      { return new VecArray(vec.add(this._arr, _unwrap(o))); }
  __radd__(o)     { return new VecArray(vec.add(_unwrap(o), this._arr)); }
  __sub__(o)      { return new VecArray(vec.sub(this._arr, _unwrap(o))); }
  __rsub__(o)     { return new VecArray(vec.sub(_unwrap(o), this._arr)); }
  __mul__(o)      { return new VecArray(vec.mul(this._arr, _unwrap(o))); }
  __rmul__(o)     { return new VecArray(vec.mul(_unwrap(o), this._arr)); }
  __truediv__(o)  { return new VecArray(vec.div(this._arr, _unwrap(o))); }
  __rtruediv__(o) { return new VecArray(vec.div(_unwrap(o), this._arr)); }
  __pow__(o)      { return new VecArray(vec.pow(this._arr, _unwrap(o))); }
  __rpow__(o)     { return new VecArray(vec.pow(_unwrap(o), this._arr)); }
  __matmul__(o)   { return new VecArray(vec.matmul(this._arr, _unwrap(o))); }
  __rmatmul__(o)  { return new VecArray(vec.matmul(_unwrap(o), this._arr)); }
  __neg__()       { return new VecArray(vec.neg(this._arr)); }
  __abs__()       { return new VecArray(vec.abs(this._arr)); }

  // container dunders
  __len__() { return this._arr.shape[0]; }
  __bool__() {
    if (this._arr.size !== 1) {
      throw new Error('truth value of array with more than one element is ambiguous');
    }
    return this._arr.data[0] !== 0;
  }

  __getitem__(key) {
    const arr = this._arr;
    if (typeof key === 'number') {
      const idx = key < 0 ? key + arr.shape[0] : key;
      if (arr.ndim === 1) return arr.get(idx);
      if (arr.ndim === 2) return new VecArray(arr.row(idx));
      // N-D: slice off the first axis.
      return new VecArray(_takeAxis0(arr, idx));
    }
    if (key && key._slice) {
      // Python slice: { lower, upper, step }
      return new VecArray(_sliceAxis0(arr, key));
    }
    if (Array.isArray(key)) {
      // Tuple indexing.
      return _tupleIndex(arr, key);
    }
    throw new Error(`unsupported index type: ${typeof key}`);
  }

  __setitem__(key, value) {
    const arr = this._arr;
    if (typeof key === 'number') {
      const idx = key < 0 ? key + arr.shape[0] : key;
      if (arr.ndim === 1) {
        arr.data[idx] = _isVa(value) ? value._arr.data[0] : value;
        return;
      }
      if (arr.ndim === 2) {
        const cols = arr.shape[1];
        const off = idx * cols;
        if (typeof value === 'number') {
          for (let j = 0; j < cols; j++) arr.data[off + j] = value;
        } else if (_isVa(value)) {
          if (value._arr.size !== cols) {
            throw new RangeError(`cannot assign size ${value._arr.size} into row of length ${cols}`);
          }
          for (let j = 0; j < cols; j++) arr.data[off + j] = value._arr.data[j];
        } else {
          throw new TypeError('row assignment requires number or VecArray');
        }
        return;
      }
      throw new Error(`setitem on ${arr.ndim}D not supported in v1`);
    }
    if (Array.isArray(key)) {
      // Multi-axis integer indexing.
      if (key.length !== arr.ndim) {
        throw new RangeError(`expected ${arr.ndim} indices, got ${key.length}`);
      }
      let off = 0;
      for (let i = 0; i < key.length; i++) {
        const k = key[i];
        if (typeof k !== 'number') throw new Error('setitem with slices not supported in v1');
        const idx = k < 0 ? k + arr.shape[i] : k;
        off += idx * arr.strides[i];
      }
      arr.data[off] = _isVa(value) ? value._arr.data[0] : value;
      return;
    }
    throw new Error(`unsupported setitem key type: ${typeof key}`);
  }

  // comparison: scalar element-wise via _cmp.
  __eq__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a === b ? 1 : 0)); }
  __ne__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a !== b ? 1 : 0)); }
  __lt__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a <  b ? 1 : 0)); }
  __le__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a <= b ? 1 : 0)); }
  __gt__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a >  b ? 1 : 0)); }
  __ge__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a >= b ? 1 : 0)); }

  // display
  __repr__() { return this._arr.toString(); }
  __str__() { return this._arr.toString(); }

  // methods
  sum(opts)   { return _wrap(vec.sum (this._arr, _axisOpts(opts))); }
  mean(opts)  { return _wrap(vec.mean(this._arr, _axisOpts(opts))); }
  min(opts)   { return _wrap(vec.min (this._arr, _axisOpts(opts))); }
  max(opts)   { return _wrap(vec.max (this._arr, _axisOpts(opts))); }
  std(opts)   { return _wrap(vec.std (this._arr, _axisOpts(opts))); }
  var(opts)   { return _wrap(vec.variance(this._arr, _axisOpts(opts))); }
  norm()      { return vec.norm(this._arr); }

  reshape(...shapeArgs) {
    const shape = shapeArgs.length === 1 && Array.isArray(shapeArgs[0])
      ? shapeArgs[0] : shapeArgs;
    return new VecArray(vec.reshape(this._arr, shape));
  }
  flatten()    { return new VecArray(vec.flatten(this._arr)); }
  copy()       { return new VecArray(vec.copy(this._arr)); }
  tolist()     { return this._arr.toArray(); }
  dot(other)   { return _wrap(vec.dot(this._arr, _unwrap(other))); }
  transpose()  { return new VecArray(vec.transpose(this._arr)); }

  // iteration: 1D yields scalars, ≥2D yields VecArray rows.
  [Symbol.iterator]() {
    const arr = this._arr;
    let i = 0;
    const len = arr.shape[0];
    return {
      next: () => {
        if (i >= len) return { value: undefined, done: true };
        const idx = i++;
        if (arr.ndim === 1) return { value: arr.data[idx], done: false };
        if (arr.ndim === 2) return { value: new VecArray(arr.row(idx)), done: false };
        return { value: new VecArray(_takeAxis0(arr, idx)), done: false };
      },
    };
  }
}

// ---------- internal helpers ----------

function _axisOpts(opts) {
  // opts may be a number (positional axis), { axis }, or adder kw object.
  if (opts === undefined || opts === null) return undefined;
  if (typeof opts === 'number') return { axis: opts };
  if (opts._kw) return { axis: opts.axis };
  return opts;
}

function _takeAxis0(arr, idx) {
  // Slice along axis 0 — returns a contiguous copy of the (idx)-th sub-array.
  if (arr.ndim < 1) throw new RangeError('cannot index 0-D array');
  const dim0 = arr.shape[0];
  if (idx < 0 || idx >= dim0) {
    throw new RangeError(`index ${idx} out of bounds for axis 0 size ${dim0}`);
  }
  const innerShape = arr.shape.slice(1);
  let innerSize = 1;
  for (let i = 0; i < innerShape.length; i++) innerSize *= innerShape[i];
  const out = new Float64Array(innerSize);
  const off = idx * innerSize;
  for (let i = 0; i < innerSize; i++) out[i] = arr.data[off + i];
  return new vec.NdArray(out, innerShape);
}

function _sliceAxis0(arr, slc) {
  // Build vec.slice ranges: first axis from slc, others null.
  const range = {
    start: slc.lower ?? undefined,
    end:   slc.upper ?? undefined,
    step:  slc.step  ?? undefined,
  };
  const ranges = new Array(arr.ndim).fill(null);
  ranges[0] = range;
  return vec.slice(arr, ranges);
}

function _tupleIndex(arr, key) {
  // Each element is either a number (collapse axis) or a slice.
  if (key.length > arr.ndim) {
    throw new RangeError(`too many indices: got ${key.length}, ${arr.ndim}D array`);
  }
  // Check fast path: all integers and full ndim → scalar lookup.
  if (key.length === arr.ndim && key.every(k => typeof k === 'number')) {
    const idx = key.map((k, i) => k < 0 ? k + arr.shape[i] : k);
    return arr.get(...idx);
  }
  // Otherwise build vec.slice ranges; integer entries collapse to length 1
  // and we drop those axes after slicing.
  const ranges = new Array(arr.ndim).fill(null);
  const collapsed = new Array(arr.ndim).fill(false);
  for (let i = 0; i < key.length; i++) {
    const k = key[i];
    if (typeof k === 'number') {
      const idx = k < 0 ? k + arr.shape[i] : k;
      ranges[i] = { start: idx, end: idx + 1 };
      collapsed[i] = true;
    } else if (k && k._slice) {
      ranges[i] = {
        start: k.lower ?? undefined,
        end:   k.upper ?? undefined,
        step:  k.step  ?? undefined,
      };
    } else if (k === null || k === undefined) {
      // full axis
    } else {
      throw new Error(`unsupported tuple index element: ${typeof k}`);
    }
  }
  let sliced = vec.slice(arr, ranges);
  // Drop collapsed axes.
  const newShape = [];
  for (let i = 0; i < sliced.ndim; i++) {
    if (!collapsed[i]) newShape.push(sliced.shape[i]);
  }
  if (newShape.length === sliced.ndim) return new VecArray(sliced);
  if (newShape.length === 0) return sliced.data[0];
  return new VecArray(vec.reshape(sliced, newShape));
}

function _cmp(arr, other, fn) {
  const out = new Float64Array(arr.size);
  if (typeof other === 'number') {
    const d = arr.data;
    for (let i = 0; i < arr.size; i++) out[i] = fn(d[i], other);
    return new vec.NdArray(out, arr.shape);
  }
  const o = other instanceof vec.NdArray ? other : null;
  if (!o) throw new TypeError('comparison requires number or NdArray');
  if (o.size !== arr.size) {
    throw new RangeError(`comparison shape mismatch: [${arr.shape.join(',')}] vs [${o.shape.join(',')}]`);
  }
  const ad = arr.data, od = o.data;
  for (let i = 0; i < arr.size; i++) out[i] = fn(ad[i], od[i]);
  return new vec.NdArray(out, arr.shape);
}

// ---------- module exports ----------

const _module = {
  // creation
  array: (data) => new VecArray(vec.from(data)),
  zeros: (shape) => new VecArray(vec.zeros(shape)),
  ones:  (shape) => new VecArray(vec.ones(shape)),
  full:  (shape, value) => new VecArray(vec.full(shape, value)),
  eye:   (n) => new VecArray(vec.eye(n)),
  arange: (start, stop, step) => {
    if (stop === undefined) { stop = start; start = 0; }
    return new VecArray(vec.range(start, stop, step ?? 1));
  },
  linspace: (a, b, n) => {
    if (n?._kw) n = n.num ?? 50;
    return new VecArray(vec.linspace(a, b, n ?? 50));
  },

  // element-wise math
  abs:  (a) => _isVa(a) ? new VecArray(vec.abs (a._arr)) : Math.abs(a),
  sqrt: (a) => _isVa(a) ? new VecArray(vec.sqrt(a._arr)) : Math.sqrt(a),
  exp:  (a) => _isVa(a) ? new VecArray(vec.exp (a._arr)) : Math.exp(a),
  log:  (a) => _isVa(a) ? new VecArray(vec.log (a._arr)) : Math.log(a),
  sin:  (a) => _isVa(a) ? new VecArray(vec.sin (a._arr)) : Math.sin(a),
  cos:  (a) => _isVa(a) ? new VecArray(vec.cos (a._arr)) : Math.cos(a),
  tan:  (a) => _isVa(a) ? new VecArray(vec.tan (a._arr)) : Math.tan(a),

  // reductions
  sum:  (a, opts) => _wrap(vec.sum (_unwrap(a), _axisOpts(opts))),
  mean: (a, opts) => _wrap(vec.mean(_unwrap(a), _axisOpts(opts))),
  min:  (a, opts) => _wrap(vec.min (_unwrap(a), _axisOpts(opts))),
  max:  (a, opts) => _wrap(vec.max (_unwrap(a), _axisOpts(opts))),
  std:  (a, opts) => _wrap(vec.std (_unwrap(a), _axisOpts(opts))),
  var:  (a, opts) => _wrap(vec.variance(_unwrap(a), _axisOpts(opts))),

  // linear algebra
  dot:    (a, b) => _wrap(vec.dot(_unwrap(a), _unwrap(b))),
  matmul: (a, b) => new VecArray(vec.matmul(_unwrap(a), _unwrap(b))),

  // shape ops
  reshape:   (a, ...shapeArgs) => {
    const s = shapeArgs.length === 1 && Array.isArray(shapeArgs[0]) ? shapeArgs[0] : shapeArgs;
    return new VecArray(vec.reshape(_unwrap(a), s));
  },
  transpose: (a) => new VecArray(vec.transpose(_unwrap(a))),
  flatten:   (a) => new VecArray(vec.flatten(_unwrap(a))),
  copy:      (a) => new VecArray(vec.copy(_unwrap(a))),

  // linalg namespace (numpy-flavored)
  linalg: {
    solve:    (A, b) => new VecArray(vec.solve(_unwrap(A), _unwrap(b))),
    inv:      (A)    => new VecArray(vec.inv(_unwrap(A))),
    det:      (A)    => vec.det(_unwrap(A)),
    cholesky: (A)    => new VecArray(vec.cholesky(_unwrap(A))),
    norm:     (a)    => vec.norm(_unwrap(a)),
    lstsq:    (A, b) => new VecArray(vec.lstsq(_unwrap(A), _unwrap(b))),
    // eigh returns [values, vectors] tuple. Values are descending here (vec
    // convention); numpy.linalg.eigh returns ascending. Document the
    // difference; users who want ascending can reverse.
    eigh:     (A) => {
      const { values, vectors } = vec.eigSym(_unwrap(A));
      return [new VecArray(values), new VecArray(vectors)];
    },
    eigh3:    (A) => {
      const { values, vectors } = vec.eigSym3(_unwrap(A));
      return [new VecArray(values), new VecArray(vectors)];
    },
  },

  // constants
  pi:  Math.PI,
  e:   Math.E,
  inf: Infinity,
  nan: NaN,
  newaxis: null,

  // type tag
  float64: 'f64',
  ndarray: 'ndarray',

  // expose the wrapper class for advanced use
  VecArray,
};

// ---------- registration ----------

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/vec',
      version: '0.1.0',
      description: 'TypedArray-based numerical library — adder bridge',
      exports: { vec: _module },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions['vec'] = _module;
  }
}

export { _module as vecAdder, VecArray };
