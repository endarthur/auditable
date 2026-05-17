// adder transpile runtime — Python semantics helpers called from AIR-emitted JS.
// Small monomorphic functions that V8 inlines. Reuses builtins.js internals.

import {
  AdderError, AdderRange, Complex,
  pyBool, pyTypeName, pyStr, pyRepr, pyIter, pyCollect, pyFormatValue,
  adderGetAttr,
} from './builtins.js';
import { _resolveModule, _loadVfsModule, _loadHttpModule, _loadDirectModule } from './eval.js';

// ── Arithmetic (preserve Python semantics) ──

function _add(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  // dunder fallback
  if (a !== null && typeof a === 'object' && typeof a.__add__ === 'function') return a.__add__(b);
  if (b !== null && typeof b === 'object' && typeof b.__radd__ === 'function') return b.__radd__(a);
  throw new AdderError('TypeError', `unsupported operand type(s) for +: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

// In-place add used by `+=`. Python semantics: try __iadd__ first; if the
// LHS is a mutable container (list, set), extend it in-place; otherwise
// fall through to _add (creates a new value, caller rebinds via the
// surrounding assignment). Always returns the value to rebind.
function _iadd(a, b) {
  if (a !== null && typeof a === 'object' && typeof a.__iadd__ === 'function') {
    return a.__iadd__(b);
  }
  if (Array.isArray(a)) {
    // list += iterable — Python list.__iadd__ accepts any iterable.
    if (Array.isArray(b)) {
      for (const x of b) a.push(x);
    } else if (typeof b === 'string') {
      for (const ch of b) a.push(ch);
    } else if (b !== null && b !== undefined) {
      for (const x of pyIter(b)) a.push(x);
    }
    return a;
  }
  return _add(a, b);
}

function _sub(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a !== null && typeof a === 'object' && typeof a.__sub__ === 'function') return a.__sub__(b);
  if (b !== null && typeof b === 'object' && typeof b.__rsub__ === 'function') return b.__rsub__(a);
  throw new AdderError('TypeError', `unsupported operand type(s) for -: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

function _mul(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a * b;
  if (typeof a === 'string' && typeof b === 'number') return a.repeat(b);
  if (typeof a === 'number' && typeof b === 'string') return b.repeat(a);
  if (Array.isArray(a) && typeof b === 'number') { const r = []; for (let i = 0; i < b; i++) r.push(...a); return r; }
  if (typeof a === 'number' && Array.isArray(b)) { const r = []; for (let i = 0; i < a; i++) r.push(...b); return r; }
  if (a !== null && typeof a === 'object' && typeof a.__mul__ === 'function') return a.__mul__(b);
  if (b !== null && typeof b === 'object' && typeof b.__rmul__ === 'function') return b.__rmul__(a);
  throw new AdderError('TypeError', `unsupported operand type(s) for *: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

function _div(a, b) {
  if (b === 0) throw new AdderError('ZeroDivisionError', 'division by zero');
  if (typeof a === 'number' && typeof b === 'number') return a / b;
  if (a !== null && typeof a === 'object' && typeof a.__truediv__ === 'function') return a.__truediv__(b);
  throw new AdderError('TypeError', `unsupported operand type(s) for /: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

function _floordiv(a, b) {
  if (b === 0) throw new AdderError('ZeroDivisionError', 'integer division or modulo by zero');
  if (typeof a === 'number' && typeof b === 'number') return Math.floor(a / b);
  if (a !== null && typeof a === 'object' && typeof a.__floordiv__ === 'function') return a.__floordiv__(b);
  throw new AdderError('TypeError', `unsupported operand type(s) for //: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

function _mod(a, b) {
  if (b === 0) throw new AdderError('ZeroDivisionError', 'integer division or modulo by zero');
  if (typeof a === 'string') return _strPctFormat(a, Array.isArray(b) ? b : [b]);
  if (typeof a === 'number' && typeof b === 'number') return ((a % b) + b) % b;
  if (a !== null && typeof a === 'object' && typeof a.__mod__ === 'function') return a.__mod__(b);
  throw new AdderError('TypeError', `unsupported operand type(s) for %: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

function _pow(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.pow(a, b);
  if (a !== null && typeof a === 'object' && typeof a.__pow__ === 'function') return a.__pow__(b);
  throw new AdderError('TypeError', `unsupported operand type(s) for **: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

function _strPctFormat(fmt, args) {
  let i = 0;
  return fmt.replace(/%([sd%fegx])/g, (_, code) => {
    if (code === '%') return '%';
    return pyStr(args[i++]);
  });
}

// ── Comparison ──

function _eq(a, b) {
  if (a === b) return true;
  if (a !== null && typeof a === 'object' && typeof a.__eq__ === 'function') return a.__eq__(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!_eq(a[i], b[i])) return false;
    return true;
  }
  return false;
}

function _neq(a, b) {
  if (a !== null && typeof a === 'object' && typeof a.__ne__ === 'function') return a.__ne__(b);
  return !_eq(a, b);
}

function _lt(a, b) {
  if (a !== null && typeof a === 'object' && typeof a.__lt__ === 'function') return a.__lt__(b);
  if (typeof a === 'number' && typeof b === 'number') return a < b;
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  if (Array.isArray(a) && Array.isArray(b)) {
    const min = Math.min(a.length, b.length);
    for (let i = 0; i < min; i++) { if (_lt(a[i], b[i])) return true; if (_lt(b[i], a[i])) return false; }
    return a.length < b.length;
  }
  return a < b;
}

function _lte(a, b) {
  if (a !== null && typeof a === 'object' && typeof a.__le__ === 'function') return a.__le__(b);
  return _lt(a, b) || _eq(a, b);
}

function _gt(a, b) {
  if (a !== null && typeof a === 'object' && typeof a.__gt__ === 'function') return a.__gt__(b);
  return _lt(b, a);
}

function _gte(a, b) {
  if (a !== null && typeof a === 'object' && typeof a.__ge__ === 'function') return a.__ge__(b);
  return _lt(b, a) || _eq(a, b);
}

function _contains(container, value) {
  if (typeof container === 'string') return container.includes(String(value));
  if (Array.isArray(container)) return container.some(v => _eq(v, value));
  if (container instanceof Map) return container.has(value);
  if (container instanceof Set) return container.has(value);
  if (container instanceof AdderRange) return container.includes(value);
  if (container !== null && typeof container === 'object') {
    if (typeof container.__contains__ === 'function') return container.__contains__(value);
    return value in container;
  }
  throw new AdderError('TypeError', `argument of type '${pyTypeName(container)}' is not iterable`);
}

// ── Subscript ──

// 2D ndarray-shape tuple subscript — accepts any object with
// `data: Float64Array` + `shape: [n, m]`. Returns scalar / row /
// column / sub-matrix depending on the key shape. Used by both
// `_py.getitem` and `_py.setitem` so libraries (learn, scitra) that
// return `{data, shape}` are subscriptable with tuple keys without
// each one having to ship its own `__getitem__`.
function _ndarrayTupleGet(obj, key) {
  const [n, m] = obj.shape;
  const d = _ndarrayData(obj);
  const rk = key[0], ck = key[1];
  // scalar + scalar → value
  if (typeof rk === 'number' && typeof ck === 'number') {
    const i = rk < 0 ? n + rk : rk;
    const j = ck < 0 ? m + ck : ck;
    return d[i * m + j];
  }
  // scalar row + slice col → row vector (m or sub)
  if (typeof rk === 'number' && rk._slice == null && ck && ck._slice) {
    const i = rk < 0 ? n + rk : rk;
    const lo = ck.lower != null ? ck.lower : 0;
    const hi = ck.upper != null ? Math.min(ck.upper, m) : m;
    const out = new Float64Array(hi - lo);
    for (let k = 0; k < hi - lo; k++) out[k] = d[i * m + lo + k];
    out.shape = [out.length];
    return out;
  }
  // slice row + scalar col → column vector
  if (rk && rk._slice && typeof ck === 'number') {
    const lo = rk.lower != null ? rk.lower : 0;
    const hi = rk.upper != null ? Math.min(rk.upper, n) : n;
    const j = ck < 0 ? m + ck : ck;
    const out = new Float64Array(hi - lo);
    for (let i = 0; i < hi - lo; i++) out[i] = d[(lo + i) * m + j];
    out.shape = [out.length];
    return out;
  }
  // slice + slice → 2D sub-matrix
  if (rk && rk._slice && ck && ck._slice) {
    const r0 = rk.lower != null ? rk.lower : 0;
    const r1 = rk.upper != null ? Math.min(rk.upper, n) : n;
    const c0 = ck.lower != null ? ck.lower : 0;
    const c1 = ck.upper != null ? Math.min(ck.upper, m) : m;
    const rows = r1 - r0;
    const cols = c1 - c0;
    const out = new Float64Array(rows * cols);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) out[i * cols + j] = d[(r0 + i) * m + (c0 + j)];
    }
    out.shape = [rows, cols];
    return out;
  }
  throw new AdderError('TypeError', `ndarray: unsupported tuple subscript shape`);
}

function _looksLikeNdarray(obj) {
  if (!obj || !Array.isArray(obj.shape) || obj.shape.length !== 2) return false;
  if (obj.data instanceof Float64Array) return true;
  // learn's transformers return a Float64Array directly with `.shape`
  // tacked on as an own property — no wrapping object.
  if (obj instanceof Float64Array) return true;
  return false;
}

function _ndarrayData(obj) {
  return obj instanceof Float64Array ? obj : obj.data;
}

function _getitem(obj, key) {
  if (obj === null || obj === undefined) {
    throw new AdderError('TypeError', `'NoneType' object is not subscriptable`);
  }
  // 2D ndarray with tuple subscript — handle natively so libraries
  // returning `{data: Float64Array, shape: [n, m]}` (learn's transform
  // outputs, etc.) support `x[i, j]` / `x[:, 0]` without needing their
  // own __getitem__.
  if (Array.isArray(key) && _looksLikeNdarray(obj)) {
    return _ndarrayTupleGet(obj, key);
  }
  if (obj instanceof Map) {
    if (!obj.has(key)) throw new AdderError('KeyError', pyRepr(key));
    return obj.get(key);
  }
  if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array) {
    const idx = key < 0 ? obj.length + key : key;
    if (idx < 0 || idx >= obj.length) throw new AdderError('IndexError', `${pyTypeName(obj)} index out of range`);
    return obj[idx];
  }
  if (typeof obj === 'object') {
    if (typeof obj.__getitem__ === 'function') return obj.__getitem__(key);
    if (key in obj) return obj[key];
    throw new AdderError('KeyError', pyRepr(key));
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object is not subscriptable`);
}

function _setitem(obj, key, value) {
  if (obj instanceof Map) { obj.set(key, value); return; }
  if (Array.isArray(obj)) {
    const idx = key < 0 ? obj.length + key : key;
    obj[idx] = value;
    return;
  }
  // 2D ndarray with tuple key (`x_trans[:, 1] = 0.0`). Mirrors the
  // getitem path — accepts `{data: Float64Array, shape}` wrappers and
  // bare Float64Arrays-with-shape. Value can be a scalar (broadcast)
  // or an iterable (must match the assigned slice length).
  if (Array.isArray(key) && _looksLikeNdarray(obj)) {
    _ndarrayTupleSet(obj, key, value);
    return;
  }
  if (typeof obj === 'object' && obj !== null) {
    if (typeof obj.__setitem__ === 'function') { obj.__setitem__(key, value); return; }
    obj[key] = value;
    return;
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object does not support item assignment`);
}

function _ndarrayTupleSet(obj, key, value) {
  const [n, m] = obj.shape;
  const d = _ndarrayData(obj);
  const rk = key[0], ck = key[1];
  const _broadcast = (write, len) => {
    if (value != null && typeof value !== 'string'
        && typeof value[Symbol.iterator] === 'function') {
      const flat = [...value];
      if (flat.length !== len) {
        throw new AdderError('ValueError', `cannot broadcast ${flat.length} values to ${len} positions`);
      }
      for (let i = 0; i < len; i++) write(i, flat[i]);
    } else {
      for (let i = 0; i < len; i++) write(i, value);
    }
  };

  // scalar + scalar — single cell
  if (typeof rk === 'number' && typeof ck === 'number') {
    const i = rk < 0 ? n + rk : rk;
    const j = ck < 0 ? m + ck : ck;
    d[i * m + j] = value;
    return;
  }
  // slice row + scalar col → column slice
  if (rk && rk._slice && typeof ck === 'number') {
    const lo = rk.lower != null ? rk.lower : 0;
    const hi = rk.upper != null ? Math.min(rk.upper, n) : n;
    const j = ck < 0 ? m + ck : ck;
    _broadcast((i, v) => { d[(lo + i) * m + j] = v; }, hi - lo);
    return;
  }
  // scalar row + slice col → row slice
  if (typeof rk === 'number' && ck && ck._slice) {
    const i = rk < 0 ? n + rk : rk;
    const lo = ck.lower != null ? ck.lower : 0;
    const hi = ck.upper != null ? Math.min(ck.upper, m) : m;
    _broadcast((k, v) => { d[i * m + lo + k] = v; }, hi - lo);
    return;
  }
  // slice + slice → 2D sub-block
  if (rk && rk._slice && ck && ck._slice) {
    const r0 = rk.lower != null ? rk.lower : 0;
    const r1 = rk.upper != null ? Math.min(rk.upper, n) : n;
    const c0 = ck.lower != null ? ck.lower : 0;
    const c1 = ck.upper != null ? Math.min(ck.upper, m) : m;
    const rows = r1 - r0, cols = c1 - c0;
    // Scalar value → fill block
    if (value == null || typeof value === 'number'
        || typeof value === 'string'
        || typeof value[Symbol.iterator] !== 'function') {
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) d[(r0 + i) * m + (c0 + j)] = value;
      }
      return;
    }
    throw new AdderError('TypeError', 'ndarray block assignment from iterable not yet supported');
  }
  throw new AdderError('TypeError', `ndarray: unsupported tuple subscript shape`);
}

function _slice(obj, lower, upper, step) {
  step = step ?? 1;
  if (step === 0) throw new AdderError('ValueError', 'slice step cannot be zero');
  if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array) {
    const len = obj.length;
    if (step === 1) {
      const l = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
      const u = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
      return obj.slice(l, u);
    }
    const positive = step > 0;
    let l = lower == null ? (positive ? 0 : len - 1) : lower < 0 ? Math.max(positive ? 0 : -1, len + lower) : Math.min(lower, positive ? len : len - 1);
    let u = upper == null ? (positive ? len : -1) : upper < 0 ? Math.max(positive ? 0 : -1, len + upper) : Math.min(upper, positive ? len : len - 1);
    const result = [];
    if (positive) { for (let i = l; i < u; i += step) result.push(obj[i]); }
    else { for (let i = l; i > u; i += step) result.push(obj[i]); }
    return typeof obj === 'string' ? result.join('') : result;
  }
  if (typeof obj?.__getitem__ === 'function') {
    return obj.__getitem__({ _slice: true, lower, upper, step });
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object is not subscriptable`);
}

function _rtSliceIndices(len, lower, upper, step) {
  let start, stop;
  if (step > 0) {
    start = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
    stop = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
  } else {
    start = lower == null ? len - 1 : lower < 0 ? Math.max(-1, len + lower) : Math.min(lower, len - 1);
    stop = upper == null ? -1 : upper < 0 ? Math.max(-1, len + upper) : upper;
  }
  const out = [];
  if (step > 0) { for (let i = start; i < stop; i += step) out.push(i); }
  else { for (let i = start; i > stop; i += step) out.push(i); }
  return out;
}

function _setslice(obj, lower, upper, step, value) {
  if (typeof obj === 'string') {
    throw new AdderError('TypeError', "'str' object does not support item assignment");
  }
  if (obj instanceof Uint8Array) {
    throw new AdderError('TypeError', "'bytes' object does not support item assignment");
  }
  if (typeof obj?.__setitem__ === 'function') {
    obj.__setitem__({ _slice: true, lower, upper, step }, value);
    return;
  }
  if (!Array.isArray(obj)) {
    throw new AdderError('TypeError', `'${pyTypeName(obj)}' object does not support slice assignment`);
  }
  const rhs = [...pyIter(value)];
  const effectiveStep = step ?? 1;
  if (effectiveStep === 0) throw new AdderError('ValueError', 'slice step cannot be zero');
  if (effectiveStep === 1) {
    const len = obj.length;
    const l = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
    const u = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
    const removeCount = Math.max(0, u - l);
    obj.splice(l, removeCount, ...rhs);
    return;
  }
  const indices = _rtSliceIndices(obj.length, lower, upper, effectiveStep);
  if (rhs.length !== indices.length) {
    throw new AdderError(
      'ValueError',
      `attempt to assign sequence of size ${rhs.length} to extended slice of size ${indices.length}`,
    );
  }
  for (let k = 0; k < indices.length; k++) obj[indices[k]] = rhs[k];
}

function _delslice(obj, lower, upper, step) {
  if (typeof obj === 'string') {
    throw new AdderError('TypeError', "'str' object doesn't support item deletion");
  }
  if (obj instanceof Uint8Array) {
    throw new AdderError('TypeError', "'bytes' object doesn't support item deletion");
  }
  if (typeof obj?.__delitem__ === 'function') {
    obj.__delitem__({ _slice: true, lower, upper, step });
    return;
  }
  if (!Array.isArray(obj)) {
    throw new AdderError('TypeError', `'${pyTypeName(obj)}' object doesn't support slice deletion`);
  }
  const effectiveStep = step ?? 1;
  if (effectiveStep === 0) throw new AdderError('ValueError', 'slice step cannot be zero');
  if (effectiveStep === 1) {
    const len = obj.length;
    const l = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
    const u = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
    if (u > l) obj.splice(l, u - l);
    return;
  }
  const indices = _rtSliceIndices(obj.length, lower, upper, effectiveStep);
  indices.sort((a, b) => b - a);
  for (const i of indices) obj.splice(i, 1);
}

// ── Method-call PIC (polymorphic inline cache) ──
//
// `obj.method(args)` in adder lowers to `await _py.callMethod(obj, name,
// siteId, ...args)`. Each call site has a unique siteId allocated by the
// lowerer; the helper keeps a tiny (type → unbound_method) cache keyed
// off siteId. On hit, skip adderGetAttr's type-dispatch chain entirely
// and skip the bound-method closure allocation.
//
// Layout: _PIC[siteId] = { types, methods, next } — arrays of length
// 0..PIC_SIZE. FIFO eviction once full so a 5-way polymorphic site
// (e.g. richards' task-table) cycles instead of going megamorphic.
//
// Class-instance fast path only. Primitives (string, array, Map, …) and
// modules fall through to adderGetAttr because their per-type method
// tables (`_strMethod`, `_listMethod`, etc.) build a fresh closure per
// call — caching one would alias the receiver across instances. The
// adderGetAttr slow path already returns the right closure for these.

const _PIC_SIZE = 4;
const _PIC = [];

// Sync function — the underlying method may be sync OR async, and JS
// `return` preserves that polarity. Wrapping this helper in `async`
// would wrap every return in `Promise.resolve()` even when the method
// is sync, paying the Promise allocation on every method call.
// The caller's `await _py.callMethod(...)` handles both shapes.
function _callMethod(obj, name, siteId, ...args) {
  // Fast path: scan the cache for a matching __adderType__.
  const t = (obj !== null && obj !== undefined) ? obj.__adderType__ : undefined;
  const cache = _PIC[siteId];
  if (cache && t !== undefined) {
    const types = cache.types;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === t) return cache.methods[i].call(obj, ...args);
    }
  }
  // Slow path: full adderGetAttr lookup + call.
  const fn = adderGetAttr(obj, name);
  const result = fn(...args);

  // Populate the cache for class-instance receivers. We cache the
  // wrapper on `t.prototype[name]` (a non-_pyFunc function whose `this`
  // gets bound to the receiver at call time via `.call(obj, ...)`).
  // Skip caching for primitives / dicts / modules — adderGetAttr there
  // returns receiver-bound closures whose identity changes per call.
  if (t !== undefined && t.prototype && typeof t.prototype[name] === 'function') {
    let c = cache;
    if (!c) {
      c = { types: [], methods: [], next: 0 };
      _PIC[siteId] = c;
    }
    if (c.types.length < _PIC_SIZE) {
      c.types.push(t);
      c.methods.push(t.prototype[name]);
    } else {
      // FIFO eviction so a 5-way polymorphic site cycles instead of
      // pinning to the first 4 types it ever saw.
      const idx = c.next;
      c.types[idx] = t;
      c.methods[idx] = t.prototype[name];
      c.next = (idx + 1) % _PIC_SIZE;
    }
  }
  return result;
}

// ── Context manager __exit__ ──

// Called by `with` lowering. When the body completes normally, `exc` is
// null and __exit__ is called with (None, None, None); the return value
// is ignored. When the body raised, `exc` is the error and __exit__ is
// called with (type, exc, None); a truthy return value indicates the
// exception is suppressed (the lowerer checks and only re-raises on
// falsy). __exit__ may be async — we must AWAIT it so the lowered call
// site's `await _py.exitWith(...)` actually waits for side effects
// (e.g. a file open(..., "w") that flushes to the VFS on close).
async function _exitWith(mgr, exc) {
  if (mgr === null || mgr === undefined || typeof mgr.__exit__ !== 'function') {
    throw new AdderError(
      'AttributeError',
      `'${pyTypeName(mgr)}' object has no attribute '__exit__'`,
    );
  }
  if (exc === null || exc === undefined) {
    // Normal-exit path: discard return; CPython does likewise here.
    await mgr.__exit__(null, null, null);
    return false;
  }
  // Exception path: pass (type, value, None) and return suppression flag.
  const excType =
    (exc !== null && typeof exc === 'object' && exc.__class__) ||
    (exc && exc.constructor) ||
    null;
  return await mgr.__exit__(excType, exc, null);
}

// ── Attribute access ──

function _getattr(obj, name) {
  return adderGetAttr(obj, name);
}

function _setattr(obj, name, value) {
  // typeof check accepts both 'object' (instances) and 'function' (adder
  // classes — class-attribute assignment patterns like
  // `Strength.REQUIRED = Strength(0)` deltablue uses for module-level
  // singletons set after the class body has evaluated).
  if (obj !== null && (typeof obj === 'object' || typeof obj === 'function')) {
    obj[name] = value;
  }
}

function _delitem(obj, key) {
  if (obj instanceof Map) { obj.delete(key); return; }
  if (Array.isArray(obj)) {
    const idx = key < 0 ? obj.length + key : key;
    obj.splice(idx, 1);
    return;
  }
  if (obj instanceof Set) { obj.delete(key); return; }
  if (obj !== null && typeof obj === 'object') {
    if (typeof obj.__delitem__ === 'function') { obj.__delitem__(key); return; }
    delete obj[key];
    return;
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object does not support item deletion`);
}

function _delattr(obj, name) {
  if (obj !== null && typeof obj === 'object') delete obj[name];
}

function _makeDict(keys, values) {
  const m = new Map();
  for (let i = 0; i < keys.length; i++) m.set(keys[i], values[i]);
  return m;
}

function _makeSet(arr) {
  return new Set(arr);
}

// ── Imports ──

async function _import(name) {
  let mod = _resolveModule(name);
  if (mod) return mod;
  mod = await _loadVfsModule(name);
  if (mod) return mod;
  mod = await _loadHttpModule(name);
  if (mod) return mod;
  throw new AdderError('ModuleNotFoundError', `No module named '${name}'`);
}

async function _importPath(path) {
  const mod = await _loadDirectModule(path);
  if (mod) return mod;
  throw new AdderError('ModuleNotFoundError', `cannot load module from '${path}'`);
}

async function _importFrom(moduleName, names) {
  // names: array of { name, alias } (or special "*" to expose all)
  let mod = _resolveModule(moduleName);
  if (!mod) mod = await _loadVfsModule(moduleName);
  if (!mod) mod = await _loadHttpModule(moduleName);
  if (!mod) throw new AdderError('ModuleNotFoundError', `No module named '${moduleName}'`);
  return _extractFromImport(mod, names, moduleName);
}

async function _importFromPath(path, names) {
  const mod = await _loadDirectModule(path);
  if (!mod) throw new AdderError('ModuleNotFoundError', `cannot load module from '${path}'`);
  return _extractFromImport(mod, names, path);
}

function _extractFromImport(mod, names, displayName) {
  const result = {};
  for (const { name, alias } of names) {
    if (name === '*') {
      for (const k of Object.keys(mod)) result[k] = mod[k];
    } else {
      if (!(name in mod)) {
        throw new AdderError('ImportError', `cannot import name '${name}' from '${displayName}'`);
      }
      result[alias || name] = mod[name];
    }
  }
  return result;
}

// ── Class creation ──
// Mirrors _evalClass in eval.js, but takes pre-evaluated bases and members.

function _rtComputeMRO(cls) {
  if (!cls._pyBases || cls._pyBases.length === 0) return [cls];
  const baseMROs = cls._pyBases.map(b => [..._rtComputeMRO(b)]);
  const result = [cls];
  const lists = [...baseMROs, [...cls._pyBases]];
  while (lists.some(l => l.length > 0)) {
    let head = null;
    for (const list of lists) {
      if (list.length === 0) continue;
      const candidate = list[0];
      if (lists.every(l => { const idx = l.indexOf(candidate); return idx <= 0; })) { head = candidate; break; }
    }
    if (!head) throw new AdderError('TypeError', 'Cannot create a consistent method resolution order');
    result.push(head);
    for (const list of lists) { const idx = list.indexOf(head); if (idx !== -1) list.splice(idx, 1); }
  }
  return result;
}

function _createClass(name, bases, members) {
  // `class X(list): …` — instance must BE an Array so native list methods
  // (append/pop/indexing) dispatch via adderGetAttr's Array branch. See
  // _evalClass for the mirror-image logic on the tree-walker side.
  const listBase = (bases || []).find(b => b && b._pyContainerType === 'list');
  const cls = function (...args) {
    const instance = listBase
      ? Object.assign(args.length > 0 ? [...pyIter(args[0])] : [], { __adderClass__: name, __adderType__: cls })
      : Object.create(cls.prototype);
    if (!listBase) {
      instance.__adderClass__ = name;
      instance.__adderType__ = cls;
    }
    for (const [k, v] of Object.entries(members)) {
      if (typeof v !== 'function' && !(v && (v.__property__ || v.__staticmethod__ || v.__classmethod__))) {
        instance[k] = v;
      }
    }
    if (typeof cls.prototype.__init__ === 'function') {
      const result = cls.prototype.__init__.call(instance, ...args);
      if (result instanceof Promise) return result.then(() => instance);
    }
    return instance;
  };

  cls.prototype = {};
  cls._pyName = name;
  cls._pyClass = true;
  cls._pyBases = (bases || []).filter(b => b?._pyClass);

  const mro = _rtComputeMRO(cls);
  cls._pyMRO = mro;

  // Inherit methods from MRO
  for (let i = mro.length - 1; i >= 1; i--) {
    const base = mro[i];
    if (!base.prototype || !base._pyOwnMembers) continue;
    for (const key of base._pyOwnMembers) {
      const desc = Object.getOwnPropertyDescriptor(base.prototype, key);
      if (desc) Object.defineProperty(cls.prototype, key, desc);
    }
  }

  for (const [mName, value] of Object.entries(members)) {
    if (value && value.__property__) {
      const fget = value.fget;
      const fset = value.fset;
      const desc = { get() { return fget(this); }, configurable: true, enumerable: true };
      if (fset) {
        const setFn = function(v) { fset(this, v); };
        setFn._pyFset = fset;
        desc.set = setFn;
      }
      Object.defineProperty(cls.prototype, mName, desc);
    } else if (value && value.__staticmethod__) {
      const rawFn = value.fn;
      const sm = (...args) => rawFn(...args);
      sm._pyName = `${name}.${mName}`;
      cls.prototype[mName] = sm;
      cls[mName] = sm;
    } else if (value && value.__classmethod__) {
      const originalFn = value.fn;
      const cm = function (...args) { return originalFn(cls, ...args); };
      cm._pyName = `${name}.${mName}`;
      cls.prototype[mName] = cm;
      cls[mName] = cm;
    } else if (typeof value === 'function') {
      const originalFn = value;
      cls.prototype[mName] = function (...args) { return originalFn(this, ...args); };
      cls.prototype[mName]._pyName = `${name}.${mName}`;
      // Python unbound-method access (`ClassName.method(instance, ...)`).
      // Arrow form so adderGetAttr's `.bind(obj)` doesn't pin `this` to
      // the class. Mirror of the tree-walker's _evalClass branch.
      cls[mName] = (...args) => originalFn(...args);
    }
  }

  for (const [k, v] of Object.entries(members)) {
    if (typeof v !== 'function' && !(v && (v.__property__ || v.__staticmethod__ || v.__classmethod__))) {
      cls[k] = v;
    }
  }

  // Inherit class-level method bindings from MRO bases. Walk furthest-
  // first so closer bases win, and skip keys this class already owns —
  // without the hasOwnProperty guard the parent's binding would silently
  // overwrite the child's own definition.
  for (let i = mro.length - 1; i >= 1; i--) {
    const base = mro[i];
    if (!base._pyOwnMembers) continue;
    for (const key of base._pyOwnMembers) {
      if (Object.prototype.hasOwnProperty.call(cls, key)) continue;
      if (key in base && typeof base[key] === 'function') cls[key] = base[key];
    }
  }

  cls._pyOwnMembers = new Set();
  for (const [mName, value] of Object.entries(members)) {
    if (typeof value === 'function' || (value && (value.__property__ || value.__staticmethod__ || value.__classmethod__))) {
      cls._pyOwnMembers.add(mName);
    }
  }

  return cls;
}

// ── Exception matching (for try/except) ──

// _excParents comes from builtins.js
import { _excParents } from './builtins.js';

function _rtMatchException(error, excTypeVal) {
  if (!excTypeVal) return true;
  if (Array.isArray(excTypeVal)) return excTypeVal.some(t => _rtMatchException(error, t));
  if (error instanceof AdderError) {
    const targetName = typeof excTypeVal === 'function'
      ? (excTypeVal._pyName || excTypeVal.name)
      : (typeof excTypeVal === 'string' ? excTypeVal : null);
    if (targetName) {
      if (error.pyType === targetName) return true;
      let pt = _excParents[error.pyType];
      while (pt) { if (pt === targetName) return true; pt = _excParents[pt]; }
    }
  }
  if (typeof excTypeVal === 'function' && excTypeVal._pyClass && error !== null && typeof error === 'object') {
    let proto = error;
    while (proto) {
      if (proto.__adderClass__ === (excTypeVal._pyName || excTypeVal.name)) return true;
      proto = Object.getPrototypeOf(proto);
    }
  }
  if (typeof excTypeVal === 'function' && !excTypeVal._pyClass) {
    try { return error instanceof excTypeVal; } catch { /* arrow fn */ }
  }
  return false;
}

// ── Unary ──

function _neg(a) {
  if (typeof a === 'number') return -a;
  if (a !== null && typeof a === 'object' && typeof a.__neg__ === 'function') return a.__neg__();
  throw new AdderError('TypeError', `bad operand type for unary -: '${pyTypeName(a)}'`);
}

function _pos(a) {
  if (typeof a === 'number') return +a;
  return a;
}

function _invert(a) {
  if (typeof a === 'number') return ~a;
  // dunder fallback so e.g. sadpan's BooleanMask.__invert__ fires
  if (a !== null && typeof a === 'object' && typeof a.__invert__ === 'function') return a.__invert__();
  throw new AdderError('TypeError', `bad operand type for unary ~: '${pyTypeName(a)}'`);
}

// ── Bitwise (with dunder fallback) ──
// Lowered from `&`, `|`, `^` between values whose types AIR can't prove
// are ints. Fast-path real ints to native bitwise; fall through to
// __and__/__or__/__xor__ so libraries like sadpan can overload (their
// BooleanMask combines via these). The constant-fold pass in passes.js
// can short-circuit back to native bitwise once both operands are typed.

function _and_(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a & b;
  if (a !== null && typeof a === 'object' && typeof a.__and__ === 'function') return a.__and__(b);
  if (b !== null && typeof b === 'object' && typeof b.__rand__ === 'function') return b.__rand__(a);
  throw new AdderError('TypeError', `unsupported operand type(s) for &: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

function _or_(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a | b;
  if (a !== null && typeof a === 'object' && typeof a.__or__ === 'function') return a.__or__(b);
  if (b !== null && typeof b === 'object' && typeof b.__ror__ === 'function') return b.__ror__(a);
  throw new AdderError('TypeError', `unsupported operand type(s) for |: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

function _xor(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a ^ b;
  if (a !== null && typeof a === 'object' && typeof a.__xor__ === 'function') return a.__xor__(b);
  if (b !== null && typeof b === 'object' && typeof b.__rxor__ === 'function') return b.__rxor__(a);
  throw new AdderError('TypeError', `unsupported operand type(s) for ^: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

// ── Function call with kwargs ──

function _call(fn, args, kwargs) {
  if (typeof fn !== 'function') {
    if (fn !== null && typeof fn === 'object' && typeof fn.__call__ === 'function') {
      return fn.__call__(...(args || []));
    }
    throw new AdderError('TypeError', `'${pyTypeName(fn)}' object is not callable`);
  }
  if (kwargs) {
    const kw = { _kw: true, ...kwargs };
    return fn(...(args || []), kw);
  }
  return fn(...(args || []));
}

// ── Iteration helpers ──

// Convert any iterable to an array (for for-of compatibility)
function _iterArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (typeof obj === 'string') return obj;  // strings iterate char-by-char in JS for...of
  // Async iterables can't be materialised synchronously — return a Promise
  // and let the call site `await` it. Returning a sync iterable on the
  // common path keeps that fast path free of microtasks.
  if (obj && typeof obj[Symbol.asyncIterator] === 'function') {
    return (async () => {
      const out = [];
      for await (const v of obj) out.push(v);
      return out;
    })();
  }
  return [...pyIter(obj)];
}

// ── Exceptions ──

function _raise(exc) {
  if (exc instanceof Error) throw exc;
  if (exc instanceof AdderError) throw exc;
  if (typeof exc === 'string') throw new AdderError('Exception', exc);
  throw exc;
}

// ── Export as single namespace ──

export const _py = {
  // arithmetic
  add: _add, sub: _sub, mul: _mul, div: _div,
  floordiv: _floordiv, mod: _mod, pow: _pow,
  // in-place: __iadd__ dispatch + list extend semantics for `+=`
  iadd: _iadd,
  // bitwise (with dunder fallback for masks/sets/etc.)
  and_: _and_, or_: _or_, xor: _xor,
  // unary
  neg: _neg, pos: _pos, invert: _invert,
  // comparison
  eq: _eq, neq: _neq, lt: _lt, lte: _lte, gt: _gt, gte: _gte,
  contains: _contains,
  // subscript
  getitem: _getitem, setitem: _setitem, slice: _slice,
  setslice: _setslice, delslice: _delslice,
  // Marker object for slice elements inside a tuple subscript
  // (`arr[i:j, k]` lowers to `getitem(obj, [makeSlice(i,j,null), k])`
  // — the consumer's __getitem__ destructures via `_slice` flag).
  makeSlice: (lower, upper, step) => ({ _slice: true, lower, upper, step }),
  // context manager __exit__ (with statement)
  exitWith: _exitWith,
  // attribute
  getattr: _getattr, setattr: _setattr,
  callMethod: _callMethod,
  delitem: _delitem, delattr: _delattr,
  // dict/set construction
  makeDict: _makeDict, makeSet: _makeSet,
  // call
  call: _call,
  // iteration
  iter: _iterArray,
  // truthiness
  truthy: pyBool,
  // string formatting
  fmt: pyFormatValue,
  str: pyStr,
  repr: pyRepr,
  // exception
  raise: _raise,
  matchException: _rtMatchException,
  // imports
  import: _import,
  importPath: _importPath,
  importFrom: _importFrom,
  importFromPath: _importFromPath,
  // class
  createClass: _createClass,
};
