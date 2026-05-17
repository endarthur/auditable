// natra/adder — numpy-compatible ndarray bridge for adder (Python) cells
// Registers as window._auditableExtensions['natra'] and ['numpy'].
// Uses cell hooks for implicit per-cell arena scoping.
//
// No static import of natra/index.js — in the browser, this module runs
// from a blob URL where relative imports can't resolve. Instead we find
// the already-loaded natra factory from _importCache (browser) or use
// dynamic import (Node.js tests).

// ── Module state ──

let _ctx = null;       // natra context (lazy-initialized)
let _activeOps = null;  // current cell's scope ops (set by hook)
let _initPromise = null;
let _natraFn = null;   // cached reference to natra() factory

async function _ensureCtx() {
  if (_ctx) return _ctx;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (!_natraFn) {
      // browser: find natra in import cache (must be pre-loaded via load())
      if (typeof window !== 'undefined' && window._importCache) {
        for (const mod of Object.values(window._importCache)) {
          if (mod && typeof mod.natra === 'function') { _natraFn = mod.natra; break; }
        }
        if (!_natraFn) throw new Error('natra not loaded \u2014 call load("./ext/natra/index.js") first');
      } else {
        // Node.js tests: dynamic import (relative path resolves from this file)
        const mod = await import('./index.js');
        _natraFn = mod.natra;
      }
    }
    _ctx = await _natraFn();
    _registerHook();
    // The cell hook only fires from cell N+1 onward — the current
    // cell already passed `before()` while _ctx was still null, so
    // _activeOps wasn't set. Open a scope inline so this cell can
    // complete. The after-hook for this cell is a no-op (its hookState
    // was null), so the arena just lingers until the next cell's
    // `before` starts a fresh one. Minor leak, acceptable bootstrap.
    if (!_activeOps) {
      const { ops } = _ctx._beginCellScope();
      _activeOps = ops;
    }
    return _ctx;
  })();
  return _initPromise;
}

// ── Helpers ──

function _ops() {
  if (_activeOps) return _activeOps;
  throw new Error('natra: no active cell scope — operations must run inside a cell or with np.scope()');
}

function _raw(v) {
  if (v && v._nd) return v._arr;
  // Coerce plain JS arrays / TypedArrays into a natra ndarray so the
  // reduction ops (max/min/sum/mean/etc.) work on lists from outside
  // natra (e.g. plt.hist counts, user-built lists). Requires _ctx to
  // already exist — if it doesn't, return as-is and let the op fail.
  if (_ctx && (Array.isArray(v) || ArrayBuffer.isView(v))) {
    return _ctx.array(Array.isArray(v) ? v : Array.from(v));
  }
  return v;
}

function _isNd(v) {
  return v && v._nd === true;
}

// ── NdArray wrapper ──

function _makeNd(arr) {
  const nd = {
    _nd: true,
    _arr: arr,
    // Surface as `<class 'ndarray'>` to adder's type() builtin —
    // matches numpy's reporting closely enough for the common
    // `print(type(x))` debugging pattern.
    __adderClass__: 'ndarray',
    get shape() { return [...arr.shape]; },
    get ndim() { return arr.ndim; },
    get dtype() { return arr.dtype; },
    get size() { return arr.length; },
    get T() { return _makeNd(arr.T); },

    // arithmetic dunders
    __add__(other) { return _makeNd(_ops().add(arr, _raw(other))); },
    __radd__(other) { return _makeNd(_ops().add(_raw(other), arr)); },
    __sub__(other) { return _makeNd(_ops().sub(arr, _raw(other))); },
    __rsub__(other) { return _makeNd(_ops().sub(_raw(other), arr)); },
    __mul__(other) { return _makeNd(_ops().mul(arr, _raw(other))); },
    __rmul__(other) { return _makeNd(_ops().mul(_raw(other), arr)); },
    __truediv__(other) { return _makeNd(_ops().div(arr, _raw(other))); },
    __rtruediv__(other) { return _makeNd(_ops().div(_raw(other), arr)); },
    __matmul__(other) { return _makeNd(_ops().matmul(arr, _raw(other))); },
    __rmatmul__(other) { return _makeNd(_ops().matmul(_raw(other), arr)); },
    __neg__() { return _makeNd(_ops().neg(arr)); },
    __abs__() { return _makeNd(_ops().map(arr, Math.abs)); },

    // comparison dunders (return mask arrays)
    __eq__(other) { return _makeNd(_ops().eq(arr, _raw(other))); },
    __ne__(other) { return _makeNd(_ops().ne(arr, _raw(other))); },
    __lt__(other) { return _makeNd(_ops().lt(arr, _raw(other))); },
    __le__(other) { return _makeNd(_ops().le(arr, _raw(other))); },
    __gt__(other) { return _makeNd(_ops().gt(arr, _raw(other))); },
    __ge__(other) { return _makeNd(_ops().ge(arr, _raw(other))); },

    // container dunders
    __len__() { return arr.shape[0]; },
    __bool__() { if (arr.length !== 1) throw new Error('truth value of array with more than one element is ambiguous'); return _ctx.get(arr, 0) !== 0; },

    // subscript
    __getitem__(key) {
      if (typeof key === 'number') {
        if (arr.ndim === 1) return _ctx.get(arr, key < 0 ? key + arr.shape[0] : key);
        return _makeNd(arr.slice(key < 0 ? key + arr.shape[0] : key));
      }
      if (key && key._slice) {
        const lower = key.lower ?? 0;
        const upper = key.upper ?? arr.shape[0];
        const step = key.step ?? 1;
        return _makeNd(arr.slice([lower < 0 ? lower + arr.shape[0] : lower, upper < 0 ? upper + arr.shape[0] : upper, step]));
      }
      if (Array.isArray(key)) {
        // tuple indexing (multi-dimensional)
        const sliceArgs = key.map((k, d) => {
          if (typeof k === 'number') return k < 0 ? k + arr.shape[d] : k;
          if (k && k._slice) {
            const lower = k.lower ?? 0;
            const upper = k.upper ?? arr.shape[d];
            const step = k.step ?? 1;
            return [lower < 0 ? lower + arr.shape[d] : lower, upper < 0 ? upper + arr.shape[d] : upper, step];
          }
          return null; // full slice
        });
        const result = arr.slice(...sliceArgs);
        // if all dimensions were integer-indexed, we have a [1] array — return scalar
        if (result.ndim === 1 && result.length === 1 && sliceArgs.every(s => typeof s === 'number')) {
          return _ctx.get(result, 0);
        }
        return _makeNd(result);
      }
      // boolean mask indexing
      if (_isNd(key)) return _makeNd(_ops().compress(arr, key._arr));
      throw new Error(`unsupported index type: ${typeof key}`);
    },

    __setitem__(key, val) {
      if (typeof key === 'number') {
        const idx = key < 0 ? key + arr.shape[0] : key;
        if (arr.ndim === 1) {
          _ctx.set(arr, _isNd(val) ? _ctx.get(val._arr, 0) : val, idx);
        } else {
          throw new Error('multi-dimensional setitem not yet supported');
        }
        return;
      }
      if (Array.isArray(key)) {
        // tuple indexing
        const indices = key.map((k, d) => {
          if (typeof k !== 'number') throw new Error('setitem with slices not yet supported');
          return k < 0 ? k + arr.shape[d] : k;
        });
        _ctx.set(arr, _isNd(val) ? _ctx.get(val._arr, 0) : val, ...indices);
        return;
      }
      throw new Error(`unsupported setitem key type: ${typeof key}`);
    },

    // display
    __repr__() { return arr.toString(); },
    __str__() { return arr.toString(); },
    _repr_html_() { return _htmlTable(arr); },

    // methods
    sum(axis) {
      const a = axis?._kw ? axis.axis : axis;
      const r = _ops().sum(arr, a);
      return typeof r === 'number' ? r : _makeNd(r);
    },
    mean(axis) {
      const a = axis?._kw ? axis.axis : axis;
      const r = _ops().mean(arr, a);
      return typeof r === 'number' ? r : _makeNd(r);
    },
    min(axis) {
      const a = axis?._kw ? axis.axis : axis;
      const r = _ops().min(arr, a);
      return typeof r === 'number' ? r : _makeNd(r);
    },
    max(axis) {
      const a = axis?._kw ? axis.axis : axis;
      const r = _ops().max(arr, a);
      return typeof r === 'number' ? r : _makeNd(r);
    },
    reshape(...s) {
      const shape = s.length === 1 && Array.isArray(s[0]) ? s[0] : s;
      return _makeNd(arr.reshape(shape));
    },
    flatten() { return _makeNd(arr.reshape([arr.length])); },
    copy() { return _makeNd(_ctx.copy(arr)); },
    tolist() { return _ctx.toArray(arr); },
    dot(other) {
      const r = _ops().dot(arr, _raw(other));
      return typeof r === 'number' ? r : _makeNd(r);
    },
    diag() { return _makeNd(arr.diag()); },
    argmin() {
      const vals = _ctx.toArray(arr).flat();
      let mi = 0;
      for (let i = 1; i < vals.length; i++) if (vals[i] < vals[mi]) mi = i;
      return mi;
    },
    argmax() {
      const vals = _ctx.toArray(arr).flat();
      let mi = 0;
      for (let i = 1; i < vals.length; i++) if (vals[i] > vals[mi]) mi = i;
      return mi;
    },

    // iteration (for Python for-loops)
    [Symbol.iterator]() {
      let i = 0;
      const len = arr.shape[0];
      return {
        next() {
          if (i >= len) return { done: true };
          const idx = i++;
          if (arr.ndim === 1) return { value: _ctx.get(arr, idx), done: false };
          return { value: _makeNd(arr.slice(idx)), done: false };
        }
      };
    },
  };
  return nd;
}

// ── HTML table display ──

function _htmlTable(arr) {
  const fmtVal = v => {
    if (Number.isNaN(v)) return 'nan';
    if (v === Infinity) return 'inf';
    if (v === -Infinity) return '-inf';
    if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
    const a = Math.abs(v);
    if (a >= 1e8 || (a !== 0 && a < 1e-4)) return v.toExponential(4);
    return v.toFixed(4).replace(/\.?0+$/, '');
  };

  if (arr.ndim === 1) {
    const MAX = 20;
    const data = _ctx.toArray(arr);
    const show = data.length <= MAX ? data : [...data.slice(0, 10), '...', ...data.slice(-5)];
    return `<code>array([${show.map(v => typeof v === 'string' ? v : fmtVal(v)).join(', ')}])</code>`;
  }
  if (arr.ndim === 2) {
    const [rows, cols] = arr.shape;
    const MAX_R = 20, MAX_C = 10;
    let html = '<table style="border-collapse:collapse;font-family:monospace;font-size:0.85em">';
    const rShow = rows <= MAX_R ? rows : 10;
    for (let i = 0; i < rShow; i++) {
      html += '<tr>';
      const cShow = cols <= MAX_C ? cols : 6;
      for (let j = 0; j < cShow; j++) {
        html += `<td style="padding:2px 6px;text-align:right">${fmtVal(_ctx.get(arr, i, j))}</td>`;
      }
      if (cols > MAX_C) html += '<td style="padding:2px 6px">…</td>';
      html += '</tr>';
    }
    if (rows > MAX_R) html += `<tr><td colspan="${Math.min(cols, MAX_C) + (cols > MAX_C ? 1 : 0)}" style="text-align:center">⋮</td></tr>`;
    html += '</table>';
    return html;
  }
  return `<code>${arr.toString()}</code>`;
}

// ── Cell hook ──

let _hookRegistered = false;

function _registerHook() {
  if (_hookRegistered) return;
  _hookRegistered = true;
  if (typeof window === 'undefined') return;
  window._adderCellHooks = window._adderCellHooks || [];
  window._adderCellHooks.push({
    before(scope, cell) {
      if (!_ctx) return null;
      const { arena, ops } = _ctx._beginCellScope();
      _activeOps = ops;
      return arena;
    },
    after(arena, defines, scope) {
      if (!arena) return;
      // collect raw descriptors for defined NdArrays
      const keep = [];
      for (const v of Object.values(defines)) {
        if (_isNd(v) && v._arr._arena === arena) keep.push(v._arr);
      }
      const promoted = _ctx._endCellScope(arena, keep);
      // update wrapper references to promoted descriptors
      let pi = 0;
      for (const v of Object.values(defines)) {
        if (_isNd(v) && v._arr._arena === arena) v._arr = promoted[pi++];
      }
      _activeOps = null;
    },
  });
}

// Numpy parity: np.zeros(3) accepts a scalar (= 1D shape of length 3).
// natra's underlying ctx expects an array; wrap scalars before passing
// through. Applied to zeros/ones/full and any other shape-taking constructor.
function _normShape(shape) {
  return typeof shape === 'number' ? [shape] : shape;
}

// ── Module API ──

const _module = {
  // numpy scalar constants
  NaN: Number.NaN,
  nan: Number.NaN,   // numpy exposes both spellings
  Inf: Number.POSITIVE_INFINITY,
  inf: Number.POSITIVE_INFINITY,
  NINF: Number.NEGATIVE_INFINITY,
  pi: Math.PI,
  e: Math.E,
  newaxis: null,     // numpy.newaxis is None; used as a placeholder in slicing

  // array creation (sync permPtr before perm alloc to avoid overwriting arena scratch)
  async array(data) { const ctx = await _ensureCtx(); ctx._syncPerm(); return _makeNd(ctx.array(data)); },
  async zeros(shape) { const ctx = await _ensureCtx(); ctx._syncPerm(); return _makeNd(ctx.zeros(_normShape(shape))); },
  async ones(shape) { const ctx = await _ensureCtx(); ctx._syncPerm(); return _makeNd(ctx.ones(_normShape(shape))); },
  async full(shape, v) { const ctx = await _ensureCtx(); ctx._syncPerm(); return _makeNd(ctx.full(_normShape(shape), v)); },
  async eye(n) { const ctx = await _ensureCtx(); ctx._syncPerm(); return _makeNd(ctx.eye(n)); },
  async linspace(start, stop, num) {
    if (num?._kw) num = num.num ?? 50;
    const ctx = await _ensureCtx(); ctx._syncPerm();
    return _makeNd(ctx.linspace(start, stop, num ?? 50));
  },
  async arange(start, stop, step) {
    const ctx = await _ensureCtx(); ctx._syncPerm();
    if (stop === undefined) { stop = start; start = 0; }
    return _makeNd(ctx.arange(start, stop, step ?? 1));
  },

  // math functions (element-wise)
  abs(a) { return _isNd(a) ? _makeNd(_ops().map(a._arr, Math.abs)) : Math.abs(a); },
  sqrt(a) { return _isNd(a) ? _makeNd(_ops().map(a._arr, Math.sqrt)) : Math.sqrt(a); },
  exp(a) { return _isNd(a) ? _makeNd(_ops().map(a._arr, Math.exp)) : Math.exp(a); },
  log(a) { return _isNd(a) ? _makeNd(_ops().map(a._arr, Math.log)) : Math.log(a); },
  sin(a) { return _isNd(a) ? _makeNd(_ops().map(a._arr, Math.sin)) : Math.sin(a); },
  cos(a) { return _isNd(a) ? _makeNd(_ops().map(a._arr, Math.cos)) : Math.cos(a); },
  tan(a) { return _isNd(a) ? _makeNd(_ops().map(a._arr, Math.tan)) : Math.tan(a); },

  // reductions
  sum(a, axis) {
    const ax = axis?._kw ? axis.axis : axis;
    const r = _ops().sum(_raw(a), ax);
    return typeof r === 'number' ? r : _makeNd(r);
  },
  mean(a, axis) {
    const ax = axis?._kw ? axis.axis : axis;
    const r = _ops().mean(_raw(a), ax);
    return typeof r === 'number' ? r : _makeNd(r);
  },
  min(a, axis) {
    const ax = axis?._kw ? axis.axis : axis;
    const r = _ops().min(_raw(a), ax);
    return typeof r === 'number' ? r : _makeNd(r);
  },
  max(a, axis) {
    const ax = axis?._kw ? axis.axis : axis;
    const r = _ops().max(_raw(a), ax);
    return typeof r === 'number' ? r : _makeNd(r);
  },

  // numpy-shaped extras commonly hit by ported notebooks
  // np.average(a, axis=None, weights=None) — weighted mean. Without
  // weights it's equivalent to np.mean.
  average(a, axisOrKw, weights) {
    let axis = axisOrKw, w = weights;
    if (axisOrKw?._kw) { axis = axisOrKw.axis; w = axisOrKw.weights; }
    const raw = _raw(a);
    if (w === undefined || w === null) {
      const r = _ops().mean(raw, axis);
      return typeof r === 'number' ? r : _makeNd(r);
    }
    const wRaw = _raw(w);
    const num = _ops().sum(_ops().mul(raw, wRaw), axis);
    const den = _ops().sum(wRaw, axis);
    if (typeof num === 'number' && typeof den === 'number') return num / den;
    return _makeNd(_ops().div(num, den));
  },
  // np.percentile(a, q) — q in [0,100]. Returns scalar (q scalar) or
  // array (q list). Linear interpolation, matches numpy's default.
  async percentile(a, q) {
    const raw = _raw(a);
    const ctx = await _ensureCtx();
    const flat = typeof ctx.toArray === 'function' ? ctx.toArray(raw).flat() : Array.from(raw);
    flat.sort((x, y) => x - y);
    const _pick = (qq) => {
      const idx = (qq / 100) * (flat.length - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      if (lo === hi) return flat[lo];
      return flat[lo] + (flat[hi] - flat[lo]) * (idx - lo);
    };
    if (Array.isArray(q)) return q.map(_pick);
    return _pick(q);
  },
  // np.median(a) — equivalent to percentile(a, 50)
  median(a) { return this.percentile(a, 50); },
  // np.sort(a) — ascending, returns new ndarray
  async sort(a) {
    const raw = _raw(a);
    // natra's raw arr is a WASM-arena descriptor — use toArray to read.
    const ctx = await _ensureCtx();
    const flat = typeof ctx.toArray === 'function' ? ctx.toArray(raw).flat() : Array.from(raw);
    flat.sort((x, y) => x - y);
    return _makeNd(ctx.array(flat));
  },
  // np.log10(a)
  log10(a) {
    return _isNd(a) ? _makeNd(_ops().map(a._arr, Math.log10)) : Math.log10(a);
  },
  // np.logspace(start, stop, num=50, base=10) — log-spaced points between
  // base**start and base**stop inclusive.
  async logspace(start, stop, num, base) {
    if (start?._kw) {
      const kw = start;
      start = kw.start; stop = kw.stop;
      num = kw.num ?? 50; base = kw.base ?? 10;
    }
    num = num ?? 50; base = base ?? 10;
    const ctx = await _ensureCtx(); ctx._syncPerm();
    const lin = ctx.linspace(start, stop, num);
    return _makeNd(_ops().map(lin, (v) => Math.pow(base, v)));
  },
  // np.var(a, axis=None) / np.std(a, axis=None)
  var(a, axis) {
    const raw = _raw(a);
    const m = _ops().mean(raw, axis);
    const diff = _ops().sub(raw, m);
    const sq = _ops().mul(diff, diff);
    const r = _ops().mean(sq, axis);
    return typeof r === 'number' ? r : _makeNd(r);
  },
  std(a, axis) {
    const v = this.var(a, axis);
    if (typeof v === 'number') return Math.sqrt(v);
    return _makeNd(_ops().map(v._arr, Math.sqrt));
  },

  // linear algebra helpers
  dot(a, b) {
    const r = _ops().dot(_raw(a), _raw(b));
    return typeof r === 'number' ? r : _makeNd(r);
  },
  matmul(a, b) { return _makeNd(_ops().matmul(_raw(a), _raw(b))); },
  where(cond, a, b) {
    // Three input shapes commonly arrive here:
    //   - natra ndarray condition → use the native op (vectorized)
    //   - sadpan BooleanMask / Series / plain JS array → element-wise loop
    //     in JS (cheap for the array sizes scientific notebooks pass in)
    //   - scalar bool → just pick a or b
    if (typeof cond === 'boolean') return cond ? a : b;
    if (_isNd(cond)) return _makeNd(_ops().where(cond._arr, _raw(a), _raw(b)));

    const condArr = (cond && cond._values) ? cond._values
                  : (Array.isArray(cond) ? cond
                  : null);
    if (!condArr) throw new Error(`np.where: unsupported condition type ${typeof cond}`);

    const getElt = (v) => {
      if (v == null) return () => v;
      if (v._values) return (i) => v._values[i];
      if (Array.isArray(v)) return (i) => v[i];
      return () => v;
    };
    const fa = getElt(a);
    const fb = getElt(b);
    const out = new Array(condArr.length);
    for (let i = 0; i < condArr.length; i++) out[i] = condArr[i] ? fa(i) : fb(i);
    return out;
  },

  // linalg namespace
  linalg: {
    solve(a, b) { return _makeNd(_ops().solve(_raw(a), _raw(b))); },
    inv(a) { return _makeNd(_ops().inv(_raw(a))); },
    cholesky(a) { return _makeNd(_ops().cholesky(_raw(a))); },
    eigh(a) { const [w, v] = _ops().eigh(_raw(a)); return [_makeNd(w), _makeNd(v)]; },
    eig(a) { const [w, v] = _ops().eigh(_raw(a)); return [_makeNd(w), _makeNd(v)]; },
    det(a) { return _ops().det(_raw(a)); },
    norm(a) { return _ops().norm(_raw(a)); },
  },

  // random namespace
  random: {
    async seed(n) { const ctx = await _ensureCtx(); ctx.seed(n); },
    async rand(...shape) { const ctx = await _ensureCtx(); ctx._syncPerm(); return _makeNd(ctx.random(shape)); },
    async randn(...shape) { const ctx = await _ensureCtx(); ctx._syncPerm(); return _makeNd(ctx.randn(shape)); },
    async uniform(low, high, shape) {
      if (low?._kw) { shape = low.size; high = low.high ?? 1; low = low.low ?? 0; }
      const ctx = await _ensureCtx();
      const arr = ctx.random(_normShape(shape || [1]));
      // scale: low + arr * (high - low)
      const ops = _ops();
      const scaled = ops.add(ops.mul(arr, high - low), low);
      return _makeNd(scaled);
    },
    async normal(loc, scale, shape) {
      if (loc?._kw) { shape = loc.size; scale = loc.scale ?? 1; loc = loc.loc ?? 0; }
      const ctx = await _ensureCtx();
      const arr = ctx.randn(_normShape(shape || [1]));
      const ops = _ops();
      const scaled = ops.add(ops.mul(arr, scale ?? 1), loc ?? 0);
      return _makeNd(scaled);
    },
    async lognormal(mean, sigma, shape) {
      if (mean?._kw) { shape = mean.size; sigma = mean.sigma ?? 1; mean = mean.mean ?? 0; }
      const ctx = await _ensureCtx();
      const arr = ctx.randn(_normShape(shape || [1]));
      const ops = _ops();
      // exp(mean + sigma * z) where z ~ N(0,1)
      const scaled = ops.exp(ops.add(ops.mul(arr, sigma ?? 1), mean ?? 0));
      return _makeNd(scaled);
    },
  },

  // context manager for explicit scoping
  scope() {
    return {
      __enter__() {
        if (!_ctx) throw new Error('natra not initialized — call an array creation function first');
        const { arena, ops } = _ctx._beginCellScope();
        const prevOps = _activeOps;
        _activeOps = ops;
        return { _arena: arena, _prevOps: prevOps };
      },
      __exit__(scopeObj) {
        if (!scopeObj) return false;
        _activeOps = scopeObj._prevOps;
        _ctx._endCellScope(scopeObj._arena, []);
        return false;
      },
    };
  },

  // constants
  pi: Math.PI,
  e: Math.E,
  inf: Infinity,
  nan: NaN,
  newaxis: null,

  // type helpers
  float64: 'f64',
  ndarray: 'ndarray',
};

// ── Registration ──
// Adder cell hooks (window._adderCellHooks) stay on a side channel — they're
// adder-internals (arena lifecycle), not a generic Auditable extension hook
// surface. The cross-language exports go through the manifest API.

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/natra',
      version: '0.1.0',
      description: 'Numpy-compatible ndarray wrapper for adder cells',
      exports: { natra: _module },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions['natra'] = _module;
  }
}

export { _module as natraAdder };
