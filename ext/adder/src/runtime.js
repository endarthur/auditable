// adder transpile runtime — Python semantics helpers called from AIR-emitted JS.
// Small monomorphic functions that V8 inlines. Reuses builtins.js internals.

import {
  AdderError, AdderRange, Complex,
  pyBool, pyTypeName, pyStr, pyRepr, pyIter, pyCollect, pyFormatValue,
  adderGetAttr,
} from './builtins.js';
import { _resolveModule, _loadVfsModule } from './eval.js';

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

function _getitem(obj, key) {
  if (obj === null || obj === undefined) {
    throw new AdderError('TypeError', `'NoneType' object is not subscriptable`);
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
  if (typeof obj === 'object' && obj !== null) {
    if (typeof obj.__setitem__ === 'function') { obj.__setitem__(key, value); return; }
    obj[key] = value;
    return;
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object does not support item assignment`);
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

// ── Attribute access ──

function _getattr(obj, name) {
  return adderGetAttr(obj, name);
}

function _setattr(obj, name, value) {
  if (obj !== null && typeof obj === 'object') obj[name] = value;
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
  throw new AdderError('ModuleNotFoundError', `No module named '${name}'`);
}

async function _importFrom(moduleName, names) {
  // names: array of { name, alias } (or special "*" to expose all)
  let mod = _resolveModule(moduleName);
  if (!mod) mod = await _loadVfsModule(moduleName);
  if (!mod) throw new AdderError('ModuleNotFoundError', `No module named '${moduleName}'`);
  const result = {};
  for (const { name, alias } of names) {
    if (name === '*') {
      for (const k of Object.keys(mod)) result[k] = mod[k];
    } else {
      if (!(name in mod)) {
        throw new AdderError('ImportError', `cannot import name '${name}' from '${moduleName}'`);
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
  const cls = function (...args) {
    const instance = Object.create(cls.prototype);
    instance.__adderClass__ = name;
    instance.__adderType__ = cls;
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
    }
  }

  for (const [k, v] of Object.entries(members)) {
    if (typeof v !== 'function' && !(v && (v.__property__ || v.__staticmethod__ || v.__classmethod__))) {
      cls[k] = v;
    }
  }

  for (let i = mro.length - 1; i >= 1; i--) {
    const base = mro[i];
    if (!base._pyOwnMembers) continue;
    for (const key of base._pyOwnMembers) {
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
  throw new AdderError('TypeError', `bad operand type for unary ~: '${pyTypeName(a)}'`);
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
  // unary
  neg: _neg, pos: _pos, invert: _invert,
  // comparison
  eq: _eq, neq: _neq, lt: _lt, lte: _lte, gt: _gt, gte: _gte,
  contains: _contains,
  // subscript
  getitem: _getitem, setitem: _setitem, slice: _slice,
  // attribute
  getattr: _getattr, setattr: _setattr,
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
  importFrom: _importFrom,
  // class
  createClass: _createClass,
};
