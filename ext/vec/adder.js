// vec/adder — TypedArray-backed numerical bridge for adder (Python) cells.
// Registers as window._auditableExtensions['vec'].
//
// Unlike natra (which has wasm + bump-allocator scope discipline), vec is
// pure JS with GC-managed lifetimes — no scope hook, no arena. The only
// async element is the one-time module resolution: in Node we dynamic-
// import './index.js'; in the browser we scan _importCache for the
// already-loaded namespace (since blob-URL ES modules can't resolve
// relative imports). After the first creation call, all dunder methods
// run synchronously.
//
// Users alias at import time: `import vec as np` (Auditable's convention
// is to register modules under their package name; aliasing is the
// user's job).

// ── module resolution ──

let _vec = null;
let _initPromise = null;

function _isVecModule(mod) {
  return mod
    && typeof mod.NdArray === 'function'
    && typeof mod.eigSym3 === 'function'
    && typeof mod.matmul === 'function';
}

async function _ensureVec() {
  if (_vec) return _vec;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (typeof window !== 'undefined' && window._importCache) {
      for (const mod of Object.values(window._importCache)) {
        if (_isVecModule(mod)) { _vec = mod; return _vec; }
      }
      throw new Error('vec not loaded — call load("./ext/vec/index.js") first');
    }
    // Node tests / Deno / Bun: dynamic import resolves from this file.
    _vec = await import('./index.js');
    return _vec;
  })();
  return _initPromise;
}

function _v() {
  if (!_vec) {
    throw new Error('vec not initialized — create an array first (e.g. np.array(...))');
  }
  return _vec;
}

// ── helpers ──

function _isVa(v) { return v && v._va === true; }

function _unwrap(v) {
  if (_isVa(v)) return v._arr;
  if (typeof v === 'number') return v;
  const vec = _v();
  if (v instanceof vec.NdArray) return v;
  if (Array.isArray(v)) return vec.from(v);
  return v;
}

function _wrap(v) {
  if (typeof v === 'number') return v;
  const vec = _v();
  if (v instanceof vec.NdArray) return new VecArray(v);
  return v;
}

// ── VecArray wrapper ──

class VecArray {
  constructor(nd) {
    const vec = _v();
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
  get T()     { return new VecArray(_v().transpose(this._arr)); }

  __add__(o)      { return new VecArray(_v().add(this._arr, _unwrap(o))); }
  __radd__(o)     { return new VecArray(_v().add(_unwrap(o), this._arr)); }
  __sub__(o)      { return new VecArray(_v().sub(this._arr, _unwrap(o))); }
  __rsub__(o)     { return new VecArray(_v().sub(_unwrap(o), this._arr)); }
  __mul__(o)      { return new VecArray(_v().mul(this._arr, _unwrap(o))); }
  __rmul__(o)     { return new VecArray(_v().mul(_unwrap(o), this._arr)); }
  __truediv__(o)  { return new VecArray(_v().div(this._arr, _unwrap(o))); }
  __rtruediv__(o) { return new VecArray(_v().div(_unwrap(o), this._arr)); }
  __pow__(o)      { return new VecArray(_v().pow(this._arr, _unwrap(o))); }
  __rpow__(o)     { return new VecArray(_v().pow(_unwrap(o), this._arr)); }
  __matmul__(o)   { return new VecArray(_v().matmul(this._arr, _unwrap(o))); }
  __rmatmul__(o)  { return new VecArray(_v().matmul(_unwrap(o), this._arr)); }
  __neg__()       { return new VecArray(_v().neg(this._arr)); }
  __abs__()       { return new VecArray(_v().abs(this._arr)); }

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
      return new VecArray(_takeAxis0(arr, idx));
    }
    if (key && key._slice) return new VecArray(_sliceAxis0(arr, key));
    if (Array.isArray(key)) return _tupleIndex(arr, key);
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

  __eq__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a === b ? 1 : 0)); }
  __ne__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a !== b ? 1 : 0)); }
  __lt__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a <  b ? 1 : 0)); }
  __le__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a <= b ? 1 : 0)); }
  __gt__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a >  b ? 1 : 0)); }
  __ge__(o) { return new VecArray(_cmp(this._arr, _unwrap(o), (a, b) => a >= b ? 1 : 0)); }

  __repr__() { return this._arr.toString(); }
  __str__() { return this._arr.toString(); }

  sum(opts)   { return _wrap(_v().sum (this._arr, _axisOpts(opts))); }
  mean(opts)  { return _wrap(_v().mean(this._arr, _axisOpts(opts))); }
  min(opts)   { return _wrap(_v().min (this._arr, _axisOpts(opts))); }
  max(opts)   { return _wrap(_v().max (this._arr, _axisOpts(opts))); }
  std(opts)   { return _wrap(_v().std (this._arr, _axisOpts(opts))); }
  var(opts)   { return _wrap(_v().variance(this._arr, _axisOpts(opts))); }
  norm()      { return _v().norm(this._arr); }

  reshape(...shapeArgs) {
    const shape = shapeArgs.length === 1 && Array.isArray(shapeArgs[0])
      ? shapeArgs[0] : shapeArgs;
    return new VecArray(_v().reshape(this._arr, shape));
  }
  flatten()    { return new VecArray(_v().flatten(this._arr)); }
  copy()       { return new VecArray(_v().copy(this._arr)); }
  tolist()     { return this._arr.toArray(); }
  dot(other)   { return _wrap(_v().dot(this._arr, _unwrap(other))); }
  transpose()  { return new VecArray(_v().transpose(this._arr)); }

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

// ── internal helpers ──

function _axisOpts(opts) {
  if (opts === undefined || opts === null) return undefined;
  if (typeof opts === 'number') return { axis: opts };
  if (opts._kw) return { axis: opts.axis };
  return opts;
}

function _takeAxis0(arr, idx) {
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
  return new (_v().NdArray)(out, innerShape);
}

function _sliceAxis0(arr, slc) {
  const range = {
    start: slc.lower ?? undefined,
    end:   slc.upper ?? undefined,
    step:  slc.step  ?? undefined,
  };
  const ranges = new Array(arr.ndim).fill(null);
  ranges[0] = range;
  return _v().slice(arr, ranges);
}

function _tupleIndex(arr, key) {
  if (key.length > arr.ndim) {
    throw new RangeError(`too many indices: got ${key.length}, ${arr.ndim}D array`);
  }
  if (key.length === arr.ndim && key.every(k => typeof k === 'number')) {
    const idx = key.map((k, i) => k < 0 ? k + arr.shape[i] : k);
    return arr.get(...idx);
  }
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
  let sliced = _v().slice(arr, ranges);
  const newShape = [];
  for (let i = 0; i < sliced.ndim; i++) {
    if (!collapsed[i]) newShape.push(sliced.shape[i]);
  }
  if (newShape.length === sliced.ndim) return new VecArray(sliced);
  if (newShape.length === 0) return sliced.data[0];
  return new VecArray(_v().reshape(sliced, newShape));
}

function _cmp(arr, other, fn) {
  const out = new Float64Array(arr.size);
  if (typeof other === 'number') {
    const d = arr.data;
    for (let i = 0; i < arr.size; i++) out[i] = fn(d[i], other);
    return new (_v().NdArray)(out, arr.shape);
  }
  const vec = _v();
  const o = other instanceof vec.NdArray ? other : null;
  if (!o) throw new TypeError('comparison requires number or NdArray');
  if (o.size !== arr.size) {
    throw new RangeError(`comparison shape mismatch: [${arr.shape.join(',')}] vs [${o.shape.join(',')}]`);
  }
  const ad = arr.data, od = o.data;
  for (let i = 0; i < arr.size; i++) out[i] = fn(ad[i], od[i]);
  return new vec.NdArray(out, arr.shape);
}

// ── module exports ──
// Creation methods are async (they trigger the one-time module resolution
// on first call). Once initialized, every dunder method on VecArray runs
// synchronously. After the first await np.array(...) succeeds, vec is
// fully bound and the rest of the API behaves as if it were sync — though
// adder cells still need to await any further np.* helper calls because
// they're declared async at the binding level.

const _module = {
  async array(data) { await _ensureVec(); return new VecArray(_v().from(data)); },
  async zeros(shape) { await _ensureVec(); return new VecArray(_v().zeros(shape)); },
  async ones(shape)  { await _ensureVec(); return new VecArray(_v().ones(shape)); },
  async full(shape, value) { await _ensureVec(); return new VecArray(_v().full(shape, value)); },
  async eye(n) { await _ensureVec(); return new VecArray(_v().eye(n)); },
  async arange(start, stop, step) {
    await _ensureVec();
    if (stop === undefined) { stop = start; start = 0; }
    return new VecArray(_v().range(start, stop, step ?? 1));
  },
  async linspace(a, b, n) {
    await _ensureVec();
    if (n?._kw) n = n.num ?? 50;
    return new VecArray(_v().linspace(a, b, n ?? 50));
  },

  abs:  (a) => _isVa(a) ? new VecArray(_v().abs (a._arr)) : Math.abs(a),
  sqrt: (a) => _isVa(a) ? new VecArray(_v().sqrt(a._arr)) : Math.sqrt(a),
  exp:  (a) => _isVa(a) ? new VecArray(_v().exp (a._arr)) : Math.exp(a),
  log:  (a) => _isVa(a) ? new VecArray(_v().log (a._arr)) : Math.log(a),
  sin:  (a) => _isVa(a) ? new VecArray(_v().sin (a._arr)) : Math.sin(a),
  cos:  (a) => _isVa(a) ? new VecArray(_v().cos (a._arr)) : Math.cos(a),
  tan:  (a) => _isVa(a) ? new VecArray(_v().tan (a._arr)) : Math.tan(a),

  sum:  (a, opts) => _wrap(_v().sum (_unwrap(a), _axisOpts(opts))),
  mean: (a, opts) => _wrap(_v().mean(_unwrap(a), _axisOpts(opts))),
  min:  (a, opts) => _wrap(_v().min (_unwrap(a), _axisOpts(opts))),
  max:  (a, opts) => _wrap(_v().max (_unwrap(a), _axisOpts(opts))),
  std:  (a, opts) => _wrap(_v().std (_unwrap(a), _axisOpts(opts))),
  var:  (a, opts) => _wrap(_v().variance(_unwrap(a), _axisOpts(opts))),

  dot:    (a, b) => _wrap(_v().dot(_unwrap(a), _unwrap(b))),
  matmul: (a, b) => new VecArray(_v().matmul(_unwrap(a), _unwrap(b))),

  reshape: (a, ...shapeArgs) => {
    const s = shapeArgs.length === 1 && Array.isArray(shapeArgs[0]) ? shapeArgs[0] : shapeArgs;
    return new VecArray(_v().reshape(_unwrap(a), s));
  },
  transpose: (a) => new VecArray(_v().transpose(_unwrap(a))),
  flatten:   (a) => new VecArray(_v().flatten(_unwrap(a))),
  copy:      (a) => new VecArray(_v().copy(_unwrap(a))),

  linalg: {
    solve:    (A, b) => new VecArray(_v().solve(_unwrap(A), _unwrap(b))),
    inv:      (A)    => new VecArray(_v().inv(_unwrap(A))),
    det:      (A)    => _v().det(_unwrap(A)),
    cholesky: (A)    => new VecArray(_v().cholesky(_unwrap(A))),
    norm:     (a)    => _v().norm(_unwrap(a)),
    lstsq:    (A, b) => new VecArray(_v().lstsq(_unwrap(A), _unwrap(b))),
    eigh:     (A) => {
      const { values, vectors } = _v().eigSym(_unwrap(A));
      return [new VecArray(values), new VecArray(vectors)];
    },
    eigh3:    (A) => {
      const { values, vectors } = _v().eigSym3(_unwrap(A));
      return [new VecArray(values), new VecArray(vectors)];
    },
  },

  pi:  Math.PI,
  e:   Math.E,
  inf: Infinity,
  nan: NaN,
  newaxis: null,
  float64: 'f64',
  ndarray: 'ndarray',
  VecArray,
};

// ── registration ──

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
